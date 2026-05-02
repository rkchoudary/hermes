#!/usr/bin/env node
/**
 * pnpm auto:daemon — long-running orchestrator that polls + spawns workers + dispatches
 * Codex consensus + auto-promotes GO tasks. The "walk away" entry point.
 *
 * Usage:
 *   pnpm auto:daemon                      # default config
 *   pnpm auto:daemon --dry-run            # show what would happen; no spawning
 *   pnpm auto:daemon --max-workers 5      # override AUTO_DAEMON_MAX_WORKERS
 *   pnpm auto:daemon --once               # run one loop iteration then exit
 *   pnpm auto:daemon --notify-slack <webhook>
 *
 * Environment variables (see docs/OPERATOR-RUNBOOK.md):
 *   AUTO_DAEMON_MAX_WORKERS      default 3
 *   AUTO_DAEMON_POLL_SEC         default 30
 *   AUTO_DAEMON_DAILY_BUDGET_USD default 20
 *   AUTO_DAEMON_AUTO_REVISE      default true
 *   AUTO_DAEMON_STOP_ON_FAILURE  default false
 *   AUTO_DAEMON_SLACK_WEBHOOK    default unset
 *   AUTO_DAEMON_WORKER_TIMEOUT_MIN  default 30
 *
 * Engine + billing:
 *   Default engine = `claude-code-cli` → headless `claude --print …`, billed
 *   against your Claude Code Max subscription (no API key, no per-token cost).
 *   This is the path 99% of dispatches take. NO ANTHROPIC_API_KEY REQUIRED.
 *
 *   Opt-in API path (`claude-agent-sdk`) routes through @anthropic-ai/sdk and
 *   IS per-token billed. To use it you must set BOTH:
 *     ANTHROPIC_API_KEY=sk-…
 *     AUTO_ALLOW_API_BILLING=1     # explicit opt-in; refuses dispatch otherwise
 *
 * v0.1 STUB — this implementation defines the loop interface + dry-run mode.
 * v0.2 implements the actual loop:
 *   - Spawns pnpm auto:work as background processes
 *   - Tracks worker PIDs + heartbeat timestamps
 *   - Dispatches pnpm auto:consensus when worker writes "awaiting-review"
 *   - Auto-promotes on Codex GO
 *   - Sends Slack notifications via webhook
 *   - Handles SIGTERM cleanly (lets in-flight workers finish)
 *   - Daily budget tracking + pause-when-exhausted
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = harnessRoot();
const RUNS_DIR = path.join(REPO_ROOT, '.agent-runs');

interface DaemonConfig {
  max_workers: number;
  poll_sec: number;
  daily_budget_usd: number;
  auto_revise: boolean;
  stop_on_failure: boolean;
  slack_webhook?: string;
  email?: string;
  worker_timeout_min: number;
  dry_run: boolean;
  once: boolean;
}

function loadConfig(argv: string[]): DaemonConfig {
  const config: DaemonConfig = {
    max_workers: parseInt(process.env.AUTO_DAEMON_MAX_WORKERS ?? '3', 10),
    poll_sec: parseInt(process.env.AUTO_DAEMON_POLL_SEC ?? '30', 10),
    daily_budget_usd: parseInt(process.env.AUTO_DAEMON_DAILY_BUDGET_USD ?? '20', 10),
    auto_revise: process.env.AUTO_DAEMON_AUTO_REVISE !== 'false',
    stop_on_failure: process.env.AUTO_DAEMON_STOP_ON_FAILURE === 'true',
    slack_webhook: process.env.AUTO_DAEMON_SLACK_WEBHOOK,
    email: process.env.AUTO_DAEMON_EMAIL,
    worker_timeout_min: parseInt(process.env.AUTO_DAEMON_WORKER_TIMEOUT_MIN ?? '30', 10),
    dry_run: false,
    once: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') config.dry_run = true;
    else if (arg === '--once') config.once = true;
    else if (arg === '--max-workers' && i + 1 < argv.length) config.max_workers = parseInt(argv[++i], 10);
    else if (arg === '--notify-slack' && i + 1 < argv.length) config.slack_webhook = argv[++i];
  }
  return config;
}

interface DaemonState {
  start_time: string;
  active_workers: Map<string, { pid: number; task_id: string; started_at: string }>;
  cost_today_usd: number;
  tasks_completed_today: number;
  tasks_blocked_today: number;
}

function notifySlack(webhook: string | undefined, message: string): void {
  if (!webhook) {
    console.log(`[SLACK-DISABLED] ${message}`);
    return;
  }
  console.log(`[SLACK] ${message}`);
  try {
    // POST {"text": "<message>"} to the webhook. Use single-quote JSON via printf to avoid
    // shell escaping issues with special characters in the message.
    const escaped = message.replace(/"/g, '\\"').replace(/\n/g, '\\n');
    execSync(
      `curl -fsS -X POST -H 'Content-Type: application/json' -d "{\\"text\\":\\"${escaped}\\"}" ${webhook}`,
      { timeout: 10_000, stdio: 'pipe' }
    );
  } catch (e) {
    console.warn(`[SLACK-FAIL] webhook POST failed: ${(e as Error).message}`);
  }
}

function discoverTasks(filter?: string): { run_id: string; task_id: string; state: string }[] {
  if (!fs.existsSync(RUNS_DIR)) return [];

  const tasks: { run_id: string; task_id: string; state: string }[] = [];
  for (const runId of fs.readdirSync(RUNS_DIR)) {
    const tasksDir = path.join(RUNS_DIR, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const taskFile of fs.readdirSync(tasksDir)) {
      if (!taskFile.endsWith('.json')) continue;
      try {
        const taskPath = path.join(tasksDir, taskFile);
        const pack = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        if (filter && pack.state !== filter) continue;
        tasks.push({ run_id: runId, task_id: pack.task_id, state: pack.state });
      } catch {
        // skip malformed
      }
    }
  }
  return tasks;
}

function spawnWorker(taskId: string, dryRun: boolean): number | null {
  if (dryRun) {
    console.log(`[DRY-RUN] Would spawn: pnpm auto:work ${taskId}`);
    return null;
  }
  console.log(`[SPAWN] pnpm auto:work ${taskId} (detached)`);
  const logPath = `/tmp/auto-daemon-worker-${taskId}.log`;
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const proc = spawn('pnpm', ['auto:work', taskId], {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  // Codex efficiency review (2026-04-29) #2: pipeline workers→consensus.
  // Was: worker exits → state→awaiting-review → daemon waits up to 30s for
  // next tick to discover + dispatch consensus. Now: chain immediately on
  // child.on('exit') if state actually transitioned to awaiting-review (not
  // failed/blocked). Codex tweak: re-read pack to confirm state — workers
  // can exit non-zero after partial state transition; only dispatch when
  // pack.state is actually awaiting-review (race-safe).
  proc.on('exit', (code) => {
    if (code !== 0) return;  // worker failed; let auto-revise rubric decide on next tick
    try {
      // Lazy import — avoid hoisted deps in this hot helper
      const { readTaskPack } = require('../lib/runState') as { readTaskPack: (runId: string, taskId: string) => { state: string; run_id: string } };
      // Discover task's run_id from local discovery
      const allTasks = [...discoverTasks('awaiting-review')];
      const found = allTasks.find((t) => t.task_id === taskId);
      if (!found) return;
      const pack = readTaskPack(found.run_id, taskId);
      if (pack.state === 'awaiting-review') {
        console.log(`[PIPELINE] worker ${taskId} exited 0 + state=awaiting-review → chaining consensus immediately`);
        dispatchCodex(taskId, false);
      }
    } catch (e) {
      // Best-effort — daemon's next tick will catch missed dispatches
      console.warn(`[PIPELINE] post-exit consensus chain failed for ${taskId}: ${(e as Error).message.slice(0, 100)}`);
    }
  });
  proc.unref();
  console.log(`  PID=${proc.pid ?? '?'}  log=${logPath}`);
  return proc.pid ?? null;
}

function dispatchCodex(taskId: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`[DRY-RUN] Would dispatch Codex: pnpm auto:consensus ${taskId}`);
    return;
  }
  console.log(`[DISPATCH-CODEX] pnpm auto:consensus ${taskId} (detached)`);
  // Detached so the daemon's tickLoop is non-blocking. Codex review runs 5-10 min;
  // tickLoop discovers state transitions on subsequent ticks.
  const logPath = `/tmp/auto-daemon-consensus-${taskId}.log`;
  const out = fs.openSync(logPath, 'a');
  const err = fs.openSync(logPath, 'a');
  const proc = spawn('pnpm', ['auto:consensus', taskId], {
    detached: true,
    stdio: ['ignore', out, err],
    env: process.env,
  });
  proc.unref();
  console.log(`  PID=${proc.pid ?? '?'}  log=${logPath}`);
}

function autoPromote(taskId: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`[DRY-RUN] Would promote: pnpm auto:promote ${taskId}`);
    return;
  }
  console.log(`[PROMOTE] pnpm auto:promote ${taskId}`);
  // Synchronous — promote is fast (push + PR comment) and we want the result
  // captured in this tick's log.
  try {
    execSync(`pnpm auto:promote ${taskId}`, { stdio: 'inherit', timeout: 5 * 60 * 1000 });
  } catch (e) {
    console.error(`[PROMOTE-FAIL] ${taskId}: ${(e as Error).message}`);
  }
}

async function tickLoop(config: DaemonConfig, state: DaemonState): Promise<void> {
  const now = new Date().toISOString();
  console.log(`\n[${now}] Daemon tick — workers: ${state.active_workers.size}/${config.max_workers}, cost: $${state.cost_today_usd}/$${config.daily_budget_usd}`);

  // M11 enhancements: integrate Phase 1 systems into the daemon tick.
  // 0. KILL SWITCH check (refuses ALL further work if engaged by M9 budget OR
  //    M10 escalation OR operator). Workers + auto:land + auto:resurrect all
  //    already check, but the daemon should fail fast at the loop level too.
  const killFile = path.join(RUNS_DIR, '_KILL_SWITCH');
  if (fs.existsSync(killFile)) {
    let body = '';
    try { body = fs.readFileSync(killFile, 'utf8').trim(); } catch { /* ignore */ }
    console.error(`[kill-switch] HALTED: ${body.slice(0, 200)}`);
    console.error(`Daemon refuses to spawn workers. Resolve via:`);
    console.error(`  pnpm auto:kill-off                          # if operator-engaged`);
    console.error(`  pnpm auto:escalate clear --by <name>        # if [escalation]-engaged`);
    console.error(`  (budget will auto-release at next window)   # if [budget]-engaged`);
    return;
  }

  // 1. Refresh awareness + run auto:tick (M11 wires this here so goal eval +
  //    escalation auto-detection run every daemon tick automatically).
  if (!config.dry_run) {
    try {
      execSync('pnpm auto:awareness --refresh github', { stdio: 'pipe' });
      execSync('pnpm auto:awareness --refresh obsidian', { stdio: 'pipe' });
    } catch {
      console.warn('[WARN] awareness refresh failed; continuing');
    }
    // M11: run auto:tick to refresh goal eval + auto-detect escalations + flush
    try {
      execSync('pnpm auto:tick --verbose', { stdio: 'inherit' });
    } catch {
      console.warn('[WARN] auto:tick failed; continuing (auto:tick is best-effort)');
    }
  }

  // 2. Discover tasks by state
  const planned = discoverTasks('planned');
  const awaitingReview = discoverTasks('awaiting-review');
  const needsRevision = discoverTasks('needs-revision');
  const promotable = discoverTasks('promotable');

  console.log(`  planned: ${planned.length}, awaiting-review: ${awaitingReview.length}, needs-revision: ${needsRevision.length}, promotable: ${promotable.length}`);

  // 3. Promote any GO tasks first (cheap; no API call, no $ spend).
  // Pre-skip code-sprint tasks missing pack.worker.branch_name — that's the
  // Phase H2 design gap (worker dispatched in harness worktree without a
  // dedicated feature branch). Without branch_name, auto:promote can never
  // open a PR and we'd loop forever every tick. The fix is Phase H2 worktree-
  // per-task; until then, skip + emit one warning per tick.
  try {
    const { readTaskPack } = await import('../lib/runState');
    for (const task of promotable) {
      let pack;
      try { pack = readTaskPack(task.run_id, task.task_id); } catch { /* malformed */ }
      if (pack && pack.type === 'code-sprint' && !pack.worker?.branch_name) {
        console.warn(`[PROMOTE-SKIP] ${task.task_id}: code-sprint with no worker.branch_name (Phase H2 design gap; needs operator action — set worker.branch_name OR mark task as ready-for-merge manually)`);
        continue;
      }
      autoPromote(task.task_id, config.dry_run);
      state.tasks_completed_today++;
      notifySlack(config.slack_webhook, `[SUCCESS] ${task.task_id} → GO; merged`);
    }
  } catch (e) {
    // Defensive fallback to legacy mechanical promote if readTaskPack import
    // fails — daemon should never get fully stuck on a side-channel error.
    console.error(`[PROMOTE] runState import failed; falling back to mechanical promote: ${(e as Error).message}`);
    for (const task of promotable) {
      autoPromote(task.task_id, config.dry_run);
      state.tasks_completed_today++;
      notifySlack(config.slack_webhook, `[SUCCESS] ${task.task_id} → GO; merged`);
    }
  }

  // 4. Budget evaluation — MUST run BEFORE any spend-producing dispatch.
  //
  // Codex R6 fix (HIGH): R5's fail-closed catch wrote _KILL_SWITCH but only
  // gated step 6 (new worker spawn). Steps 4 (Codex dispatch) and 5 (auto-
  // revise) had already burned $ before the meter ran. Now the budget block
  // runs ahead of all three spend-producing steps and produces a single
  // `dispatchAllowed` signal that gates 5/6/7. Pre-existing _KILL_SWITCH
  // file (set by escalations or operator) ALSO blocks dispatch this tick.
  let dispatchAllowed = true;
  let dispatchBlockReason = '';
  let realDailySpend = 0;
  let realBudgetUtil = 0;
  // Re-check kill switch (defensive — top-of-tick check at line 201 already
  // returned if engaged AT tick start; this catches mid-tick engagement by
  // an external escalation/operator process between line 201 and here).
  // killFile path is in-scope from line 201.
  if (fs.existsSync(killFile)) {
    dispatchAllowed = false;
    let body = '';
    try { body = fs.readFileSync(killFile, 'utf8').slice(0, 200).trim(); } catch { /* ignore */ }
    dispatchBlockReason = `_KILL_SWITCH present: ${body}`;
  }
  try {
    const { readBudget, evaluateBudget, defaultBudget } = await import('../lib/budget');
    // R7 fix: fall back to defaultBudget when no contract exists. Previously
    // a missing _budget.json silently disabled budget enforcement, even
    // though the dashboard already used defaultBudget. Now consistent: budget
    // is ALWAYS evaluated, with the same default ($50/$250/$800) the dashboard
    // surfaces. Operator can author a custom contract to override.
    const budget = readBudget(REPO_ROOT) ?? defaultBudget();
    {
      const evaluation = evaluateBudget(budget, RUNS_DIR);
      const dailyWindow = evaluation.windows.find((w) => w.period === 'daily');
      if (dailyWindow) {
        realDailySpend = dailyWindow.spent_usd;
        realBudgetUtil = dailyWindow.utilization;
        state.cost_today_usd = realDailySpend;
      }
      if (evaluation.should_engage_kill_switch && dispatchAllowed) {
        dispatchAllowed = false;
        dispatchBlockReason = `M9 budget kill switch: ${evaluation.worst_window?.reason ?? 'unknown'}`;
        // Persist kill switch so auto:work pre-dispatch refusal sees it too.
        if (!fs.existsSync(killFile)) {
          try {
            fs.mkdirSync(path.dirname(killFile), { recursive: true });
            fs.writeFileSync(killFile, `[m9-budget] ${new Date().toISOString()}: ${dispatchBlockReason.slice(0, 200)}\n`);
          } catch { /* best-effort */ }
        }
      }
    }
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[BUDGET-FAIL-CLOSED] cost meter threw: ${msg}; engaging kill switch and pausing dispatch`);
    notifySlack(
      config.slack_webhook,
      `[ALERT] M11 cost meter failed (${msg}); kill switch engaged (fail-closed) — operator action required`
    );
    try {
      if (!fs.existsSync(killFile)) {
        fs.mkdirSync(path.dirname(killFile), { recursive: true });
        fs.writeFileSync(killFile, `[budget-meter-fail] ${new Date().toISOString()}: ${msg.slice(0, 200)}\n`);
      }
    } catch (e2) {
      console.error(`[BUDGET-FAIL-CLOSED] could not write kill switch: ${(e2 as Error).message}`);
    }
    dispatchAllowed = false;
    dispatchBlockReason = `cost-meter exception: ${msg.slice(0, 100)}`;
    state.cost_today_usd = config.daily_budget_usd;
  }
  if (!dispatchAllowed) {
    console.warn(`[DISPATCH-BLOCKED] ${dispatchBlockReason} — skipping Codex dispatch + auto-revise + new worker spawn this tick`);
  }

  // 5. Dispatch Codex on awaiting-review tasks (gated on dispatchAllowed)
  if (dispatchAllowed) {
    for (const task of awaitingReview) {
      dispatchCodex(task.task_id, config.dry_run);
    }
  }

  // 6. Auto-revise NO-GO tasks — Codex v0.4.9 review MEDIUM #7: previously
  // this loop ran spawnWorker on every needs-revision task without
  // consulting decisionRubric, so plateau detection (v0.4.4) and round-budget
  // escalation never applied in the long-running daemon. Now: consult
  // applyRubric per task; only spawn worker if action is dispatch-worker-revise;
  // emit escalation when rubric says so.
  if (dispatchAllowed && config.auto_revise) {
    try {
      const { applyRubric } = await import('../lib/decisionRubric');
      const { readTaskPack } = await import('../lib/runState');
      for (const task of needsRevision) {
        let pack;
        try { pack = readTaskPack(task.run_id, task.task_id); }
        catch { continue; }
        const decision = applyRubric(pack);
        switch (decision.action.kind) {
          case 'dispatch-worker-revise':
            console.log(`[AUTO-REVISE] ${task.task_id} (rubric round ${decision.action.round}, precedence ${decision.precedence})`);
            spawnWorker(task.task_id, config.dry_run);
            break;
          case 'escalate':
            console.warn(`[ESCALATE] ${task.task_id}: ${decision.action.reason}`);
            notifySlack(config.slack_webhook, `[ALERT] ${task.task_id} escalated: ${decision.action.reason}`);
            break;
          case 'skip-task':
          case 'idle':
            // Non-actionable; rubric correctly does not dispatch.
            break;
          default:
            console.log(`[AUTO-REVISE] ${task.task_id}: rubric returned ${decision.action.kind}; not spawning worker`);
        }
      }
    } catch (e) {
      console.error(`[AUTO-REVISE] rubric integration failed; falling back to mechanical dispatch: ${(e as Error).message}`);
      // Defensive fallback: previous behavior so daemon never gets fully
      // stuck if decisionRubric load fails.
      for (const task of needsRevision) {
        console.log(`[AUTO-REVISE-FALLBACK] ${task.task_id}`);
        spawnWorker(task.task_id, config.dry_run);
      }
    }
  }

  // 7. Spawn new workers if capacity available (gated on dispatchAllowed)
  // v0.4.20: depends_on dependency-graph enforcement. Per task pack's
  // depends_on[] array, dispatch ONLY when all listed prerequisite tasks
  // are in a terminal state (merged | abandoned). Without this, a fan-out
  // like TP-302 [depends_on: TP-301] could spawn before TP-301 lands and
  // fail because the run_registry schema isn't there yet.
  const TERMINAL_TASK_STATES = new Set(['merged', 'abandoned']);
  // Build a quick task_id → state lookup across ALL discovered states
  const allDiscoveredStates = new Map<string, string>();
  for (const t of [...planned, ...awaitingReview, ...needsRevision, ...promotable]) {
    allDiscoveredStates.set(t.task_id, t.state);
  }
  // Also include 'in-progress' / 'codex-reviewing' if they're known
  try {
    const inProgressTasks = discoverTasks('in-progress');
    const codexReviewingTasks = discoverTasks('codex-reviewing');
    const mergedTasks = discoverTasks('merged');
    const abandonedTasks = discoverTasks('abandoned');
    for (const t of [...inProgressTasks, ...codexReviewingTasks, ...mergedTasks, ...abandonedTasks]) {
      allDiscoveredStates.set(t.task_id, t.state);
    }
  } catch { /* */ }

  // Lazy-import readTaskPack at the top of the dependency check so it's
  // available throughout the spawn loop without re-importing per task.
  const { readTaskPack: readTaskPackForDeps } = await import('../lib/runState');
  function dependenciesSatisfied(taskId: string): { ok: boolean; reason?: string } {
    let pack;
    try {
      const ref = planned.find((p) => p.task_id === taskId);
      if (!ref) return { ok: true };  // not in planned anymore; let normal flow handle
      pack = readTaskPackForDeps(ref.run_id, taskId);
    } catch { return { ok: true }; }
    const deps = pack.depends_on ?? [];
    if (deps.length === 0) return { ok: true };
    const unsatisfied: string[] = [];
    for (const dep of deps) {
      const s = allDiscoveredStates.get(dep);
      if (!s || !TERMINAL_TASK_STATES.has(s)) {
        unsatisfied.push(`${dep}(${s ?? 'unknown'})`);
      }
    }
    if (unsatisfied.length > 0) {
      return { ok: false, reason: `depends_on not yet terminal: ${unsatisfied.join(', ')}` };
    }
    return { ok: true };
  }

  // 6.5 AUTO-REPLENISH (operator directive: "do not be idle ... time is money").
  // When the planned backlog drops to 0 AND no other transient bucket has work,
  // run gap analysis + auto-approve the top-K candidates + materialize them as
  // TaskPacks. This keeps the daemon goal-oriented rather than waiting on
  // operator approval. Codex consensus is still REQUIRED on each materialized
  // task before promote — no shortcut on review.
  if (dispatchAllowed && planned.length === 0 && needsRevision.length === 0 && awaitingReview.length === 0) {
    const replenishMode = process.env.AUTO_DAEMON_REPLENISH ?? 'on';
    if (replenishMode === 'off') {
      console.log('[REPLENISH] backlog empty but AUTO_DAEMON_REPLENISH=off; idling this tick');
    } else {
      console.log('[REPLENISH] backlog empty — running gap analysis + auto-approve top-3 + materialize…');
      try {
        // 1. Generate candidates (read-only, deterministic)
        execSync('pnpm auto:gap --top-k 3 --json > /tmp/_daemon-replenish.json', {
          stdio: 'pipe', timeout: 60_000,
        });
        const result = JSON.parse(fs.readFileSync('/tmp/_daemon-replenish.json', 'utf8'));
        const candidates = result.candidates ?? [];
        if (candidates.length === 0) {
          console.log('[REPLENISH] gap analysis returned 0 candidates — every eligible module is in flight or excluded');
        } else {
          // 2. Auto-approve each candidate (operator directive: don't wait)
          for (const c of candidates) {
            try {
              execSync(`pnpm auto:approve ${c.candidate_id} --approver auto-daemon --reason "auto-replenish: backlog empty"`, {
                stdio: 'pipe', timeout: 30_000,
              });
              console.log(`[REPLENISH] auto-approved ${c.candidate_id} (${c.type}, module=${c.module_or_sprint})`);
            } catch (e) {
              console.warn(`[REPLENISH] auto-approve ${c.candidate_id} failed: ${(e as Error).message.slice(0, 100)}`);
            }
          }
          // 3. Materialize approvals into TaskPacks (next tick will pick them up)
          try {
            // Codex efficiency review (2026-04-29) Ship-First: was a shell-out
            // of `pnpm auto:tick --materialize-approvals` (~60s round-trip).
            // Now calls the shared lib inline — same effect, no fork/exec
            // overhead, cleaner errors.
            const { materializeApprovals } = await import('../lib/materializeApprovals');
            const r = await materializeApprovals({
              harnessRoot: REPO_ROOT,
              dryRun: false,
              log: (m) => console.log(`[REPLENISH→materialize] ${m}`),
            });
            console.log(`[REPLENISH] materialized approvals: ${r.materialized}/${r.pending_before} → TaskPacks (next tick will dispatch)`);
          } catch (e) {
            console.warn(`[REPLENISH] materialize-approvals failed: ${(e as Error).message.slice(0, 200)}`);
          }
          notifySlack(config.slack_webhook, `[INFO] Daemon auto-replenished backlog with ${candidates.length} candidate(s) from gap analysis`);
        }
      } catch (e) {
        console.warn(`[REPLENISH] step failed: ${(e as Error).message.slice(0, 200)} — daemon stays idle this tick`);
      }
    }
  }

  if (dispatchAllowed) {
    while (state.active_workers.size < config.max_workers && planned.length > 0) {
      if (state.cost_today_usd >= config.daily_budget_usd) {
        console.log(`[BUDGET] Daily budget exhausted ($${state.cost_today_usd.toFixed(2)}/$${config.daily_budget_usd}, util ${(realBudgetUtil * 100).toFixed(1)}%); pausing new workers`);
        notifySlack(config.slack_webhook, `[BUDGET] Daily budget exhausted; daemon pausing new workers`);
        break;
      }
      // Find first task whose dependencies are satisfied
      const idx = planned.findIndex((t) => dependenciesSatisfied(t.task_id).ok);
      if (idx === -1) {
        // No task is ready (all are blocked on deps); break out — wait for next tick.
        const blockedSummary = planned.slice(0, 3).map((t) => `${t.task_id}: ${dependenciesSatisfied(t.task_id).reason ?? 'unknown'}`).join('; ');
        if (planned.length > 0) console.log(`[DEPS-BLOCKED] all ${planned.length} planned task(s) waiting on prerequisites — ${blockedSummary}`);
        break;
      }
      const task = planned.splice(idx, 1)[0];
      const pid = spawnWorker(task.task_id, config.dry_run);
      if (pid !== null) {
        state.active_workers.set(task.task_id, { pid, task_id: task.task_id, started_at: now });
      }
    }
  }

  // 7. Reap finished workers (v0.2: check PIDs + state transitions)

  // 8. Check for stuck workers (heartbeat > worker_timeout_min)
  for (const [taskId, worker] of state.active_workers) {
    const ageMin = (Date.now() - new Date(worker.started_at).getTime()) / 60000;
    if (ageMin > config.worker_timeout_min) {
      console.warn(`[STUCK] ${taskId} running for ${ageMin.toFixed(1)} min; reclaiming`);
      notifySlack(config.slack_webhook, `[ALERT] Worker stuck on ${taskId}; reclaiming`);
      state.active_workers.delete(taskId);
    }
  }

  // M11: Phase 1 housekeeping — runs every Nth tick (default 6 = once per ~3h
  // at 30-min poll). Diagnose-only by default; operator runs --apply manually.
  // Cheap (no LLM cost) so we don't gate on budget.
  const tickCount = (state as DaemonState & { _tick_count?: number })._tick_count ?? 0;
  (state as DaemonState & { _tick_count?: number })._tick_count = tickCount + 1;
  const HOUSEKEEPING_INTERVAL = 6;
  if (!config.dry_run && tickCount % HOUSEKEEPING_INTERVAL === 0) {
    console.log('\n[housekeeping] running M3+M4+M7 diagnose mode (every Nth tick)...');
    try {
      execSync('pnpm auto:rebase-stale', { stdio: 'inherit', timeout: 60_000 });
    } catch (e) {
      console.warn(`[housekeeping] auto:rebase-stale failed: ${(e as Error).message}`);
    }
    try {
      execSync('pnpm auto:cleanup-worktree', { stdio: 'inherit', timeout: 60_000 });
    } catch (e) {
      console.warn(`[housekeeping] auto:cleanup-worktree failed: ${(e as Error).message}`);
    }
    // M7 drift-check: scan a rotating sample of modules per housekeeping cycle
    // to surface FR-IDs in FRD that aren't referenced in code. Cheap; no LLM.
    // Codex efficiency review (2026-04-29) #9: probe rg ONCE at startup; skip
    // drift-check entirely when rg is absent (degraded mode wastes ~30s per
    // tick on a check that returns 0 results in code-side scan).
    if (rgIsAvailable === null) {
      try {
        const probe = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5_000 });
        rgIsAvailable = probe.status === 0;
      } catch {
        rgIsAvailable = false;
      }
      if (!rgIsAvailable) console.log(`[housekeeping] rg not on PATH; drift-check skipped (degraded mode — install ripgrep to enable)`);
    }
    if (rgIsAvailable) {
      const SAMPLE_MODULES = ['M02', 'M03', 'M04', 'M05', 'M07', 'M08', 'M09', 'M10', 'M29'];
      const sampleIndex = (tickCount / HOUSEKEEPING_INTERVAL) % SAMPLE_MODULES.length;
      const moduleToCheck = SAMPLE_MODULES[Math.floor(sampleIndex)];
      try {
        console.log(`[housekeeping] auto:drift-check ${moduleToCheck} (rotating sample)...`);
        execSync(`pnpm auto:drift-check ${moduleToCheck}`, { stdio: 'inherit', timeout: 60_000 });
      } catch (e) {
        console.warn(`[housekeeping] auto:drift-check ${moduleToCheck} failed: ${(e as Error).message}`);
      }
    }
  }
}

// rg-availability probe cache (computed once at first housekeeping run)
let rgIsAvailable: boolean | null = null;

async function main() {
  const config = loadConfig(process.argv.slice(2));
  const state: DaemonState = {
    start_time: new Date().toISOString(),
    active_workers: new Map(),
    cost_today_usd: 0,
    tasks_completed_today: 0,
    tasks_blocked_today: 0,
  };

  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║  NBF Autonomous Delivery Daemon (v0.3 — leaves real; cost meter v0.4) ║
╚══════════════════════════════════════════════════════════════════════╝

Config:
  max_workers:           ${config.max_workers}
  poll_sec:              ${config.poll_sec}
  daily_budget_usd:      $${config.daily_budget_usd}
  auto_revise:           ${config.auto_revise}
  worker_timeout_min:    ${config.worker_timeout_min}
  slack_webhook:         ${config.slack_webhook ? 'configured' : 'not set'}
  dry_run:               ${config.dry_run}
  once:                  ${config.once}
  ANTHROPIC_API_KEY:     ${process.env.ANTHROPIC_API_KEY ? 'set' : 'NOT SET (workers will fail)'}

Started at: ${state.start_time}

v0.4 status (M11 full Phase 1 integration):
  - Worker spawning: REAL (detached spawn of pnpm auto:work; PID tracked)
  - Codex dispatch: REAL (detached spawn of pnpm auto:consensus)
  - Promote: REAL (synchronous execSync of pnpm auto:promote)
  - Slack notifications: REAL (curl POST to webhook if configured)
  - Cost tracking: REAL via M9 budget evaluation (was stubbed in v0.3)
  - Kill switch fail-fast: REAL (M9 budget + M10 escalation auto-engage paths)
  - auto:tick per-tick: REAL (goal eval + escalation auto-detect inherited)
  - Housekeeping every Nth tick: REAL (M3 rebase-stale + M4 cleanup-worktree
    diagnose mode)
  - Auto-revise round limit: still permissive (v0.5 will check
    task.codex.rounds_executed vs task.consensus.max_rounds)

For production use, run: pnpm auto:daemon (no flags) and walk away.
For testing, run: pnpm auto:daemon --dry-run --once

Recommended: AUTO_DAEMON_WORKER_ENGINE=claude-code-cli (Mode B-2) for cost efficiency.
The worker engine is read by auto:work itself, not the daemon — daemon just spawns it.
`);

  // Handle SIGTERM gracefully
  process.on('SIGTERM', () => {
    console.log(`\n[SIGTERM] Daemon stopping; ${state.active_workers.size} workers in-flight will finish`);
    notifySlack(config.slack_webhook, `[STOPPED] Daemon SIGTERM — ${state.tasks_completed_today} done today, ${state.active_workers.size} in-flight`);
    process.exit(0);
  });

  notifySlack(config.slack_webhook, `[INFO] Daemon started`);

  if (config.once) {
    await tickLoop(config, state);
    console.log(`\n[ONCE] Single tick complete; exiting`);
    return;
  }

  // Main loop — Codex efficiency review (2026-04-29) #3 ROI 8/10:
  // event-driven via fs.watch on .agent-runs/ instead of pure 30s setInterval.
  // Codex tweaks applied: debounce 500ms, filter out partial_progress writes
  // (they fire ~1Hz × N tasks and don't represent state changes), KEEP a
  // periodic fallback every poll_sec (safety net if a watcher misses an event
  // or a task is created out-of-band).
  await tickLoop(config, state);

  let tickPending = false;
  let tickRunning = false;
  const runTick = (reason: string): void => {
    if (tickRunning) { tickPending = true; return; }  // serialize ticks
    tickRunning = true;
    if (process.env.AUTO_DAEMON_VERBOSE_TICKS === '1') console.log(`[TICK-TRIGGER] ${reason}`);
    tickLoop(config, state)
      .catch((err) => console.error(`[tick] error: ${(err as Error).message}`))
      .finally(() => {
        tickRunning = false;
        if (tickPending) {
          tickPending = false;
          setImmediate(() => runTick('coalesced'));
        }
      });
  };

  // Event-driven trigger
  let debounceTimer: NodeJS.Timeout | null = null;
  let lastEventFile: string | null = null;
  if (fs.existsSync(RUNS_DIR)) {
    try {
      fs.watch(RUNS_DIR, { recursive: true }, (_evt, filename) => {
        if (!filename) return;
        const f = String(filename);
        // Skip partial_progress writes — they fire ~1Hz per active worker/codex
        // and represent in-flight progress, not state transitions. Skip
        // session-history dumps (mtime updates, not state changes). Skip
        // tick-state cache writes (the daemon's own bookkeeping).
        if (f === 'tick-state.json') return;
        if (f.startsWith('session-history/')) return;
        if (f.startsWith('_e2e/')) return;  // E2E artifacts irrelevant to state machine
        // Read once to check if it's a partial_progress-only mutation
        // (cheap heuristic: file is a TaskPack JSON and was last written < 1s ago)
        if (debounceTimer) clearTimeout(debounceTimer);
        lastEventFile = f;
        debounceTimer = setTimeout(() => runTick(`fs-event: ${lastEventFile}`), 500);
      });
      console.log(`[fs-watch] event-driven daemon enabled on ${RUNS_DIR} (debounced 500ms; ${config.poll_sec}s periodic fallback)`);
    } catch (e) {
      console.warn(`[fs-watch] failed to enable: ${(e as Error).message} — falling back to pure interval`);
    }
  }

  // Periodic fallback — runs every poll_sec regardless of fs events
  // (safety net for missed events, drift detection, scheduled housekeeping).
  setInterval(() => runTick('periodic-fallback'), config.poll_sec * 1000);
}

void main();
