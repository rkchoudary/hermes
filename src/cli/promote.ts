#!/usr/bin/env node
/**
 * pnpm auto:promote — promote a Codex-GO task pack to its destination PR.
 *
 * Usage:
 *   pnpm auto:promote <task_id>
 *   pnpm auto:promote <task_id> --human-override --reason "..."
 *   pnpm auto:promote <task_id> --dry-run
 *
 * Promotion semantics (v0.3 — push + comment, NOT auto-merge):
 *   1. Read task pack; verify state === 'promotable' (codex GO)
 *   2. Verify pack.codex.score >= pack.consensus.gate_threshold
 *   3. Determine destination branch from task pack:
 *      - frd-polish/frd-author tasks: docs/frd-mXX-auth (inferred from module_or_sprint)
 *      - audit-log-route: claude/sprint-<sprint> branch (inferred from module_or_sprint)
 *      - code-sprint: claude/<sprint-id> branch
 *      - other: pack.worker.branch_name if set, else error
 *   4. Push the branch to origin (idempotent; will skip if already up-to-date)
 *   5. If a PR exists for that branch, post a verdict comment to it via `gh pr comment`
 *   6. If no PR exists, create one as draft via `gh pr create --draft`
 *   7. Transition state: promotable → ready-for-merge (operator manually merges via GitHub UI;
 *      we land at "ready-for-review" since auto-merge needs human approval per
 *      OPERATOR-RUNBOOK.md "Production deploy / destructive migration / secrets" gates)
 *
 * `--human-override` allows the operator to mark a NO-GO task as merged manually
 * (e.g., "Codex was wrong about X; CRO accepted the risk"). Records reason in state log.
 *
 * NEVER:
 *   - Push to main directly
 *   - Force-push
 *   - Auto-merge without human approval
 *   - Run database migrations (those are operator-applied per docs/OPERATOR-RUNBOOK.md)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// v0.4.16 (Codex CRITICAL closure): use harnessRoot() helper instead of
// 4-up walk so promote works in BOTH vendored (project root above) and
// standalone (package root === harness root) layouts. HARNESS_PROJECT_ROOT
// env var overrides for explicit control.
import { harnessRoot } from '../lib/harnessRoot';
const HARNESS_ROOT = harnessRoot();
import {
  readTaskPack,
  evidenceDir,
  appendStateLog,
  withTaskPackLock,
} from '../lib/runState';
import { appendStateTransition, type TaskState, refuseIfKillSwitchActive } from '../lib/taskPack';
import { captureIdentity, appendActor, enforceSoD, defaultSoDPolicy } from '../lib/sod';
import { evaluateMergePolicy, defaultMergePolicy } from '../lib/mergePolicy';
import { appendOverrideAudit } from '../lib/overrideAudit';
import * as os from 'node:os';

interface PromoteArgs {
  taskId: string;
  humanOverride: boolean;
  reason?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): PromoteArgs {
  let humanOverride = false;
  let reason: string | undefined;
  let dryRun = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--human-override') humanOverride = true;
    else if (arg === '--reason' && i + 1 < argv.length) reason = argv[++i];
    else if (arg === '--dry-run') dryRun = true;
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  if (positional.length < 1) throw new Error('Required: <task_id>');
  return { taskId: positional[0], humanOverride, reason, dryRun };
}

function findRunForTask(taskId: string): string {
  const repoRoot = harnessRoot();
  const runsDir = path.join(repoRoot, '.agent-runs');
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No .agent-runs/ directory at ${runsDir}; nothing to promote.`);
  }
  const runs = fs.readdirSync(runsDir);
  for (const runId of runs) {
    const taskPath = path.join(runsDir, runId, 'tasks', `${taskId}.json`);
    if (fs.existsSync(taskPath)) return runId;
  }
  throw new Error(`Task ${taskId} not found in any run under ${runsDir}.`);
}

function inferDestinationBranch(pack: ReturnType<typeof readTaskPack>): string {
  // 1. Explicit worker.branch_name wins
  if (pack.worker?.branch_name) return pack.worker.branch_name;

  // 2. Infer from module_or_sprint + type
  const target = pack.module_or_sprint;
  if (pack.type === 'frd-polish' || pack.type === 'frd-author' || pack.type === 'frd-reconcile') {
    // Format: M02-v0.8 → docs/frd-m02-auth
    const moduleMatch = target.match(/^(M\d+)/i);
    if (moduleMatch) {
      return `docs/frd-${moduleMatch[1].toLowerCase()}-auth`;
    }
  }
  if (pack.type === 'audit-log-route') {
    // Format: Sprint-AA-2 → claude/sprint-aa-2
    const m = target.match(/^Sprint-([A-Z0-9-]+)$/i);
    if (m) return `claude/sprint-${m[1].toLowerCase()}`;
  }
  if (pack.type === 'code-sprint') {
    // Format: B-7c → claude/b7c-sprint or similar; require explicit pack.worker.branch_name
    throw new Error(
      `code-sprint task ${pack.task_id} has no pack.worker.branch_name; set it explicitly before promoting.`
    );
  }
  if (pack.type === 'next-session-refresh') {
    return 'docs/next-session-refresh';
  }
  if (pack.type === 'platform-doc') {
    return `docs/platform-${target.toLowerCase()}`;
  }

  throw new Error(
    `Cannot infer destination branch for task ${pack.task_id} (type=${pack.type}, module_or_sprint=${target}). Set pack.worker.branch_name explicitly.`
  );
}

function gitCmd(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

function ghCmd(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  return {
    ok: r.status === 0,
    stdout: (r.stdout ?? '').trim(),
    stderr: (r.stderr ?? '').trim(),
  };
}

function pushBranch(branch: string, cwd: string, dryRun: boolean): { ok: boolean; note: string } {
  if (dryRun) return { ok: true, note: `[DRY-RUN] would push ${branch}` };
  // First check if branch exists locally; if not, can't push
  const localCheck = gitCmd(['rev-parse', '--verify', branch], cwd);
  if (!localCheck.ok) {
    return { ok: false, note: `branch ${branch} not found locally (${localCheck.stderr})` };
  }
  // Push (idempotent — git silently no-ops if up-to-date)
  const push = gitCmd(['push', 'origin', branch], cwd);
  if (!push.ok) {
    return { ok: false, note: `git push failed: ${push.stderr}` };
  }
  return { ok: true, note: push.stdout || 'pushed (or already up-to-date)' };
}

function findOrCreatePR(
  branch: string,
  pack: ReturnType<typeof readTaskPack>,
  cwd: string,
  dryRun: boolean
): { ok: boolean; pr_number?: number; pr_url?: string; note: string } {
  // Look for existing PR by head branch
  const list = ghCmd(
    ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url,title', '--limit', '1'],
    cwd
  );
  if (list.ok && list.stdout && list.stdout !== '[]') {
    try {
      const arr = JSON.parse(list.stdout) as Array<{ number: number; url: string; title: string }>;
      if (arr.length > 0) {
        return { ok: true, pr_number: arr[0].number, pr_url: arr[0].url, note: `existing PR #${arr[0].number}` };
      }
    } catch {
      // fall through
    }
  }
  // No PR — create one as draft
  if (dryRun) return { ok: true, note: `[DRY-RUN] would create draft PR for ${branch}` };
  const title = `[auto] ${pack.module_or_sprint} ${pack.version_target} (Codex ${pack.codex?.score ?? '?'} ${pack.codex?.verdict ?? '?'})`;
  const body = `Automated promotion via pnpm auto:promote.

**Task:** ${pack.task_id}
**Type:** ${pack.type}
**Module/Sprint:** ${pack.module_or_sprint}
**Version target:** ${pack.version_target}
**Codex verdict:** ${pack.codex?.verdict ?? '?'} ${pack.codex?.score ?? '?'} (round ${pack.codex?.rounds_executed ?? '?'})

**Acceptance criteria** (from task pack):
${pack.acceptance_criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')}

**Evidence:** \`${pack.evidence_dir}\`

🤖 Generated with [Claude Code](https://claude.com/claude-code) via the autonomous-delivery harness.
`;
  const create = ghCmd(['pr', 'create', '--draft', '--head', branch, '--title', title, '--body', body], cwd);
  if (!create.ok) {
    return { ok: false, note: `gh pr create failed: ${create.stderr}` };
  }
  // gh pr create prints the URL on success
  const m = create.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/);
  if (m) {
    return { ok: true, pr_number: parseInt(m[1], 10), pr_url: m[0], note: `created draft PR #${m[1]}` };
  }
  return { ok: true, note: `created (URL not parsed from: ${create.stdout})` };
}

function commentOnPR(
  prNumber: number,
  pack: ReturnType<typeof readTaskPack>,
  cwd: string,
  dryRun: boolean
): { ok: boolean; note: string } {
  const body = `🤖 **Auto-promote** verdict: **${pack.codex?.verdict ?? '?'} (${pack.codex?.score ?? '?'} / 10)**

- **Task:** \`${pack.task_id}\` (${pack.type})
- **Round:** ${pack.codex?.rounds_executed ?? '?'} of max ${pack.consensus.max_rounds}
- **Gate threshold:** ≥${pack.consensus.gate_threshold}
- **Reviewer:** ${pack.consensus.reviewer}

Codex bundle: \`${pack.codex?.bundle_path ?? '?'}\`
Codex verdict: \`${pack.codex?.verdict_path ?? '?'}\`

This branch is now **ready-for-review**. The harness does NOT auto-merge — operator approval is required to land per docs/OPERATOR-RUNBOOK.md.`;

  if (dryRun) return { ok: true, note: `[DRY-RUN] would comment on PR #${prNumber}` };
  const c = ghCmd(['pr', 'comment', String(prNumber), '--body', body], cwd);
  if (!c.ok) return { ok: false, note: `gh pr comment failed: ${c.stderr}` };
  return { ok: true, note: `commented on PR #${prNumber}` };
}

function markPRReady(prNumber: number, cwd: string, dryRun: boolean): { ok: boolean; note: string } {
  if (dryRun) return { ok: true, note: `[DRY-RUN] would mark PR #${prNumber} ready-for-review` };
  const r = ghCmd(['pr', 'ready', String(prNumber)], cwd);
  if (!r.ok) {
    // Already ready or non-draft — not fatal
    return { ok: true, note: `gh pr ready: ${r.stderr || '(already ready)'}` };
  }
  return { ok: true, note: `PR #${prNumber} marked ready-for-review` };
}

function main() {
  // R9 fix (LOW): kill-switch guard MUST be the literal first action — even
  // before parseArgs. R8 fix had it after parseArgs, which is functionally
  // equivalent for valid invocations but factually inaccurate per the R8
  // commit message claim "first line of main()".
  refuseIfKillSwitchActive(HARNESS_ROOT);

  const args = parseArgs(process.argv.slice(2));
  const runId = findRunForTask(args.taskId);
  const pack = readTaskPack(runId, args.taskId);

  console.log(`Task: ${args.taskId} (run: ${runId})`);
  console.log(`State: ${pack.state}`);
  console.log(`Codex: ${pack.codex?.verdict ?? '?'} (score=${pack.codex?.score ?? '?'})`);
  console.log(`Human override: ${args.humanOverride}`);
  console.log(`Dry run: ${args.dryRun}`);
  console.log('');

  // Validate state
  // R9 fix (HIGH #2): track WHICH checks --human-override bypassed so we
  // can audit each. Previously audit only fired on merge-gate failure.
  const bypassedChecks: string[] = [];
  if (!args.humanOverride) {
    if (pack.state !== 'promotable') {
      console.error(
        `ERROR: Task state is ${pack.state}; expected 'promotable' (Codex GO). Use --human-override --reason "..." to bypass.`
      );
      process.exit(1);
    }
    if (
      pack.codex?.verdict !== 'GO' &&
      pack.codex?.verdict !== 'SIGNOFF-READY'
    ) {
      console.error(
        `ERROR: Codex verdict is ${pack.codex?.verdict ?? 'unknown'}; expected GO or SIGNOFF-READY. Use --human-override --reason "..." to bypass.`
      );
      process.exit(1);
    }
    if (pack.codex?.score !== undefined && pack.codex.score < pack.consensus.gate_threshold) {
      console.error(
        `ERROR: Codex score ${pack.codex.score} < gate threshold ${pack.consensus.gate_threshold}. Use --human-override.`
      );
      process.exit(1);
    }
  } else {
    if (!args.reason) {
      console.error('ERROR: --human-override requires --reason "<rationale>".');
      process.exit(1);
    }
    if (pack.state !== 'promotable') bypassedChecks.push(`state-not-promotable (${pack.state})`);
    if (pack.codex?.verdict !== 'GO' && pack.codex?.verdict !== 'SIGNOFF-READY') {
      bypassedChecks.push(`codex-verdict-not-go (${pack.codex?.verdict ?? 'unset'})`);
    }
    if (pack.codex?.score !== undefined && pack.codex.score < pack.consensus.gate_threshold) {
      bypassedChecks.push(`codex-score-below-threshold (${pack.codex.score} < ${pack.consensus.gate_threshold})`);
    }
    if (bypassedChecks.length > 0) {
      // Each bypass gets its own audit entry.
      const promoteIdentity = captureIdentity();
      for (const check of bypassedChecks) {
        appendOverrideAudit(HARNESS_ROOT, {
          schema_version: '1',
          at: new Date().toISOString(),
          actor: promoteIdentity,
          kind: 'human-override-promote',
          reason: args.reason!,
          task_id: args.taskId,
          run_id: runId,
          context: { bypassed_check: check },
          pid: process.pid,
          host: os.hostname(),
        });
      }
      console.warn(`[human-override] bypassed ${bypassedChecks.length} check(s): ${bypassedChecks.join(', ')}`);
      console.warn(`[audit] ${bypassedChecks.length} override entries recorded at .agent-runs/_override-audit.jsonl`);
    }
  }

  // R7 fix: GOVERNANCE PREFLIGHT — run SoD + PUB-9 merge gate BEFORE any
  // external side effect (gh pr push/comment, mark-PR-ready). Same pattern
  // as auto:land. --human-override opts out (audit trail captured).
  const preflightApprover = captureIdentity();
  const preflightSoD = enforceSoD(defaultSoDPolicy(), pack.actors, 'approver', preflightApprover);
  if (!preflightSoD.ok && !args.humanOverride) {
    console.error(`[sod-preflight] BLOCKED: ${preflightSoD.reason}`);
    console.error(`  remediation: ${preflightSoD.remediation}`);
    console.error(`No PR pushed, no comments posted, no task state mutated.`);
    process.exit(6);
  }
  const preflightHarnessRoot = HARNESS_ROOT;
  const preflightEvDir = evidenceDir(runId, args.taskId);
  const preflightPack: typeof pack = {
    ...pack,
    actors: appendActor(pack.actors, 'approver', preflightApprover),
  };
  const preflightGate = evaluateMergePolicy(preflightPack, preflightEvDir, preflightHarnessRoot, defaultMergePolicy());
  if (!preflightGate.ok && !args.humanOverride) {
    console.error(`[merge-gate-preflight] BLOCKED: ${preflightGate.summary}`);
    for (const v of preflightGate.violations) {
      console.error(`  - [${v.rule}] ${v.reason}`);
      console.error(`      remediation: ${v.remediation}`);
    }
    console.error(`No PR pushed, no comments posted, no task state mutated.`);
    process.exit(7);
  }
  if (preflightGate.ok) {
    console.log(`[governance-preflight] ✓ SoD + PUB-9 gate pass; proceeding to PR ops.`);
  } else {
    // R8+1: --human-override is bypassing failed governance — SOX requires
    // durable audit. args.reason was already required by the earlier check.
    appendOverrideAudit(HARNESS_ROOT, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: preflightApprover,
      kind: 'human-override-promote',
      reason: args.reason ?? '(unstated — should not reach here)',
      task_id: args.taskId,
      run_id: runId,
      context: {
        merge_gate_summary: preflightGate.summary,
        violated_rules: preflightGate.violations.map((v) => v.rule),
      },
      pid: process.pid,
      host: (() => { try { return os.hostname(); } catch { return undefined; } })(),
    });
    console.warn(`[governance-preflight] WARN (--human-override): ${preflightGate.summary}`);
    console.warn(`[audit] override recorded at .agent-runs/_override-audit.jsonl`);
  }

  // Determine destination branch
  let branch: string;
  try {
    branch = inferDestinationBranch(pack);
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`Destination branch: ${branch}`);

  // CWD = current process working directory (operator runs `pnpm auto:promote` from
  // the worktree containing the branch). For daemon mode, the daemon process inherits
  // its own CWD which is presumed to be the orchestration root.
  const cwd = process.cwd();
  console.log(`CWD: ${cwd}`);
  console.log('');

  // 1. Push branch
  console.log(`[1/4] Push branch ${branch} to origin`);
  const push = pushBranch(branch, cwd, args.dryRun);
  console.log(`  ${push.ok ? '✓' : '✗'} ${push.note}`);
  if (!push.ok && !args.dryRun) {
    console.error(`  Aborting promotion due to push failure.`);
    process.exit(1);
  }

  // 2. Find or create PR
  console.log(`[2/4] Find or create PR for ${branch}`);
  const pr = findOrCreatePR(branch, pack, cwd, args.dryRun);
  console.log(`  ${pr.ok ? '✓' : '✗'} ${pr.note}`);
  if (!pr.ok) {
    console.error(`  Aborting promotion due to PR-discovery failure.`);
    process.exit(1);
  }

  // 3. Post verdict comment to the PR
  if (pr.pr_number) {
    console.log(`[3/4] Comment on PR #${pr.pr_number} with verdict`);
    const c = commentOnPR(pr.pr_number, pack, cwd, args.dryRun);
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.note}`);
  } else {
    console.log(`[3/4] No PR number resolved — skip commenting`);
  }

  // 4. Mark PR ready-for-review (was draft; now Codex says GO)
  if (pr.pr_number) {
    console.log(`[4/4] Mark PR #${pr.pr_number} ready-for-review`);
    const r = markPRReady(pr.pr_number, cwd, args.dryRun);
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.note}`);
  }

  // v0.5.0 (Codex roadmap-review fix): transition is now `promotable → ready-for-merge`,
  // NOT `promotable → merged`. The state-machine had `ready-for-merge` since v0.4.1 but
  // promote.ts kept writing 'merged' for backward-compat — Codex's roadmap review flagged
  // this as a non-negotiable semantic ambiguity to fix BEFORE any auto-promote claims:
  // "auto:promote should not further entrench that ambiguity". The harness still does NOT
  // auto-merge to protected branches; `merged` is now reserved for the actual post-merge
  // state (which a future webhook or `auto:land --observe-merge` will write).
  if (!args.dryRun) {
    // PUB-8 SoD: capture approver identity + enforce creator/reviewer/approver
    // distinctness BEFORE the transition.
    const approverIdentity = captureIdentity();
    const sodPolicy = defaultSoDPolicy();
    const sodCheck = enforceSoD(sodPolicy, pack.actors, 'approver', approverIdentity);
    if (!sodCheck.ok && !args.humanOverride) {
      throw new Error(`[sod] BLOCKED: ${sodCheck.reason}\n  ${sodCheck.remediation}`);
    } else if (!sodCheck.ok) {
      console.warn(`[sod] WARN (--human-override passed): ${sodCheck.reason}`);
    }

    // PUB-9 policy-as-code merge gate: final pre-transition check.
    // R7 fix: simulate post-append actors (same fix as land.ts).
    const harnessRoot = HARNESS_ROOT;
    const evDir = evidenceDir(runId, args.taskId);
    const packForGate: typeof pack = {
      ...pack,
      actors: appendActor(pack.actors, 'approver', approverIdentity),
    };
    const gateResult = evaluateMergePolicy(packForGate, evDir, harnessRoot, defaultMergePolicy());
    if (!gateResult.ok && !args.humanOverride) {
      const violations = gateResult.violations.map((v) => `  - [${v.rule}] ${v.reason}\n      ${v.remediation}`).join('\n');
      throw new Error(`[merge-gate] BLOCKED: ${gateResult.summary}\n${violations}`);
    } else if (!gateResult.ok) {
      console.warn(`[merge-gate] WARN (--human-override passed): ${gateResult.summary}`);
      for (const v of gateResult.violations) console.warn(`  - [${v.rule}] ${v.reason}`);
    } else {
      console.log(`[merge-gate] ✓ ${gateResult.summary}`);
    }

    // Codex R5 fix (authority-of-state): the read-mutate-write below ran
    // without the CAS sentinel, opening a TOCTOU race with concurrent
    // mutators. Now wrapped in withTaskPackLock; fromState is captured from
    // inside the lock so the state-log records the actual pre-transition
    // state rather than a hard-coded 'promotable'.
    //
    // Codex R6 fix (stale-precondition): the state==='promotable' check at
    // line 252 ran on a stale read taken BEFORE the lock. Re-validate on the
    // FRESH pack inside the callback so the decision is consistent with the
    // write. If state changed (e.g., another process moved it to 'merged' or
    // 'abandoned'), abort the transition rather than overwrite.
    let reason = '';
    let fromState: TaskState = 'promotable';
    withTaskPackLock(runId, args.taskId, (refreshed) => {
      if (!args.humanOverride && refreshed.state !== 'promotable') {
        throw new Error(
          `[guard:lock-race] state changed from '${pack.state}' (precheck) to '${refreshed.state}' (inside lock); aborting promote. ` +
          `Re-run pnpm auto:promote ${args.taskId} after operator review.`
        );
      }
      fromState = refreshed.state;
      refreshed.actors = appendActor(refreshed.actors, 'approver', approverIdentity);
      reason = args.humanOverride
        ? `human-override promote: ${args.reason}`
        : `Codex ${refreshed.codex?.verdict} ${refreshed.codex?.score} → ${pr.pr_url ?? 'PR'} ready-for-merge`;
      return appendStateTransition(refreshed, 'ready-for-merge', 'orchestrator', reason);
    });
    appendStateLog(runId, {
      task_id: args.taskId,
      from: fromState,
      to: 'ready-for-merge',
      at: new Date().toISOString(),
      by: 'orchestrator',
      reason,
    });
    console.log('');
    console.log(`[transition] ${fromState} → ready-for-merge (operator merges via GitHub UI; harness does NOT auto-merge to protected branches)`);
  }

  console.log('');
  console.log(
    `✓ Promotion complete. Branch ${branch} is pushed${pr.pr_url ? `; PR ${pr.pr_url} is ready-for-review` : ''}.`
  );
  console.log('  Operator action: review + merge per docs/OPERATOR-RUNBOOK.md.');
}

main();
