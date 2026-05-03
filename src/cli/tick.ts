#!/usr/bin/env node
/**
 * pnpm auto:tick — periodic background heartbeat: flush + Slack delta + DLQ check.
 *
 * Designed for cron / launchd / systemd timer invocation every N minutes
 * (recommended cadence: 5-15 min for active development, 30-60 min when
 * walking away). Idempotent + bounded + non-blocking.
 *
 * What it does:
 *  1. Runs auto:flush-progress to refresh ~/Obsidian/.../AUTONOMOUS-PROGRESS.md
 *  2. Diff'd against the prior tick's snapshot:
 *     - new completed tasks → Slack [SUCCESS]
 *     - new failed tasks → Slack [ALERT]
 *     - new awaiting-review tasks → Slack [INFO]
 *     - stuck tasks (no state change > worker_timeout) → Slack [ALERT]
 *     - new Codex outputs (unintegrated) → Slack [INFO]
 *  3. If --daily flag and clock is at 09:00 UTC ±5 min: post daily roll-up
 *  4. Exits silently (cron-friendly) unless --verbose
 *
 * Usage:
 *   pnpm auto:tick                    # cron-friendly (silent if no changes)
 *   pnpm auto:tick --verbose          # print everything
 *   pnpm auto:tick --daily            # post daily roll-up to Slack
 *   pnpm auto:tick --dry-run          # don't post; just log what would
 *
 * Env vars:
 *   AUTO_DAEMON_SLACK_WEBHOOK         # required for Slack pushes
 *   AUTO_TICK_DRY_RUN=true            # equivalent to --dry-run
 *   AUTO_TICK_QUIET_HOURS=22-07       # don't push between these hours (UTC)
 *
 * Cron example (every 15 min):
 *   #!/bin/bash
 *   * /15 * * * * cd /path/to/repo && /usr/local/bin/pnpm --dir tools/autonomous-delivery auto:tick
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';
import { notifyFromLegacyMessage, loadConfig as loadNotifyConfig } from '../lib/notifications';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = harnessRoot();
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(REPO_ROOT, '.agent-runs');
const SESSION_HISTORY_DIR = path.resolve(__dirname, '..', '..', 'session-history');
const TICK_STATE_PATH = path.resolve(__dirname, '..', '..', 'tick-state.json');

interface TickArgs {
  verbose: boolean;
  daily: boolean;
  dryRun: boolean;
  autoPromote: boolean;
  autoLand: boolean;
  applyLand: boolean;
  materializeApprovals: boolean;
}

interface TickState {
  last_tick_at: string;
  last_known_states: Record<string, { task_id: string; state: string; module: string }>;
  last_daily_rollup_at: string | null;
}

function parseArgs(argv: string[]): TickArgs {
  let verbose = false;
  let daily = false;
  let dryRun = process.env.AUTO_TICK_DRY_RUN === 'true';
  // v0.5.0: opt-in auto-promote. Default OFF. Either --auto-promote OR
  // AUTO_AUTO_PROMOTE=1|true env opts in. Per Codex roadmap review:
  // "no side effects without policy context".
  let autoPromote = process.env.AUTO_AUTO_PROMOTE === '1' || process.env.AUTO_AUTO_PROMOTE === 'true';
  // v0.5.0 Sprint 4 (Codex bvw1dczxm): materialize operator-approved gap
  // candidates into real TaskPacks. Default OFF; either --materialize-approvals
  // CLI or AUTO_MATERIALIZE_APPROVALS=1 env opts in.
  let materializeApprovals = process.env.AUTO_MATERIALIZE_APPROVALS === '1' || process.env.AUTO_MATERIALIZE_APPROVALS === 'true';
  // Gap #2 (auto-lander loop): close the ready-for-merge → merged transition that
  // was previously a manual operator step. Default OFF; --auto-land or
  // AUTO_AUTO_LAND=1 opts in. Mirrors auto-promote's three-signal opt-in pattern.
  // --apply-land or AUTO_AUTO_LAND_APPLY=1 additionally authorizes REAL merge
  // (otherwise dry-run report-only). Both must agree, AND each task's pack must
  // have auto_land_policy.real_merge_enabled === true.
  let autoLand = process.env.AUTO_AUTO_LAND === '1' || process.env.AUTO_AUTO_LAND === 'true';
  let applyLand = process.env.AUTO_AUTO_LAND_APPLY === '1' || process.env.AUTO_AUTO_LAND_APPLY === 'true';
  for (const a of argv) {
    if (a === '--verbose') verbose = true;
    else if (a === '--daily') daily = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--auto-promote') autoPromote = true;
    else if (a === '--auto-land') autoLand = true;
    else if (a === '--apply-land') applyLand = true;
    else if (a === '--materialize-approvals') materializeApprovals = true;
  }
  return { verbose, daily, dryRun, autoPromote, autoLand, applyLand, materializeApprovals };
}

function readTickState(): TickState {
  if (!fs.existsSync(TICK_STATE_PATH)) {
    return { last_tick_at: '', last_known_states: {}, last_daily_rollup_at: null };
  }
  try {
    return JSON.parse(fs.readFileSync(TICK_STATE_PATH, 'utf8'));
  } catch {
    return { last_tick_at: '', last_known_states: {}, last_daily_rollup_at: null };
  }
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function inQuietHours(): boolean {
  const range = process.env.AUTO_TICK_QUIET_HOURS;
  if (!range) return false;
  const m = range.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  const hour = new Date().getUTCHours();
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end; // crosses midnight
}

// Codex v0.4.9 review HIGH: tick.ts had a local Slack-only post function;
// the v0.4.8 multi-backend notify adapter never got wired. Now routed
// through notifyFromLegacyMessage which parses the [INFO]/[ALERT]/[CRITICAL]
// prefix → severity, fans out to console + slack + (for critical) PD + email.
function postSlack(message: string, dryRun: boolean): void {
  try {
    const cfg = loadNotifyConfig(REPO_ROOT);
    notifyFromLegacyMessage(message, dryRun, cfg);
  } catch (e) {
    // Fallback: legacy direct-curl path so a notifications.ts bug never
    // silently swallows operator alerts.
    legacyPostSlackFallback(message, dryRun);
    void e;
  }
}

function legacyPostSlackFallback(message: string, dryRun: boolean): void {
  const webhook = process.env.AUTO_DAEMON_SLACK_WEBHOOK;
  if (!webhook) return;
  if (dryRun) {
    console.log(`[DRY-RUN-SLACK] ${message}`);
    return;
  }
  if (inQuietHours()) {
    console.log(`[QUIET-HOURS] suppressing: ${message}`);
    return;
  }
  try {
    const escaped = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    spawnSync(
      'curl',
      ['-fsS', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', `{"text":"${escaped}"}`, webhook],
      { timeout: 10_000, stdio: 'pipe' }
    );
  } catch (e) {
    console.warn(`[SLACK-FAIL] ${(e as Error).message}`);
  }
}

function discoverTasks(): Array<{ run_id: string; task_id: string; state: string; module: string; updated_at: number }> {
  const tasks: Array<{ run_id: string; task_id: string; state: string; module: string; updated_at: number }> = [];
  if (!fs.existsSync(RUNS_DIR)) return tasks;
  for (const runId of fs.readdirSync(RUNS_DIR)) {
    const tasksDir = path.join(RUNS_DIR, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const taskFile of fs.readdirSync(tasksDir)) {
      if (!taskFile.endsWith('.json')) continue;
      try {
        const fullPath = path.join(tasksDir, taskFile);
        const pack = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        const stat = fs.statSync(fullPath);
        tasks.push({
          run_id: runId,
          task_id: pack.task_id,
          state: pack.state,
          module: pack.module_or_sprint ?? '?',
          updated_at: stat.mtimeMs,
        });
      } catch {
        // skip
      }
    }
  }
  return tasks;
}

function detectChanges(prev: Record<string, { state: string }>, curr: Array<{ task_id: string; state: string; module: string }>): {
  newCompleted: typeof curr;
  newFailed: typeof curr;
  newAwaiting: typeof curr;
  newPlanned: typeof curr;
  stateChanges: Array<{ task_id: string; module: string; from: string; to: string }>;
} {
  const newCompleted: typeof curr = [];
  const newFailed: typeof curr = [];
  const newAwaiting: typeof curr = [];
  const newPlanned: typeof curr = [];
  const stateChanges: Array<{ task_id: string; module: string; from: string; to: string }> = [];

  for (const task of curr) {
    const prior = prev[task.task_id];
    if (!prior) {
      if (task.state === 'planned') newPlanned.push(task);
      continue;
    }
    if (prior.state !== task.state) {
      stateChanges.push({ task_id: task.task_id, module: task.module, from: prior.state, to: task.state });
      if (task.state === 'merged' || task.state === 'ready-for-merge') newCompleted.push(task);
      else if (task.state === 'abandoned') newFailed.push(task);
      else if (task.state === 'awaiting-review' || task.state === 'awaiting-human-approval') newAwaiting.push(task);
    }
  }

  return { newCompleted, newFailed, newAwaiting, newPlanned, stateChanges };
}

function detectStuckTasks(curr: Array<{ task_id: string; state: string; module: string; updated_at: number }>): Array<{ task_id: string; module: string; state: string; ageMinutes: number }> {
  const stuckThresholdMs = 30 * 60 * 1000;
  const now = Date.now();
  return curr
    .filter((t) => ['in-progress', 'codex-reviewing'].includes(t.state) && now - t.updated_at > stuckThresholdMs)
    .map((t) => ({ task_id: t.task_id, module: t.module, state: t.state, ageMinutes: (now - t.updated_at) / 60000 }));
}

function buildDailyRollup(state: TickState, tasks: ReturnType<typeof discoverTasks>): string {
  const counts: Record<string, number> = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] ?? 0) + 1;
  const lines: string[] = [];
  lines.push(`*NBF Auto-Build Daily Roll-up — ${new Date().toISOString().slice(0, 10)}*`);
  lines.push('');
  lines.push(`Tasks by state:`);
  for (const [state, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    lines.push(`  • \`${state}\`: ${count}`);
  }
  lines.push('');
  const completed = tasks.filter((t) => t.state === 'merged' || t.state === 'ready-for-merge').length;
  const blocked = tasks.filter((t) => ['needs-revision', 'awaiting-human-approval', 'abandoned'].includes(t.state)).length;
  const inFlight = tasks.filter((t) => ['in-progress', 'codex-reviewing'].includes(t.state)).length;
  lines.push(`Completed: ${completed} | Blocked: ${blocked} | In-flight: ${inFlight}`);
  lines.push(`Last tick: ${state.last_tick_at || '(none)'}`);
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = readTickState();
  const now = new Date().toISOString();

  // 1. Refresh flush (silent on success per --quiet)
  if (args.verbose) console.log(`[tick ${now}] running auto:flush-progress…`);
  const flushResult = spawnSync(
    'pnpm',
    ['--silent', '--dir', PACKAGE_ROOT, 'auto:flush-progress', '--reason', 'tick'],
    { encoding: 'utf8', timeout: 60_000 }
  );
  if (flushResult.status !== 0 && args.verbose) {
    console.warn(`[tick] flush failed: ${flushResult.stderr}`);
  }

  // 2. Discover current tasks + detect changes
  const tasks = discoverTasks();
  const changes = detectChanges(state.last_known_states, tasks);
  const stuck = detectStuckTasks(tasks);

  if (args.verbose) {
    console.log(`[tick] tasks=${tasks.length} changes=${changes.stateChanges.length} stuck=${stuck.length}`);
  }

  // 3. Push notifications for material events
  for (const task of changes.newCompleted) {
    postSlack(`[SUCCESS] ${task.task_id} (${task.module}) → state=${task.state}`, args.dryRun);
  }
  for (const task of changes.newFailed) {
    postSlack(`[ALERT] ${task.task_id} (${task.module}) → ${task.state}; review evidence + decide remediation`, args.dryRun);
  }
  for (const task of changes.newAwaiting) {
    postSlack(`[INFO] ${task.task_id} (${task.module}) → ${task.state}; needs review`, args.dryRun);
  }
  for (const s of stuck) {
    postSlack(`[ALERT] STUCK: ${s.task_id} (${s.module}) in ${s.state} for ${s.ageMinutes.toFixed(0)} min`, args.dryRun);
  }

  // 4. Daily rollup if --daily and 09:00 UTC ±5 min and not posted today
  if (args.daily) {
    const utcHour = new Date().getUTCHours();
    const utcMin = new Date().getUTCMinutes();
    const isMorning = utcHour === 9 && utcMin <= 5;
    const todayStr = now.slice(0, 10);
    const lastRollupDay = state.last_daily_rollup_at?.slice(0, 10);
    if (isMorning && lastRollupDay !== todayStr) {
      const rollup = buildDailyRollup(state, tasks);
      postSlack(rollup, args.dryRun);
      state.last_daily_rollup_at = now;
      if (args.verbose) console.log('[tick] posted daily roll-up');
    }
  }

  // 5. Persist new state
  const newState: TickState = {
    last_tick_at: now,
    last_known_states: Object.fromEntries(tasks.map((t) => [t.task_id, { task_id: t.task_id, state: t.state, module: t.module }])),
    last_daily_rollup_at: state.last_daily_rollup_at,
  };
  atomicWrite(TICK_STATE_PATH, JSON.stringify(newState, null, 2));

  // 6a. (Phase 1 / M10 / LRA-6) Auto-detect escalation conditions.
  // Engages [escalation] kill switch if 3+ consecutive NO-GOs OR stale heartbeat.
  // Dedup-protected: same condition won't re-escalate within 30 min.
  try {
    const { detectEscalations, isDuplicateEscalation, engageEscalation, DEFAULT_DETECTION } = await import('../lib/escalation');
    const detection = detectEscalations({ ...DEFAULT_DETECTION, runs_dir: path.join(REPO_ROOT, '.agent-runs') });
    let newEscalations = 0;
    for (const candidate of detection.triggered) {
      if (!isDuplicateEscalation(REPO_ROOT, candidate)) {
        engageEscalation(REPO_ROOT, candidate.reason, candidate.detail, candidate.task_id);
        newEscalations += 1;
      }
    }
    if (args.verbose && newEscalations > 0) {
      console.warn(`[escalation ${now}] auto-engaged ${newEscalations} new escalation(s); kill switch active`);
    } else if (args.verbose && detection.triggered.length > 0) {
      console.log(`[escalation ${now}] ${detection.triggered.length} condition(s) triggered, all dedup'd within 30min window`);
    }
  } catch (e) {
    if (args.verbose) {
      console.warn(`[escalation] check skipped: ${(e as Error).message}`);
    }
  }

  // 6a.5 — Watchdog reaper (operator directive 2026-04-28: active timeouts +
  // restarts + cleanup so the harness doesn't sit waiting on hung processes).
  // Runs every tick; safe + idempotent + audited.
  try {
    const { reapStale, listRegistered } = await import('../lib/processWatchdog');
    const before = listRegistered(REPO_ROOT).length;
    const results = reapStale(REPO_ROOT, { apply: !args.dryRun });
    const reaped = results.filter(
      (r) => r.applied && r.verdict.action !== 'keep'
    );
    if (args.verbose) {
      console.log(`[watchdog ${now}] registered=${before} reaped=${reaped.length} (kept=${results.filter((r) => r.verdict.action === 'keep').length})`);
    }
    for (const r of reaped) {
      const tag = r.entry.task_id ? `${r.entry.task_id} ` : '';
      const sig = r.killed_signal ? ` signal=${r.killed_signal}` : '';
      postSlack(
        `[ALERT] WATCHDOG REAPED ${tag}pid=${r.entry.pid} kind=${r.entry.kind}: ${r.verdict.reason}${sig}`,
        args.dryRun,
      );
    }
  } catch (e) {
    if (args.verbose) {
      console.warn(`[watchdog] check skipped: ${(e as Error).message}`);
    }
  }

  // 6a.6 — Cleanup policies (operator directive 2026-04-28: proactive cleanup
  // at right intervals per standards/best practices). Runs every tick; each
  // policy self-rate-limits via cadence_seconds in _cleanup-state.json. So
  // /tmp gets hourly, session-history every 6h, codex 30d artifacts daily.
  try {
    const { runAll, totalActions, totalBytesFreed } = await import('../lib/cleanupPolicy');
    const cleanupResults = runAll(REPO_ROOT, { apply: !args.dryRun });
    const ran = cleanupResults.filter((r) => !r.skipped_for_cadence);
    const actions = totalActions(cleanupResults);
    const bytes = totalBytesFreed(cleanupResults);
    if (args.verbose && (ran.length > 0 || actions > 0)) {
      console.log(`[cleanup ${now}] policies-ran=${ran.length}/${cleanupResults.length} actions=${actions} bytes-freed=${(bytes / 1024).toFixed(1)} KB`);
    }
    if (actions > 0 && !args.dryRun) {
      postSlack(`[INFO] cleanup: ${actions} stale file(s) removed (${(bytes / 1024 / 1024).toFixed(2)} MB)`, args.dryRun);
    }
  } catch (e) {
    if (args.verbose) {
      console.warn(`[cleanup] check skipped: ${(e as Error).message}`);
    }
  }

  // 6a.65 — Scheduled tasks (long-cadence CLIs: rebase-stale daily,
  // cleanup-worktree weekly). Per-task cadence prevents runaway IO.
  // Default: dry-run (just reports what WOULD run); set
  // AUTO_TICK_SCHEDULED_APPLY=true to actually invoke. Audited as
  // 'cleanup-action' kind on each invocation.
  try {
    const { runScheduled } = await import('../lib/scheduledTasks');
    const apply = !args.dryRun && process.env.AUTO_TICK_SCHEDULED_APPLY === 'true';
    const sched = runScheduled(REPO_ROOT, { apply, cwd: PACKAGE_ROOT });
    const ran = sched.filter((r) => r.ran);
    if (args.verbose && ran.length > 0) {
      console.log(`[scheduled ${now}] ran=${ran.length} (apply=${apply})`);
      for (const r of ran) console.log(`  • ${r.task_id} exit=${r.exit_code} duration=${(r.duration_ms / 1000).toFixed(1)}s`);
    }
    if (apply && ran.some((r) => r.exit_code !== 0)) {
      const fails = ran.filter((r) => r.exit_code !== 0).map((r) => r.task_id).join(', ');
      postSlack(`[ALERT] scheduled tasks failed: ${fails}`, args.dryRun);
    }
  } catch (e) {
    if (args.verbose) console.warn(`[scheduled] check skipped: ${(e as Error).message}`);
  }

  // 6a.68 — Task queue drain (gap #6: cross-task path coordination). When
  // tasks were enqueued by auto:work due to path overlap, this checks if
  // their blockers reached terminal state. apply=true removes drained
  // entries from the queue file. Apply default = !dryRun.
  try {
    const { drainQueue, listQueue } = await import('../lib/taskQueue');
    const before = listQueue(REPO_ROOT).length;
    const results = drainQueue(REPO_ROOT, { apply: !args.dryRun });
    const drained = results.filter((r) => r.unblocked);
    if (args.verbose && (before > 0 || drained.length > 0)) {
      console.log(`[task-queue ${now}] queued=${before} drained=${drained.length}`);
      for (const d of drained) console.log(`  ✓ ${d.task_id} unblocked (was behind: ${d.before_blocked_by.join(', ')})`);
    }
    for (const d of drained) {
      postSlack(`[INFO] task-queue: ${d.task_id} unblocked — blockers ${d.before_blocked_by.join(', ')} reached terminal state`, args.dryRun);
    }
  } catch (e) {
    if (args.verbose) console.warn(`[task-queue] check skipped: ${(e as Error).message}`);
  }

  // 6a.69 — Auto-promote loop (v0.5.0, Codex roadmap-review GO-with-modifications).
  // ENABLED ONLY when ALL THREE signals agree:
  //   1. CLI: --auto-promote flag OR AUTO_AUTO_PROMOTE=1 env (this `args.autoPromote`)
  //   2. Per-task: pack.auto_promote_policy.enabled === true
  //   3. Per-task: pack.type ∈ pack.auto_promote_policy.allowed_task_types (default
  //      [frd-polish, platform-doc])
  // Plus: codex score ≥ pack.auto_promote_policy.min_score (default 7.5) AND
  // last N consecutive rounds all GO (default 2; debounces single-round flukes).
  //
  // Drives `promotable → ready-for-merge`. NEVER auto-merges to protected branches.
  // Each decision (eligible or not) audited as kind='auto-promote-decision'.
  if (args.autoPromote) {
    try {
      const { evaluateAutoPromote } = await import('../lib/autoPromote');
      const { readTaskPack, listRuns, listTasks } = await import('../lib/runState');
      const { appendOverrideAudit } = await import('../lib/overrideAudit');
      const { captureIdentity } = await import('../lib/sod');
      let evaluated = 0;
      let promoted = 0;
      let denied = 0;
      for (const runId of listRuns()) {
        for (const taskId of listTasks(runId)) {
          let pack;
          try { pack = readTaskPack(runId, taskId); } catch { continue; }
          if (pack.state !== 'promotable') continue;
          evaluated += 1;
          const verdict = evaluateAutoPromote(pack, args.autoPromote);
          // Audit the autonomous decision regardless of outcome — operators
          // need to see "harness considered TP-X and chose to / not to promote".
          if (!args.dryRun) {
            try {
              appendOverrideAudit(REPO_ROOT, {
                schema_version: '1',
                at: new Date().toISOString(),
                pid: process.pid,
                actor: captureIdentity(),
                kind: 'auto-promote-decision',
                reason: verdict.reason,
                task_id: taskId,
                run_id: runId,
                context: { eligible: verdict.eligible, detail: verdict.detail as unknown as Record<string, unknown> },
              });
            } catch { /* audit best-effort; never block tick */ }
          }
          if (!verdict.eligible) { denied += 1; continue; }

          // Eligible — invoke auto:promote (which has its own CAS lock, SoD
          // enforcement, merge-gate policy check, and state-log audit). We do
          // not pass --human-override; this MUST pass the merge-gate as an
          // autonomous transition.
          if (args.verbose) console.log(`[auto-promote ${now}] eligible: ${taskId} — ${verdict.reason}`);
          if (!args.dryRun) {
            const result = spawnSync(
              'pnpm',
              ['--silent', '--dir', PACKAGE_ROOT, 'auto:promote', taskId],
              { encoding: 'utf8', timeout: 120_000 }
            );
            if (result.status === 0) {
              promoted += 1;
              postSlack(`[INFO] auto-promote: ${taskId} → ready-for-merge (codex ${pack.codex?.score})`, args.dryRun);
            } else {
              postSlack(`[ALERT] auto-promote: ${taskId} INVOCATION FAILED — ${(result.stderr || result.stdout).slice(0, 200)}`, args.dryRun);
            }
          }
        }
      }
      if (args.verbose && evaluated > 0) {
        console.log(`[auto-promote ${now}] evaluated=${evaluated} promoted=${promoted} denied=${denied} (dry-run=${args.dryRun})`);
      }
    } catch (e) {
      if (args.verbose) console.warn(`[auto-promote] skipped: ${(e as Error).message}`);
    }
  }

  // 6a.69b — Auto-land loop (Gap #2 closure: 2026-05-03). Mirrors the auto-promote
  // pattern but for `ready-for-merge → merged`. Three-signal opt-in:
  //   1. CLI: --auto-land OR AUTO_AUTO_LAND=1 env (this `args.autoLand`)
  //   2. Per-task: pack.auto_land_policy.enabled === true
  //   3. Per-task: pack.type ∈ pack.auto_land_policy.allowed_task_types AND
  //      codex.score ≥ pack.auto_land_policy.min_score (default 8.0; raised
  //      above auto-promote 7.5) AND last N consecutive GO rounds.
  // For REAL merge (vs dry-run report): pack.auto_land_policy.real_merge_enabled
  // === true AND args.applyLand. Both must agree.
  // Each decision audited as kind='auto-land-decision'. Drives ready-for-merge
  // tasks across the finish line — closes the "30 tasks frozen at
  // ready-for-merge" failure mode where tick auto-promoted but nothing landed.
  if (args.autoLand) {
    try {
      const { evaluateAutoLand } = await import('../lib/autoLand');
      const { readTaskPack, listRuns, listTasks } = await import('../lib/runState');
      const { appendOverrideAudit } = await import('../lib/overrideAudit');
      const { captureIdentity } = await import('../lib/sod');
      let evaluated = 0;
      let landed = 0;
      let denied = 0;
      let dryRunReports = 0;
      for (const runId of listRuns()) {
        for (const taskId of listTasks(runId)) {
          let pack;
          try { pack = readTaskPack(runId, taskId); } catch { continue; }
          if (pack.state !== 'ready-for-merge') continue;
          evaluated += 1;
          // Resolve target branch from pack (best-effort) so the protected-branch
          // predicate has signal even when run inside tick. The pack schema
          // doesn't store target branch directly; default to 'main' which is
          // always in protected_branches_excluded (so dry-run-eligible tasks
          // surface for operator review).
          const targetBranch = (pack as unknown as { target_branch?: string }).target_branch
            ?? (pack as unknown as { branch?: string }).branch
            ?? 'main';
          const verdict = evaluateAutoLand(pack, {
            globalOptIn: args.autoLand,
            applyAuthorization: args.applyLand,
            targetBranch,
            runId,
          });
          // Audit every decision (eligible or not, real-merge or dry-run).
          // Operators need to see "harness considered TP-X for auto-land".
          if (!args.dryRun) {
            try {
              appendOverrideAudit(REPO_ROOT, {
                schema_version: '1',
                at: new Date().toISOString(),
                pid: process.pid,
                actor: captureIdentity(),
                kind: 'auto-land-decision',
                reason: verdict.summary,
                task_id: taskId,
                run_id: runId,
                context: {
                  eligible: verdict.eligible,
                  real_merge_authorized: verdict.real_merge_authorized,
                  predicates: verdict.predicates,
                  suggested_merge_command: verdict.suggested_merge_command,
                } as unknown as Record<string, unknown>,
              });
            } catch { /* audit best-effort; never block tick */ }
          }
          if (!verdict.eligible) { denied += 1; continue; }
          if (!verdict.real_merge_authorized) {
            // Eligible but in dry-run mode (either pack.real_merge_enabled=false
            // or AUTO_AUTO_LAND_APPLY not set). Surface as INFO so operators
            // see what would have landed.
            dryRunReports += 1;
            if (args.verbose) console.log(`[auto-land ${now}] dry-run eligible: ${taskId} — ${verdict.summary}`);
            postSlack(`[INFO] auto-land DRY-RUN eligible: ${taskId} — ${verdict.suggested_merge_command ?? 'no PR number'}`, args.dryRun);
            continue;
          }
          // Real-merge authorized. Invoke auto:land which has its own pre-flight,
          // CAS lock, branch verification, and audit — we just trigger.
          if (args.verbose) console.log(`[auto-land ${now}] real-merge: ${taskId} — ${verdict.summary}`);
          if (!args.dryRun) {
            const result = spawnSync(
              'pnpm',
              ['--silent', '--dir', PACKAGE_ROOT, 'auto:land', taskId],
              { encoding: 'utf8', timeout: 600_000 } // 10 min — merge can take time
            );
            if (result.status === 0) {
              landed += 1;
              postSlack(`[SUCCESS] auto-land: ${taskId} merged (codex ${pack.codex?.score})`, args.dryRun);
            } else {
              postSlack(`[ALERT] auto-land: ${taskId} INVOCATION FAILED — ${(result.stderr || result.stdout).slice(0, 300)}`, args.dryRun);
            }
          }
        }
      }
      if (args.verbose && evaluated > 0) {
        console.log(`[auto-land ${now}] evaluated=${evaluated} landed=${landed} dry-run-eligible=${dryRunReports} denied=${denied} (apply=${args.applyLand}, tick-dry-run=${args.dryRun})`);
      }
    } catch (e) {
      if (args.verbose) console.warn(`[auto-land] skipped: ${(e as Error).message}`);
    }
  }

  // 6a.69c — Queued-but-idle detector (Gap #4 closure: 2026-05-03). If the
  // queue has tasks pending AND no workers are registered AND no awaiting-review
  // tasks have a consensus dispatch in flight, the harness is wedged: tasks are
  // ready but nothing is processing them. This is the failure mode where an
  // operator stops `auto:daemon` and forgets — the queue grows but produces
  // nothing. Surfaces a single Slack [ALERT] per tick (idempotent — same
  // message repeats only if the state persists; operators should silence by
  // either starting the daemon or draining the queue manually).
  //
  // We deliberately do NOT auto-spawn the daemon from tick — that crosses the
  // supervisor boundary (tick is one-shot, daemon is long-running) and creates
  // unowned processes. See docs/DURABLE-ORCHESTRATION.md for the durable
  // launchd/systemd path.
  try {
    const { listQueue } = await import('../lib/taskQueue');
    const { listRegistered } = await import('../lib/processWatchdog');
    const queued = listQueue(REPO_ROOT);
    const registered = listRegistered(REPO_ROOT);
    const liveWorkers = registered.filter((e) =>
      e.kind === 'claude-cli-worker' || e.kind === 'codex-consensus'
    );
    if (queued.length > 0 && liveWorkers.length === 0) {
      const msg =
        `[ALERT] queued-but-idle: ${queued.length} task(s) waiting in _task-queue.json but ZERO live workers (claude-cli-worker, codex-consensus). ` +
        `Either start the daemon (\`pnpm auto:daemon\`) or wire up durable orchestration ` +
        `(see docs/DURABLE-ORCHESTRATION.md). Queue: ${queued.slice(0, 3).map((q) => q.task_id).join(', ')}${queued.length > 3 ? ` (+${queued.length - 3} more)` : ''}`;
      if (args.verbose) console.warn(`[queued-idle ${now}] ${msg}`);
      postSlack(msg, args.dryRun);
    } else if (args.verbose && (queued.length > 0 || liveWorkers.length > 0)) {
      console.log(`[queued-idle ${now}] queued=${queued.length} live-workers=${liveWorkers.length} (healthy)`);
    }
  } catch (e) {
    if (args.verbose) console.warn(`[queued-idle] check skipped: ${(e as Error).message}`);
  }

  // 6a.69 — Materialize approved gap candidates into TaskPacks (Sprint 4,
  // Codex bvw1dczxm "one thing" prescription). Reads
  // .agent-runs/_approved-candidates.jsonl, finds entries without
  // materialized_as set, synthesizes TaskPacks via candidateToTaskPack, and
  // writes them to disk in state=planned. Daemon picks them up next tick
  // for normal applyRubric() dispatch.
  if (args.materializeApprovals) {
    try {
      // Codex efficiency review (2026-04-29) Ship-First: factored out into
      // src/lib/materializeApprovals.ts so auto:approve + daemon can call it
      // inline (no shell-out of `auto:tick --materialize-approvals` round-trip).
      const { materializeApprovals } = await import('../lib/materializeApprovals');
      const r = await materializeApprovals({
        harnessRoot: REPO_ROOT,
        dryRun: args.dryRun,
        log: args.verbose ? (m) => console.log(`[${now}] ${m}`) : undefined,
      });
      if (r.pending_before > 0) {
        console.log(`[materialize ${now}] materialized=${r.materialized} pending=${r.pending_after}`);
      }
    } catch (e) {
      if (args.verbose) console.warn(`[materialize] skipped: ${(e as Error).message}`);
    }
  }

  // 6a.7 — System health (operator directive 2026-04-28: "system is healthy
  // all the time and performing at its peak"). Always runs; alerts only on
  // warning/critical. Critical conditions audited as 'health-alert'.
  try {
    const { runHealthChecks } = await import('../lib/systemHealth');
    const { appendOverrideAudit } = await import('../lib/overrideAudit');
    const { captureIdentity } = await import('../lib/sod');
    const report = runHealthChecks(REPO_ROOT);
    if (args.verbose && report.overall !== 'ok') {
      const failing = report.checks.filter((c) => c.severity !== 'ok' && c.severity !== 'info');
      console.log(`[health ${now}] overall=${report.overall.toUpperCase()} (${failing.length} non-ok check${failing.length === 1 ? '' : 's'})`);
      for (const c of failing) console.log(`  ${c.id}: ${c.value} — ${c.recommendation ?? ''}`);
    }
    for (const c of report.checks) {
      if (c.severity === 'critical' || c.severity === 'warning') {
        postSlack(
          `[${c.severity.toUpperCase()}] HEALTH ${c.id}: ${c.value} (${c.threshold})${c.recommendation ? ` — ${c.recommendation}` : ''}`,
          args.dryRun,
        );
        if (c.severity === 'critical' && !args.dryRun) {
          try {
            appendOverrideAudit(REPO_ROOT, {
              schema_version: '1',
              at: new Date().toISOString(),
              actor: captureIdentity(),
              kind: 'health-alert',
              reason: `health critical: ${c.id}=${c.value} (${c.threshold}) — ${c.recommendation ?? ''}`,
              context: { check_id: c.id, value: c.value, threshold: c.threshold, host: report.host },
              pid: process.pid,
            });
          } catch (e) {
            if (args.verbose) console.warn(`[health] audit failed: ${(e as Error).message}`);
          }
        }
      }
    }
  } catch (e) {
    if (args.verbose) {
      console.warn(`[health] check skipped: ${(e as Error).message}`);
    }
  }

  // 6b. (Phase 1 / LRA-5) Evaluate goal contract if defined.
  // Reports completion status; logs "MISSION COMPLETE" if all criteria met.
  // No-op if no .agent-runs/_goal.json exists.
  try {
    const { readGoal, evaluateGoal, persistGoalEvaluation, buildGoalSnapshot } = await import('../lib/goal');
    const harnessRoot = REPO_ROOT;
    const goal = readGoal(harnessRoot);
    if (goal) {
      // Codex R4 fix: use centralized buildGoalSnapshot helper. Tick already
      // discovered tasks during its own scan, so we pass them in pre-built
      // (skips re-scan) and let the helper attach scoreboard inputs.
      const snapshot = buildGoalSnapshot(harnessRoot, PACKAGE_ROOT, {
        tasks: tasks.map((t) => ({
          task_id: t.task_id,
          run_id: t.run_id,
          state: t.state as never,
          module_or_sprint: t.module,
        })),
      });
      const eval_ = evaluateGoal(goal, snapshot);
      persistGoalEvaluation(harnessRoot, goal, eval_);
      if (args.verbose || eval_.complete) {
        console.log(
          `[goal ${now}] ${eval_.complete ? '🎉 MISSION COMPLETE' : 'in progress'} — ` +
          `${eval_.criteria_met}/${eval_.total_criteria} criteria met` +
          (eval_.criteria_overridden > 0 ? ` (${eval_.criteria_overridden} overridden)` : '')
        );
        for (const c of eval_.per_criterion) {
          const status = c.met ? '✓' : c.override_active ? '⚠ override' : ' ';
          console.log(`  ${status} ${c.id}: ${c.current}/${c.target}${c.override_reason ? ` — ${c.override_reason}` : ''}`);
        }
      }
    }
  } catch (e) {
    if (args.verbose) {
      console.warn(`[goal] evaluation skipped: ${(e as Error).message}`);
    }
  }

  if (args.verbose) {
    console.log(`[tick ${now}] complete; ${changes.stateChanges.length} state changes, ${stuck.length} stuck, ${changes.newCompleted.length + changes.newFailed.length + changes.newAwaiting.length} notifications sent`);
  }
}

main();
