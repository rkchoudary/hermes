#!/usr/bin/env tsx
/**
 * Layer 7.B — DAG fan-out driver (`pnpm auto:fanout M01 M02 M03 …`).
 *
 * Replaces scripts/serial-by-module.sh. TypeScript driver that:
 *
 *   1. Builds SchedulerState from the module list.
 *   2. Resumes from prior crash if .agent-runs/_driver-state.json
 *      heartbeat is <5 min old; else marks orphans.
 *   3. Each tick: pickNextDispatches → spawn the next stage CLI for
 *      each candidate (capped by per-stage WIP) → on completion mark
 *      stage completed/failed.
 *   4. Heartbeat every 30s.
 *   5. Honors KILL_SWITCH + budget circuit breaker (_BUDGET_CIRCUIT_BREAKER).
 *   6. Per-stage spawn passes through L1 reservation + L4.A watchdog
 *      (auto:work has both); other stages are pass-through.
 *   7. Emits L0 outcome envelope at run end.
 *
 * Default arguments:
 *   --concurrency-default <N>   Per-stage WIP default (default 4)
 *   --max-modules <N>           Cap modules processed per run
 *   --label <STR>               Free-form label written into driver-state
 *   --resume-only               Don't accept new modules; only resume
 *                               an in-flight fanout
 *   --dry-run                   Walk the schedule without spawning
 *
 * Stops naturally when:
 *   - Every module reaches a terminal state (merged or failed)
 *   - KILL_SWITCH file appears
 *   - Budget circuit breaker engages
 *   - 6h wall-clock elapses (configurable via AUTO_FANOUT_MAX_HOURS)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import { harnessRoot } from '../lib/harnessRoot';
import {
  newSchedulerState,
  pickNextDispatches,
  markStageDispatched,
  markStageCompleted,
  markStageFailed,
  pauseScheduler,
  type SchedulerState,
  type DispatchCandidate,
} from '../lib/fanoutScheduler';
import {
  decideResume,
  heartbeat,
  writeDriverState,
  clearDriverState,
  type DriverState,
} from '../lib/driverState';
import { emitStageOutcome } from '../lib/stageOutcome';
import { reapExpiredReservations } from '../lib/budgetReservation';

interface CliArgs {
  modules: string[];
  concurrencyDefault?: number;
  maxModules?: number;
  label?: string;
  resumeOnly?: boolean;
  dryRun?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const modules: string[] = [];
  const a: Partial<CliArgs> = { modules };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--concurrency-default' && i + 1 < argv.length) a.concurrencyDefault = parseInt(argv[++i], 10);
    else if (x === '--max-modules' && i + 1 < argv.length) a.maxModules = parseInt(argv[++i], 10);
    else if (x === '--label' && i + 1 < argv.length) a.label = argv[++i];
    else if (x === '--resume-only') a.resumeOnly = true;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '-h' || x === '--help') {
      console.log('pnpm auto:fanout M01 M02 [...] [--concurrency-default N] [--max-modules N] [--label STR] [--resume-only] [--dry-run]');
      process.exit(0);
    }
    else if (/^M\d{2,3}$/.test(x)) modules.push(x);
  }
  if (!a.modules || a.modules.length === 0) {
    if (!a.resumeOnly) {
      console.error('No modules supplied. Pass module IDs (M01, M02, …) or --resume-only.');
      process.exit(1);
    }
  }
  return { ...a, modules: a.modules ?? [] };
}

function killSwitchActive(): boolean {
  const root = harnessRoot();
  return (
    fs.existsSync(path.join(root, '.agent-runs', '_KILL_SWITCH')) ||
    fs.existsSync(path.join(root, '.agent-runs', '_BUDGET_CIRCUIT_BREAKER'))
  );
}

interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Hard ceiling — kill if exceeded. */
  timeoutSec: number;
  /** Free-form label for logging. */
  label: string;
}

interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

function spawnStage(opts: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd ?? harnessRoot(),
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); process.stdout.write(b); });
    child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); process.stderr.write(b); });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
    }, opts.timeoutSec * 1000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - start });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + (err as Error).message, timedOut, durationMs: Date.now() - start });
    });
  });
}

function stageCommand(stage: string, module: string, dryRun: boolean): SpawnOptions | null {
  // Map stage name → CLI invocation. The driver doesn't try to reconstruct
  // stage args from scratch — it shells out to the stage's own pnpm script
  // (which honors --self-test, env vars, etc).
  const base: Record<string, { cmd: string; args: string[]; timeoutSec: number }> = {
    'auto:plan': {
      cmd: 'pnpm',
      args: ['--silent', 'auto:plan', '--module', module, '--type', 'code-sprint'],
      timeoutSec: 60,
    },
    'auto:work': {
      cmd: 'pnpm',
      args: ['--silent', 'auto:work', '--module', module, '--engine', 'claude-code-cli'],
      timeoutSec: 90 * 60,  // 90 min hard ceiling matching the legacy serial driver
    },
    'auto:postflight': {
      // postflight is per-task; the driver expects it to read the latest
      // task pack for the module. OSS doesn't have postflight CLI yet —
      // fall back to no-op that emits gate-pass envelope.
      cmd: 'pnpm',
      args: ['--silent', 'auto:postflight', '--module', module],
      timeoutSec: 5 * 60,
    },
    'auto:promote': {
      cmd: 'pnpm',
      args: ['--silent', 'auto:promote', '--module', module],
      timeoutSec: 60,
    },
    'auto:land': {
      cmd: 'pnpm',
      args: ['--silent', 'auto:land', '--module', module],
      timeoutSec: 5 * 60,
    },
    'auto:tick': {
      cmd: 'pnpm',
      args: ['--silent', 'auto:tick'],
      timeoutSec: 2 * 60,
    },
    'auto:deploy-staging': {
      cmd: 'pnpm',
      args: ['--silent', 'auto:deploy-staging', '--module', module],
      timeoutSec: 10 * 60,
    },
  };
  const entry = base[stage];
  if (!entry) return null;
  if (dryRun) {
    return { cmd: 'echo', args: ['[dry-run]', stage, module, ...entry.args.slice(1)], timeoutSec: 5, label: `${stage}/${module}` };
  }
  return { cmd: entry.cmd, args: entry.args, timeoutSec: entry.timeoutSec, label: `${stage}/${module}` };
}

async function tick(state: SchedulerState, args: CliArgs): Promise<{ state: SchedulerState; advanced: number; failed: number }> {
  const candidates = pickNextDispatches(state);
  if (candidates.length === 0) return { state, advanced: 0, failed: 0 };
  let advanced = 0;
  let failed = 0;
  // Mark all picked candidates as in-flight in scheduler state BEFORE spawning,
  // so the next pick honors the WIP limit even mid-spawn.
  let next = state;
  for (const c of candidates) next = markStageDispatched(next, c.module, c.stage);
  // Run candidates concurrently up to their per-stage cap.
  const results = await Promise.all(candidates.map(async (c) => {
    const cmd = stageCommand(c.stage, c.module, args.dryRun ?? false);
    if (!cmd) {
      console.warn(`[fanout] no command mapped for ${c.stage} — skipping ${c.module}`);
      return { c, ok: false, reason: 'unmapped-stage' };
    }
    console.log(`[fanout] ▶ ${c.stage} ${c.module}  (${c.reason})`);
    const r = await spawnStage(cmd);
    const ok = r.exitCode === 0;
    if (!ok) {
      console.error(`[fanout] ✗ ${c.stage} ${c.module} failed (exit=${r.exitCode}, timedOut=${r.timedOut}, ${r.durationMs}ms)`);
    } else {
      console.log(`[fanout] ✓ ${c.stage} ${c.module} ok (${r.durationMs}ms)`);
    }
    return { c, ok, reason: ok ? 'success' : `exit=${r.exitCode}${r.timedOut ? ' (timeout)' : ''}` };
  }));
  for (const r of results) {
    if (r.ok) {
      next = markStageCompleted(next, r.c.module, r.c.stage);
      advanced++;
    } else {
      next = markStageFailed(next, r.c.module, r.c.stage);
      failed++;
    }
  }
  return { state: next, advanced, failed };
}

async function main() {
  const start = Date.now();
  const args = parseArgs(process.argv.slice(2));

  // Decide resume vs fresh-start
  const resume = decideResume();
  console.log(`[fanout] resume decision: ${resume.decision} — ${resume.reason}`);

  let state: SchedulerState;
  if (resume.decision === 'resume' && resume.prior_state) {
    state = resume.prior_state.scheduler_state;
    console.log(`[fanout] resuming with ${state.modules.length} modules`);
  } else if (resume.decision === 'orphaned-recover' && resume.prior_state) {
    // Mark in-flight stages from the prior state as failed (driver-orphan).
    state = resume.prior_state.scheduler_state;
    for (const m of state.modules) {
      for (const stg of m.in_flight_stages) {
        state = markStageFailed(state, m.module, stg);
      }
    }
    console.log(`[fanout] recovered ${state.modules.length} modules from orphaned driver`);
  } else {
    if (args.resumeOnly) {
      console.log('[fanout] no resumable state and --resume-only set; exiting');
      process.exit(0);
    }
    const modules = args.maxModules ? args.modules.slice(0, args.maxModules) : args.modules;
    state = newSchedulerState(modules);
    console.log(`[fanout] fresh start with ${modules.length} modules: ${modules.join(', ')}`);
  }

  // Heartbeat write loop (every 30s).
  const fanoutId = `fanout-${Date.now()}-${os.hostname()}`;
  const driverState: DriverState = {
    driver_state_version: 1,
    fanout_id: fanoutId,
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date(start).toISOString(),
    last_heartbeat_at: new Date(start).toISOString(),
    scheduler_state: state,
    label: args.label,
  };
  writeDriverState(driverState);
  const heartbeatTimer = setInterval(() => {
    try { reapExpiredReservations(); } catch { /* best-effort */ }
    try { heartbeat({ ...driverState, scheduler_state: state }); } catch { /* tolerate */ }
  }, 30_000);

  const maxHours = parseFloat(process.env.AUTO_FANOUT_MAX_HOURS ?? '6');
  const wallCeilingMs = maxHours * 3600 * 1000;

  let totalAdvanced = 0;
  let totalFailed = 0;
  let killed = false;

  while (true) {
    if (killSwitchActive()) {
      console.log('[fanout] KILL_SWITCH or _BUDGET_CIRCUIT_BREAKER detected — stopping');
      state = pauseScheduler(state, true);
      killed = true;
      break;
    }
    if (Date.now() - start > wallCeilingMs) {
      console.log(`[fanout] ${maxHours}h wall-clock ceiling reached — stopping`);
      break;
    }
    const r = await tick(state, args);
    state = r.state;
    totalAdvanced += r.advanced;
    totalFailed += r.failed;
    // Heartbeat the new scheduler state.
    try { heartbeat({ ...driverState, scheduler_state: state }); } catch { /* tolerate */ }

    // Done condition: every module is either fully complete or has failed_stages.
    const stillActive = state.modules.some((m) =>
      m.failed_stages.length === 0 &&
      m.in_flight_stages.length === 0 &&
      pickNextDispatches({ ...state, modules: [m], in_flight_per_stage: {} }).length > 0
    );
    if (!stillActive) {
      console.log('[fanout] no more candidates — fanout complete');
      break;
    }
    if (r.advanced === 0 && r.failed === 0) {
      // Defensive: nothing happened this tick. WIP caps may be saturated.
      // Sleep briefly and re-tick rather than busy-loop.
      await new Promise((res) => setTimeout(res, 5_000));
    }
  }

  clearInterval(heartbeatTimer);

  const completed = state.modules.filter((m) => m.failed_stages.length === 0 && m.in_flight_stages.length === 0).length;
  const failedModules = state.modules.filter((m) => m.failed_stages.length > 0).length;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`FANOUT ${killed ? 'INTERRUPTED' : 'COMPLETE'} — ${(Date.now() - start) / 1000}s`);
  console.log(`  modules attempted: ${state.modules.length}`);
  console.log(`  modules completed: ${completed}`);
  console.log(`  modules with failures: ${failedModules}`);
  console.log(`  stage dispatches: ${totalAdvanced} advanced, ${totalFailed} failed`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Clear driver state on clean completion; preserve on kill so resume works.
  if (!killed) clearDriverState();

  emitStageOutcome({
    stage: 'auto:fanout',
    ok: failedModules === 0 && !killed,
    kind: killed ? 'budget-exceeded' : (failedModules === 0 ? 'success' : 'gate-fail'),
    retryable: killed,
    driver_action: killed ? 'pause-fanout' : 'advance',
    reason: `${state.modules.length} modules: ${completed} complete, ${failedModules} with failures, ${totalAdvanced} stage dispatches advanced, ${totalFailed} failed${killed ? ' (interrupted)' : ''}`,
    evidence: [],
    metrics: { duration_ms: Date.now() - start },
    details: {
      fanout_id: fanoutId,
      modules: state.modules,
      total_advanced: totalAdvanced,
      total_failed: totalFailed,
      killed,
    },
  });
  process.exit(killed ? 130 : (failedModules > 0 ? 1 : 0));
}

main().catch((err) => {
  console.error(`[fanout] crashed: ${(err as Error).message}`);
  process.exit(1);
});
