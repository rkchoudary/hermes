/**
 * Layer 0.A — Typed outcome envelope (factory-floor doctrine).
 *
 * Every driver-callable stage MUST return a StageOutcome envelope so the
 * driver can route on business outcome instead of guessing from exit code.
 *
 * Doctrine: "The driver never infers semantics from exit code alone."
 * Exit code = transport success / process crash. Business outcome lives in
 * the typed envelope on stdout.
 *
 * Wire format: stage CLIs emit the envelope as a single line of JSON
 * prefixed with the magic marker `__STAGE_OUTCOME__::` so it can be picked
 * out of mixed stdout (logs + envelope). Drivers parse the LAST such line
 * (in case the stage emits more than one over its lifetime; the last one
 * wins). When no envelope is found and no exit-code crash signal is set,
 * the driver synthesizes an `infrastructure-error` envelope and routes to
 * the operator.
 *
 * Schema-validated via zod (already a project dependency).
 */
import { z } from 'zod';

export const STAGE_OUTCOME_MAGIC = '__STAGE_OUTCOME__::';
export const ENVELOPE_VERSION = 1 as const;

/**
 * Outcome categories. The driver routes on `kind` × `driver_action`.
 *
 * - `success` — stage produced its intended output cleanly
 * - `gate-pass` — gate stage (postflight, verify-claims, security-check)
 *   ran cleanly and PASSED its checks
 * - `gate-fail` — gate stage ran cleanly and FAILED its checks (real
 *   defect detected; driver may patch-round)
 * - `precondition-fail` — stage cannot run because its inputs are wrong
 *   shape (the F2-class bug — postflight couldn't infer artifact path).
 *   Driver marks the gate BROKEN, not the task FAILED.
 * - `policy-refusal` — RBAC, SoD, identity, intake-not-approved (F1-class).
 *   Driver pauses the module and surfaces actionable remediation.
 * - `budget-exceeded` — L1 admission denied. Driver pauses fanout.
 * - `worker-error` — LLM crash, network failure, timeout (B1-class).
 *   `retryable` distinguishes transient from terminal.
 * - `infrastructure-error` — disk full, git lock, gh CLI unauthenticated.
 *   Operator action required.
 * - `harness-bug` — contract violation (e.g., stage produced output
 *   inconsistent with its registry contract). Block fanout immediately.
 */
export const StageOutcomeKind = z.enum([
  'success',
  'gate-pass',
  'gate-fail',
  'precondition-fail',
  'policy-refusal',
  'budget-exceeded',
  'worker-error',
  'infrastructure-error',
  'harness-bug',
]);
export type StageOutcomeKind = z.infer<typeof StageOutcomeKind>;

/**
 * Driver decision recommendation. The stage tells the driver what action
 * makes sense; the driver may override based on policy (e.g., a stuck
 * module in fanout may park instead of patch-round per WIP limits).
 */
export const DriverAction = z.enum([
  'advance',          // green path — move to next stage
  'patch-round',      // gate-fail with retryable diagnosis
  'park',             // 3-strike rule or non-retryable failure
  'mark-gate-broken', // precondition-fail — DO NOT retry until gate fixed
  'requeue',          // transient infrastructure issue, try later
  'pause-fanout',     // budget-exceeded or harness-bug
  'abandon',          // terminal failure, no recovery possible
]);
export type DriverAction = z.infer<typeof DriverAction>;

export const EvidenceRef = z.object({
  kind: z.string(),                // 'diff-patch' | 'test-summary' | 'verify-claims' | …
  path: z.string().optional(),     // relative to evidence_dir
  sha256: z.string().optional(),   // populated by L9 when content-addressed
});
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const StageOutcomeMetrics = z.object({
  duration_ms: z.number().nonnegative(),
  tokens: z.number().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  /** For subscription-billed engines (claude max plan), report quota %. */
  quota_pct: z.number().min(0).max(100).optional(),
});
export type StageOutcomeMetrics = z.infer<typeof StageOutcomeMetrics>;

export const StageOutcome = z.object({
  envelope_version: z.literal(ENVELOPE_VERSION),
  stage: z.string(),               // 'auto:postflight', 'auto:work', …
  task_id: z.string().optional(),  // omitted for stages that aren't task-bound
  run_id: z.string().optional(),
  ok: z.boolean(),
  kind: StageOutcomeKind,
  retryable: z.boolean(),
  driver_action: DriverAction,
  reason: z.string(),              // human-readable; ≤500 chars
  evidence: z.array(EvidenceRef).default([]),
  metrics: StageOutcomeMetrics,
  /** Optional structured details — kind-specific payload. */
  details: z.record(z.unknown()).optional(),
  /** ISO8601. */
  emitted_at: z.string(),
  /** Harness commit SHA that produced this envelope (set by emitStageOutcome). */
  harness_version: z.string().optional(),
});
export type StageOutcome = z.infer<typeof StageOutcome>;

// ─── Emitting (stage side) ───────────────────────────────────────────────

/**
 * Stage CLIs call this as their last action. Writes a single JSON line to
 * stdout prefixed with the magic marker. The driver picks it up.
 *
 * Idempotent — calling twice emits two lines; the LAST one is authoritative
 * per parser semantics.
 */
export function emitStageOutcome(outcome: Omit<StageOutcome, 'envelope_version' | 'emitted_at' | 'harness_version'>): void {
  const enriched: StageOutcome = {
    envelope_version: ENVELOPE_VERSION,
    emitted_at: new Date().toISOString(),
    harness_version: harnessVersionMarker(),
    ...outcome,
  };
  const validated = StageOutcome.parse(enriched);
  // Single line, no internal newlines, so a tail-line parse is unambiguous.
  process.stdout.write(`\n${STAGE_OUTCOME_MAGIC}${JSON.stringify(validated)}\n`);
}

/**
 * Convenience emitter for the green path. Most stages will call this.
 */
export function emitSuccess(opts: {
  stage: string;
  task_id?: string;
  run_id?: string;
  reason: string;
  evidence?: EvidenceRef[];
  metrics: StageOutcomeMetrics;
  details?: Record<string, unknown>;
}): void {
  emitStageOutcome({
    stage: opts.stage,
    task_id: opts.task_id,
    run_id: opts.run_id,
    ok: true,
    kind: 'success',
    retryable: false,
    driver_action: 'advance',
    reason: opts.reason,
    evidence: opts.evidence ?? [],
    metrics: opts.metrics,
    details: opts.details,
  });
}

/**
 * Convenience emitter for `precondition-fail` (the F2 class). Stage cannot
 * run because of a structural input issue. Driver should mark gate broken
 * and surface to operator — NOT retry the same way.
 */
export function emitPreconditionFail(opts: {
  stage: string;
  task_id?: string;
  reason: string;
  details?: Record<string, unknown>;
  metrics?: StageOutcomeMetrics;
}): void {
  emitStageOutcome({
    stage: opts.stage,
    task_id: opts.task_id,
    ok: false,
    kind: 'precondition-fail',
    retryable: false,
    driver_action: 'mark-gate-broken',
    reason: opts.reason,
    evidence: [],
    metrics: opts.metrics ?? { duration_ms: 0 },
    details: opts.details,
  });
}

/**
 * Convenience emitter for `policy-refusal` (the F1 class). RBAC, SoD,
 * intake-not-approved. Driver should NOT retry; needs operator intervention.
 */
export function emitPolicyRefusal(opts: {
  stage: string;
  task_id?: string;
  reason: string;
  remediation?: string;
  metrics?: StageOutcomeMetrics;
}): void {
  emitStageOutcome({
    stage: opts.stage,
    task_id: opts.task_id,
    ok: false,
    kind: 'policy-refusal',
    retryable: false,
    driver_action: 'pause-fanout',
    reason: opts.reason,
    evidence: [],
    metrics: opts.metrics ?? { duration_ms: 0 },
    details: opts.remediation ? { remediation: opts.remediation } : undefined,
  });
}

// ─── Parsing (driver side) ───────────────────────────────────────────────

/**
 * Scan stdout for the LAST stage-outcome envelope. Returns null if none
 * found (driver should treat as `infrastructure-error` synthetic envelope
 * and route to operator).
 */
export function parseLastStageOutcome(stdout: string): StageOutcome | null {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const idx = line.indexOf(STAGE_OUTCOME_MAGIC);
    if (idx === -1) continue;
    const json = line.slice(idx + STAGE_OUTCOME_MAGIC.length);
    try {
      const parsed = JSON.parse(json);
      return StageOutcome.parse(parsed);
    } catch {
      // malformed envelope — keep looking; older line might be valid
      continue;
    }
  }
  return null;
}

/**
 * Synthetic envelope for the missing-envelope case. Driver calls this
 * when a stage exited without emitting an outcome — typically a process
 * crash. The driver should treat this as a hard infrastructure issue.
 */
export function synthesizeInfrastructureError(opts: {
  stage: string;
  task_id?: string;
  exit_code: number | null;
  reason: string;
  duration_ms: number;
}): StageOutcome {
  return {
    envelope_version: ENVELOPE_VERSION,
    stage: opts.stage,
    task_id: opts.task_id,
    ok: false,
    kind: 'infrastructure-error',
    retryable: true,
    driver_action: 'requeue',
    reason: `[synthetic] ${opts.reason} (exit=${opts.exit_code ?? 'null'})`,
    evidence: [],
    metrics: { duration_ms: opts.duration_ms },
    emitted_at: new Date().toISOString(),
    harness_version: harnessVersionMarker(),
  };
}

// ─── Harness version marker ──────────────────────────────────────────────

let _cachedVersion: string | null = null;
function harnessVersionMarker(): string {
  if (_cachedVersion !== null) return _cachedVersion;
  // Best-effort short SHA from HEAD; falls back to timestamp if git unavailable.
  try {
    const { execSync } = require('node:child_process');
    const sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: __dirname, timeout: 1000 }).trim();
    _cachedVersion = `h-${sha}`;
  } catch {
    _cachedVersion = `h-unknown-${Date.now()}`;
  }
  return _cachedVersion;
}
