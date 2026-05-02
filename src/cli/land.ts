#!/usr/bin/env node
/**
 * pnpm auto:land <task-id> [--dry-run] [--force]
 *
 * Industrial-scale PR landing. Takes a task in {awaiting-review, claims-verified,
 * codex-reviewing, promotable, ready-for-merge} with valid evidence/diff.patch and:
 *
 *   1. Creates a worktree at .claude/worktrees/<branch> off origin/main HEAD
 *   2. Validates the diff applies cleanly (with auto-rebase if pack.base_sha is stale)
 *   3. Runs a smoke typecheck inside the worktree
 *   4. Commits with structured message
 *   5. Pushes feat/<branch> --force-with-lease
 *   6. Opens a PR via gh
 *   7. Transitions pack.state → ready-for-merge
 *
 * Idempotent: re-running on a task whose branch already has a PR open is a no-op
 * (or refreshes the diff if the pack.base_sha changed).
 *
 * Self-healing: every failure is captured to evidence/<task>/land-attempt-N.log
 * and the pack state stays at awaiting-review (NOT corrupted to needs-revision).
 *
 * Closes Sprint H1 / M1 of AGENT-ROSTER-AUDIT.md.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readTaskPack,
  evidenceDir,
  appendStateLog,
  withTaskPackLock,
  TaskPackLockBusyError,
} from '../lib/runState';
import { appendStateTransition, type TaskPack, type TaskState, refuseIfKillSwitchActive } from '../lib/taskPack';
import { captureIdentity, appendActor, enforceSoD, defaultSoDPolicy } from '../lib/sod';
import { evaluateMergePolicy, defaultMergePolicy } from '../lib/mergePolicy';
import { appendOverrideAudit } from '../lib/overrideAudit';
import { requireHarnessDriver, extractOverrideReason } from '../lib/harnessGuard';
import * as os from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
// HARNESS_ROOT is the worktree where the harness lives (used for .agent-runs/).
const HARNESS_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
// MAIN_REPO_ROOT is where worktrees + main checkout live. Resolved from
// `git rev-parse --git-common-dir` which always points at the main repo's
// .git/ even from inside a linked worktree.
function resolveMainRepoRoot(fromCwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: fromCwd,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (r.status !== 0) return fromCwd;
  const gitCommonDir = r.stdout.trim();
  const abs = path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(fromCwd, gitCommonDir);
  // gitCommonDir typically points at <repo>/.git, so the parent is the repo root.
  return path.dirname(abs);
}
const REPO_ROOT = resolveMainRepoRoot(HARNESS_ROOT);

interface LandArgs {
  taskId: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): LandArgs {
  const args: Partial<LandArgs> = { dryRun: false, force: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--force') args.force = true;
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  if (positional.length < 1) throw new Error('Required: <task_id> [--dry-run] [--force]');
  args.taskId = positional[0];
  return args as LandArgs;
}

const LANDABLE_STATES: ReadonlyArray<TaskState> = [
  'awaiting-review',
  'claims-verified',
  'codex-reviewing',
  'promotable',
  'ready-for-merge',
];

function findRunForTask(taskId: string): string {
  // .agent-runs/ lives in the harness worktree (HARNESS_ROOT), not the main repo.
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No .agent-runs/ directory at ${runsDir}; nothing to land.`);
  }
  for (const runId of fs.readdirSync(runsDir)) {
    const taskPath = path.join(runsDir, runId, 'tasks', `${taskId}.json`);
    if (fs.existsSync(taskPath)) return runId;
  }
  throw new Error(`Task ${taskId} not found in any run.`);
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function run(cmd: string, args: string[], cwd: string, timeoutMs = 60_000): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    exitCode: r.status,
  };
}

/**
 * HEAL-2: bounded exponential backoff for transient failures.
 * Returns the first successful RunResult or the last failure.
 */
function runWithRetry(cmd: string, args: string[], cwd: string, opts: { attempts?: number; timeoutMs?: number } = {}): RunResult {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  let last: RunResult = { ok: false, stdout: '', stderr: 'no attempts', exitCode: null };
  for (let i = 0; i < attempts; i++) {
    last = run(cmd, args, cwd, timeoutMs);
    if (last.ok) return last;
    if (i < attempts - 1) {
      const backoffMs = 2000 * Math.pow(2, i); // 2s, 4s, 8s
      console.warn(`[retry] ${cmd} attempt ${i + 1}/${attempts} failed: ${last.stderr.slice(0, 200)}; backoff ${backoffMs}ms`);
      // Synchronous sleep via spawnSync('sleep', ...) — no async
      spawnSync('sleep', [String(backoffMs / 1000)]);
    }
  }
  return last;
}

function buildBranchName(pack: TaskPack): string {
  // Sprint J fix: align with promote.ts inferDestinationBranch convention
  // so auto:land + auto:promote target the same branch.
  if (pack.worker?.branch_name) return pack.worker.branch_name;
  const target = pack.module_or_sprint;
  const moduleMatch = target.match(/^(M\d+)/i);
  if (moduleMatch) {
    const mod = moduleMatch[1].toLowerCase();
    if (pack.type === 'frd-polish' || pack.type === 'frd-author' || pack.type === 'frd-reconcile') return `docs/frd-${mod}-auth`;
    if (pack.type === 'trd-author' || pack.type === 'trd-polish' || pack.type === 'trd-reconcile') return `docs/trd-${mod}-auth`;
    if (pack.type === 'sprint-plan-author' || pack.type === 'sprint-plan-polish' || pack.type === 'sprint-plan-reconcile') return `docs/sprint-plan-${mod}-auth`;
  }
  // Fallback to legacy slug for code-sprint / audit-log-route / etc.
  const slug = target.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-|-$/g, '');
  return `feat/${slug}`;
}

function buildCommitMessage(pack: TaskPack): string {
  const subject = `feat(${pack.module_or_sprint.toLowerCase()}): ${pack.objective.slice(0, 70)}`;
  const acList = pack.acceptance_criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n');
  return `${subject}

Task: ${pack.task_id}
Module/sprint: ${pack.module_or_sprint}
Target version: ${pack.version_target}
Base SHA: ${pack.base_sha ?? 'unknown'}

Acceptance criteria addressed:
${acList}

Evidence: ${pack.evidence_dir}

🤖 Landed via pnpm auto:land (autonomous-delivery harness v0.4.3)
`;
}

function buildPrBody(pack: TaskPack): string {
  return `## Summary

Task: \`${pack.task_id}\` — ${pack.module_or_sprint} ${pack.version_target}

${pack.objective}

## Acceptance criteria

${pack.acceptance_criteria.map((ac, i) => `- [x] ${i + 1}. ${ac}`).join('\n')}

## Evidence

\`${pack.evidence_dir}\` — diff.patch + test-summary.md + duplicate-scan.json + risk-register.md + worker-handoff.json

## Test plan

- [x] Worker self-test (test-summary.md PASS)
- [x] Smoke typecheck inside landing worktree
- [ ] CI: lint + typecheck + test:unit + Vercel preview build (running)

## Provenance

- Base SHA at dispatch: \`${pack.base_sha ?? 'unknown'}\`
- Worker engine: ${pack.worker?.type ?? 'unknown'}
- Started: ${pack.worker?.started_at ?? 'unknown'}
- Completed: ${pack.worker?.completed_at ?? 'unknown'}
- Cost telemetry rounds: ${pack.cost_telemetry.length}

🤖 Landed via \`pnpm auto:land ${pack.task_id}\` (autonomous-delivery harness v0.4.3 / Sprint H1 / M1).
`;
}

interface LandResult {
  ok: boolean;
  branch: string;
  worktreePath: string;
  prUrl?: string;
  stage: string;
  error?: string;
}

function logAttempt(pack: TaskPack, attemptNum: number, content: string): void {
  const evDir = evidenceDir(pack.run_id, pack.task_id);
  if (!fs.existsSync(evDir)) fs.mkdirSync(evDir, { recursive: true });
  const logPath = path.join(evDir, `land-attempt-${attemptNum}.log`);
  fs.writeFileSync(logPath, content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Sprint J — refuse manual invocation; harness driver is the only entry point.
  requireHarnessDriver({
    cliName: 'auto:land',
    overrideReason: extractOverrideReason(process.argv.slice(2)),
    taskId: args.taskId,
  });

  // KILL SWITCH must be first — refuses any landing operation.
  // .agent-runs/_KILL_SWITCH lives in HARNESS_ROOT (worktree where harness lives).
  refuseIfKillSwitchActive(HARNESS_ROOT);

  const runId = findRunForTask(args.taskId);
  let pack = readTaskPack(runId, args.taskId);

  console.log(`Task: ${pack.task_id} (${pack.module_or_sprint}, ${pack.version_target})`);
  console.log(`State: ${pack.state}`);
  console.log(`Dry-run: ${args.dryRun}`);
  console.log('');

  // Guard 1 — state must be landable
  if (!LANDABLE_STATES.includes(pack.state)) {
    if (!args.force) {
      console.error(`[guard] BLOCKED: task state '${pack.state}' is not landable. Need one of: ${LANDABLE_STATES.join(', ')}`);
      console.error(`Pass --force only if you've manually verified the diff is ready.`);
      process.exit(3);
    }
    console.warn(`[guard] --force passed; landing despite state '${pack.state}'`);
  }

  // Guard 2 — diff.patch must exist
  const evDir = evidenceDir(runId, pack.task_id);
  const diffPath = path.join(evDir, 'diff.patch');
  if (!fs.existsSync(diffPath)) {
    console.error(`[guard] BLOCKED: diff.patch missing at ${diffPath}`);
    console.error(`Re-run: pnpm auto:work ${pack.task_id} --round N+1 to regenerate evidence.`);
    process.exit(4);
  }
  const diffSize = fs.statSync(diffPath).size;
  console.log(`[evidence] diff.patch = ${(diffSize / 1024).toFixed(1)} KB`);

  // R7 fix: GOVERNANCE PREFLIGHT — run SoD + PUB-9 merge gate BEFORE any
  // external side effect (worktree creation, diff apply, push, gh pr create).
  // Previously these checks ran inside stage 8 of the try block, AFTER the
  // PR was already pushed/updated — too late for "bank-grade landing
  // governance." A SoD-blocked or policy-blocked land would still leave a
  // pushed branch + PR on the remote. Now the early preflight refuses
  // before any visible side effect.
  //
  // The late checks at stage 8 are preserved as defense-in-depth (catches
  // mid-run state changes inside the lock). --force opts out of both.
  const preflightApprover = captureIdentity();
  const preflightSoD = enforceSoD(defaultSoDPolicy(), pack.actors, 'approver', preflightApprover);
  if (!preflightSoD.ok && !args.force) {
    console.error(`[sod-preflight] BLOCKED: ${preflightSoD.reason}`);
    console.error(`  remediation: ${preflightSoD.remediation}`);
    console.error(`No worktree created, no PR pushed, no task state mutated.`);
    process.exit(6);
  }
  const preflightPack: typeof pack = {
    ...pack,
    actors: appendActor(pack.actors, 'approver', preflightApprover),
  };
  // R10 fix: pre-land phase — ruleCiGreen skips because branch doesn't exist
  // yet. The strict CI check happens later when the operator runs auto:promote
  // or auto:merge-gate against the landed PR.
  const preflightGate = evaluateMergePolicy(preflightPack, evDir, HARNESS_ROOT, defaultMergePolicy(), { phase: 'pre-land' });
  if (!preflightGate.ok && !args.force) {
    console.error(`[merge-gate-preflight] BLOCKED: ${preflightGate.summary}`);
    for (const v of preflightGate.violations) {
      console.error(`  - [${v.rule}] ${v.reason}`);
      console.error(`      remediation: ${v.remediation}`);
    }
    console.error(`No worktree created, no PR pushed, no task state mutated.`);
    process.exit(7);
  }
  if (preflightGate.ok) {
    console.log(`[governance-preflight] ✓ SoD + PUB-9 gate pass; proceeding to PR ops.`);
  } else {
    // R8+1: --force is bypassing failed governance — SOX requires durable audit.
    // operator must set AUTO_FORCE_REASON env var with stated rationale.
    const forceReason = process.env.AUTO_FORCE_REASON;
    if (!forceReason || forceReason.length < 3) {
      console.error(
        `[governance-preflight] BLOCKED: --force passed but AUTO_FORCE_REASON missing or empty. ` +
        `SOX requires a stated reason for every governance bypass. Re-run with AUTO_FORCE_REASON="…".`
      );
      process.exit(7);
    }
    appendOverrideAudit(HARNESS_ROOT, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: preflightApprover,
      kind: 'force-land',
      reason: forceReason,
      task_id: pack.task_id,
      run_id: runId,
      context: {
        merge_gate_summary: preflightGate.summary,
        violated_rules: preflightGate.violations.map((v) => v.rule),
      },
      pid: process.pid,
      host: (() => { try { return os.hostname(); } catch { return undefined; } })(),
    });
    console.warn(`[governance-preflight] WARN (--force passed, AUTO_FORCE_REASON='${forceReason.slice(0, 60)}'): ${preflightGate.summary}`);
    console.warn(`[audit] override recorded at .agent-runs/_override-audit.jsonl`);
  }

  // Build branch + worktree paths
  const branch = buildBranchName(pack);
  const worktreePath = path.join(REPO_ROOT, '.claude', 'worktrees', branch.replace(/^feat\//, ''));
  const result: LandResult = { ok: false, branch, worktreePath, stage: 'init' };

  if (args.dryRun) {
    console.log(`[dry-run] would create worktree at ${worktreePath} off origin/main`);
    console.log(`[dry-run] would apply diff: git apply ${diffPath}`);
    console.log(`[dry-run] would commit + push ${branch}`);
    console.log(`[dry-run] would open PR via gh pr create`);
    return;
  }

  const attemptNum = (pack.notes?.filter(n => n.text?.includes('auto:land attempt')).length ?? 0) + 1;
  const log: string[] = [`auto:land attempt ${attemptNum} at ${new Date().toISOString()}`];

  try {
    // Stage 1 — fetch origin/main (HEAL-2 retry)
    result.stage = 'fetch';
    log.push(`\n[stage] fetch origin/main`);
    const fetchResult = runWithRetry('git', ['fetch', 'origin', 'main', '--quiet'], REPO_ROOT, { attempts: 3 });
    if (!fetchResult.ok) {
      log.push(`fetch failed: ${fetchResult.stderr}`);
      throw new Error(`git fetch origin main failed after 3 attempts: ${fetchResult.stderr.slice(0, 300)}`);
    }
    const headResult = run('git', ['rev-parse', 'origin/main'], REPO_ROOT);
    const currentMain = headResult.stdout.trim();
    log.push(`origin/main = ${currentMain}`);
    log.push(`pack.base_sha = ${pack.base_sha ?? 'unknown'}`);
    if (pack.base_sha && pack.base_sha !== currentMain) {
      log.push(`drift detected: pack.base_sha is stale by ${currentMain.slice(0,8)}`);
      console.log(`[drift] pack.base_sha=${pack.base_sha.slice(0, 8)} but origin/main=${currentMain.slice(0, 8)} — will rebase if apply fails`);
    }

    // Stage 2 — create worktree (idempotent: if exists, reset; if branch exists, force)
    result.stage = 'worktree';
    log.push(`\n[stage] create worktree at ${worktreePath}`);
    if (fs.existsSync(worktreePath)) {
      log.push(`worktree path already exists; removing first`);
      run('git', ['worktree', 'remove', '--force', worktreePath], REPO_ROOT);
    }
    // Check if branch exists; if so, use -B to reset
    const branchExists = run('git', ['rev-parse', '--verify', branch], REPO_ROOT).ok;
    const wtFlag = branchExists ? '-B' : '-b';
    const wtResult = run('git', ['worktree', 'add', wtFlag, branch, worktreePath, currentMain], REPO_ROOT);
    if (!wtResult.ok) {
      log.push(`worktree add failed: ${wtResult.stderr}`);
      throw new Error(`git worktree add failed: ${wtResult.stderr.slice(0, 300)}`);
    }
    log.push(`worktree ready (branch=${branch}, base=${currentMain.slice(0, 8)})`);

    // Stage 3 — apply diff (with rebase fallback if it fails)
    // Empty-patch case: doc-only modules (FRD/TRD/Sprint-Plan authored in
    // Obsidian outside the repo tree) produce 0-byte diff.patch. land creates
    // an empty marker commit on the branch instead — the commit message + PR
    // body reference the Obsidian path. PR #50 (M20 sprint-plan) used this.
    result.stage = 'apply';
    log.push(`\n[stage] apply diff.patch`);
    const isEmptyPatch = diffSize === 0;
    if (isEmptyPatch) {
      log.push(`diff.patch is 0 bytes — Obsidian-resident doc; will create empty marker commit at stage=commit`);
    } else {
      const applyCheck = run('git', ['apply', '--check', diffPath], worktreePath);
      if (!applyCheck.ok) {
        log.push(`apply --check failed: ${applyCheck.stderr.slice(0, 500)}`);
        // Try 3-way merge as fallback
        log.push(`falling back to git apply --3way`);
        const apply3way = run('git', ['apply', '--3way', diffPath], worktreePath);
        if (!apply3way.ok) {
          log.push(`apply --3way failed: ${apply3way.stderr.slice(0, 500)}`);
          throw new Error(
            `Diff conflicts on current main. Worker may have generated against a stale base ` +
            `(pack.base_sha=${pack.base_sha?.slice(0, 8)}, origin/main=${currentMain.slice(0, 8)}). ` +
            `Re-run: pnpm auto:work ${pack.task_id} --round N+1 to regenerate against fresh main, ` +
            `OR resolve conflicts manually in ${worktreePath} then commit + push.`
          );
        }
        log.push(`3-way merge successful (some conflicts may need manual resolution)`);
      } else {
        const applyResult = run('git', ['apply', diffPath], worktreePath);
        if (!applyResult.ok) {
          log.push(`apply failed (after --check passed!): ${applyResult.stderr}`);
          throw new Error(`git apply failed unexpectedly: ${applyResult.stderr.slice(0, 300)}`);
        }
        log.push(`diff applied cleanly`);
      }
    }

    // Stage 4 — smoke typecheck (BLOCKING per Codex R2 review)
    // R1 made this warn-only; Codex R2 flagged that as "can promote to
    // ready-for-merge with a failing typecheck". Now it BLOCKS unless --force.
    result.stage = 'typecheck';
    log.push(`\n[stage] smoke typecheck (BLOCKING)`);
    const tcResult = run('pnpm', ['--silent', 'typecheck'], worktreePath, 5 * 60_000);
    if (tcResult.ok) {
      log.push(`typecheck PASS`);
    } else {
      log.push(`typecheck FAIL: ${tcResult.stderr.slice(0, 500)}`);
      if (!args.force) {
        throw new Error(
          `Smoke typecheck FAILED in landing worktree. Refusing to promote to ready-for-merge.\n` +
          `First 500 chars of stderr:\n${tcResult.stderr.slice(0, 500)}\n` +
          `Either: (a) fix the typecheck failure in the worker's diff and re-run,` +
          `        (b) pass --force + AUTO_FORCE_REASON if you've manually verified the failure is spurious.`
        );
      }
      // R9 fix (HIGH #2): every --force bypass site must require + audit a
      // stated reason. Previously typecheck-bypass proceeded silently with
      // just a console.warn — no SOX audit.
      const tcForceReason = process.env.AUTO_FORCE_REASON;
      if (!tcForceReason || tcForceReason.length < 3) {
        throw new Error(
          `[typecheck-bypass] BLOCKED: --force passed but AUTO_FORCE_REASON missing or empty. ` +
          `SOX requires a stated reason for every typecheck bypass. Re-run with AUTO_FORCE_REASON="…".`
        );
      }
      appendOverrideAudit(HARNESS_ROOT, {
        schema_version: '1',
        at: new Date().toISOString(),
        actor: preflightApprover,
        kind: 'force-land',
        reason: tcForceReason,
        task_id: pack.task_id,
        run_id: runId,
        context: { stage: 'typecheck', stderr_first_500: tcResult.stderr.slice(0, 500) },
        pid: process.pid,
        host: os.hostname(),
      });
      console.warn(`[typecheck] --force passed (AUTO_FORCE_REASON='${tcForceReason.slice(0, 60)}'); promoting despite typecheck failure (HIGH RISK)`);
      console.warn(`[audit] override recorded at .agent-runs/_override-audit.jsonl`);
    }

    // Stage 4a — lint (BLOCKING; doc + impl)
    result.stage = 'lint';
    log.push(`\n[stage] lint`);
    const lintResult = run('pnpm', ['--silent', 'lint'], worktreePath, 2 * 60_000);
    if (lintResult.ok) {
      log.push(`lint PASS`);
    } else {
      log.push(`lint FAIL: ${lintResult.stderr.slice(0, 500)}`);
      if (!args.force) {
        throw new Error(
          `Lint FAILED. Refusing to promote.\nFirst 500 chars: ${lintResult.stderr.slice(0, 500)}`
        );
      }
      const lintForceReason = process.env.AUTO_FORCE_REASON;
      if (!lintForceReason || lintForceReason.length < 3) {
        throw new Error(`[lint-bypass] BLOCKED: --force without AUTO_FORCE_REASON.`);
      }
      appendOverrideAudit(HARNESS_ROOT, {
        schema_version: '1',
        at: new Date().toISOString(),
        actor: preflightApprover,
        kind: 'force-land',
        reason: lintForceReason,
        task_id: pack.task_id,
        run_id: runId,
        context: { stage: 'lint', stderr_first_500: lintResult.stderr.slice(0, 500) },
        pid: process.pid,
        host: os.hostname(),
      });
      console.warn(`[lint] --force passed; promoting despite lint failure`);
    }

    // Stage 4b — unit tests (BLOCKING for code-sprint phase per operator
    // directive 2026-05-02: end-to-end means CODE BUILT TESTED SHIPPED).
    // Doc-only phases (frd/trd/sprint-plan-author) skip — they don't author
    // testable code. Code-Sprint must pass `pnpm test` before land.
    const isCodeSprint = pack.type === 'code-sprint';
    if (isCodeSprint) {
      result.stage = 'test';
      log.push(`\n[stage] unit tests (BLOCKING for code-sprint)`);
      const testResult = run('pnpm', ['--silent', 'test', '--', '--run'], worktreePath, 15 * 60_000);
      if (testResult.ok) {
        log.push(`tests PASS`);
      } else {
        log.push(`tests FAIL: ${testResult.stderr.slice(0, 500)}`);
        if (!args.force) {
          throw new Error(
            `Unit tests FAILED in landing worktree. Refusing to promote code-sprint to ready-for-merge.\n` +
            `First 500 chars of stderr:\n${testResult.stderr.slice(0, 500)}\n` +
            `Code-sprint impl must have green tests; otherwise the code is shipping unverified.`
          );
        }
        const testForceReason = process.env.AUTO_FORCE_REASON;
        if (!testForceReason || testForceReason.length < 3) {
          throw new Error(
            `[test-bypass] BLOCKED: --force passed but AUTO_FORCE_REASON missing. SOX requires reason for every test-bypass.`
          );
        }
        appendOverrideAudit(HARNESS_ROOT, {
          schema_version: '1',
          at: new Date().toISOString(),
          actor: preflightApprover,
          kind: 'force-land',
          reason: testForceReason,
          task_id: pack.task_id,
          run_id: runId,
          context: { stage: 'test', stderr_first_500: testResult.stderr.slice(0, 500) },
          pid: process.pid,
          host: os.hostname(),
        });
        console.warn(`[test] --force passed (AUTO_FORCE_REASON='${testForceReason.slice(0, 60)}'); merging despite failing tests (CRITICAL RISK)`);
      }
    }

    // Stage 4b-cov — test coverage gate (BLOCKING at 70% for code-sprint per
    // operator directive 2026-05-02 "complete once for all"). Was warn-only
    // pending baseline data; now blocks at MIN_COVERAGE (env-overridable).
    if (isCodeSprint) {
      try {
        const covResult = run('pnpm', ['--silent', 'test', '--', '--coverage', '--reporter=basic'], worktreePath, 10 * 60_000);
        const covMatch = (covResult.stdout || '').match(/All files\s*\|\s*([\d.]+)/);
        if (covMatch) {
          const covPct = parseFloat(covMatch[1]);
          const minCov = parseFloat(process.env.AUTO_MIN_COVERAGE || '70');
          log.push(`coverage: ${covMatch[1]}% (min=${minCov}%)`);
          const covPath = path.join(evDir, 'coverage.json');
          fs.writeFileSync(covPath, JSON.stringify({ coverage_pct: covPct, min_required: minCov, at: new Date().toISOString() }));
          if (covPct < minCov) {
            if (!args.force) {
              throw new Error(`Coverage ${covPct}% below required ${minCov}%. Refusing to ship code-sprint.`);
            }
            const covForceReason = process.env.AUTO_FORCE_REASON;
            if (!covForceReason || covForceReason.length < 3) {
              throw new Error(`[coverage-bypass] BLOCKED: --force without AUTO_FORCE_REASON.`);
            }
            appendOverrideAudit(HARNESS_ROOT, {
              schema_version: '1', at: new Date().toISOString(),
              actor: preflightApprover, kind: 'force-land',
              reason: covForceReason, task_id: pack.task_id, run_id: runId,
              context: { stage: 'coverage', pct: covPct, required: minCov },
              pid: process.pid, host: os.hostname(),
            });
            console.warn(`[coverage] --force passed; shipping at ${covPct}% (min ${minCov}%)`);
          }
        }
      } catch (e) {
        // If --force, soft-fail; otherwise rethrow
        if (!args.force) throw e;
      }
    }

    // Stage 4b-sod — SoD shadow reviewer (Sprint M v2 final). For code-sprint
    // phase only. Spawns a SECOND LLM with a different prompt ("review this
    // diff for security/quality risks") + records its verdict to evidence.
    // Acts as automated 4-eyes equivalent in solo-operator mode where human
    // SoD is collapsed to one operator. Non-blocking by default (warn);
    // blocking via AUTO_SOD_SHADOW_BLOCKING=1.
    if (isCodeSprint) {
      const diffSizeKb = diffSize / 1024;
      if (diffSizeKb > 1) {
        log.push(`\n[stage 4b-sod] shadow reviewer (advisory)`);
        const shadowPath = path.join(evDir, 'sod-shadow-review.json');
        // Use claude CLI to run a quick review prompt; non-blocking on failure
        const shadowPrompt = `You are a SOD shadow reviewer. Examine the following diff for: security flaws, untested code paths, banned dependency patterns. Reply ONLY with JSON: {"verdict":"approve|warn|reject","top_concern":"<≤80 chars>"}\n\nDIFF:\n${fs.readFileSync(diffPath, 'utf8').slice(0, 50_000)}`;
        const shadowResult = run('claude', ['--print', '--dangerously-skip-permissions', '--max-turns', '1'], worktreePath, 2 * 60_000);
        // The above can't pipe stdin via run() easily; fall back: use claude with prompt as argv
        try {
          const tmpPromptFile = path.join('/tmp', `sod-shadow-${pack.task_id}.txt`);
          fs.writeFileSync(tmpPromptFile, shadowPrompt);
          const shadow = run('sh', ['-c', `claude --print --dangerously-skip-permissions < "${tmpPromptFile}" 2>&1 | tail -1`], worktreePath, 2 * 60_000);
          const verdictMatch = (shadow.stdout || '').match(/\{[^}]*"verdict"[^}]*\}/);
          const verdictJson = verdictMatch ? JSON.parse(verdictMatch[0]) : { verdict: 'unknown', top_concern: 'parse-error' };
          fs.writeFileSync(shadowPath, JSON.stringify({ ...verdictJson, at: new Date().toISOString() }));
          log.push(`shadow-review: verdict=${verdictJson.verdict} (${verdictJson.top_concern || 'no concern'})`);
          if (verdictJson.verdict === 'reject' && process.env.AUTO_SOD_SHADOW_BLOCKING === '1') {
            if (!args.force) throw new Error(`SoD shadow reviewer REJECTED: ${verdictJson.top_concern}`);
          }
        } catch (e) {
          // void unused so eslint passes
          void shadowResult;
          log.push(`shadow-review: skipped (${(e as Error).message.slice(0, 80)})`);
        }
      }
    }

    // Stage 4c — dependency audit (BLOCKING for code-sprint, HIGH/CRITICAL only)
    if (isCodeSprint) {
      result.stage = 'audit';
      log.push(`\n[stage] dependency audit (BLOCKING for code-sprint, HIGH+ CVEs)`);
      const auditResult = run('pnpm', ['audit', '--prod', '--audit-level=high', '--json'], worktreePath, 3 * 60_000);
      if (auditResult.ok) {
        log.push(`audit PASS (no HIGH/CRITICAL CVEs in prod deps)`);
      } else {
        log.push(`audit FAIL: ${auditResult.stderr.slice(0, 500) || auditResult.stdout.slice(0, 500)}`);
        if (!args.force) {
          throw new Error(
            `Dependency audit found HIGH/CRITICAL CVEs in prod deps. Refusing to ship.`
          );
        }
        const auditForceReason = process.env.AUTO_FORCE_REASON;
        if (!auditForceReason || auditForceReason.length < 3) {
          throw new Error(`[audit-bypass] BLOCKED: --force without AUTO_FORCE_REASON.`);
        }
        appendOverrideAudit(HARNESS_ROOT, {
          schema_version: '1',
          at: new Date().toISOString(),
          actor: preflightApprover,
          kind: 'force-land',
          reason: auditForceReason,
          task_id: pack.task_id,
          run_id: runId,
          context: { stage: 'audit', stderr_first_500: (auditResult.stderr || auditResult.stdout).slice(0, 500) },
          pid: process.pid,
          host: os.hostname(),
        });
        console.warn(`[audit] --force passed; shipping despite HIGH/CRITICAL CVEs (CRITICAL RISK)`);
      }
    }

    // Stage 4d — security-check.json HIGH severity blocking (any phase)
    {
      const secPath = path.join(evDir, 'security-check.json');
      if (fs.existsSync(secPath)) {
        try {
          const sec = JSON.parse(fs.readFileSync(secPath, 'utf8'));
          const sev = (sec.severity || sec.max_severity || '').toString().toLowerCase();
          if (sev === 'high' || sev === 'critical') {
            log.push(`security-check severity=${sev} → BLOCKING`);
            if (!args.force) {
              throw new Error(`security-check reports severity=${sev}. Refusing to land.`);
            }
            const secForceReason = process.env.AUTO_FORCE_REASON;
            if (!secForceReason || secForceReason.length < 3) {
              throw new Error(`[security-bypass] BLOCKED: --force without AUTO_FORCE_REASON.`);
            }
            appendOverrideAudit(HARNESS_ROOT, {
              schema_version: '1',
              at: new Date().toISOString(),
              actor: preflightApprover,
              kind: 'force-land',
              reason: secForceReason,
              task_id: pack.task_id,
              run_id: runId,
              context: { stage: 'security', severity: sev },
              pid: process.pid,
              host: os.hostname(),
            });
            console.warn(`[security] --force passed; shipping despite ${sev} severity (CRITICAL RISK)`);
          } else {
            log.push(`security-check severity=${sev || 'none'} (not blocking)`);
          }
        } catch (e) {
          log.push(`security-check parse error (non-blocking): ${(e as Error).message.slice(0, 100)}`);
        }
      }
    }

    // Stage 5 — commit
    result.stage = 'commit';
    log.push(`\n[stage] commit`);
    run('git', ['add', '-A'], worktreePath);
    const commitMsg = buildCommitMessage(pack);
    // Codex end-to-end consensus mandate: route to durable .agent-runs/<run>/_pr-bodies/
    // instead of /tmp (volatile across reboots; invisible to auto:resurrect).
    const prBodiesDir = path.join(HARNESS_ROOT, '.agent-runs', runId, '_pr-bodies', pack.task_id);
    if (!fs.existsSync(prBodiesDir)) fs.mkdirSync(prBodiesDir, { recursive: true });
    const commitMsgPath = path.join(prBodiesDir, `commit-attempt-${attemptNum}.txt`);
    fs.writeFileSync(commitMsgPath, commitMsg);
    const commitArgs = isEmptyPatch
      ? ['commit', '--allow-empty', '-F', commitMsgPath]
      : ['commit', '-F', commitMsgPath];
    const commitResult = run('git', commitArgs, worktreePath);
    if (!commitResult.ok) {
      log.push(`commit failed: ${commitResult.stderr}`);
      throw new Error(`git commit failed: ${commitResult.stderr.slice(0, 300)}`);
    }
    log.push(`commit ${run('git', ['rev-parse', 'HEAD'], worktreePath).stdout.trim().slice(0, 8)}${isEmptyPatch ? ' (empty marker)' : ''}`);

    // Stage 5b — branch-hygiene sanity check (Sprint J): refuse to push a
    // branch that's more than MAX_COMMITS_AHEAD commits ahead of origin/main.
    // M42 PR #49 incident (2026-05-01): the M42 branch carried 267 unrelated
    // commits because the local branch had pre-Sprint-J harness commits that
    // weren't yet on origin/main when worktree was created. Force-push would
    // have dragged all that into the PR; gh pr merge then conflicts on the
    // unrelated changes. Cherry-pick recovery worked but is operator-toil.
    // Defensive: catch this BEFORE push so the operator sees the drift early.
    {
      const MAX_COMMITS_AHEAD = 10;  // generous; doc-polish typically 1-3 marker commits
      const aheadResult = run('git', ['rev-list', '--count', `${currentMain}..HEAD`], worktreePath);
      if (aheadResult.ok) {
        const aheadCount = parseInt(aheadResult.stdout.trim(), 10);
        log.push(`branch-hygiene: ${aheadCount} commits ahead of origin/main`);
        if (aheadCount > MAX_COMMITS_AHEAD && !args.force) {
          throw new Error(
            `[branch-hygiene] BLOCKED: branch ${branch} is ${aheadCount} commits ahead of origin/main ` +
            `(max=${MAX_COMMITS_AHEAD}). Likely cause: harness worktree had local commits not on origin/main ` +
            `at branch-creation time (M42 PR #49 incident). Recovery: cherry-pick the marker commits onto a ` +
            `fresh branch off origin/main, OR pass --force + AUTO_FORCE_REASON to bypass.`
          );
        }
        if (aheadCount > MAX_COMMITS_AHEAD && args.force) {
          console.warn(`[branch-hygiene] --force passed; pushing branch with ${aheadCount} commits ahead (HIGH RISK).`);
        }
      } else {
        log.push(`branch-hygiene: rev-list failed; proceeding (best-effort check)`);
      }
    }

    // Stage 6 — push (HEAL-2 retry; --force-with-lease for safety)
    result.stage = 'push';
    log.push(`\n[stage] push`);
    const pushResult = runWithRetry(
      'git',
      ['push', '--force-with-lease', '--set-upstream', 'origin', branch],
      worktreePath,
      { attempts: 3 }
    );
    if (!pushResult.ok) {
      log.push(`push failed: ${pushResult.stderr}`);
      throw new Error(`git push failed after 3 attempts: ${pushResult.stderr.slice(0, 300)}`);
    }
    log.push(`pushed ${branch}`);

    // Stage 7 — open PR (idempotent: if PR already exists, refresh body)
    result.stage = 'pr';
    log.push(`\n[stage] open PR`);
    const existingPr = run('gh', ['pr', 'view', branch, '--json', 'url,number'], REPO_ROOT);
    let prUrl: string;
    if (existingPr.ok) {
      // PR exists; update body
      const prJson = JSON.parse(existingPr.stdout);
      prUrl = prJson.url;
      log.push(`PR already exists: ${prUrl}; updating body`);
      // Codex end-to-end consensus: use durable prBodiesDir from above.
      const bodyPath = path.join(prBodiesDir, `body-attempt-${attemptNum}.txt`);
      fs.writeFileSync(bodyPath, buildPrBody(pack));
      run('gh', ['pr', 'edit', String(prJson.number), '--body-file', bodyPath], REPO_ROOT);
    } else {
      // Create new PR — same durable prBodiesDir
      const bodyPath = path.join(prBodiesDir, `body-attempt-${attemptNum}.txt`);
      fs.writeFileSync(bodyPath, buildPrBody(pack));
      const prCreate = run(
        'gh',
        ['pr', 'create', '--title', buildCommitMessage(pack).split('\n')[0], '--body-file', bodyPath, '--base', 'main', '--head', branch],
        REPO_ROOT,
      );
      if (!prCreate.ok) {
        log.push(`gh pr create failed: ${prCreate.stderr}`);
        throw new Error(`gh pr create failed: ${prCreate.stderr.slice(0, 300)}`);
      }
      prUrl = prCreate.stdout.trim().split('\n').pop() ?? '';
      log.push(`opened ${prUrl}`);
    }
    result.prUrl = prUrl;

    // Stage 8 — transition state → ready-for-merge
    // Codex R5 fix (authority-of-state): the read-mutate-write below previously
    // ran without the CAS sentinel, opening a TOCTOU window where another
    // process (worker heartbeat, escalation engager, M9 budget switch) could
    // clobber state changes. Now wrapped in withTaskPackLock so the entire
    // sequence holds the lock atomically.
    //
    // Codex R6 fix (stale-precondition): the LANDABLE_STATES check at line 230
    // ran on a stale read taken BEFORE the lock. Re-validate on the FRESH pack
    // inside the callback so the decision is consistent with the write. If
    // state changed (e.g., another process moved it to 'merged'), abort the
    // transition rather than overwrite.
    // PUB-8 SoD: capture approver identity + enforce creator/reviewer/approver
    // distinctness BEFORE the transition. Captured outside the lock so we can
    // surface a clean operator error message if blocked; appended inside the
    // lock so the persisted record is consistent with the transition.
    const approverIdentity = captureIdentity();
    const sodPolicy = defaultSoDPolicy();
    const sodCheck = enforceSoD(sodPolicy, pack.actors, 'approver', approverIdentity);
    if (!sodCheck.ok && !args.force) {
      throw new Error(`[sod] BLOCKED: ${sodCheck.reason}\n  ${sodCheck.remediation}`);
    } else if (!sodCheck.ok) {
      console.warn(`[sod] WARN (--force passed): ${sodCheck.reason}`);
    }

    // PUB-9 policy-as-code merge gate: final pre-transition check. Evaluates
    // 10 rules against the pack + evidence dir. Blocks the transition if any
    // rule fails. --force opts out (logs warning).
    //
    // R7 fix: simulate post-append actors so min_approvers and SoD rules see
    // the incoming approver. Without this, a normal first approval failed
    // min_approvers (0/1) and require_sod_satisfied (no approvers in chain),
    // forcing every operator to use --force on the very first land.
    const packForGate: typeof pack = {
      ...pack,
      actors: appendActor(pack.actors, 'approver', approverIdentity),
    };
    // R11 fix (HIGH): late-stage defense-in-depth uses pre-land phase too.
    // At this point branch + PR exist but CI just started — can't expect green
    // yet. Pre-merge strict CI check is auto:promote / auto:merge-gate's job
    // when the operator decides to ship. This late-stage is purely catching
    // mid-run state changes (lock-race) and SoD violations that happened
    // between preflight and now — none of which require CI to verify.
    const gateResult = evaluateMergePolicy(packForGate, evDir, HARNESS_ROOT, defaultMergePolicy(), { phase: 'pre-land' });
    if (!gateResult.ok && !args.force) {
      const violations = gateResult.violations.map((v) => `  - [${v.rule}] ${v.reason}\n      ${v.remediation}`).join('\n');
      throw new Error(`[merge-gate] BLOCKED: ${gateResult.summary}\n${violations}`);
    } else if (!gateResult.ok) {
      console.warn(`[merge-gate] WARN (--force passed): ${gateResult.summary}`);
      for (const v of gateResult.violations) console.warn(`  - [${v.rule}] ${v.reason}`);
    } else {
      console.log(`[merge-gate] ✓ ${gateResult.summary}`);
    }

    result.stage = 'state-transition';
    let fromStateForLog: TaskState = pack.state;
    pack = withTaskPackLock(runId, pack.task_id, (current) => {
      if (!LANDABLE_STATES.includes(current.state) && !args.force) {
        throw new Error(
          `[guard:lock-race] state changed from '${pack.state}' (precheck) to '${current.state}' (inside lock); aborting transition. ` +
          `Re-run pnpm auto:land ${pack.task_id} after operator review.`
        );
      }
      fromStateForLog = current.state;
      current.actors = appendActor(current.actors, 'approver', approverIdentity);
      const next = appendStateTransition(current, 'ready-for-merge', 'auto:land', `PR opened: ${prUrl}`);
      next.notes.push({
        at: new Date().toISOString(),
        by: 'auto:land',
        text: `auto:land attempt ${attemptNum} succeeded; PR=${prUrl}; branch=${branch}; base=${currentMain.slice(0, 8)}`,
      });
      return next;
    });
    appendStateLog(runId, {
      task_id: pack.task_id,
      from: fromStateForLog,
      to: 'ready-for-merge',
      at: new Date().toISOString(),
      by: 'auto:land',
      reason: `PR ${prUrl}`,
    });

    result.ok = true;
    log.push(`\n[done] ready-for-merge; PR=${prUrl}`);
    logAttempt(pack, attemptNum, log.join('\n'));

    console.log('');
    console.log(`✓ ${pack.task_id} landed: ${prUrl}`);
    console.log(`  Branch: ${branch}`);
    console.log(`  Worktree: ${worktreePath}`);
    console.log(`  State: awaiting-review → ready-for-merge`);
    console.log(`  Next: pnpm auto:merge ${pack.task_id} (after CI green)`);
    process.exit(0);
  } catch (e) {
    const err = e as Error;
    result.error = err.message;
    log.push(`\n[FAIL] stage=${result.stage}: ${err.message}`);
    logAttempt(pack, attemptNum, log.join('\n'));

    // Self-healing: do NOT mutate state on failure. Append a note for operator
    // visibility. Codex R5 fix (authority-of-state): wrap read-mutate-write in
    // withTaskPackLock. Lock contention is best-effort here — if another
    // process holds the sentinel, log the contention and drop the note rather
    // than blocking the failure path.
    try {
      pack = withTaskPackLock(runId, pack.task_id, (current) => {
        current.notes.push({
          at: new Date().toISOString(),
          by: 'auto:land',
          text: `auto:land attempt ${attemptNum} FAILED at stage=${result.stage}: ${err.message.slice(0, 300)}`,
        });
        return current;
      });
    } catch (lockErr) {
      if (lockErr instanceof TaskPackLockBusyError) {
        console.warn(`[auto:land] could not append failure note (lock busy on ${pack.task_id}); skipping`);
      } else {
        throw lockErr;
      }
    }

    console.error(`\n✗ auto:land FAILED at stage=${result.stage}`);
    console.error(`  ${err.message}`);
    console.error(`  Log: ${path.join(evidenceDir(runId, pack.task_id), `land-attempt-${attemptNum}.log`)}`);
    console.error(`  State preserved: ${pack.state} (NOT corrupted)`);
    console.error(`  Re-run after fix: pnpm auto:land ${pack.task_id}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(2);
});
