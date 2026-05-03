/**
 * PA4 — Liveness verdict (production-hardened).
 *
 * Consumes the event ledger (PA2) plus optional host-supervisor
 * snapshots (filesystem mutation rate, container CPU%, network I/O)
 * to produce a typed `LivenessVerdict` with confidence + provenance.
 *
 * Doctrine principle 9 in action: liveness is derived from the
 * host-stamped event ledger, never from raw stdout heuristics.
 *
 * Codex critique honored:
 *   - No anthropomorphizing names ('thinking' → 'awaiting_model')
 *   - 'idle-with-progress' contradiction → 'recent_filesystem_activity'
 *   - 'dead' reserved for confirmed termination → 'heartbeat_lost' for
 *     missing pings
 *   - Verdict carries confidence (0..1), provenance (which signals
 *     drove the decision), and a recommended driver action.
 *
 * Verdicts (closed enum, ordered roughly by progress quality):
 *
 *   completed                    Engine emitted worker.session_end ok=true
 *   active                       Recent worker events; tool calls per minute > threshold
 *   recent_filesystem_activity   FS mutation rate > 0 in last 60s; no recent worker events
 *   awaiting_model               Network egress to anthropic is active; no worker events
 *                                in last 30s; CPU low (LLM in flight)
 *   awaiting_tool                Last worker event was tool_call > 30s ago, no tool_result
 *                                yet (long-running tool inside container)
 *   low_signal_active            Has SOME signal but ambiguous which class
 *   no_recent_control_events     Quiet for >2min on all signals; not yet ruled dead
 *   heartbeat_lost               In-container heartbeat missing for >30s but no
 *                                docker_state_changed=exited yet
 *   confirmed_terminated         Container exit observed OR heartbeat missing >5min
 *
 * The driver consumes (verdict, confidence, recommended_action) and
 * decides whether to:
 *   - continue            (active, awaiting_model, awaiting_tool, recent_fs)
 *   - log warning         (low_signal_active, no_recent_control_events <5min)
 *   - SIGTERM             (no_recent_control_events >5min with low confidence)
 *   - SIGKILL + reap      (heartbeat_lost >60s, confirmed_terminated)
 */
import type { HermesWorkerEventV1 } from './events/hermesWorkerEvent';

export const VerdictKind = [
  'completed',
  'active',
  'recent_filesystem_activity',
  'awaiting_model',
  'awaiting_tool',
  'low_signal_active',
  'no_recent_control_events',
  'heartbeat_lost',
  'confirmed_terminated',
] as const;
export type VerdictKind = typeof VerdictKind[number];

export type RecommendedAction =
  | 'continue'
  | 'log-warning'
  | 'sigterm'
  | 'sigkill-and-reap';

export interface LivenessVerdict {
  /** Discriminator. */
  kind: VerdictKind;
  /** [0..1]. Reflects how strongly the signals agreed. */
  confidence: number;
  /** Host wall clock when this assessment was computed. */
  observed_at: string;
  /** Which signal drove the verdict (e.g. 'last_event_age_s', 'docker_exit_code'). */
  primary_signal: string;
  /** All signals that fed the assessment, with values. */
  supporting_signals: Record<string, unknown>;
  /** Driver routing recommendation. */
  recommended_action: RecommendedAction;
  /** When recommended_action is anything other than 'continue', this
   *  explains WHY in operator-facing language for the "why was this
   *  worker killed?" surface. */
  reason?: string;
  /** Optional: when the harness deliberately lowered the recommended
   *  action below what raw signals would suggest (e.g. docker mode
   *  disables no-output watchdog). Empty when no suppression applied. */
  suppression_reason?: string;
}

// ─── Inputs ────────────────────────────────────────────────────────────

export interface LivenessInputs {
  /** Recent events for the task, oldest → newest. Sliced to last N for
   *  performance; collector.tailEvents(N) is the typical caller. */
  events: HermesWorkerEventV1[];
  /** Optional: recent filesystem mutation count in the task's
   *  allowed_paths in the last 60s. */
  fs_mutations_last_60s?: number;
  /** Optional: container CPU% from docker stats (0..100). */
  container_cpu_pct?: number;
  /** Optional: container network I/O bytes/s on egress to api.anthropic.com. */
  container_anthropic_egress_bytes_per_s?: number;
  /** Optional: container exit code if exited; null if still running. */
  container_exit_code?: number | null;
  /** Optional: docker container state ('running' | 'exited' | 'paused'). */
  container_state?: 'starting' | 'running' | 'paused' | 'exited' | 'unknown';
  /** Optional: in-container heartbeat age in seconds (null if no heartbeat data). */
  heartbeat_age_s?: number | null;
  /** Operator-tunable thresholds. */
  thresholds?: Partial<LivenessThresholds>;
}

export interface LivenessThresholds {
  /** Below this rate per minute, worker is considered not-actively-tooling. */
  active_tool_calls_per_min: number;
  /** Worker quiet for >this many seconds → 'awaiting_*' or 'no_recent'. */
  quiet_warn_s: number;
  /** No control events for >this many seconds → recommend SIGTERM if low confidence. */
  quiet_sigterm_s: number;
  /** Heartbeat missing >this many seconds → heartbeat_lost. */
  heartbeat_lost_s: number;
  /** Heartbeat missing >this many seconds → confirmed_terminated. */
  heartbeat_terminal_s: number;
  /** Container CPU% above this means worker is computing. */
  cpu_active_pct: number;
}

const DEFAULT_THRESHOLDS: LivenessThresholds = {
  active_tool_calls_per_min: 0.5,
  quiet_warn_s: 60,
  quiet_sigterm_s: 600,             // 10 min — generous; LLM thinking can be long
  heartbeat_lost_s: 30,
  heartbeat_terminal_s: 300,
  cpu_active_pct: 5,
};

// ─── Pure-function assessor ────────────────────────────────────────────

/**
 * Pure function — given the inputs, returns a verdict. No I/O, no
 * side-effects. The caller (collector poller, fleet watcher) is
 * responsible for fetching events + supervisor signals.
 *
 * This makes it trivially testable: replay any historical event stream
 * through assessLiveness with synthetic supervisor signals, assert the
 * verdict transitions match operator expectations.
 */
export function assessLiveness(input: LivenessInputs): LivenessVerdict {
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const now = Date.now();
  const observedAt = new Date(now).toISOString();

  // Confirmed terminations first — strongest signal
  if (input.container_state === 'exited' && input.container_exit_code !== undefined) {
    return {
      kind: 'confirmed_terminated',
      confidence: 1.0,
      observed_at: observedAt,
      primary_signal: 'container_state',
      supporting_signals: {
        container_state: input.container_state,
        container_exit_code: input.container_exit_code,
      },
      recommended_action: 'sigkill-and-reap',
      reason: `container exited with code ${input.container_exit_code}`,
    };
  }

  // Engine self-reported completion via session_end
  const lastEvent = input.events[input.events.length - 1];
  if (lastEvent?.kind === 'worker.session_end') {
    const isError = lastEvent.payload?.is_error === true;
    return {
      kind: 'completed',
      confidence: 1.0,
      observed_at: observedAt,
      primary_signal: 'worker.session_end',
      supporting_signals: {
        is_error: isError,
        duration_ms: lastEvent.payload?.duration_ms,
        total_cost_usd: lastEvent.payload?.total_cost_usd,
      },
      recommended_action: 'continue',
      reason: isError ? 'engine reported session_end with is_error=true' : undefined,
    };
  }

  // Heartbeat-based detection (when available)
  if (input.heartbeat_age_s !== undefined && input.heartbeat_age_s !== null) {
    if (input.heartbeat_age_s >= t.heartbeat_terminal_s) {
      return {
        kind: 'confirmed_terminated',
        confidence: 0.95,
        observed_at: observedAt,
        primary_signal: 'heartbeat_age_s',
        supporting_signals: { heartbeat_age_s: input.heartbeat_age_s },
        recommended_action: 'sigkill-and-reap',
        reason: `heartbeat missing for ${input.heartbeat_age_s}s (>= terminal threshold ${t.heartbeat_terminal_s}s)`,
      };
    }
    if (input.heartbeat_age_s >= t.heartbeat_lost_s) {
      return {
        kind: 'heartbeat_lost',
        confidence: 0.85,
        observed_at: observedAt,
        primary_signal: 'heartbeat_age_s',
        supporting_signals: { heartbeat_age_s: input.heartbeat_age_s },
        recommended_action: 'log-warning',
        reason: `heartbeat missing for ${input.heartbeat_age_s}s (>= lost threshold ${t.heartbeat_lost_s}s)`,
      };
    }
  }

  // Compute event-based signals
  const lastEventAge = lastEvent
    ? (now - new Date(lastEvent.host_observed_at).getTime()) / 1000
    : Infinity;

  const recentToolCalls = input.events.filter((e) =>
    e.kind === 'worker.tool_call'
    && (now - new Date(e.host_observed_at).getTime()) <= 60_000,
  ).length;
  const toolCallsPerMin = recentToolCalls;

  const lastToolCall = [...input.events].reverse().find((e) => e.kind === 'worker.tool_call');
  const lastToolResult = [...input.events].reverse().find((e) => e.kind === 'worker.tool_result');
  const awaitingTool =
    lastToolCall !== undefined &&
    (lastToolResult === undefined ||
     new Date(lastToolCall.host_observed_at).getTime() > new Date(lastToolResult.host_observed_at).getTime());
  const awaitingToolAgeS = awaitingTool && lastToolCall
    ? (now - new Date(lastToolCall.host_observed_at).getTime()) / 1000
    : null;

  // Active: recent tool calls
  if (toolCallsPerMin >= t.active_tool_calls_per_min) {
    return {
      kind: 'active',
      confidence: 0.95,
      observed_at: observedAt,
      primary_signal: 'tool_calls_per_min',
      supporting_signals: {
        tool_calls_per_min: toolCallsPerMin,
        last_event_age_s: Math.round(lastEventAge),
      },
      recommended_action: 'continue',
    };
  }

  // Filesystem mutation rate (host-supervisor signal)
  if (input.fs_mutations_last_60s !== undefined && input.fs_mutations_last_60s > 0) {
    return {
      kind: 'recent_filesystem_activity',
      confidence: 0.85,
      observed_at: observedAt,
      primary_signal: 'fs_mutations_last_60s',
      supporting_signals: {
        fs_mutations_last_60s: input.fs_mutations_last_60s,
        last_event_age_s: Math.round(lastEventAge),
      },
      recommended_action: 'continue',
      reason: 'no recent worker events but files in allowed_paths are being modified',
    };
  }

  // Awaiting tool: tool_call without tool_result for >quiet_warn_s
  if (awaitingTool && awaitingToolAgeS !== null && awaitingToolAgeS >= t.quiet_warn_s) {
    return {
      kind: 'awaiting_tool',
      confidence: 0.8,
      observed_at: observedAt,
      primary_signal: 'unmatched_tool_call',
      supporting_signals: {
        last_tool_call_age_s: Math.round(awaitingToolAgeS),
        last_tool_name: (lastToolCall?.payload as { tool_name?: string })?.tool_name,
      },
      recommended_action: awaitingToolAgeS > t.quiet_sigterm_s ? 'sigterm' : 'continue',
      reason: awaitingToolAgeS > t.quiet_sigterm_s
        ? `tool call unmatched for ${Math.round(awaitingToolAgeS)}s (>= sigterm threshold ${t.quiet_sigterm_s}s)`
        : `tool call still running for ${Math.round(awaitingToolAgeS)}s`,
    };
  }

  // Awaiting model: CPU low + recent network egress to anthropic
  const cpuLow = (input.container_cpu_pct ?? 100) < t.cpu_active_pct;
  const egressActive = (input.container_anthropic_egress_bytes_per_s ?? 0) > 0;
  if (cpuLow && egressActive) {
    return {
      kind: 'awaiting_model',
      confidence: 0.75,
      observed_at: observedAt,
      primary_signal: 'cpu_low_with_egress',
      supporting_signals: {
        container_cpu_pct: input.container_cpu_pct,
        anthropic_egress_bytes_per_s: input.container_anthropic_egress_bytes_per_s,
        last_event_age_s: Math.round(lastEventAge),
      },
      recommended_action: 'continue',
      reason: 'low CPU + active anthropic egress = waiting on model response',
    };
  }

  // Quiet for >sigterm threshold → recommend sigterm with low confidence
  if (lastEventAge > t.quiet_sigterm_s) {
    return {
      kind: 'no_recent_control_events',
      confidence: 0.5,
      observed_at: observedAt,
      primary_signal: 'last_event_age_s',
      supporting_signals: {
        last_event_age_s: Math.round(lastEventAge),
        threshold_s: t.quiet_sigterm_s,
      },
      recommended_action: 'sigterm',
      reason: `no events for ${Math.round(lastEventAge)}s (>= ${t.quiet_sigterm_s}s threshold) and no other progress signals`,
    };
  }

  // Quiet but not yet at sigterm threshold
  if (lastEventAge > t.quiet_warn_s) {
    return {
      kind: 'no_recent_control_events',
      confidence: 0.6,
      observed_at: observedAt,
      primary_signal: 'last_event_age_s',
      supporting_signals: {
        last_event_age_s: Math.round(lastEventAge),
        threshold_warn_s: t.quiet_warn_s,
        threshold_sigterm_s: t.quiet_sigterm_s,
      },
      recommended_action: 'log-warning',
      reason: `no events for ${Math.round(lastEventAge)}s (warn threshold)`,
    };
  }

  // Has SOME signal but no clear category
  return {
    kind: 'low_signal_active',
    confidence: 0.5,
    observed_at: observedAt,
    primary_signal: 'last_event_age_s',
    supporting_signals: {
      last_event_age_s: Math.round(lastEventAge),
      tool_calls_per_min: toolCallsPerMin,
    },
    recommended_action: 'continue',
  };
}
