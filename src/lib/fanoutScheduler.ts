/**
 * Layer 7 — DAG fan-out scheduler.
 *
 * Doctrine: a module advances as soon as its own predecessor gates pass.
 * Barriers only at real governance boundaries (FRD freeze, architecture
 * approval, release train).
 *
 * Codex critique on the v1 plan: phase-scoped fan-out (all modules
 * through phase N before any go to N+1) is usually lower throughput
 * because one slow module blocks the entire wave. Use a DAG scheduler
 * with per-stage WIP limits and let independent modules race ahead.
 *
 * This is the pure logic layer — no IO, no spawn. The driver
 * (`auto:fanout`, Layer 7.B) wires it to real auto:work / auto:postflight
 * / auto:land calls. The TypeScript driver is the v0 replacement for
 * scripts/serial-by-module.sh.
 */
import { STAGE_REGISTRY, getStageEntry } from './stageRegistry';

// ─── Types ───────────────────────────────────────────────────────────────

export interface ModuleJob {
  /** Module ID (e.g., "M07"). */
  module: string;
  /** Stages that have completed for this module. */
  completed_stages: string[];
  /** Stages currently in flight. */
  in_flight_stages: string[];
  /** Stages that hit a terminal failure (parked/abandoned). */
  failed_stages: string[];
}

export interface SchedulerState {
  modules: ModuleJob[];
  /** Per-stage WIP counts (currently in-flight across all modules). */
  in_flight_per_stage: Record<string, number>;
  /** Operator-engaged pause sentinel — refuses new dispatches. */
  paused: boolean;
}

export interface DispatchCandidate {
  module: string;
  stage: string;
  /** Why this stage is the next move. */
  reason: string;
}

export interface WipLimits {
  /** Default cap when a stage isn't called out. */
  default: number;
  /** Per-stage overrides. */
  overrides: Record<string, number>;
}

/**
 * Default WIP limits derived from the registry's cost_estimate.profile.
 * Heavy LLM stages (code-sprint) get tight caps; light gates run wide.
 * Operator overrides via .harness/fanout.yaml (Layer 7.B reads).
 */
export const DEFAULT_WIP_LIMITS: WipLimits = {
  default: 4,
  overrides: {
    'auto:work': 2,         // claude-code-cli is the throughput choke
    'auto:diagnose': 2,     // also LLM-heavy
    'auto:consensus': 3,    // codex is rate-limited per-account
    'auto:land': 4,         // gh CLI + git operations
    'auto:postflight': 8,   // gate, fast
    'auto:promote': 8,      // gate, fast
    'auto:tick': 1,         // run-bound, single-instance
  },
};

// ─── Scheduling logic ────────────────────────────────────────────────────

/**
 * Pick the next batch of (module, stage) dispatches that respect:
 *   - registry depends_on edges
 *   - per-stage WIP limits
 *   - failed-stage exclusion (modules with failed stages stop advancing)
 *   - global pause
 *
 * Returns the candidates in an order the caller should attempt one-by-one
 * (first candidate has the highest expected throughput contribution).
 */
export function pickNextDispatches(
  state: SchedulerState,
  limits: WipLimits = DEFAULT_WIP_LIMITS,
): DispatchCandidate[] {
  if (state.paused) return [];
  const candidates: DispatchCandidate[] = [];
  // Track per-stage "virtual in-flight" — current real in-flight + candidates
  // already collected in this scheduling pass. Without this, N modules ready
  // for the same stage would all pass the WIP check (each sees the same
  // current in_flight_per_stage value) and we'd emit N candidates for a
  // cap-K stage. Incrementing as we go enforces the cap correctly.
  const virtualInFlight: Record<string, number> = { ...state.in_flight_per_stage };
  for (const job of state.modules) {
    if (job.failed_stages.length > 0) continue;  // module exited the conveyor
    // Find the FIRST stage in registry order that this module hasn't
    // completed and isn't in flight on.
    for (const entry of STAGE_REGISTRY) {
      if (job.completed_stages.includes(entry.stage)) continue;
      if (job.in_flight_stages.includes(entry.stage)) continue;
      // Dependencies all satisfied?
      const depsOk = entry.depends_on.every((d) => job.completed_stages.includes(d));
      if (!depsOk) {
        // Don't bubble up — modules can have parallel non-dep stages.
        continue;
      }
      // WIP cap respected?
      const cap = limits.overrides[entry.stage] ?? limits.default;
      const live = virtualInFlight[entry.stage] ?? 0;
      if (live >= cap) continue;
      candidates.push({
        module: job.module,
        stage: entry.stage,
        reason: `deps=[${entry.depends_on.join(',')}] satisfied; wip ${live}/${cap}`,
      });
      virtualInFlight[entry.stage] = live + 1;
      break;  // one stage per module per scheduling pass
    }
  }
  return candidates;
}

// ─── Mutators (called by driver after dispatch lifecycle events) ────────

export function markStageDispatched(state: SchedulerState, module: string, stage: string): SchedulerState {
  const next = cloneState(state);
  const job = next.modules.find((m) => m.module === module);
  if (!job) return state;
  if (!job.in_flight_stages.includes(stage)) job.in_flight_stages.push(stage);
  next.in_flight_per_stage[stage] = (next.in_flight_per_stage[stage] ?? 0) + 1;
  return next;
}

export function markStageCompleted(state: SchedulerState, module: string, stage: string): SchedulerState {
  const next = cloneState(state);
  const job = next.modules.find((m) => m.module === module);
  if (!job) return state;
  job.in_flight_stages = job.in_flight_stages.filter((s) => s !== stage);
  if (!job.completed_stages.includes(stage)) job.completed_stages.push(stage);
  next.in_flight_per_stage[stage] = Math.max(0, (next.in_flight_per_stage[stage] ?? 1) - 1);
  return next;
}

export function markStageFailed(state: SchedulerState, module: string, stage: string): SchedulerState {
  const next = cloneState(state);
  const job = next.modules.find((m) => m.module === module);
  if (!job) return state;
  job.in_flight_stages = job.in_flight_stages.filter((s) => s !== stage);
  if (!job.failed_stages.includes(stage)) job.failed_stages.push(stage);
  next.in_flight_per_stage[stage] = Math.max(0, (next.in_flight_per_stage[stage] ?? 1) - 1);
  return next;
}

export function pauseScheduler(state: SchedulerState, paused: boolean): SchedulerState {
  return { ...cloneState(state), paused };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function cloneState(s: SchedulerState): SchedulerState {
  return {
    modules: s.modules.map((m) => ({
      module: m.module,
      completed_stages: [...m.completed_stages],
      in_flight_stages: [...m.in_flight_stages],
      failed_stages: [...m.failed_stages],
    })),
    in_flight_per_stage: { ...s.in_flight_per_stage },
    paused: s.paused,
  };
}

export function newSchedulerState(modules: string[]): SchedulerState {
  return {
    modules: modules.map((module) => ({
      module,
      completed_stages: [],
      in_flight_stages: [],
      failed_stages: [],
    })),
    in_flight_per_stage: {},
    paused: false,
  };
}
