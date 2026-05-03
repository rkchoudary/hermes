/**
 * PA5 — livenessPoller (production-hardened).
 *
 * Periodic driver hook that:
 *   1. Reads the event ledger (PA2) for a task
 *   2. Reads supervisor signals (filesystem, container CPU, heartbeat)
 *   3. Calls assessLiveness() (PA4)
 *   4. Emits the verdict as a cp.liveness_assessed event into the ledger
 *      (closing the loop — verdicts themselves become audit data)
 *   5. Returns the verdict so the driver can route on recommended_action
 *
 * Doctrine: the poller is the ONLY place liveness signals are
 * aggregated. Direct stdout heuristics (the old L4.A no-output
 * watchdog) are deprecated in favor of this typed-verdict path.
 *
 * Hardening:
 *   - Bounded event tail (default 256) — large logs don't blow memory
 *   - Verdict-emission failures are logged but never crash the poller
 *     (the worker dispatch must not be killed by an audit-write fault)
 *   - Pollers are per-task; cancel-safe via stopPoller()
 *   - Suppression mode: when the operator has set
 *     AUTO_LIVENESS_SUPPRESS=1, the poller still computes verdicts and
 *     writes them, but `recommended_action` is overridden to 'continue'
 *     with `suppression_reason='AUTO_LIVENESS_SUPPRESS=1'`. Useful for
 *     debugging without losing the audit trail.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tailEvents, appendEvent, type CollectorState } from './events/eventCollector';
import { assessLiveness, type LivenessVerdict, type LivenessInputs, type RecommendedAction } from './liveness';

export interface PollerOptions {
  collector: CollectorState;
  /** Optional supplier for fs_mutations_last_60s. Most callers pass
   *  () => count of files in allowed_paths with mtime within the last
   *  60s. */
  fsMutationsSupplier?: () => number;
  /** Optional supplier for docker stats (CPU%, anthropic egress B/s). */
  containerStatsSupplier?: () => Promise<{
    cpu_pct?: number;
    anthropic_egress_bytes_per_s?: number;
    state?: 'starting' | 'running' | 'paused' | 'exited' | 'unknown';
    exit_code?: number | null;
  }>;
  /** Optional supplier for in-container heartbeat age in seconds. */
  heartbeatAgeSupplier?: () => number | null;
  /** Tail this many events from the ledger each poll (default 256). */
  eventTailSize?: number;
  /** Poll interval in ms (default 30s). */
  intervalMs?: number;
  /** Callback fired on every verdict — driver routes on this. */
  onVerdict?: (verdict: LivenessVerdict) => void;
}

export interface PollerHandle {
  /** The most recent verdict; null until the first poll completes. */
  lastVerdict: LivenessVerdict | null;
  /** Stop the poller. Idempotent. */
  stop: () => void;
  /** Force an immediate poll synchronously (skip the timer). */
  pollNow: () => Promise<LivenessVerdict>;
}

/**
 * Start a periodic liveness poller for the given task. Returns a
 * handle the caller uses to stop the poller and read the latest
 * verdict.
 */
export function startPoller(opts: PollerOptions): PollerHandle {
  const intervalMs = opts.intervalMs ?? 30_000;
  const eventTailSize = opts.eventTailSize ?? 256;
  const handle: PollerHandle = {
    lastVerdict: null,
    stop: () => { /* set below */ },
    pollNow: async () => null as unknown as LivenessVerdict,
  };
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  const doPoll = async (): Promise<LivenessVerdict> => {
    if (polling) return handle.lastVerdict ?? defaultVerdict();
    polling = true;
    try {
      const events = tailEvents(
        opts.collector.harnessRoot,
        opts.collector.runId,
        opts.collector.taskId,
        eventTailSize,
      );
      const inputs: LivenessInputs = { events };
      if (opts.fsMutationsSupplier) {
        try { inputs.fs_mutations_last_60s = opts.fsMutationsSupplier(); }
        catch { /* supplier failure should not crash the poll */ }
      }
      if (opts.heartbeatAgeSupplier) {
        try { inputs.heartbeat_age_s = opts.heartbeatAgeSupplier(); }
        catch { /* same */ }
      }
      if (opts.containerStatsSupplier) {
        try {
          const stats = await opts.containerStatsSupplier();
          inputs.container_cpu_pct = stats.cpu_pct;
          inputs.container_anthropic_egress_bytes_per_s = stats.anthropic_egress_bytes_per_s;
          inputs.container_state = stats.state;
          inputs.container_exit_code = stats.exit_code;
        } catch { /* same */ }
      }
      let verdict = assessLiveness(inputs);
      if (process.env.AUTO_LIVENESS_SUPPRESS === '1' && verdict.recommended_action !== 'continue') {
        verdict = {
          ...verdict,
          recommended_action: 'continue',
          suppression_reason: 'AUTO_LIVENESS_SUPPRESS=1',
        };
      }
      handle.lastVerdict = verdict;

      // Close the loop: emit the verdict as a cp.liveness_assessed event
      // back into the ledger. Best-effort — never crash the poller.
      try {
        appendEvent(opts.collector, {
          source: 'control-plane',
          kind: 'cp.liveness_assessed',
          payload: {
            kind: verdict.kind,
            confidence: verdict.confidence,
            primary_signal: verdict.primary_signal,
            supporting_signals: verdict.supporting_signals,
            recommended_action: verdict.recommended_action,
            reason: verdict.reason,
            suppression_reason: verdict.suppression_reason,
          },
          task_id: opts.collector.taskId,
          run_id: opts.collector.runId,
        });
      } catch (err) {
        console.error(`[liveness-poller] failed to record verdict for ${opts.collector.taskId}: ${(err as Error).message}`);
      }

      // Fire the driver callback
      if (opts.onVerdict) {
        try { opts.onVerdict(verdict); }
        catch (err) {
          console.error(`[liveness-poller] onVerdict callback threw for ${opts.collector.taskId}: ${(err as Error).message}`);
        }
      }
      return verdict;
    } finally {
      polling = false;
    }
  };

  handle.pollNow = doPoll;
  handle.stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  // Schedule the periodic loop
  const tick = () => {
    if (stopped) return;
    void doPoll().catch((err) => {
      console.error(`[liveness-poller] poll error for ${opts.collector.taskId}: ${(err as Error).message}`);
    });
  };
  // First poll immediately, then every intervalMs
  setImmediate(tick);
  timer = setInterval(tick, intervalMs);
  // Don't keep the event loop alive just for this poller
  if (timer.unref) timer.unref();
  return handle;
}

function defaultVerdict(): LivenessVerdict {
  return {
    kind: 'low_signal_active',
    confidence: 0,
    observed_at: new Date().toISOString(),
    primary_signal: 'no_data',
    supporting_signals: {},
    recommended_action: 'continue',
  };
}

/**
 * Helper: count files in a directory tree modified within the last
 * `windowSec` seconds. Used as the default fsMutationsSupplier for
 * tasks whose allowed_paths anchor at a known root.
 */
export function fsMutationCounter(rootPaths: string[], windowSec: number = 60): () => number {
  return () => {
    const now = Date.now();
    let count = 0;
    for (const root of rootPaths) {
      try { count += walkAndCount(root, now - windowSec * 1000); }
      catch { /* missing path is expected for some allowed_paths globs */ }
    }
    return count;
  };
}

function walkAndCount(dir: string, sinceMs: number): number {
  let count = 0;
  try {
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
      return stat.mtimeMs >= sinceMs ? 1 : 0;
    }
    if (!stat.isDirectory()) return 0;
  } catch { return 0; }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, .git for performance
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      count += walkAndCount(p, sinceMs);
    } else if (entry.isFile()) {
      try {
        const s = fs.statSync(p);
        if (s.mtimeMs >= sinceMs) count++;
      } catch { /* tolerate */ }
    }
  }
  return count;
}

/**
 * Map a recommended action to the concrete kill signal (or null for
 * non-kill actions). Used by the driver's reaper.
 */
export function actionToSignal(action: RecommendedAction): NodeJS.Signals | null {
  switch (action) {
    case 'sigterm': return 'SIGTERM';
    case 'sigkill-and-reap': return 'SIGKILL';
    default: return null;
  }
}
