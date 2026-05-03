#!/usr/bin/env node
/**
 * pnpm auto:work — execute a task pack via a headless worker engine (v0.2).
 *
 * Engines:
 *   - claude-code-cli (DEFAULT) — Mode B-2: invokes `claude --print` headless from the
 *     current worktree; Anthropic Max subscription billing (~$200-600 across the full
 *     large multi-module portfolio). Recommended path for operators with Claude Max.
 *   - claude-agent-sdk          — Mode B-1: @anthropic-ai/sdk tool-use loop; per-token
 *     API billing (~$3-7K across portfolio). Use when no Max subscription.
 *   - codex-cli                 — Mode C: Codex CLI as worker; Codex per-token billing.
 *   - manual                    — writes prompt to /tmp/, waits for a human to do the work.
 *
 * Default engine resolution (highest precedence first):
 *   1. --engine <name> flag
 *   2. AUTO_DAEMON_WORKER_ENGINE env var
 *   3. 'claude-code-cli' (lowest cost)
 *
 * Every invocation is a fresh process with bounded context — no session state accumulates
 * across tasks. Multiple `pnpm auto:work TP-...` invocations run truly in parallel via
 * shell `&` operator (or via `pnpm auto:daemon` orchestration).
 *
 * After the worker terminates, this script:
 *   1. Parses the worker output for a STATUS:{complete,blocked,abandoned} marker
 *   2. Validates that the 5 expected evidence files exist in evidence_dir
 *   3. Transitions task state in-progress → awaiting-review (or → blocked / → abandoned)
 *   4. Writes worker.completed_at + worker output snippet to the task pack
 *
 * Codex consensus (auto:consensus) is a SEPARATE step run after this — see
 * docs/HEADLESS-OPERATION.md Mode B-2 for the full Claude Code CLI worker + Codex CLI
 * consensus pipeline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
import {
  readTaskPack,
  writeTaskPack,
  evidenceDir,
  appendStateLog,
  listEvidence,
  tasksDir as tasksDirAbs,
  withTaskPackLock,
  TaskPackLockBusyError,
  atomicWriteFile,
} from '../lib/runState';
import { harnessRoot } from '../lib/harnessRoot';
import { captureIdentity, appendActor } from '../lib/sod';
import { appendOverrideAudit as appendOverrideAuditFn } from '../lib/overrideAudit';
import {
  registerProcess,
  unregisterProcess,
  defaultMaxDurationSec,
} from '../lib/processWatchdog';
const captureIdentityFn = captureIdentity; // alias for helper readability
import {
  appendStateTransition,
  type TaskState,
  type TaskPack,
  checkReDispatchAllowed,
  checkDependenciesResolved,
  acquireTaskLock,
  releaseTaskLock,
  refuseIfKillSwitchActive,
  detectDependencyCycle,
  checkPathOverlapAgainstInFlight,
} from '../lib/taskPack';
import { readBudget, evaluateBudget } from '../lib/budget';
import { assembleMemoryPrimer, formatPrimerForPrompt } from '../lib/memory';
import { loadSkills, formatSkillsForPrompt, writeSkillEvidence } from '../lib/skillLoader';
// Citation validator is an optional plugin; v0.1 OSS ships without one.
// To enable, drop a module at src/lib/regulatory/validator.ts that exports
// validateCitations(text: string): { findings: { line_no, framework, kind, reason }[] }
// and re-import below. See examples/regulatory-plugin/ for a starter.
type CitationFinding = { line_no: number; framework: string; kind: string; reason: string };
const validateCitations = (_content: string): { findings: CitationFinding[] } => ({ findings: [] });
import { evaluateLlmBudget, formatBudgetEvaluation } from '../lib/llmBudget';
import { readBugReview } from '../lib/diagnostics';
import { requireHarnessDriver, extractOverrideReason } from '../lib/harnessGuard';

// ─── Engine definition ────────────────────────────────────────────────────────

type Engine = 'claude-code-cli' | 'claude-agent-sdk' | 'codex-cli' | 'manual' | 'mock';
const ALL_ENGINES: readonly Engine[] = [
  'claude-code-cli',
  'claude-agent-sdk',
  'codex-cli',
  'manual',
  // v0.5.0 T3 sprint (Codex bx9m0hx0a): scenario-test mock engine. Reports
  // status=complete after writing the prompt. Operator pre-stages evidence
  // files in the evidence dir BEFORE invoking auto:work --engine mock; the
  // dispatcher sees them and the lifecycle continues normally to
  // awaiting-review. Exists ONLY for scenario.smoke.ts; do NOT use for real
  // task dispatch.
  'mock',
] as const;

const DEFAULT_ENGINE: Engine = 'claude-code-cli';

const REQUIRED_EVIDENCE_FILES = [
  'diff.patch',
  'test-summary.md',
  'duplicate-scan.json',
  'risk-register.md',
  'worker-handoff.json',
] as const;

interface WorkArgs {
  taskId: string;
  engine: Engine;
  round: number;
  cwd: string;
  force: boolean;
  /**
   * Sprint J — surgical patch round. When set, the worker reads
   * pack.artifact_acceptance.postflight_summary.failures and produces a
   * focused MUST-FIX-ONLY-THESE-CHECKS instruction in the prompt instead
   * of authoring broadly. The worker MUST NOT add new content, MUST NOT
   * touch sections that already passed post-flight, and MUST NOT introduce
   * new scope. After the patch worker exits, the driver re-runs post-flight
   * once; if it still fails, the module is parked.
   */
  patch?: boolean;
  /**
   * Sprint J — self-healing harness mode. When set, the worker reads
   * pack.evidence_dir/_bug-review.json (written by auto:diagnose) and
   * prepends a "BUGS TO FIX (council review)" instruction with the
   * ordered fix list. Worker applies fixes per the council's diagnosis,
   * then exits. Driver re-runs post-flight + tests; if either still fails,
   * one more diagnose-fix cycle is allowed before park (no-hang invariant).
   */
  fixBugs?: boolean;
  /**
   * Sprint J — operator-supplied rationale to bypass the LLM budget cap.
   * Required when total LLM calls (used + planned) exceed
   * DEFAULT_LLM_BUDGET.hard_cap. Recorded in _override-audit.jsonl.
   */
  budgetOverride?: string;
  /**
   * v0.4.18 plateau-pivot executor (operator directive 2026-04-28: better
   * path when plateau detected). When set, the worker prompt is augmented
   * with an explicit fold-in directive extracted from the latest Codex
   * review, AND a 'plateau-pivot:N' note is appended to pack.notes so the
   * rubric increments to next strategy on subsequent pivots.
   */
  pivotStrategy?: 'apply-foldin-plan' | 'try-different-reviewer' | 'tighten-scope';
  /**
   * v0.7.2 (FR-HARNESS-023 METR autonomy): when set, the worker acquires a
   * persistent lease before dispatch via workerLease.acquireLease, with
   * heartbeat renewal every 30s. Detects pause/resume across session
   * boundaries and reaps stale leases from crashed workers. Co-exists
   * with the existing acquireTaskLock (mutex) for back-compat.
   */
  useLease?: boolean;
  /** Heartbeat interval in seconds (default 30). */
  leaseHeartbeatSec?: number;
  /** Lease TTL in seconds (default 600 = 10min). */
  leaseTtlSec?: number;
}

function parseArgs(argv: string[]): WorkArgs {
  let engine: Engine | undefined;
  let round = 1;
  let cwd = process.cwd();
  let force = false;
  let patch = false;
  let fixBugs = false;
  let budgetOverride: string | undefined;
  let pivotStrategy: WorkArgs['pivotStrategy'] | undefined;
  let useLease = false;
  let leaseHeartbeatSec = 30;
  let leaseTtlSec = 600;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--engine' && i + 1 < argv.length) {
      engine = argv[++i] as Engine;
    } else if (arg === '--round' && i + 1 < argv.length) {
      round = parseInt(argv[++i], 10);
    } else if (arg === '--cwd' && i + 1 < argv.length) {
      cwd = path.resolve(argv[++i]);
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--patch') {
      patch = true;
    } else if (arg === '--fix-bugs') {
      fixBugs = true;
    } else if (arg === '--budget-override' && i + 1 < argv.length) {
      budgetOverride = argv[++i];
    } else if (arg === '--pivot-strategy' && i + 1 < argv.length) {
      pivotStrategy = argv[++i] as WorkArgs['pivotStrategy'];
    } else if (arg.startsWith('--pivot-strategy=')) {
      // Support --key=value form (shells often expand this differently than --key value)
      pivotStrategy = arg.slice('--pivot-strategy='.length) as WorkArgs['pivotStrategy'];
    } else if (arg === '--use-lease') {
      useLease = true;
    } else if (arg === '--lease-heartbeat-sec' && i + 1 < argv.length) {
      leaseHeartbeatSec = parseInt(argv[++i], 10);
    } else if (arg === '--lease-ttl-sec' && i + 1 < argv.length) {
      leaseTtlSec = parseInt(argv[++i], 10);
    } else if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }
  if (positional.length < 1) throw new Error('Required: <task_id>');
  if (!engine) {
    const envEngine = process.env.AUTO_DAEMON_WORKER_ENGINE as Engine | undefined;
    engine = envEngine && ALL_ENGINES.includes(envEngine) ? envEngine : DEFAULT_ENGINE;
  }
  if (!ALL_ENGINES.includes(engine)) {
    throw new Error(
      `Unknown engine: ${engine}. Valid: ${ALL_ENGINES.join(', ')}`
    );
  }
  return { taskId: positional[0], engine, round, cwd, force, patch, fixBugs, budgetOverride, pivotStrategy, useLease, leaseHeartbeatSec, leaseTtlSec };
}

/**
 * v0.4.18: Extract findings section from a Codex review file for fold-in
 * embedding into the worker prompt. Looks for "Findings:" section followed
 * by bullet list; falls back to last-2KB of review if no section found.
 */
function extractFoldinDirective(verdictPath: string): string {
  if (!fs.existsSync(verdictPath)) {
    return '(no prior review found at expected path; worker should focus on closing all open ACs)';
  }
  let body: string;
  try { body = fs.readFileSync(verdictPath, 'utf8'); }
  catch { return '(could not read prior review; proceed best-effort)'; }
  // Try to find a "Findings" section
  const findingsMatch = body.match(/(?:^|\n)(##?\s*Findings?[\s\S]*?)(?:\n##? |\Z|tokens used)/i);
  if (findingsMatch) return findingsMatch[1].slice(0, 8000);
  // Fall back: last 2KB
  return body.slice(-2000);
}

// ─── v0.4.3: Industrial-scale guards ──────────────────────────────────────────

/**
 * G2 (Codex D3 fix) — fetch origin/main and return its current SHA. FAIL CLOSED:
 * if fetch fails, throw rather than silently fall back to HEAD (which would
 * destroy the base-SHA invariant while still recording a value).
 */
function pinBaseSha(cwd: string): string {
  // Greenfield mode (or any repo without an `origin` remote) skips the
  // base-SHA invariant. If there's no remote there's nothing to compare to;
  // we anchor on local HEAD instead. Operator can force-disable via
  // HERMES_SKIP_BASE_SHA=1 if their workflow doesn't use remotes at all.
  if (process.env.HERMES_SKIP_BASE_SHA === '1') {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5_000 });
    return (head.stdout ?? '').trim() || 'noremote';
  }
  const remoteCheck = spawnSync('git', ['remote'], { cwd, encoding: 'utf8', timeout: 5_000 });
  const hasRemote = remoteCheck.status === 0 && (remoteCheck.stdout ?? '').split('\n').filter(Boolean).includes('origin');
  if (!hasRemote) {
    console.warn('[base-sha] no `origin` remote configured — falling back to local HEAD (typical for greenfield repos)');
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 5_000 });
    return (head.stdout ?? '').trim() || 'noremote';
  }
  const fetch = spawnSync('git', ['fetch', 'origin', 'main', '--quiet'], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (fetch.status !== 0) {
    throw new Error(
      `[base-sha] git fetch origin main FAILED (status=${fetch.status}). ` +
      `Refusing dispatch — base-SHA invariant cannot be verified. ` +
      `stderr: ${(fetch.stderr ?? '').slice(0, 300)}. ` +
      `(Set HERMES_SKIP_BASE_SHA=1 to bypass for non-GitHub workflows.)`
    );
  }
  const result = spawnSync('git', ['rev-parse', 'origin/main'], {
    cwd,
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.status !== 0 || !(result.stdout ?? '').trim()) {
    throw new Error(
      `[base-sha] git rev-parse origin/main FAILED after successful fetch. ` +
      `stderr: ${(result.stderr ?? '').slice(0, 300)}`
    );
  }
  return result.stdout.trim();
}

/**
 * G1 — load all task packs in the run for dependency resolution.
 */
function buildPackLookup(runId: string): (taskId: string) => TaskPack | null {
  const cache = new Map<string, TaskPack | null>();
  return (taskId: string): TaskPack | null => {
    if (cache.has(taskId)) return cache.get(taskId) ?? null;
    try {
      const pack = readTaskPack(runId, taskId);
      cache.set(taskId, pack);
      return pack;
    } catch {
      cache.set(taskId, null);
      return null;
    }
  };
}

function findRunForTask(taskId: string): string {
  const repoRoot = harnessRoot();
  const runsDir = path.join(repoRoot, '.agent-runs');
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No .agent-runs/ directory at ${runsDir}; run pnpm auto:plan first.`);
  }
  const runs = fs.readdirSync(runsDir);
  for (const runId of runs) {
    const taskPath = path.join(runsDir, runId, 'tasks', `${taskId}.json`);
    if (fs.existsSync(taskPath)) return runId;
  }
  throw new Error(`Task ${taskId} not found in any run under ${runsDir}.`);
}

// ─── Worker prompt ────────────────────────────────────────────────────────────

/**
 * Sprint J — pre-author reviewer hook.
 *
 * Runs deterministic citation-validate against the primary FRD reference
 * BEFORE the worker writes. Imprecise / specific-invalid findings are
 * surfaced as MUST-FIX constraints in the worker prompt so the worker
 * doesn't re-introduce the same regulatory drift the council was supposed
 * to catch in Round 3.
 *
 * Per the portfolio scan (2026-05-01): 87/88 FRDs had imprecise citations
 * (581 total imprecise + 5 invalid). Top offenders: SR 11-7 → SR 26-2
 * migration (effective 2026-04-17) and CECL ≠ IFRS 9 ECL conflation.
 *
 * For frd-author (greenfield, no FRD yet): nothing to scan, skip.
 * For frd-polish / trd-* / sprint-plan-* / code-sprint: scan the FRD
 * reference and inject findings.
 */
function buildPreAuthorCitationFindings(taskType: string, references: { frd_path?: string; obsidian_paths?: string[] }): string {
  // Greenfield FRD authoring: nothing to validate yet.
  if (taskType === 'frd-author') return '';
  // Try to resolve the FRD reference path
  const tryPath = (p: string | undefined): string | null => {
    if (!p) return null;
    const expanded = p.replace(/^~/, os.homedir());
    // Globs (e.g., FRD-M02-*) — resolve via readdir
    if (expanded.includes('*')) {
      try {
        const dir = path.dirname(expanded.split('*')[0]);
        const prefix = path.basename(expanded.split('*')[0]);
        if (!fs.existsSync(dir)) return null;
        for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
          if (dirent.isDirectory() && dirent.name.startsWith(prefix.replace(/\/$/, ''))) {
            const subdir = path.join(dir, dirent.name);
            const filename = path.basename(expanded).replace('*', '').replace(/^\//, '');
            for (const f of fs.readdirSync(subdir)) {
              if (f.startsWith(filename.split('*')[0]) && f.endsWith('.md')) {
                return path.join(subdir, f);
              }
            }
          }
        }
      } catch { return null; }
      return null;
    }
    return fs.existsSync(expanded) ? expanded : null;
  };
  const frdPath = tryPath(references.frd_path) ?? (references.obsidian_paths ?? []).map(tryPath).find((p): p is string => p !== null);
  if (!frdPath) return '';

  let content: string;
  try { content = fs.readFileSync(frdPath, 'utf8'); }
  catch { return ''; }

  const report = validateCitations(content);
  const blockingFindings = report.findings.filter(
    (f) => f.kind === 'imprecise' || f.kind === 'specific-invalid'
  );
  if (blockingFindings.length === 0) return '';

  // Cap at top 25 findings to keep the worker prompt bounded.
  const top = blockingFindings.slice(0, 25);
  const lines: string[] = [];
  lines.push('');
  lines.push('PRE-AUTHOR REVIEWER FINDINGS — REGULATORY CITATIONS (deterministic, MUST FIX)');
  lines.push(`The reference FRD has ${blockingFindings.length} imprecise/invalid citations the post-flight gate WILL reject. Address each in your output (or document why it cannot be addressed in this round).`);
  lines.push('');
  for (const f of top) {
    lines.push(`  L${f.line_no} [${f.framework}] ${f.kind}: ${f.reason}`);
  }
  if (blockingFindings.length > top.length) {
    lines.push(`  … +${blockingFindings.length - top.length} more (run pnpm auto:citation-validate --file <frd> for full list)`);
  }
  lines.push('');
  lines.push('Common fixes from the portfolio scan:');
  lines.push('  • SR 11-7 → SR 26-2 (effective 2026-04-17; cite SR 26-2 for any decision after that date)');
  lines.push('  • CECL (US GAAP, ASC 326) is NOT the same as IFRS 9 ECL (three-stage SICR); use the correct framework name for the context');
  lines.push('');
  return lines.join('\n');
}

function buildWorkerPrompt(taskId: string, runId: string): string {
  const pack = readTaskPack(runId, taskId);
  // L5 / MEM-5: assemble + prepend memory primer for this dispatch.
  // Closes "workers start cold every dispatch" gap. Per Codex SOTA-bar:
  // long-term memory is OPERATOR-RATIFIED only (no auto-append from
  // rejected diffs to avoid fossilizing reviewer mistakes).
  const harnessRoot = path.resolve(PACKAGE_ROOT, '..', '..');
  // Resolve repoRoot for git log (used in assembleMemoryPrimer for recent merges)
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: harnessRoot, encoding: 'utf8', timeout: 5_000 });
  const repoRoot = topLevel.status === 0 ? topLevel.stdout.trim() : harnessRoot;
  const primer = assembleMemoryPrimer(harnessRoot, repoRoot, pack.module_or_sprint);
  const primerBlock = formatPrimerForPrompt(primer);

  // T2 core (Codex bgxrqvh58): wire pack.required_skills into the worker's
  // system message. Skills are EXECUTABLE POLICY (design-system-aware,
  // wcag-compliant-responsive, etc.); their bodies are prepended ABOVE the
  // task-pack contract so the worker reads them first. We also write
  // skills-loaded.json to evidence so consensus + replay + doctor can see
  // exactly which SKILL.md versions the worker had access to.
  const { loaded: loadedSkills, missing: missingSkills } = loadSkills(pack.required_skills);
  if (loadedSkills.length > 0) {
    const evDir = path.join(harnessRoot, '.agent-runs', runId, pack.evidence_dir);
    try { writeSkillEvidence(evDir, loadedSkills, missingSkills); } catch { /* best-effort */ }
  }
  const skillsBlock = formatSkillsForPrompt(loadedSkills);

  // Sprint J — pre-author citation findings (deterministic, no LLM).
  const preAuthorFindings = buildPreAuthorCitationFindings(pack.type, pack.references);

  // Sprint K v3 — skill memory consumer (Hermes pattern). Read top patterns
  // from prior modules of same phase type; surface as hint to the worker.
  let skillMemoryBlock = '';
  try {
    // Inline lightweight read to avoid top-level-await in non-async function
    const memDir = path.join(harnessRoot, '.agent-runs', '_skill-memory');
    const memFile = path.join(memDir, `${pack.type}.jsonl`);
    if (fs.existsSync(memFile)) {
      const lines = fs.readFileSync(memFile, 'utf8').split('\n').filter(Boolean).slice(-50);
      const total = lines.length;
      let firstTry = 0, patchRec = 0, cogRec = 0;
      for (const ln of lines) {
        try {
          const e = JSON.parse(ln);
          if (e.patch_rounds === 0) firstTry++;
          else if (e.recovered_via === 'cognitive-recovery') cogRec++;
          else if (e.patch_rounds > 0) patchRec++;
        } catch { /* skip */ }
      }
      if (total >= 3) {
        const firstPct = Math.round((firstTry / total) * 100);
        let hint = '';
        if (firstPct >= 60) hint = `Aim for clean single-pass authoring (${firstTry}/${total} prior tasks succeeded first-try).`;
        else if (patchRec >= total / 2) hint = `Common postflight failures: AC token coverage. Ensure all FR/NFR IDs are referenced.`;
        else if (cogRec >= total / 4) hint = `Consider simpler initial draft, expand via patches.`;
        if (hint) {
          skillMemoryBlock = `\nSKILL MEMORY (from ${total} prior ${pack.type} runs)\n${hint}\n  - first-try success: ${firstTry}/${total}\n  - patch-recovered: ${patchRec}/${total}\n  - cognitive-recovered: ${cogRec}/${total}\n`;
        }
      }
    }
  } catch { /* skill memory non-blocking */ }

  return `${primerBlock}
${skillsBlock}
${skillMemoryBlock}

You are a headless worker for the NBF autonomous-delivery harness, executing task ${taskId} (${pack.module_or_sprint}, target version ${pack.version_target}).

OBJECTIVE
${pack.objective}
${preAuthorFindings}
ACCEPTANCE CRITERIA (every item must be addressed)
${pack.acceptance_criteria.map((ac, i) => {
  const entry = typeof ac === 'string' ? { text: ac, bucket: 'deterministic' as const } : { text: ac.text, bucket: ac.bucket ?? 'deterministic' as const };
  const tag = entry.bucket === 'deterministic' ? '' : ` [${entry.bucket}]`;
  return `${i + 1}. ${entry.text}${tag}`;
}).join('\n')}

ALLOWED PATHS (you MUST NOT edit anything outside these globs)
${pack.allowed_paths.map((p) => `- ${p}`).join('\n')}

FORBIDDEN PATHS (NEVER touch — single-writer rule)
${pack.forbidden_paths.map((p) => `- ${p}`).join('\n')}

REFERENCE FILES (read these for context; do NOT modify unless in allowed_paths)
${pack.references.frd_path ? `- FRD: ${pack.references.frd_path}` : ''}
${pack.references.code_paths.map((p) => `- Code: ${p}`).join('\n')}
${pack.references.obsidian_paths.map((p) => `- Obsidian: ${p}`).join('\n')}
${pack.references.prior_codex_output ? `- Prior Codex output: ${pack.references.prior_codex_output}` : ''}

COMMANDS YOU SHOULD RUN
${pack.commands.duplicate_scan ? `Duplicate scan: ${pack.commands.duplicate_scan}` : ''}
${pack.commands.test.length > 0 ? `Tests: ${pack.commands.test.join('; ')}` : ''}
${pack.commands.typecheck ? `Typecheck: ${pack.commands.typecheck}` : ''}
${pack.commands.lint ? `Lint: ${pack.commands.lint}` : ''}

EVIDENCE TO PRODUCE (write to ${pack.evidence_dir}/)
1. diff.patch — STANDARD git-format-patch covering BOTH tracked + untracked changes. **Use exactly this command (NOT \`git diff\` alone — that omits new files):**
   \`\`\`
   git add -A && git diff --cached --binary > ${pack.evidence_dir}/diff.patch && git reset
   \`\`\`
   The \`git add -A\` stages everything (tracked + untracked), \`git diff --cached --binary\` produces a clean format-patch of staged changes (binary-safe so apply works for any new bytes), and \`git reset\` un-stages so your worktree is unchanged. NEVER produce custom "UNTRACKED FILES" sections — the diff must apply with a single \`git apply\` (auto:land verifies this).
2. test-summary.md — compact summary of test results (one line per test file; full log goes to test-full.log)
3. duplicate-scan.json — structured findings from the duplicate scan
4. risk-register.md — security/governance risk notes (table format)
5. worker-handoff.json — final handoff doc with structured summary of what you did
   Shape: { "status": "complete" | "blocked" | "abandoned", "evidence_files": [...], "notes": "..." }

CONTEXT BUDGET
- This worker prompt itself: ${(Buffer.byteLength(JSON.stringify(pack), 'utf8') / 1024).toFixed(2)} KB used (max 8 KB per task pack)
- Your tool-use loop should stay bounded — read targeted file sections, not entire FRDs
- Test outputs go to disk; only summaries go in your reasoning

WHEN YOU ARE DONE
1. Verify all acceptance criteria are met (or explicitly DEFERRED with reason in notes)
2. Write all 5 evidence files (the auto:work harness validates each one exists)
3. Output a final JSON handoff to ${pack.evidence_dir}/worker-handoff.json
4. **ON THE LAST LINE OF YOUR STDOUT, EMIT EXACTLY ONE OF:**
   - \`STATUS:complete\` — work finished, all ACs addressed, ready for Codex consensus
   - \`STATUS:blocked\`  — cannot proceed (unmet dependency, ambiguous AC, missing context)
   - \`STATUS:abandoned\` — work attempted but should not be promoted (e.g., requirements wrong)
   The auto:work harness greps for this exact pattern; if missing it defaults to "blocked".

DO NOT
- Edit anything outside allowed_paths
- Touch NEXT-SESSION.md or ROADMAP.md (single-writer rule)
- Skip the duplicate scan if commands.duplicate_scan is set
- Skip tests if commands.test is non-empty
- Forget the STATUS:{complete,blocked,abandoned} marker on stdout's last line

Begin now.`;
}

// ─── Engine A: Claude Code CLI (Mode B-2 default) ────────────────────────────

interface DispatchResult {
  status: 'complete' | 'blocked' | 'abandoned' | 'error';
  output_path: string;
  exit_code: number | null;
  duration_ms: number;
  error?: string;
}

/**
 * v0.4.21: Pre-dispatch session-limit probe. Sends a tiny "ok?" prompt to
 * `claude --print` first; if Claude Code is rate-limited it fails in <2s
 * with the "You've hit your limit" message. Fail-CLOSED: better to refuse
 * the dispatch than to burn the task-pack lifecycle (in-progress → needs-
 * revision) on a guaranteed-fail run that produces no work.
 */
function probeClaudeCodeLimit(cwd: string): { ok: boolean; reason: string } {
  try {
    const r = spawnSync(
      'claude',
      ['--print', '--dangerously-skip-permissions'],
      {
        cwd,
        input: 'reply with the single word OK',
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    const stdout = String(r.stdout ?? '');
    const stderr = String(r.stderr ?? '');
    if (stdout.toLowerCase().includes("you've hit your limit") || stderr.toLowerCase().includes("you've hit your limit") || stdout.toLowerCase().includes('hit your limit')) {
      const m = (stdout + stderr).match(/resets ([\d:]+(am|pm)? ?\([^)]+\))/i);
      return { ok: false, reason: `Claude Code session limit hit${m ? `; resets ${m[1]}` : ''}` };
    }
    if (r.status !== 0) {
      return { ok: false, reason: `claude --print probe exit=${r.status}: ${stderr.slice(-300)}` };
    }
    return { ok: true, reason: 'probe OK' };
  } catch (e) {
    return { ok: false, reason: `probe failed: ${(e as Error).message}` };
  }
}

async function dispatchClaudeCodeCli(
  prompt: string,
  taskId: string,
  runId: string,
  cwd: string
): Promise<DispatchResult> {
  // v0.4.21: pre-dispatch session-limit guard. Refuses to claim the task
  // pack lock if Claude Code is rate-limited.
  if (process.env.AUTO_WORK_SKIP_LIMIT_PROBE !== 'true') {
    const probe = probeClaudeCodeLimit(cwd);
    if (!probe.ok) {
      return {
        status: 'error',
        output_path: `/tmp/auto-worker-output-${taskId}.txt`,
        exit_code: null,
        duration_ms: 0,
        error: `[pre-dispatch] ${probe.reason} — task pack NOT mutated; safe to retry after limit reset. Set AUTO_WORK_SKIP_LIMIT_PROBE=true to skip.`,
      };
    }
  }
  const promptPath = `/tmp/auto-worker-prompt-${taskId}.txt`;
  const outputPath = `/tmp/auto-worker-output-${taskId}.txt`;
  atomicWriteFile(promptPath, prompt);

  console.log(`[claude-code-cli] dispatching from cwd=${cwd}`);
  console.log(`[claude-code-cli] prompt: ${promptPath} (${(prompt.length / 1024).toFixed(2)} KB)`);
  console.log(`[claude-code-cli] output: ${outputPath}`);

  const start = Date.now();
  // Watchdog (operator directive 2026-04-28): register the wrapper pid so
  // external auto:watchdog has visibility on this in-flight worker. Worker
  // is sync-spawnSync → can't track child pid directly without async refactor;
  // killing the wrapper pid here will SIGTERM Node which propagates exit to
  // the spawned `claude` child as the file descriptor pipe closes. Heartbeat
  // path points at the partial-output file the worker writes to as it streams
  // (mtime updates → liveness signal); stale → reaper kills + escalates.
  const harnessRoot = path.resolve(PACKAGE_ROOT, '..', '..');
  const workerTimeoutSec = parseInt(
    process.env.AUTO_WORKER_TIMEOUT_SEC ?? String(defaultMaxDurationSec('claude-cli-worker')),
    10,
  );
  // Reset heartbeat-file mtime so prior-run residue doesn't trigger a false
  // stale-heartbeat reap (caught on first real dispatch 2026-04-28: file from
  // R2 had a 17min-old mtime; new R3 worker was killed at +70s because the
  // reaper compared the OLD mtime against the live worker's TTL).
  try {
    fs.writeFileSync(outputPath, '');  // truncate + reset mtime atomically
  } catch { /* fall through to register; reaper will use deadline only */ }
  registerProcess(harnessRoot, {
    pid: process.pid,
    kind: 'claude-cli-worker',
    task_id: taskId,
    run_id: runId,
    started_at: new Date(start).toISOString(),
    max_duration_sec: workerTimeoutSec,
    heartbeat_path: outputPath,
    heartbeat_ttl_sec: 30 * 60,  // 30 min without an mtime bump → reap. Claude
    // --print can be silent for many min on big prompts before first token.
    command: `claude --print --dangerously-skip-permissions (cwd=${cwd})`,
    host: os.hostname(),
    restart_policy: 'next-round',
  });
  // v0.4.2 (2026-04-27): pass `--dangerously-skip-permissions` to the headless
  // worker. Without it, the spawned `claude --print` runs in restrictive
  // permission mode (Read denied outside cwd, Write requires per-file grant,
  // Bash mutation blocked) and bails out as STATUS:blocked before doing any
  // real work — verified on M02-impl-1 dispatch 2026-04-27 (TP-2026-04-27-101)
  // which exited with the worker's diagnostic: "I cannot read references,
  // edit any allowed_paths target, run pnpm tests, or write evidence files."
  //
  // The harness owns these workers end-to-end (task pack defines allowed_paths
  // and forbidden_paths; verify-claims gate is the post-hoc safety net), so
  // running the worker under bypass-permissions is the design intent. The
  // alternative (per-spawn .claude/settings.json with allow rules) was
  // considered + rejected as more fragile + slower.
  // v0.5.x — STREAMING WORKER PROGRESS (operator directive: workers must be
  // event-driven + real-time tracked). Was spawnSync (blocking, no progress
  // signal until completion). Now async spawn + stdout parser writes
  // pack.worker.partial_progress at 1Hz so dashboard SSE picks up mid-flight
  // status (file_edits, tool calls, elapsed time). Result shape unchanged.
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  // Use explicit type that won't narrow to `never` after callback assignments.
  const errBox: { value: Error | null } = { value: null };

  // Stream parser state — heuristic over Claude Code CLI output. Common
  // markers: '✻ Thinking', tool-use lines (Read/Edit/Bash/etc.), file paths,
  // STATUS:done/blocked, "I'll …" prefixes.
  let lastWriteAt = 0;
  let editsCount = 0;
  let toolCallsCount = 0;
  let lastTool = '';
  let lastFile = '';
  const THROTTLE_MS = 1000;
  const updateWorkerPartial = (force = false): void => {
    const now = Date.now();
    if (!force && (now - lastWriteAt) < THROTTLE_MS) return;
    lastWriteAt = now;
    try {
      const packPath = path.join(harnessRoot, '.agent-runs', runId, 'tasks', `${taskId}.json`);
      if (!fs.existsSync(packPath)) return;
      const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
      pack.worker = pack.worker ?? {};
      pack.worker.partial_progress = {
        updated_at: new Date(now).toISOString(),
        elapsed_sec: Math.round((now - start) / 1000),
        tool_calls: toolCallsCount,
        edits: editsCount,
        last_tool: lastTool.slice(0, 60),
        last_file: lastFile.slice(0, 120),
        engine: 'claude-code-cli',
      };
      // Codex efficiency review (2026-04-29) #7: compact JSON on hot path.
      // 1Hz partial_progress writes; pretty-print would 3× the write size.
      // Final durable write goes through writeTaskPack (still pretty-printed
      // for diff readability).
      fs.writeFileSync(packPath, JSON.stringify(pack));
    } catch { /* best-effort; final write is the source of truth */ }
  };
  const handleStdoutChunk = (buf: Buffer | string): void => {
    const s = typeof buf === 'string' ? buf : buf.toString('utf8');
    stdout += s;
    process.stdout.write(s);  // mirror to daemon log
    // Heuristic parsers — Claude Code CLI output formats vary
    const lines = s.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const toolMatch = trimmed.match(/^(?:[●⏺]\s+)?(Read|Edit|Write|Bash|Glob|Grep|MultiEdit|NotebookEdit)\b/);
      if (toolMatch) { toolCallsCount++; lastTool = toolMatch[1]; }
      if (/^(?:[●⏺]\s+)?(Edit|Write|MultiEdit)\b/.test(trimmed)) editsCount++;
      const fileMatch = trimmed.match(/(?:apps|domains|platform|packages|gateway|deploy|e2e|src|tests?|docs)\/[\w./-]+\.(?:ts|tsx|js|md|json|yml|yaml|toml|sql|sh)\b/);
      if (fileMatch) lastFile = fileMatch[0];
    }
    updateWorkerPartial();
  };

  // Worktree HEAD guard (Sprint K, 2026-05-02 + Sprint M v2 reinforce):
  // Subagent has --dangerously-skip-permissions and can manipulate git
  // including stash --include-untracked which WIPED Sprint-M files mid-write
  // on 2026-05-02. Guard now captures:
  //   (a) HEAD + branch (catches checkout hijack)
  //   (b) UNTRACKED FILE SET (catches stash/clean wiping new files)
  //   (c) WORKING-TREE-CLEAN status (catches uncommitted file removal)
  // Post-spawn diff → auto-rollback to pre-spawn state.
  const preSpawnHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout?.trim() || '';
  const preSpawnBranch = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).stdout?.trim() || '';
  // Snapshot untracked files (porcelain '??' lines) so we can detect deletions.
  const preSpawnUntracked = (() => {
    const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
    if (r.status !== 0) return new Set<string>();
    return new Set((r.stdout || '').split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3)));
  })();

  // Multi-model routing (Sprint K, 2026-05-02): pick model by pack tier.
  // Code-Sprint + Tier-1 → Opus 4.7 (highest quality)
  // Tier-2 docs → Sonnet 4.6 (50% cheaper, ~30% faster, sufficient for doc work)
  // Tier-3 docs → Haiku 4.5 (5x cheaper, ~50% faster)
  // Override via AUTO_FORCE_MODEL env var.
  //
  // Permission posture (Sprint M v2 final, 2026-05-02): reduce blast radius.
  // Default: --dangerously-skip-permissions (legacy; allows everything).
  // Safer mode (AUTO_WORKER_RESTRICTED=1): explicit --allowed-tools list that
  // EXCLUDES git stash/clean/checkout/reset/branch — the commands that can
  // hijack the harness worktree. Subagent retains Read/Write/Edit/Bash for
  // routine work; can still call pnpm, node, git status/diff/log/add/commit.
  const claudeArgs: string[] = ['--print'];
  if (process.env.AUTO_WORKER_RESTRICTED === '1') {
    // Tools allowed by name (no Bash restriction beyond denials handled below)
    const allowList = [
      'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
      'Glob', 'Grep',
      'Bash(pnpm *)', 'Bash(npm *)', 'Bash(node *)', 'Bash(npx *)', 'Bash(tsx *)',
      'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)', 'Bash(git show*)',
      'Bash(git add*)', 'Bash(git commit*)', 'Bash(git rev-parse*)',
      'Bash(ls*)', 'Bash(cat*)', 'Bash(head*)', 'Bash(tail*)', 'Bash(grep*)', 'Bash(find*)',
      'Bash(mkdir*)', 'Bash(touch*)', 'Bash(echo*)', 'Bash(printf*)',
      'Bash(jq *)', 'Bash(awk *)', 'Bash(sed *)', 'Bash(wc *)', 'Bash(sort*)', 'Bash(uniq*)',
    ];
    claudeArgs.push('--allowed-tools', allowList.join(','));
    console.log(`[claude-code-cli] restricted permissions mode: ${allowList.length} allow patterns; git stash/checkout/clean/reset/branch DENIED`);
  } else {
    claudeArgs.push('--dangerously-skip-permissions');
  }
  const forceModel = process.env.AUTO_FORCE_MODEL;
  let modelChoice = '';
  let routedType = '';
  if (forceModel) {
    modelChoice = forceModel;
  } else {
    try {
      const routePack = readTaskPack(runId, taskId);
      routedType = routePack.type || '';
      // Sprint M v3 (item C): dynamic complexity-based routing (EXARCHON pattern)
      // replaces static tier-based routing. Considers AC count, ref count,
      // reciprocity, prior failure rates from skill memory.
      // Disable via AUTO_DYNAMIC_ROUTING=0 to fall back to static tier routing.
      if (process.env.AUTO_DYNAMIC_ROUTING !== '0') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const { routeForPack } = require('../lib/complexityRouter');
          const routing = routeForPack(routePack);
          modelChoice = routing.model;
          if (routing.reason) {
            console.log(`[claude-code-cli] dynamic-routing: score=${routing.complexity_score} ${routing.reason}`);
          }
        } catch {
          // Fall back to static tier
          const tier = ((routePack as Record<string, unknown>).tier as string ?? 'tier-2').toString().toLowerCase();
          if (routedType === 'code-sprint' || tier === 'tier-1' || tier === '1') {
            modelChoice = process.env.AUTO_CLAUDE_MODEL_TIER1 || '';
          } else if (tier === 'tier-2' || tier === '2') {
            modelChoice = process.env.AUTO_CLAUDE_MODEL_TIER2 || 'claude-sonnet-4-6';
          } else if (tier === 'tier-3' || tier === '3') {
            modelChoice = process.env.AUTO_CLAUDE_MODEL_TIER3 || 'claude-haiku-4-5';
          }
        }
      } else {
        const tier = ((routePack as Record<string, unknown>).tier as string ?? 'tier-2').toString().toLowerCase();
        const isCodeSprintRoute = routedType === 'code-sprint';
        if (isCodeSprintRoute || tier === 'tier-1' || tier === '1') {
          modelChoice = process.env.AUTO_CLAUDE_MODEL_TIER1 || '';
        } else if (tier === 'tier-2' || tier === '2') {
          modelChoice = process.env.AUTO_CLAUDE_MODEL_TIER2 || 'claude-sonnet-4-6';
        } else if (tier === 'tier-3' || tier === '3') {
          modelChoice = process.env.AUTO_CLAUDE_MODEL_TIER3 || 'claude-haiku-4-5';
        }
      }
    } catch { /* pack read failed; fall back to default model */ }
  }
  if (modelChoice) {
    claudeArgs.push('--model', modelChoice);
    console.log(`[claude-code-cli] model=${modelChoice} (tier-routed for type=${routedType})`);
  }

  // E2E fan-out finding 2026-05-02 (M05): SIGTERM to claude's immediate PID
  // doesn't propagate to its tool subprocesses. Result: claude exits but a
  // grandchild holds open the stdout pipe, child.on('exit') still fires (good)
  // but the kill ladder takes longer than expected when the child is itself
  // wedged. Fix: spawn detached so claude becomes its own session/process-group
  // leader, then send signals to the *negative pid* to kill the whole group.
  let timedOut = false;
  await new Promise<void>((resolve) => {
    const child = spawn('claude', claudeArgs, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,  // claude → new session; signal -pid kills whole tree
    });
    const childPid = child.pid;
    const killTree = (sig: NodeJS.Signals): void => {
      if (!childPid) { try { child.kill(sig); } catch { /* gone */ } return; }
      try { process.kill(-childPid, sig); } catch {
        // process group gone; try direct PID as fallback
        try { child.kill(sig); } catch { /* gone */ }
      }
    };
    if (child.stdin) {
      child.stdin.write(prompt);
      child.stdin.end();
    }
    child.stdout?.on('data', handleStdoutChunk);
    child.stderr?.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderr += s;
      process.stderr.write(s);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      console.error(`[claude-code-cli] worker timed out after ${workerTimeoutSec}s — killing process group ${childPid ? '-' + childPid : '(no pid)'}`);
      killTree('SIGTERM');
      setTimeout(() => killTree('SIGKILL'), 10_000);
      errBox.value = new Error(`[timeout-${Math.round(workerTimeoutSec / 60)}m] worker timed out after ${workerTimeoutSec}s (no completion within budget)`);
    }, workerTimeoutSec * 1000);
    child.on('error', (err) => {
      errBox.value = err as Error;
      clearTimeout(timer);
      resolve();
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      exitCode = code;
      updateWorkerPartial(true);  // final flush
      resolve();
    });
  });

  // Persist a structured timeout-evidence file so the operator (and any
  // downstream review/diagnose surface) can distinguish a wall-clock timeout
  // from a crash/SoD-violation/etc. without having to grep the dispatch log.
  if (timedOut) {
    try {
      const evDir = evidenceDir(runId, taskId);
      fs.mkdirSync(evDir, { recursive: true });
      const timeoutPayload = {
        kind: 'worker-timeout',
        engine: 'claude-code-cli',
        task_id: taskId,
        run_id: runId,
        timeout_sec: workerTimeoutSec,
        elapsed_sec: Math.round((Date.now() - start) / 1000),
        timed_out_at: new Date().toISOString(),
        edits_observed: editsCount,
        tool_calls_observed: toolCallsCount,
        last_tool: lastTool,
        last_file: lastFile,
        note: 'Process group SIGTERM/SIGKILL escalation completed. Task transitions to needs-revision; operator may bump AUTO_WORKER_TIMEOUT_SEC and retry.',
      };
      fs.writeFileSync(
        path.join(evDir, 'timeout.json'),
        JSON.stringify(timeoutPayload, null, 2),
      );
    } catch { /* best-effort */ }
  }

  // Worktree HEAD guard — verify branch + HEAD unchanged
  const postSpawnHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout?.trim() || '';
  const postSpawnBranch = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).stdout?.trim() || '';
  if (preSpawnBranch && postSpawnBranch && preSpawnBranch !== postSpawnBranch) {
    console.error(`[worktree-guard] CRITICAL: subagent hijacked branch ${preSpawnBranch} → ${postSpawnBranch} during spawn. Rolling back.`);
    // Stash any subagent changes (safety net)
    try {
      spawnSync('git', ['stash', '--include-untracked', '-m', `worktree-guard-rescue-${Date.now()}`], { cwd });
    } catch { /* best-effort */ }
    spawnSync('git', ['checkout', preSpawnBranch], { cwd });
    if (preSpawnHead) {
      spawnSync('git', ['reset', '--hard', preSpawnHead], { cwd });
    }
    errBox.value = new Error(`subagent hijacked harness worktree branch from ${preSpawnBranch} to ${postSpawnBranch}; auto-rolled-back. Task aborted to prevent state corruption.`);
  } else if (preSpawnHead && postSpawnHead && preSpawnHead !== postSpawnHead && preSpawnBranch === postSpawnBranch) {
    // Same branch but HEAD moved — subagent committed to harness branch (not its own worktree). Roll back.
    console.error(`[worktree-guard] CRITICAL: subagent committed to harness branch (${preSpawnHead.slice(0,8)} → ${postSpawnHead.slice(0,8)}). Rolling back.`);
    spawnSync('git', ['reset', '--hard', preSpawnHead], { cwd });
    errBox.value = new Error(`subagent committed to harness worktree branch; auto-reset to ${preSpawnHead.slice(0,8)}. Task aborted.`);
  } else {
    // Untracked-file deletion guard (Sprint M v2): a subagent that runs
    // `git stash --include-untracked` or `git clean -fdx` will wipe new
    // untracked files (e.g., source files just authored by the operator
    // outside the spawn's prompt). Diff pre-vs-post and pop-the-stash
    // recovery if any untracked files disappeared.
    const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
    if (r.status === 0) {
      const post = new Set<string>(
        (r.stdout || '').split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3))
      );
      const removed: string[] = [];
      for (const f of preSpawnUntracked) if (!post.has(f)) removed.push(f);
      if (removed.length > 0) {
        console.error(`[worktree-guard] CRITICAL: subagent removed ${removed.length} untracked file(s): ${removed.slice(0, 5).join(', ')}${removed.length > 5 ? '…' : ''}`);
        // Try to recover from any rescue stash created by subagent. Look for
        // the most-recent stash on this worktree's branch with our marker
        // prefix, OR any subagent-created stash from this spawn window.
        const stashList = spawnSync('git', ['stash', 'list'], { cwd, encoding: 'utf8' });
        const recent = (stashList.stdout || '').split('\n').slice(0, 3);
        if (recent.length > 0 && recent[0].includes('stash@{0}')) {
          console.error(`[worktree-guard] attempting stash pop to recover untracked files: ${recent[0]}`);
          spawnSync('git', ['stash', 'pop', '--quiet'], { cwd });
        }
        errBox.value = new Error(`subagent removed ${removed.length} untracked file(s); attempted stash-pop recovery. Task aborted to prevent further state loss.`);
      }
    }
  }
  try { unregisterProcess(harnessRoot, process.pid); } catch { /* best-effort */ }
  const duration_ms = Date.now() - start;

  // Persist stdout (and stderr in case of failure)
  fs.writeFileSync(outputPath, stdout + (stderr ? `\n\n--- STDERR ---\n${stderr}` : ''));

  if (errBox.value) {
    console.error(`[claude-code-cli] spawn error: ${errBox.value.message}`);
    return {
      status: 'error',
      output_path: outputPath,
      exit_code: null,
      duration_ms,
      error: errBox.value.message,
    };
  }

  if (exitCode !== 0) {
    console.error(`[claude-code-cli] non-zero exit: ${exitCode}`);
    console.error(`[claude-code-cli] stderr (first 500 chars): ${stderr.slice(0, 500)}`);
  }

  const status = parseStatusMarker(stdout);
  return {
    status,
    output_path: outputPath,
    exit_code: exitCode,
    duration_ms,
  };
}

// ─── Engine B: Claude Agent SDK (Mode B-1) ───────────────────────────────────

async function dispatchClaudeAgentSdk(
  prompt: string,
  taskId: string,
  runId: string,
  cwd: string
): Promise<DispatchResult> {
  // Operator-billing guard (2026-04-28): the operator explicitly requires the
  // build process to use the Claude Code Max subscription (engine=claude-code-cli)
  // and NOT the per-token Anthropic API. This guard refuses to dispatch through
  // the SDK even if ANTHROPIC_API_KEY is present, unless the operator has
  // explicitly opted in via AUTO_ALLOW_API_BILLING=1. This prevents accidental
  // API billing from a stale env var or a misrouted dispatch.
  if (process.env.AUTO_ALLOW_API_BILLING !== '1') {
    return {
      status: 'error',
      output_path: '',
      exit_code: null,
      duration_ms: 0,
      error:
        'engine=claude-agent-sdk would route through the Anthropic API (per-token billing). ' +
        'This harness defaults to engine=claude-code-cli (Claude Code Max subscription, no API cost). ' +
        'To opt in to API billing explicitly: set AUTO_ALLOW_API_BILLING=1 AND ANTHROPIC_API_KEY=sk-… ' +
        'Otherwise re-run with --engine claude-code-cli (or omit --engine to use the default).',
    };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      status: 'error',
      output_path: '',
      exit_code: null,
      duration_ms: 0,
      error: 'ANTHROPIC_API_KEY env var is required for engine=claude-agent-sdk. Either set it, or use engine=claude-code-cli (subscription-billed, no API key needed).',
    };
  }

  let Anthropic: typeof import('@anthropic-ai/sdk').default;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch (e) {
    return {
      status: 'error',
      output_path: '',
      exit_code: null,
      duration_ms: 0,
      error: `@anthropic-ai/sdk is not installed. Run: pnpm install --filter hermes-harness (it is an optionalDependency). Detail: ${(e as Error).message}`,
    };
  }

  const outputPath = `/tmp/auto-worker-output-${taskId}.txt`;
  const client = new Anthropic({ apiKey });
  const start = Date.now();

  const tools = buildSdkToolSurface();
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
    { role: 'user', content: prompt },
  ];

  const MAX_TURNS = 50; // hard cap; cost guard
  let turn = 0;
  let lastTextBlock = '';
  const transcript: string[] = [];

  console.log(`[claude-agent-sdk] dispatching with model=claude-opus-4-7 max_turns=${MAX_TURNS}`);

  // v0.4.20 Codex review HIGH #2 closure: type the SDK call explicitly.
  // The Anthropic SDK's create() returns `Stream | Message`; we want
  // Message (non-streaming). Cast tools through the SDK Tool[] type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type AnthropicMessage = any;  // local alias; SDK type is Message
  while (turn < MAX_TURNS) {
    turn += 1;
    let response: AnthropicMessage;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response = (await (client.messages.create as any)({
        model: 'claude-opus-4-7',
        max_tokens: 8192,
        tools,
        messages,
        system:
          'You are a headless worker for the NBF autonomous-delivery harness. Execute the task pack precisely. Stay within allowed_paths. Write all evidence to evidence_dir. Output a structured handoff JSON when complete and emit STATUS:{complete|blocked|abandoned} as your final stdout line.',
        stream: false,
      }));
    } catch (e) {
      const err = e as Error;
      transcript.push(`[turn ${turn}] API error: ${err.message}`);
      fs.writeFileSync(outputPath, transcript.join('\n'));
      return {
        status: 'error',
        output_path: outputPath,
        exit_code: null,
        duration_ms: Date.now() - start,
        error: `Anthropic API error: ${err.message}`,
      };
    }

    // Capture assistant text + tool-use blocks
    const textBlocks: string[] = [];
    const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const block of (response as any).content as Array<any>) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
        lastTextBlock = block.text;
      } else if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }
    transcript.push(`[turn ${turn}] text: ${textBlocks.join('\n')}`);
    if (toolUses.length > 0) {
      transcript.push(
        `[turn ${turn}] tool_use: ${toolUses.map((t) => t.name).join(', ')}`
      );
    }

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      break;
    }

    if (response.stop_reason !== 'tool_use') {
      transcript.push(`[turn ${turn}] unexpected stop_reason=${response.stop_reason}; halting`);
      break;
    }

    // Append assistant message + tool results
    messages.push({ role: 'assistant', content: response.content });
    const toolResults = toolUses.map((tu) => {
      const out = executeSdkTool(tu.name, tu.input, cwd);
      return {
        type: 'tool_result' as const,
        tool_use_id: tu.id,
        content: out.content,
        is_error: out.isError,
      };
    });
    messages.push({ role: 'user', content: toolResults });
  }

  fs.writeFileSync(outputPath, transcript.join('\n'));

  if (turn >= MAX_TURNS) {
    return {
      status: 'blocked',
      output_path: outputPath,
      exit_code: null,
      duration_ms: Date.now() - start,
      error: `Hit MAX_TURNS=${MAX_TURNS} turn cap without STATUS marker; treating as blocked.`,
    };
  }

  const status = parseStatusMarker(lastTextBlock);
  return {
    status,
    output_path: outputPath,
    exit_code: 0,
    duration_ms: Date.now() - start,
  };
}

// SDK tool surface — minimal but functional
function buildSdkToolSurface(): Array<Record<string, unknown>> {
  return [
    {
      name: 'read_file',
      description:
        'Read a file from the current working directory. Use targeted ranges via grep + offset rather than dumping entire files.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to cwd or absolute.' },
        },
        required: ['path'],
      },
    },
    {
      name: 'edit_file',
      description:
        'Replace exact `old_string` with `new_string` in the file at `path`. The old_string must appear EXACTLY once in the file.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'write_file',
      description:
        'Create a new file or overwrite existing. Prefer edit_file for modifying existing files.',
      input_schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'bash',
      description:
        'Run a shell command. 60-second timeout. Output truncated to 16 KB. Use for tests, git, grep, etc.',
      input_schema: {
        type: 'object',
        properties: {
          command: { type: 'string' },
        },
        required: ['command'],
      },
    },
    {
      name: 'glob',
      description: 'List files matching a glob pattern (uses `find -path`).',
      input_schema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
        },
        required: ['pattern'],
      },
    },
  ];
}

function executeSdkTool(
  name: string,
  input: unknown,
  cwd: string
): { content: string; isError: boolean } {
  try {
    const args = input as Record<string, string>;
    switch (name) {
      case 'read_file': {
        const fp = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);
        const content = fs.readFileSync(fp, 'utf8');
        return {
          content: content.length > 16 * 1024 ? content.slice(0, 16 * 1024) + '\n…[truncated]' : content,
          isError: false,
        };
      }
      case 'edit_file': {
        const fp = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);
        const original = fs.readFileSync(fp, 'utf8');
        const occurrences = original.split(args.old_string).length - 1;
        if (occurrences === 0) return { content: `old_string not found in ${args.path}`, isError: true };
        if (occurrences > 1) return { content: `old_string appears ${occurrences} times in ${args.path}; not unique`, isError: true };
        fs.writeFileSync(fp, original.replace(args.old_string, args.new_string));
        return { content: `Edited ${args.path} (1 replacement).`, isError: false };
      }
      case 'write_file': {
        const fp = path.isAbsolute(args.path) ? args.path : path.join(cwd, args.path);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, args.content);
        return { content: `Wrote ${args.path} (${args.content.length} bytes).`, isError: false };
      }
      case 'bash': {
        const result = spawnSync('bash', ['-lc', args.command], {
          cwd,
          encoding: 'utf8',
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
        });
        const out = (result.stdout || '') + (result.stderr ? `\n--- stderr ---\n${result.stderr}` : '');
        const truncated = out.length > 16 * 1024 ? out.slice(0, 16 * 1024) + '\n…[truncated]' : out;
        return {
          content: `exit=${result.status}\n${truncated}`,
          isError: result.status !== 0,
        };
      }
      case 'glob': {
        const result = spawnSync('bash', ['-lc', `find . -path '${args.pattern}' -type f 2>/dev/null | head -200`], {
          cwd,
          encoding: 'utf8',
          timeout: 30_000,
        });
        return { content: result.stdout || '', isError: false };
      }
      default:
        return { content: `Unknown tool: ${name}`, isError: true };
    }
  } catch (e) {
    return { content: `Tool error: ${(e as Error).message}`, isError: true };
  }
}

// ─── Engine C: Codex CLI ──────────────────────────────────────────────────────

function dispatchCodexCli(
  prompt: string,
  taskId: string,
  runId: string,
  cwd: string
): DispatchResult {
  const promptPath = `/tmp/auto-worker-prompt-${taskId}.txt`;
  const outputPath = `/tmp/auto-worker-output-${taskId}.txt`;
  atomicWriteFile(promptPath, prompt);

  const codexBin =
    process.env.CODEX_BIN ||
    process.env.AUTO_CODEX_BIN || 'codex';
  if (!fs.existsSync(codexBin)) {
    return {
      status: 'error',
      output_path: outputPath,
      exit_code: null,
      duration_ms: 0,
      error: `Codex binary not found at ${codexBin}. Set CODEX_BIN env var or install Codex CLI.`,
    };
  }

  console.log(`[codex-cli] dispatching from cwd=${cwd} via ${codexBin}`);
  const start = Date.now();
  const result = spawnSync(
    codexBin,
    [
      'exec',
      '-m', 'gpt-5.5',
      '-c', 'model_reasoning_effort=xhigh',
      '-s', 'workspace-write',
      '--skip-git-repo-check',
      '--color', 'never',
      '-o', outputPath,
      prompt,
    ],
    { cwd, encoding: 'utf8', timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
  );
  const duration_ms = Date.now() - start;

  const out = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  const status = parseStatusMarker(out);
  return {
    status,
    output_path: outputPath,
    exit_code: result.status,
    duration_ms,
    error: result.error ? result.error.message : undefined,
  };
}

// ─── Engine D: Manual ─────────────────────────────────────────────────────────

function dispatchManual(
  prompt: string,
  taskId: string,
  runId: string,
  cwd: string
): DispatchResult {
  const promptPath = `/tmp/auto-worker-prompt-${taskId}.txt`;
  atomicWriteFile(promptPath, prompt);
  const evDir = evidenceDir(runId, taskId);
  console.log(`
══════════════════════════════════════════════════════════════════════════
MANUAL WORKER DISPATCH (engine=manual)
══════════════════════════════════════════════════════════════════════════

Worker prompt written to: ${promptPath}

A human operator (you, or a Claude Code interactive session) should:
1. cd ${cwd}
2. Read the prompt: cat ${promptPath}
3. Execute the task per the prompt
4. Write evidence files to: ${evDir}/
5. When done, run: pnpm auto:consensus ${taskId}

Bundle size: ${(prompt.length / 1024).toFixed(2)} KB / 8 KB budget

This script will now exit with status=blocked. The task pack remains in-progress;
the operator transitions to awaiting-review by completing the work and re-running
\`pnpm auto:work ${taskId}\` after evidence files exist (the harness will detect
they are present and skip dispatch). Or set the state directly via the operator
runbook procedure.
`);
  return {
    status: 'blocked',
    output_path: promptPath,
    exit_code: null,
    duration_ms: 0,
  };
}

/**
 * v0.5.0 T3 sprint — mock engine for scenario.smoke.ts.
 *
 * Writes the prompt to /tmp (so audit trail is preserved) and reports
 * status=complete. Caller is responsible for pre-staging evidence files in
 * the evidence dir BEFORE invoking auto:work; the post-dispatch evidence
 * validator will see them and continue the lifecycle to awaiting-review.
 *
 * Codex bx9m0hx0a prescription: "mock outputs should use the same evidence
 * file names/schema as real workers; avoid mocking internal functions below
 * the CLI/orchestration boundary." This mock IS at the orchestration
 * boundary (it's an Engine, peer of claude-code-cli + manual + codex-cli).
 */
function dispatchMock(prompt: string, taskId: string, _runId: string): DispatchResult {
  const promptPath = `/tmp/auto-worker-prompt-${taskId}.txt`;
  atomicWriteFile(promptPath, prompt);
  console.log(`[engine=mock] reporting status=complete; evidence files must be pre-staged in evidence dir`);
  return {
    status: 'complete',
    output_path: promptPath,
    exit_code: 0,
    duration_ms: 1,
  };
}

// ─── Post-dispatch: parse + validate + transition ────────────────────────────

function parseStatusMarker(output: string): 'complete' | 'blocked' | 'abandoned' {
  // Look for STATUS:complete | STATUS:blocked | STATUS:abandoned anywhere
  // (last-occurrence wins, matching the prompt's "on the last line" instruction).
  const matches = [...output.matchAll(/^STATUS:(complete|blocked|abandoned)\s*$/gm)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1] as 'complete' | 'blocked' | 'abandoned';
  }
  return 'blocked';
}

function validateEvidence(
  runId: string,
  taskId: string
): { ok: boolean; missing: string[] } {
  const present = new Set(listEvidence(runId, taskId));
  const missing = REQUIRED_EVIDENCE_FILES.filter((f) => !present.has(f));
  return { ok: missing.length === 0, missing };
}

function statusToTaskState(status: DispatchResult['status']): TaskState {
  switch (status) {
    case 'complete':
      return 'awaiting-review';
    case 'blocked':
      return 'needs-revision';
    case 'abandoned':
      return 'abandoned';
    case 'error':
      return 'needs-revision';
  }
}

/**
 * Run pnpm auto:verify-claims as the post-worker pre-Codex gate per Codex Part A #1.
 * Architectural placement: awaiting-review → (verify-claims) → claims-verified → codex-reviewing.
 * If verify-claims finds critical issues, transition back to needs-revision instead of awaiting-review.
 */
function runVerifyClaimsGate(taskId: string): { ok: boolean; criticalCount: number; highCount: number; output: string } {
  console.log(`[verify-claims] running pre-Codex grep-verify gate against task ${taskId}…`);
  const result = spawnSync(
    'pnpm',
    ['--silent', 'auto:verify-claims', '--task', taskId, '--json'],
    {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  // Exit 0 = ok, exit 1 = critical findings, exit 2 = error
  if (result.status === 2 || result.error) {
    console.warn(`[verify-claims] gate errored: ${result.stderr || result.error?.message}`);
    return { ok: false, criticalCount: 0, highCount: 0, output: result.stderr ?? '' };
  }
  let criticalCount = 0;
  let highCount = 0;
  try {
    const jsonMatch = (result.stdout ?? '').match(/\{[\s\S]*"status"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      criticalCount = parsed.critical_count ?? 0;
      highCount = parsed.high_count ?? 0;
    }
  } catch {
    // best-effort parse; if fail, treat as no findings
  }
  return { ok: result.status === 0, criticalCount, highCount, output: result.stdout ?? '' };
}

/**
 * R12 fix: audit any --force bypass that proceeds past a guard refusal in
 * auto:work. Validates AUTO_FORCE_REASON env var (≥3 chars; SOX requires a
 * stated reason for every bypass) and writes a 'force-work' audit entry
 * with guard context. Returns the reason for use in warning messages.
 *
 * Throws (process.exit) if reason missing/empty.
 */
function auditWorkForceBypass(
  harnessRoot: string,
  taskId: string,
  guardName: string,
  guardReason: string
): string {
  const reason = process.env.AUTO_FORCE_REASON;
  if (!reason || reason.length < 3) {
    console.error(
      `[${guardName}-bypass] BLOCKED: --force passed but AUTO_FORCE_REASON missing or empty. ` +
      `SOX requires a stated reason for every guard bypass. Re-run with AUTO_FORCE_REASON="…".`
    );
    process.exit(99);
  }
  appendOverrideAuditFn(harnessRoot, {
    schema_version: '1',
    at: new Date().toISOString(),
    actor: captureIdentityFn(),
    kind: 'force-work',
    reason,
    task_id: taskId,
    context: { guard: guardName, guard_reason: guardReason.slice(0, 200) },
    pid: process.pid,
    host: os.hostname(),
  });
  return reason;
}

/**
 * M5 + M8 integration: run conflict-detect + security-check post-evidence,
 * pre-verify-claims. These are advisory MVPs; their findings are written to
 * evidence dirs but do NOT block dispatch (that comes in Phase 2 hardening).
 * Operator + Codex consensus can use the JSON outputs to decide.
 */
function runPostDispatchMvps(taskId: string): { conflict_severity?: string; security_severity?: string; red_team_catch_rate?: number } {
  const result: { conflict_severity?: string; security_severity?: string; red_team_catch_rate?: number } = {};
  try {
    const conflict = spawnSync('pnpm', ['--silent', 'auto:conflict-detect', taskId, '--apply', '--json'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (conflict.status === 0) {
      try {
        const parsed = JSON.parse(conflict.stdout);
        result.conflict_severity = parsed.severity;
        if (parsed.severity === 'high') {
          console.warn(`[conflict-detect] HIGH severity: ${parsed.recommendations?.[0] ?? '(no detail)'}`);
        } else {
          console.log(`[conflict-detect] severity=${parsed.severity}`);
        }
      } catch { /* best-effort */ }
    } else if (conflict.status !== null) {
      console.warn(`[conflict-detect] non-zero exit ${conflict.status}; non-blocking`);
    }
  } catch (e) {
    console.warn(`[conflict-detect] skipped: ${(e as Error).message}`);
  }
  try {
    const security = spawnSync('pnpm', ['--silent', 'auto:security-check', taskId, '--apply', '--json'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (security.status === 0) {
      try {
        const parsed = JSON.parse(security.stdout);
        result.security_severity = parsed.severity;
        if (parsed.severity === 'high') {
          console.warn(`[security-check] HIGH severity: ${parsed.recommendations?.[0] ?? '(no detail)'}`);
        } else {
          console.log(`[security-check] severity=${parsed.severity}`);
        }
      } catch { /* best-effort */ }
    } else if (security.status !== null) {
      console.warn(`[security-check] non-zero exit ${security.status}; non-blocking`);
    }
  } catch (e) {
    console.warn(`[security-check] skipped: ${(e as Error).message}`);
  }
  // BP6: red-team blue-team-effectiveness meter. Per operator directive
  // 2026-04-28 ("we just need to ensure we do not ship bad code using blue
  // team"), every dispatch records the catch-rate against 8 canonical
  // adversarial perturbations. Catch-rate < 1.0 is a WARN (not block) at
  // Phase 1; Phase 2 will gate dispatch on threshold.
  try {
    const redTeam = spawnSync('pnpm', ['--silent', 'auto:red-team', taskId, '--apply', '--json'], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (redTeam.status === 0) {
      try {
        const parsed = JSON.parse(redTeam.stdout);
        result.red_team_catch_rate = parsed.catch_rate;
        const pct = (parsed.catch_rate * 100).toFixed(0);
        if (parsed.catch_rate < 1.0) {
          console.warn(`[red-team] catch rate ${pct}% (${parsed.total_caught}/${parsed.total_perturbations}); blue-team coverage gap — review evidence/<task>/red-team-report.json`);
        } else {
          console.log(`[red-team] catch rate ${pct}% (blue-team caught all 8 perturbations)`);
        }
      } catch { /* best-effort */ }
    } else if (redTeam.status !== null) {
      console.warn(`[red-team] non-zero exit ${redTeam.status}; non-blocking`);
    }
  } catch (e) {
    console.warn(`[red-team] skipped: ${(e as Error).message}`);
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Sprint J — refuse manual invocation; harness driver is the only entry point.
  requireHarnessDriver({
    cliName: 'auto:work',
    overrideReason: extractOverrideReason(process.argv.slice(2)),
    taskId: args.taskId,
  });

  // ── KILL SWITCH (must be first — refuses ALL dispatch) ───────────────────
  // .agent-runs/_KILL_SWITCH lives in the harness worktree (PACKAGE_ROOT/../..).
  const harnessRoot = path.resolve(PACKAGE_ROOT, '..', '..');
  refuseIfKillSwitchActive(harnessRoot);

  // ── API-BILLING PREFLIGHT (Codex R6 finding #2) ───────────────────────────
  // Refuse `claude-agent-sdk` (per-token API path) BEFORE any task mutation.
  // R5 added the guard inside dispatchClaudeAgentSdk, but auto:work had already
  // claimed the task by then — an accidental SDK selection would mutate state
  // through in-progress → needs-revision even though no $ was spent. Check
  // here, before findRunForTask / readTaskPack / lock acquisition.
  if (args.engine === 'claude-agent-sdk' && process.env.AUTO_ALLOW_API_BILLING !== '1') {
    console.error(
      `[billing-preflight] engine=claude-agent-sdk routes through the Anthropic API ` +
      `(per-token billing). This harness defaults to claude-code-cli (Max subscription).\n` +
      `To opt in: set AUTO_ALLOW_API_BILLING=1 AND ANTHROPIC_API_KEY=sk-….\n` +
      `To use the default Max-sub path: re-run without --engine, or with --engine claude-code-cli.\n` +
      `No task state has been touched.`
    );
    process.exit(7);
  }

  // ── PUB-10: MODEL INVENTORY + CHANGE-CONTROL PREFLIGHT ────────────────────
  // generic-model-governance (Model Risk Management) requires every model touching a banking
  // change to be on the qualified inventory, with audit trail of approval.
  // Refuses dispatch if the resolved engine+model is not qualified for the
  // 'impl-worker' role. Like the API-billing preflight, runs before any task
  // mutation so accidents don't leave stale state behind.
  {
    const { readInventory, isQualified } = await import('../lib/modelInventory');
    const { appendOverrideAudit } = await import('../lib/overrideAudit');
    const { captureIdentity } = await import('../lib/sod');
    const inventory = readInventory(harnessRoot);
    const modelId = (() => {
      switch (args.engine) {
        case 'claude-code-cli': return 'claude-opus-4-7';
        case 'claude-agent-sdk': return process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
        case 'codex-cli': return process.env.CODEX_MODEL || 'gpt-5.5';
        default: return 'unknown';
      }
    })();
    const qual = isQualified(inventory, args.engine, modelId, 'impl-worker');
    if (!qual.ok) {
      console.error(`[model-inventory] BLOCKED: ${qual.reason}`);
      console.error(`No task state has been touched.`);
      console.error(`Inventory file: ${path.join(harnessRoot, '.agent-runs', '_model-inventory.json')}`);
      process.exit(8);
    }
    // R9 fix (HIGH #1): when isQualified returns ok=true via the
    // AUTO_MODEL_INVENTORY_BYPASS path, the caller MUST write a durable
    // audit entry. Previously this was a docstring-only contract; now
    // enforced inline.
    if (qual.reason && qual.reason.startsWith('AUTO_MODEL_INVENTORY_BYPASS=1')) {
      appendOverrideAudit(harnessRoot, {
        schema_version: '1',
        at: new Date().toISOString(),
        actor: captureIdentity(),
        kind: 'model-inventory-bypass',
        reason: process.env.AUTO_MODEL_INVENTORY_BYPASS_REASON ?? '(unstated — should not reach here)',
        task_id: args.taskId,
        context: { engine: args.engine, model_id: modelId, inventory_present: inventory !== null },
        pid: process.pid,
        host: os.hostname(),
      });
      console.warn(`[model-inventory-bypass] override audited at .agent-runs/_override-audit.jsonl`);
    } else if (qual.reason && !inventory) {
      console.warn(`[model-inventory] ${qual.reason}`);
    }
  }

  // ── COST GUARDIAN (M9 / LRA-3): refuse dispatch if budget exhausted ──────
  // Auto-engages the kill switch when daily/weekly/monthly cap hits 90%.
  // Auto-disengages when next budget window rolls over (daily reset at 00:00,
  // etc). Operator's "weeks-long autonomy including running out of tokens"
  // requirement is satisfied by this auto-pause + auto-resume cycle.
  try {
    const budget = readBudget(harnessRoot);
    if (budget) {
      const runsDir = path.join(harnessRoot, '.agent-runs');
      const evaluation = evaluateBudget(budget, runsDir);
      if (evaluation.should_engage_kill_switch) {
        // Auto-engage kill switch with budget reason; this dispatch refuses.
        const killFile = path.join(runsDir, '_KILL_SWITCH');
        if (!fs.existsSync(killFile)) {
          fs.writeFileSync(killFile, `[budget] ${evaluation.worst_window?.reason ?? 'budget threshold reached'} at ${evaluation.evaluated_at}\n`);
          console.warn(`[budget] auto-engaged kill switch: ${evaluation.worst_window?.reason}`);
        }
        console.error(`[budget] BLOCKED: ${evaluation.worst_window?.reason}`);
        console.error(`Budget will auto-release on next window rollover OR run 'pnpm auto:kill-off' explicitly.`);
        process.exit(99);
      } else if (evaluation.should_release_kill_switch) {
        // Operator may have engaged kill switch via budget OR manually. We can
        // only safely auto-release if the file content begins with "[budget]"
        // marker (proving budget engaged it; not operator).
        const killFile = path.join(runsDir, '_KILL_SWITCH');
        if (fs.existsSync(killFile)) {
          try {
            const body = fs.readFileSync(killFile, 'utf8');
            if (body.startsWith('[budget]')) {
              fs.rmSync(killFile);
              console.log(`[budget] auto-released kill switch — utilization back below disengage threshold`);
            }
          } catch { /* best-effort */ }
        }
      }
    }
  } catch (e) {
    console.warn(`[budget] check skipped: ${(e as Error).message}`);
  }

  const runId = findRunForTask(args.taskId);
  const pack = readTaskPack(runId, args.taskId);

  console.log(`Task: ${args.taskId} (run: ${runId})`);
  console.log(`Module: ${pack.module_or_sprint}, target: ${pack.version_target}`);
  console.log(`Engine: ${args.engine}`);
  console.log(`CWD: ${args.cwd}`);
  console.log(`Round: ${args.round}`);
  console.log(`Current state: ${pack.state}`);
  console.log(`Force: ${args.force}`);
  console.log('');

  // Sprint J — LLM budget cap check (Codex council review item 13).
  // Worker dispatches count as 1 LLM call. Refuse dispatch when budget
  // would exceed hard_cap unless --budget-override is supplied with reason.
  const budget = evaluateLlmBudget(pack, 1, args.budgetOverride);
  console.log(formatBudgetEvaluation(budget));
  if (!budget.proceed) {
    console.error(`\nERROR: LLM budget cap exceeded. ${budget.reason}`);
    console.error(`Pass --budget-override "<rationale>" to proceed (logged to _override-audit.jsonl).`);
    process.exit(11);
  }
  if (budget.override_required && args.budgetOverride) {
    // Audit-log the budget override (harnessRoot in this scope is the
    // path string set at line 1331, not the imported function).
    try {
      appendOverrideAuditFn(harnessRoot, {
        schema_version: '1',
        at: new Date().toISOString(),
        actor: captureIdentityFn(),
        kind: 'human-override-promote', // closest enum value; budget overrides use the same audit channel
        reason: `LLM-BUDGET-OVERRIDE: ${args.budgetOverride}`,
        task_id: args.taskId,
        run_id: runId,
        context: {
          mode: budget.mode,
          used: String(budget.used),
          planned: String(budget.planned),
          total: String(budget.total_after_dispatch),
        },
        pid: process.pid,
        host: os.hostname(),
      });
    } catch (e) {
      console.warn(`[llm-budget-audit] failed to record override: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  // ── RBAC + SIEM (Sprint F wire-in) ────────────────────────────────────────
  // Dispatching a worker is a privileged op (consumes LLM API budget,
  // writes to repo, can cascade through workflow). Requires write:task-pack.
  {
    const { getSecurityContext } = await import('../lib/adapters/securityContext');
    const security = getSecurityContext();
    await security.authorize(
      'write:task-pack',
      `task-pack:${args.taskId}`,
      `dispatch-engine-${args.engine}`,
      { task_id: args.taskId, engine: args.engine, module_or_sprint: pack.module_or_sprint, type: pack.type },
    );
  }

  // ── SDLC stage gate (v0.7.1 Deliverable 9 wiring) ─────────────────────────
  // Refuse to dispatch if the module has SDLC state and the task type isn't
  // permitted at the current stage. Modules without SDLC state are exempt
  // (legacy mode for backwards compatibility). Override via --force, audited.
  // Module ID is derived from module_or_sprint (e.g., "M02-impl-1" → "M02";
  // "HARNESS-foo" → "HARNESS"; lowercase normalized to upper).
  {
    const { checkDispatchPermission } = await import('../lib/sdlc');
    const moduleMatch = pack.module_or_sprint.match(/^(M\d+|HARNESS)/i);
    const moduleId = moduleMatch ? moduleMatch[1].toUpperCase() : pack.module_or_sprint;
    const permission = checkDispatchPermission(moduleId, pack.type);
    if (!permission.permitted) {
      console.error(`[guard:sdlc-stage] BLOCKED: ${permission.reason}`);
      if (!args.force) process.exit(9);
      auditWorkForceBypass(harnessRoot, args.taskId, 'guard:sdlc-stage', `bypassed: ${permission.reason}`);
      console.warn(`[guard:sdlc-stage] --force passed (audited); proceeding despite stage mismatch.`);
    } else {
      console.log(`[guard:sdlc-stage] ${permission.reason}`);
    }
  }

  // ── Worker lease (FR-HARNESS-023 METR autonomy, opt-in via --use-lease) ──
  // Acquires a heartbeat-renewable lease tied to this worker's identity.
  // Detects pause/resume across session boundaries and reaps stale leases
  // from crashed workers. Co-exists with acquireTaskLock (mutex below).
  let leaseHolderId: string | null = null;
  let leaseHeartbeatHandle: NodeJS.Timeout | null = null;
  let resumableProgress: Record<string, unknown> | null = null;
  if (args.useLease) {
    const { acquireLease, renewLease, newHolderId } =
      await import('../lib/workerLease');
    leaseHolderId = newHolderId(`auto-work-${args.engine}`);
    const acquireResult = acquireLease({
      task_id: args.taskId,
      run_id: runId,
      holder_id: leaseHolderId,
      ttl_seconds: args.leaseTtlSec,
    });
    if (!acquireResult.acquired) {
      console.error(
        `[lease] BLOCKED: held by ${acquireResult.current_holder} ` +
        `(status=${acquireResult.current_status}, ${acquireResult.current_remaining_seconds}s remaining)`
      );
      console.error(`To force takeover: pause the existing lease first or wait for TTL expiry.`);
      process.exit(10);
    }
    console.log(`[lease] acquired holder=${leaseHolderId} ttl=${args.leaseTtlSec}s`);
    if (acquireResult.resumable_progress &&
        Object.keys(acquireResult.resumable_progress.progress_marker ?? {}).length > 0) {
      resumableProgress = acquireResult.resumable_progress.progress_marker as Record<string, unknown>;
      console.log(
        `[lease] RESUMING from prior progress: completed_steps=` +
        `[${acquireResult.resumable_progress.completed_steps.join(', ')}], ` +
        `current_step=${acquireResult.resumable_progress.current_step ?? '(unset)'}`
      );
    }
    // Heartbeat scheduler — renews every leaseHeartbeatSec to keep TTL fresh
    const heartbeatMs = (args.leaseHeartbeatSec ?? 30) * 1000;
    leaseHeartbeatHandle = setInterval(() => {
      try {
        const r = renewLease({
          task_id: args.taskId,
          run_id: runId,
          holder_id: leaseHolderId!,
        });
        if (!r.ok) {
          console.error(`[lease] heartbeat refused: ${r.reason}`);
          // Don't exit — let the work continue; next heartbeat or completion will surface the issue
        }
      } catch (err) {
        console.error(`[lease] heartbeat error: ${(err as Error).message}`);
      }
    }, heartbeatMs);
    // Ensure clean release on process exit. Default action is PAUSE
    // (preserves resumable_progress) — pause is safe to leave on disk.
    // Operator marks completed explicitly via auto:lease-mgmt --complete
    // after verifying state. SIGINT/SIGTERM also pause so operator can
    // resume seamlessly.
    const { pauseLease, abandonLease } = await import('../lib/workerLease');
    const pauseOnExit = (signal: string) => {
      if (leaseHeartbeatHandle) { clearInterval(leaseHeartbeatHandle); leaseHeartbeatHandle = null; }
      if (!leaseHolderId) return;
      try {
        pauseLease(runId, args.taskId, leaseHolderId, signal);
        console.error(`[lease] paused on ${signal} — resume via auto:work --use-lease same task_id`);
      } catch (err) {
        // Fallback to abandon if pause fails (e.g. holder mismatch from a
        // race with an external --force takeover)
        try { abandonLease(runId, args.taskId, leaseHolderId, signal); } catch { /* swallow */ }
      }
    };
    process.on('exit', () => pauseOnExit('process-exit'));
    process.on('SIGINT', () => { pauseOnExit('SIGINT'); process.exit(130); });
    process.on('SIGTERM', () => { pauseOnExit('SIGTERM'); process.exit(143); });
  }
  if (resumableProgress) {
    // expose via task pack notes so the worker engine can see prior state
    pack.notes = pack.notes ?? [];
    pack.notes.push({
      by: 'lease-resume',
      at: new Date().toISOString(),
      text: `Resuming from prior worker (holder mismatch reap or paused-handoff). ` +
            `Prior progress_marker: ${JSON.stringify(resumableProgress).slice(0, 400)}`,
    });
  }

  // ── G4: re-run guard ──────────────────────────────────────────────────────
  // Refuse to re-dispatch if the task is already in a shipped/queued state.
  // Pass --force to override (you've intentionally chosen to start a new round).
  const reRunCheck = checkReDispatchAllowed(pack, { force: args.force });
  if (!reRunCheck.ok) {
    console.error(`[guard:rerun] BLOCKED: ${reRunCheck.reason}`);
    process.exit(3);
  }

  // ── G1: dependency check ──────────────────────────────────────────────────
  // Refuse to dispatch if any depends_on task is not yet merged/ready-for-merge.
  const lookup = buildPackLookup(runId);
  const depCheck = checkDependenciesResolved(pack, lookup);
  if (!depCheck.ok) {
    console.error(`[guard:deps] BLOCKED — task ${args.taskId} depends on unresolved tasks:`);
    for (const u of depCheck.unresolved) {
      console.error(`  - ${u.task_id}: ${u.reason}`);
    }
    console.error(`Resolve dependencies first (auto:land + auto:merge them), then retry.`);
    if (!args.force) process.exit(4);
    auditWorkForceBypass(harnessRoot, args.taskId, 'guard:deps', `unresolved deps: ${depCheck.unresolved.map((u) => u.task_id).join(', ')}`);
    console.warn(`[guard:deps] --force passed (audited); proceeding despite unresolved dependencies (NOT recommended)`);
  }

  // ── v0.4.21: Pre-dispatch session-limit probe (Claude Code only).
  // Refuses to acquire the task lock if Claude Code is rate-limited.
  // Better to exit cleanly than burn the in-progress → needs-revision
  // task-pack lifecycle on a guaranteed-fail dispatch. Skip via env var.
  if (args.engine === 'claude-code-cli' && process.env.AUTO_WORK_SKIP_LIMIT_PROBE !== 'true') {
    const probe = probeClaudeCodeLimit(args.cwd);
    if (!probe.ok) {
      console.error(`[pre-dispatch] ${probe.reason}`);
      console.error(`[pre-dispatch] Task pack NOT mutated; safe to retry after limit reset.`);
      console.error(`[pre-dispatch] Set AUTO_WORK_SKIP_LIMIT_PROBE=true to bypass (NOT recommended).`);
      process.exit(9);
    }
  }

  // ── G5: single-writer lock ────────────────────────────────────────────────
  const lockHolder = `auto-worker-${args.engine} pid ${process.pid}`;
  const lockResult = acquireTaskLock(pack, lockHolder, process.pid);
  if (!lockResult.ok) {
    console.error(`[guard:lock] BLOCKED: ${lockResult.reason}`);
    if (!args.force) process.exit(5);
    auditWorkForceBypass(harnessRoot, args.taskId, 'guard:lock', `clobbering lock held by: ${lockResult.reason ?? 'unknown'}`);
    console.warn(`[guard:lock] --force passed (audited); clobbering existing lock (verify holder is dead first)`);
    pack.lock = null;
    acquireTaskLock(pack, lockHolder, process.pid);
  }

  // ── Codex C4: cycle + self-dependency check ──────────────────────────────
  const cycleCheck = detectDependencyCycle(pack, lookup);
  if (cycleCheck.hasCycle) {
    console.error(`[guard:cycle] BLOCKED: ${cycleCheck.reason}`);
    console.error(`Fix the dependency DAG in the task packs before re-running.`);
    process.exit(6);
  }

  // ── Operator directive 2026-04-27: path-overlap detection ────────────────
  // "modules do not overlap and agents working on the same files at the same time"
  // Scan all in-flight tasks in this run; refuse if allowed_paths intersect.
  const harnessRootForRun = path.resolve(PACKAGE_ROOT, '..', '..');
  const tasksDir = path.join(harnessRootForRun, '.agent-runs', runId, 'tasks');
  const inFlight: TaskPack[] = [];
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.json')) continue;
      const otherId = f.replace(/\.json$/, '');
      if (otherId === args.taskId) continue;
      try {
        const other = readTaskPack(runId, otherId);
        inFlight.push(other);
      } catch { /* skip unreadable packs */ }
    }
  }
  const overlapCheck = checkPathOverlapAgainstInFlight(pack, inFlight);
  if (!overlapCheck.ok) {
    console.error(`[guard:overlap] BLOCKED — task ${args.taskId} has allowed_paths overlapping with active tasks:`);
    for (const o of overlapCheck.overlaps) {
      console.error(`  - ${o.other_task_id} (state=${o.other_state}):`);
      for (const p of o.overlapping_paths) {
        console.error(`      ours=${p.ours}  theirs=${p.theirs}`);
      }
    }
    // v0.4.7 (gap-roadmap #6): instead of just exiting, ENQUEUE the candidate
    // so it auto-dispatches when blockers reach terminal state. Operator
    // doesn't have to manually re-attempt; tick.ts drain loop unblocks it.
    if (!args.force) {
      try {
        const { enqueue } = await import('../lib/taskQueue');
        const blockerIds = overlapCheck.overlaps.map((o) => o.other_task_id);
        const blockedPaths = overlapCheck.overlaps.flatMap((o) =>
          o.overlapping_paths.map((p) => ({ ours: p.ours, theirs_task: o.other_task_id, theirs_path: p.theirs })),
        );
        enqueue(harnessRoot, {
          task_id: args.taskId,
          run_id: runId,
          blocked_by: blockerIds,
          blocked_paths: blockedPaths,
          reason: `path overlap with ${blockerIds.length} task(s): ${blockerIds.join(', ')}`,
        });
        console.log(`[guard:overlap] enqueued task ${args.taskId} behind ${blockerIds.join(', ')}; auto-drains when blockers reach terminal state.`);
        console.log(`Inspect: cat .agent-runs/_task-queue.json   |   Manual unblock: pnpm auto:queue --dequeue ${args.taskId}`);
        console.log(`Or pass --force to dispatch anyway despite overlap (HIGH RISK).`);
      } catch (e) {
        console.error(`[guard:overlap] enqueue failed: ${(e as Error).message}; falling back to error exit`);
      }
      console.error(`Resolve: wait for the queue to drain, OR adjust allowed_paths to be disjoint, OR --force.`);
      process.exit(7);
    }
    auditWorkForceBypass(harnessRoot, args.taskId, 'guard:overlap', `path overlap with in-flight tasks (HIGH RISK of conflicting diffs)`);
    console.warn(`[guard:overlap] --force passed (audited); proceeding despite path overlap (HIGH RISK of conflicting diffs)`);
  }

  // ── G2: pin base SHA from origin/main (FAIL CLOSED per Codex D3) ────────
  const baseSha = pinBaseSha(args.cwd);
  pack.base_sha = baseSha;
  console.log(`[base-sha] pinned origin/main = ${baseSha.slice(0, 8)}`);

  // ── Skip cwd-clean guard for frd-* tasks ─────────────────────────────────
  // FRD-polish / frd-author / frd-reconcile tasks edit ${process.env.HERMES_DOCS_ROOT ?? "./docs"}/,
  // NOT the repo. The cwd-clean guard exists to prevent the worker's
  // `git add -A && git diff --cached --binary` from leaking unrelated repo
  // changes into diff.patch — but frd-* workers don't generate diff.patch
  // (their evidence is the FRD diff in Obsidian). Skipping the guard for
  // these tasks unblocks the daemon's auto-revise loop when the harness
  // worktree has unrelated dirty files (e.g., orphaned source-code from a
  // prior code-sprint that exited without committing).
  if (pack.type === 'frd-polish' || pack.type === 'frd-author' || pack.type === 'frd-reconcile') {
    console.log(`[cwd-clean] skipped for type=${pack.type} (edits ~/Obsidian/, not repo)`);
  } else {
  // ── Codex D2 R3 (Sprint H1 SERIAL-ONLY scope): cwd-cleanliness guard ──────
  // R2 attempted to allow untracked files; Codex R3 caught that the worker
  // prompt's `git add -A && git diff --cached --binary` STAGES untracked files
  // into diff.patch — so unrelated untracked files DO contaminate.
  // R3 fix: refuse if EITHER (a) tracked files have uncommitted changes OR
  // (b) untracked files exist OUTSIDE the .agent-runs/ tree (which contains
  // evidence dirs the worker is allowed to write to). --force overrides.
  // Codex D2 R4 fix: ls-files emits paths RELATIVE to args.cwd, so a hardcoded
  // 'tools/autonomous-delivery/session-history/' prefix doesn't match when cwd
  // IS that directory (then git emits 'session-history/...'). Resolve absolute
  // paths via repo-toplevel + cwd, then test against repo-root-relative
  // exclusions.
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: args.cwd,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const repoRootAbs = topLevel.status === 0 ? topLevel.stdout.trim() : args.cwd;
  // Codex H1.x fix: filter the dirty-tracked check the same way as untracked.
  // Daemon writes to `.agent-runs/<run>/tasks/*.json` on every state change;
  // `tsbuildinfo` is a build cache. Both are tracked but legitimately mutate
  // between worker dispatches. Without this filter, the daemon retry-loops
  // forever — every tick's state mutation re-trips this guard.
  const trackedExclusions = [
    '.agent-runs/',
    'tools/autonomous-delivery/session-history/',
    'session-history/',
    'tsconfig.tsbuildinfo',
  ];
  const dirtyDiff = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
    cwd: args.cwd,
    encoding: 'utf8',
    timeout: 10_000,
  });
  const dirtyTrackedFiles = (dirtyDiff.stdout ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((line) => {
      const abs = path.isAbsolute(line) ? line : path.resolve(args.cwd, line);
      const rel = path.relative(repoRootAbs, abs);
      // A tracked-file exclusion matches when the path contains the exclusion
      // as a directory component (for "foo/" prefixes) OR as a basename (for
      // bare filenames). Match against ABSOLUTE path so a file like
      // /repo/.claude/worktrees/harness/.agent-runs/x.json is correctly
      // exempted under the '.agent-runs/' exclusion regardless of which
      // worktree the daemon ran from. Without this, the daemon's own pack-
      // file mutations made TP-001 / TP-002 dispatch loop with [guard:cwd-clean]
      // BLOCKED every tick.
      return !trackedExclusions.some((p) => {
        if (p.endsWith('/')) {
          // Directory prefix — match anywhere in the abs path.
          return abs.includes('/' + p) || rel.startsWith(p) || line.startsWith(p);
        }
        // Bare filename — match basename or relative-suffix.
        const basename = path.basename(abs);
        return basename === p || rel === p || rel.endsWith('/' + p) || line === p || line.endsWith('/' + p);
      });
    });
  const dirtyTracked = { status: dirtyTrackedFiles.length > 0 ? 1 : 0 };
  const untrackedResult = spawnSync(
    'git',
    ['ls-files', '--others', '--exclude-standard'],
    { cwd: args.cwd, encoding: 'utf8', timeout: 10_000 }
  );
  // Resolve each emitted line to absolute, then to repo-root-relative.
  const exclusionPrefixes = [
    '.agent-runs/',
    'tools/autonomous-delivery/session-history/',
    // Tolerate session-history at any harness package location:
    'session-history/',
  ];
  const untrackedNoise = (untrackedResult.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => {
      // Compute repo-root-relative path
      const abs = path.isAbsolute(line) ? line : path.resolve(args.cwd, line);
      const rel = path.relative(repoRootAbs, abs);
      return !exclusionPrefixes.some((p) => rel.startsWith(p) || line.startsWith(p));
    });

  const isDirtyTracked = dirtyTracked.status !== 0;
  const isUntrackedNoise = untrackedNoise.length > 0;

  if (isDirtyTracked || isUntrackedNoise) {
    if (!args.force) {
      console.error(`[guard:cwd-clean] BLOCKED: cwd ${args.cwd} is not clean.`);
      if (isDirtyTracked) {
        console.error(`  - Tracked files have uncommitted changes (git diff HEAD non-empty).`);
      }
      if (isUntrackedNoise) {
        console.error(`  - Untracked files outside .agent-runs/ would contaminate diff.patch:`);
        for (const f of untrackedNoise.slice(0, 10)) {
          console.error(`      ${f}`);
        }
        if (untrackedNoise.length > 10) console.error(`      …and ${untrackedNoise.length - 10} more`);
      }
      console.error(`At Sprint H1 (serial-only) scope, worker prompt uses 'git add -A && git diff --cached --binary'`);
      console.error(`which stages BOTH tracked and untracked changes into diff.patch.`);
      console.error(`Either: (a) commit/stash tracked + clean untracked,`);
      console.error(`        (b) cd to a clean worktree,`);
      console.error(`        (c) pass --force (NOT recommended; will pollute diff).`);
      console.error(`Sprint H2 will dispatch in a fresh worktree at base_sha automatically.`);
      process.exit(8);
    }
    auditWorkForceBypass(harnessRoot, args.taskId, 'guard:cwd-clean', `cwd dirty: tracked=${isDirtyTracked}, untracked-noise=${isUntrackedNoise}`);
    console.warn(`[guard:cwd-clean] --force passed (audited); cwd is dirty (will pollute diff)`);
  } else {
    console.log(`[cwd-clean] worker cwd has no uncommitted tracked changes + no untracked noise`);
  }
  }  // end else-branch for non-frd tasks (cwd-clean guard)

  // ── Codex C2 R4 fix: arm crash-recovery BEFORE the CAS claim ─────────────
  // R3 had the crash guard at line ~1003 — AFTER the CAS write + appendStateLog.
  // Codex R4 caught that a throw between CAS-return and the try{} would strand
  // the task as in-progress with no recovery. R4 moves the recoverFromCrash
  // closure UP and wraps the entire post-claim region in try/catch so any
  // throw triggers recovery.
  let crashGuardArmed = false;
  const releaseCrashGuard = () => { crashGuardArmed = false; };
  const recoverFromCrash = (err: Error): void => {
    if (!crashGuardArmed) return;
    try {
      const crashed = readTaskPack(runId, args.taskId);
      releaseTaskLock(crashed);
      crashed.notes.push({
        at: new Date().toISOString(),
        by: `auto-worker-${args.engine}`,
        text: `crash recovery: ${err.message?.slice(0, 300) ?? 'unknown error'}`,
      });
      appendStateTransition(crashed, 'needs-revision', `auto-worker-${args.engine}`, `crash: ${err.message?.slice(0, 100)}`);
      writeTaskPack(crashed);
      console.error(`[crash-recovery] released lock + reset state to needs-revision for ${args.taskId}`);
    } catch (recoveryErr) {
      console.error(`[crash-recovery] recovery itself failed: ${(recoveryErr as Error).message}`);
    }
  };

  // ── Codex C1 R3 fix: CAS-locked claim phase (now inside crash-guard region) ──
  // The first-read pack + advisory in-pack lock had a TOCTOU race: two parallel
  // auto:work invocations could both read lock=null, both "acquire" in memory,
  // and last-writer-wins the file. R3 wires withTaskPackLock — an OS-level
  // CAS via O_EXCL sentinel — so the read-modify-write of state→in-progress
  // is atomic. Inside the lock callback we RE-READ the pack (fresh state)
  // and RE-RUN the rerun-guard + acquireTaskLock (fresh state) so any change
  // since the first read is caught.
  let fromState: TaskState;
  let claimedPack: TaskPack;
  try {
    claimedPack = withTaskPackLock(runId, args.taskId, (freshPack) => {
      // Re-run rerun-guard on FRESH state (state may have changed)
      const reCheckCas = checkReDispatchAllowed(freshPack, { force: args.force });
      if (!reCheckCas.ok) {
        throw new Error(`[guard:rerun-cas] ${reCheckCas.reason}`);
      }
      // Acquire the in-pack advisory lock on FRESH state
      const lockResCas = acquireTaskLock(freshPack, lockHolder, process.pid);
      if (!lockResCas.ok) {
        if (!args.force) {
          throw new Error(`[guard:lock-cas] ${lockResCas.reason}`);
        }
        freshPack.lock = null;
        acquireTaskLock(freshPack, lockHolder, process.pid);
      }
      // Pin base_sha
      freshPack.base_sha = baseSha;
      // Capture pre-transition state for state-log `from` field
      fromState = freshPack.state;
      // PUB-8 SoD: capture creator identity on first claim. Idempotent on
      // re-runs (round 2+ keeps the original creator from round 1). Set inside
      // the lock so it can't race with a concurrent claim.
      if (!freshPack.actors.creator) {
        freshPack.actors = appendActor(freshPack.actors, 'creator', captureIdentity());
      }
      // Transition state to in-progress
      appendStateTransition(
        freshPack,
        'in-progress',
        `auto-worker-${args.engine}`,
        `auto:work invoked (engine=${args.engine}, round=${args.round}, base=${baseSha.slice(0, 8)})`
      );
      // Record actual engine (Codex C5 fix preserved)
      const workerType =
        args.engine === 'manual' ? 'manual' :
        args.engine === 'codex-cli' ? 'codex-cli' :
        args.engine === 'claude-agent-sdk' ? 'claude-agent-sdk' :
        'claude-code-cli';
      // Phase H2 standardization (operator 2026-04-29): preserve branch_name
      // that the daemon's prepareWorkerWorktree set BEFORE this CAS claim.
      // Without this, autoPromote later sees branch_name=null and skips with
      // "Phase H2 design gap" warning, leaving the task stuck in `promotable`
      // forever (TP-303 was the canonical symptom).
      const priorBranch = freshPack.worker?.branch_name ?? undefined;
      freshPack.worker = {
        type: workerType,
        started_at: new Date().toISOString(),
        worktree_path: args.cwd,
        pid: process.pid,
        ...(priorBranch ? { branch_name: priorBranch } : {}),
      };
      // withTaskPackLock writes this back atomically
      return freshPack;
    });
    // Codex C2 R4: arm crash recovery IMMEDIATELY after CAS claim succeeds.
    // From here until releaseCrashGuard() the state machine is "claimed but
    // not yet either dispatched-and-recorded or ready-for-merge"; ANY throw
    // in this window must trigger recovery to avoid stranding in-progress.
    crashGuardArmed = true;
  } catch (e) {
    if (e instanceof TaskPackLockBusyError) {
      console.error(`[guard:cas-lock] BLOCKED: ${e.message}`);
      process.exit(9);
    }
    throw e;
  }

  // Codex C2 R4: wrap from BEFORE appendStateLog through to success exit.
  // If appendStateLog or any subsequent operation throws, recoverFromCrash()
  // releases the lock + records the reason + transitions back to needs-revision.
  try {
    appendStateLog(runId, {
      task_id: args.taskId,
      from: fromState!,                    // captured inside CAS region
      to: 'in-progress',
      at: new Date().toISOString(),
      by: `auto-worker-${args.engine}`,
      reason: `auto:work invoked (round=${args.round})`,
    });

    // R4: this body is already inside the outer try{} that started at the
  // appendStateLog call above (line 1019). The crash guard is armed; any
  // throw here triggers recoverFromCrash() at the outer catch.
    let prompt = buildWorkerPrompt(args.taskId, runId);

    // RAG enrichment — framework-aware doc retrieval (BM25 over indexed
    // official docs, plus curated pattern notes). Plugin lives at
    // plugins/rag/; populate via `pnpm auto:rag-fetch --all`. Disable via
    // env HERMES_RAG_DISABLE=1 if you don't want the prompt enriched.
    if (process.env.HERMES_RAG_DISABLE !== '1') {
      try {
        const ragPath = path.resolve(PACKAGE_ROOT, 'plugins', 'rag', 'src', 'index.ts');
        if (fs.existsSync(ragPath)) {
          const ragUrl = pathToFileURL(ragPath).toString();
          interface RagModule { enrichPromptForPack: (pack: { allowed_paths?: string[]; objective?: string; references?: { code_paths?: string[] }; acceptance_criteria?: Array<unknown> }) => Promise<string>; }
          const rag = await import(ragUrl) as unknown as RagModule;
          const enrichmentPack = readTaskPack(runId, args.taskId);
          const block = await rag.enrichPromptForPack({
            allowed_paths: enrichmentPack.allowed_paths,
            objective: enrichmentPack.objective,
            references: { code_paths: enrichmentPack.references.code_paths },
            acceptance_criteria: enrichmentPack.acceptance_criteria,
          });
          if (block) prompt = block + '\n\n' + prompt;
        }
      } catch (e) {
        // RAG is non-blocking. Log and continue with the un-enriched prompt.
        console.warn(`[rag] enrichment skipped: ${(e as Error).message.slice(0, 200)}`);
      }
    }

    // Sprint J — self-healing harness fix-bugs mode. When invoked via
    // --fix-bugs, prepend the council's BugReview ordered fix list as a
    // "MUST FIX THESE BUGS" instruction. Worker applies fixes per the
    // diagnosis, then exits. Driver re-runs post-flight + tests; if either
    // still fails, one more diagnose-fix cycle is allowed before park.
    if (args.fixBugs) {
      const review = readBugReview(pack.evidence_dir);
      const lines: string[] = [];
      lines.push('');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('FIX-BUGS ROUND — apply council\'s diagnosis, do not freelance');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('');
      if (!review) {
        lines.push('NOTE: --fix-bugs set but no _bug-review.json found in evidence_dir.');
        lines.push('Run pnpm auto:diagnose <task_id> first, then re-fire with --fix-bugs.');
      } else {
        lines.push(`Council diagnosis (${review.failure_classification}, confidence=${review.confidence.toFixed(2)}):`);
        lines.push(`  ${review.diagnosis}`);
        lines.push('');
        lines.push('CONSTRAINTS:');
        lines.push('  • Apply ONLY the fixes listed below — do NOT add new content beyond them');
        lines.push('  • Do NOT touch sections that already passed (out-of-scope edits will be reverted)');
        lines.push('  • Order: highest severity first; if conflict, prefer the higher-severity fix');
        lines.push('');
        if (review.fixes.length === 0) {
          lines.push('NOTE: review emitted no fixes (likely transport-error → retry-same recommended).');
          lines.push('If this is a re-fire after transport recovery, proceed as a normal author pass.');
        } else {
          lines.push(`MUST-FIX BUGS (${review.fixes.length}, severity-ordered):`);
          for (const fx of review.fixes.slice(0, 25)) {
            lines.push(`  [${fx.severity.toUpperCase()}] ${fx.id}: ${fx.action}`);
            lines.push(`    @ ${fx.pointer}`);
            lines.push(`    rationale: ${fx.rationale}`);
          }
          if (review.fixes.length > 25) {
            lines.push(`  … +${review.fixes.length - 25} more (see _bug-review.json)`);
          }
        }
      }
      lines.push('');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('');
      // Inject at the TOP so it dominates over the broader instructions below.
      prompt = lines.join('\n') + prompt;
    }

    // Sprint J — surgical patch round. When invoked via --patch, prepend a
    // "make ONLY these edits" instruction synthesized from the prior post-
    // flight failure list. The driver state machine fires this after the
    // first author pass + post-flight has failed once; if the patch round
    // also fails post-flight, the driver parks the module.
    if (args.patch) {
      const failures = pack.artifact_acceptance?.postflight_summary?.failures ?? [];
      const lines: string[] = [];
      lines.push('');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('SURGICAL PATCH ROUND — make ONLY these edits, nothing else');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('');
      lines.push('The prior author pass produced an artifact that failed post-flight');
      lines.push('lint. This is your ONE patch round. Make targeted edits to address');
      lines.push('each failure below. After you exit, post-flight runs again. If it');
      lines.push('still fails, the module is PARKED for operator review — there is');
      lines.push('NO third round.');
      lines.push('');
      lines.push('CONSTRAINTS:');
      lines.push('  • Touch ONLY the lines/sections referenced in the failures below');
      lines.push('  • Do NOT add new content beyond what the failures require');
      lines.push('  • Do NOT rewrite passing sections (sections marked _ok in the');
      lines.push('    summary already passed and must remain byte-identical except');
      lines.push('    where a failure forces a change)');
      lines.push('  • Do NOT introduce new scope, new ACs, or new dependencies');
      lines.push('');
      if (failures.length === 0) {
        lines.push('NOTE: post-flight summary has no recorded failures (driver bug or');
        lines.push('first patch on a fresh task). Treat this as a normal author pass.');
      } else {
        lines.push(`MUST-FIX FAILURES (${failures.length}):`);
        for (const f of failures.slice(0, 50)) {
          lines.push(`  • ${f.check}: ${f.detail}`);
        }
        if (failures.length > 50) {
          lines.push(`  … +${failures.length - 50} more (see pack.artifact_acceptance.postflight_summary.failures)`);
        }
      }
      lines.push('');
      lines.push('═══════════════════════════════════════════════════════════════');
      lines.push('');
      // Inject at the TOP so it dominates over the broader instructions below.
      prompt = lines.join('\n') + prompt;
    }

    // v0.4.18 plateau-pivot executor: when invoked via --pivot-strategy, augment
    // the worker prompt with an explicit directive synthesized from the prior
    // Codex review, AND record the pivot in pack.notes so the rubric increments
    // to the next strategy on subsequent invocations.
    if (args.pivotStrategy) {
      const verdictPath = pack.codex?.verdict_path;
      if (verdictPath) {
        const findings = extractFoldinDirective(verdictPath);
        let directive = '';
        switch (args.pivotStrategy) {
          case 'apply-foldin-plan':
            directive = [
              '',
              '═══════════════════════════════════════════════════════════════════════',
              'PLATEAU-PIVOT DIRECTIVE — apply-foldin-plan',
              '═══════════════════════════════════════════════════════════════════════',
              '',
              'PRIOR ROUNDS HAVE PLATEAUED below the gate threshold. The Codex',
              'reviewer has been finding the SAME class of issues without scoring',
              'improvement. Read the findings below and address EACH ONE explicitly:',
              'either LAND the fix (preferred) OR mark as DEFERRED with a one-line',
              'reason in your handoff JSON. Do NOT silently leave any finding',
              'untouched — explicit DEFERRED is acceptable, silent ignore is not.',
              '',
              'PRIOR REVIEW FINDINGS (verbatim):',
              findings,
              '',
              '═══════════════════════════════════════════════════════════════════════',
              '',
            ].join('\n');
            break;
          case 'try-different-reviewer':
            directive = [
              '',
              '═══════════════════════════════════════════════════════════════════════',
              'PLATEAU-PIVOT DIRECTIVE — try-different-reviewer (no worker change)',
              '═══════════════════════════════════════════════════════════════════════',
              '',
              'NO WORKER ACTION REQUIRED. The plateau has triggered a reviewer',
              'switch on the next consensus round. Worker should re-emit',
              'evidence with no code changes; auto:consensus will dispatch the',
              'alternative reviewer model.',
              '',
            ].join('\n');
            break;
          case 'tighten-scope':
            directive = [
              '',
              '═══════════════════════════════════════════════════════════════════════',
              'PLATEAU-PIVOT DIRECTIVE — tighten-scope',
              '═══════════════════════════════════════════════════════════════════════',
              '',
              'TASK SCOPE IS LIKELY TOO BROAD. Review your acceptance criteria',
              'and propose 2-3 SMALLER subtasks in your handoff JSON under a',
              '`proposed_subtasks` key. Each subtask should:',
              '  - have ≤3 acceptance criteria',
              '  - touch ≤5 files',
              '  - be reviewable in <10 min',
              'Do NOT attempt to ship the full original task this round.',
              '',
            ].join('\n');
            break;
        }
        prompt = directive + prompt;
      }
      // Record pivot in pack.notes via withTaskPackLock for atomic CAS
      try {
        const { withTaskPackLock } = await import('../lib/runState');
        const priorPivots = (pack.notes ?? [])
          .filter((n) => n.by === 'plateau-pivot')
          .map((n) => { const m = n.text.match(/pivot[_ ]?round[:\s]+(\d+)/i); return m ? parseInt(m[1], 10) : 0; });
        const pivotRound = priorPivots.length > 0 ? Math.max(...priorPivots) + 1 : 1;
        withTaskPackLock(runId, args.taskId, (fresh) => {
          fresh.notes.push({
            at: new Date().toISOString(),
            by: 'plateau-pivot',
            text: `pivot_round: ${pivotRound} strategy=${args.pivotStrategy} (auto:work --pivot-strategy invoked)`,
          });
          return fresh;
        });
        console.log(`[plateau-pivot] recorded pivot_round=${pivotRound} strategy=${args.pivotStrategy} in pack.notes`);
      } catch (e) {
        console.warn(`[plateau-pivot] note append failed: ${(e as Error).message}`);
      }
    }

    // Dispatch
    let dispatch: DispatchResult;
  switch (args.engine) {
    case 'claude-code-cli':
      dispatch = await dispatchClaudeCodeCli(prompt, args.taskId, runId, args.cwd);
      break;
    case 'claude-agent-sdk':
      dispatch = await dispatchClaudeAgentSdk(prompt, args.taskId, runId, args.cwd);
      break;
    case 'codex-cli':
      dispatch = dispatchCodexCli(prompt, args.taskId, runId, args.cwd);
      break;
    case 'manual':
      dispatch = dispatchManual(prompt, args.taskId, runId, args.cwd);
      break;
    case 'mock':
      dispatch = dispatchMock(prompt, args.taskId, runId);
      break;
  }

  console.log('');
  console.log(`[dispatch] status=${dispatch.status} duration=${(dispatch.duration_ms / 1000).toFixed(1)}s exit=${dispatch.exit_code}`);
  if (dispatch.error) console.error(`[dispatch] error: ${dispatch.error}`);
  console.log(`[dispatch] output: ${dispatch.output_path}`);

  // Validate evidence
  const ev = validateEvidence(runId, args.taskId);
  if (!ev.ok) {
    console.warn(`[evidence] missing files: ${ev.missing.join(', ')}`);
    console.warn(`[evidence] expected dir: ${evidenceDir(runId, args.taskId)}`);
  } else {
    console.log(`[evidence] all 5 required files present`);
  }

  // Final state transition based on dispatch status + evidence completeness + verify-claims gate
  const refreshed = readTaskPack(runId, args.taskId);
  let finalState: TaskState = statusToTaskState(dispatch.status);
  // If worker says complete but evidence missing, downgrade to needs-revision
  if (finalState === 'awaiting-review' && !ev.ok) {
    finalState = 'needs-revision';
    console.warn(
      `[transition] worker said STATUS:complete but evidence is incomplete; transitioning to needs-revision instead`
    );
  }

  // M5 + M8 integration (Phase 1): run conflict-detect + security-check
  // BEFORE verify-claims. Advisory only — outputs to evidence dirs but
  // does NOT block. Operator + Codex consensus see the JSON outputs.
  if (finalState === 'awaiting-review') {
    runPostDispatchMvps(args.taskId);
  }

  // v0.4.1 — Codex Part A #1: post-worker pre-Codex verify-claims gate.
  // Only runs when worker completed cleanly (status=complete + evidence ok).
  // If verify-claims finds critical findings, downgrade to needs-revision so the worker iterates
  // BEFORE we burn a Codex round on an FRD with grep-verifiable factual errors.
  if (finalState === 'awaiting-review') {
    const verify = runVerifyClaimsGate(args.taskId);
    console.log(`[verify-claims] critical=${verify.criticalCount} high=${verify.highCount} ok=${verify.ok}`);
    // Codex H6 fix: do NOT silently pass when ok=false (gate execution failed).
    // Previously: criticalCount===0 && ok=false would slip through. Now: any
    // !ok (gate errored or returned non-zero exit) downgrades to needs-revision.
    if (!verify.ok) {
      finalState = 'needs-revision';
      console.warn(
        `[transition] verify-claims gate did not return clean exit (ok=false, critical=${verify.criticalCount}, high=${verify.highCount}); ` +
          `transitioning to needs-revision rather than treating gate-execution failure as PASS. ` +
          `Operator: review evidence/<task_id>/verify-claims.json + gate logs + re-run pnpm auto:work --round N+1.`
      );
    } else if (verify.criticalCount > 0) {
      finalState = 'needs-revision';
      console.warn(
        `[transition] verify-claims found ${verify.criticalCount} critical finding(s); transitioning to needs-revision instead of awaiting-review. ` +
          `Operator: review evidence/<task_id>/verify-claims.json + apply fix-in-place + re-run pnpm auto:work --round N+1.`
      );
    } else {
      console.log(`[verify-claims] PASS (clean exit + zero critical findings) — proceeding to awaiting-review`);
    }
  }

  // v0.5.0 T2 core (Codex tier-plan first-sprint): auto-fire ux-validate when
  // pack.ux_validation.enabled. Runs AFTER verify-claims passes (don't burn
  // Playwright cycles on already-broken worker output). If ux-validate fails
  // (any deterministic gate trips), state stays in awaiting-review but the
  // ux-verdict.json records the failure so evaluateAutoPromote() refuses to
  // promote. Operator decides whether to override + revise.
  if (finalState === 'awaiting-review' && pack.ux_validation.enabled) {
    console.log(`[ux-validate] auto-firing post-worker because pack.ux_validation.enabled=true`);
    const r = spawnSync(
      'pnpm',
      ['--silent', '--dir', PACKAGE_ROOT, 'auto:ux-validate', args.taskId, '--apply'],
      { cwd: PACKAGE_ROOT, encoding: 'utf8', stdio: 'inherit', timeout: 10 * 60 * 1000 },
    );
    if (r.status === 0) {
      console.log(`[ux-validate] auto-fire PASS — verdict written to evidence/<TP>/ux/ux-verdict.json`);
    } else {
      console.warn(`[ux-validate] auto-fire FAIL (exit ${r.status}) — verdict still written; auto-promote will refuse until resolved`);
      // Do NOT downgrade state. The ux-validation result is OBSERVABLE through
      // evaluateAutoPromote(); leave the operator + rubric to decide next action.
    }
  }

  const finalPack = appendStateTransition(
    refreshed,
    finalState,
    `auto-worker-${args.engine}`,
    `dispatch=${dispatch.status} evidence_ok=${ev.ok}${dispatch.error ? ` error=${dispatch.error}` : ''}`
  );
  if (finalPack.worker) {
    finalPack.worker.completed_at = new Date().toISOString();
  }
  // ── v0.4.3: cost telemetry + lock release ────────────────────────────────
  // Append cost telemetry for this dispatch round (BP1 reproducibility +
  // BP14 cost-quality Pareto data + Pillar 1 Observability).
  let outputBytes = 0;
  try {
    if (dispatch.output_path && fs.existsSync(dispatch.output_path)) {
      outputBytes = fs.statSync(dispatch.output_path).size;
    }
  } catch {
    /* best-effort */
  }
  // Phase 1 (BP3 provenance + PUB-10 model inventory): record per-dispatch
  // model_id, model_version, prompt hash, tool versions, host. This is the
  // SLSA-L1 baseline for autonomous-delivery provenance. SLSA-L2/L3 (signed
  // attestation) deferred to Phase 2.
  const promptHash = (() => {
    try {
      // Hash the prompt that was sent to the worker (rebuilt from task pack)
      // Codex R2: full SHA-256 hex (NOT truncated to 16 chars; truncation reduces
      // uniqueness for replay verification + provenance audit).
      return 'sha256:' + crypto.createHash('sha256').update(prompt).digest('hex');
    } catch {
      return undefined;
    }
  })();
  const modelId = (() => {
    switch (args.engine) {
      case 'claude-code-cli': return 'claude-opus-4-7';
      case 'claude-agent-sdk': return process.env.ANTHROPIC_MODEL || 'claude-opus-4-7';
      case 'codex-cli': return process.env.CODEX_MODEL || 'gpt-5.5';
      default: return undefined;
    }
  })();
  const toolVersions: Record<string, string> = {};
  try {
    const node = spawnSync('node', ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (node.status === 0) toolVersions.node = node.stdout.trim();
    const pnpm = spawnSync('pnpm', ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (pnpm.status === 0) toolVersions.pnpm = pnpm.stdout.trim();
    const git = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (git.status === 0) toolVersions.git = git.stdout.trim().replace(/^git version /, '');
  } catch {
    /* best-effort */
  }
  finalPack.cost_telemetry.push({
    round: args.round,
    engine: args.engine,
    duration_ms: dispatch.duration_ms,
    exit_code: dispatch.exit_code,
    output_bytes: outputBytes,
    at: new Date().toISOString(),
    model_id: modelId,
    model_version: process.env.ANTHROPIC_MODEL_VERSION || undefined,
    prompt_hash: promptHash,
    tool_versions: Object.keys(toolVersions).length > 0 ? toolVersions : undefined,
    host: os.hostname(),
  });
  // Release the single-writer lock so the next round can acquire.
  releaseTaskLock(finalPack);
  writeTaskPack(finalPack);
  releaseCrashGuard(); // Codex C2: success path completed, disarm crash recovery
  appendStateLog(runId, {
    task_id: args.taskId,
    from: 'in-progress',
    to: finalState,
    at: new Date().toISOString(),
    by: `auto-worker-${args.engine}`,
    reason: `dispatch=${dispatch.status} evidence_ok=${ev.ok}`,
  });

  console.log('');
  console.log(`[transition] in-progress → ${finalState}`);
  if (finalState === 'awaiting-review') {
    console.log(`
Next step: pnpm auto:consensus ${args.taskId}
`);
  } else if (finalState === 'needs-revision') {
    console.log(`
Worker did not complete cleanly. Inspect:
  - Output: ${dispatch.output_path}
  - Evidence: ${evidenceDir(runId, args.taskId)}/
  - Task pack: .agent-runs/${runId}/tasks/${args.taskId}.json

Re-run after fixes: pnpm auto:work ${args.taskId} --engine ${args.engine} --round ${args.round + 1}
`);
  } else if (finalState === 'abandoned') {
    console.log(`
Task abandoned by worker. Review notes in worker-handoff.json + decide whether to
revise scope (auto:revise) or accept abandonment (auto:abandon).
`);
  }

    process.exit(dispatch.status === 'complete' && ev.ok ? 0 : 1);
  } catch (err) {
    // Codex C2 R2: this is the ACTUAL crash recovery — fires on any throw
    // inside the try{} block above (async or sync). recoverFromCrash() is
    // a no-op if releaseCrashGuard() already disarmed it, so the success
    // path is unaffected.
    recoverFromCrash(err as Error);
    throw err;
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(2);
});
