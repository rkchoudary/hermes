/**
 * Pillar 1 (PA1) — Canonical HermesWorkerEvent schema.
 *
 * Doctrine 9 (Codex 2026-05-03): "Worker telemetry is never authoritative
 * until host-stamped, schema-validated, and durably recorded. All
 * observability, audit, liveness, and recovery flows derive from the
 * host-owned event ledger — never from worker-adjacent files. Worker
 * output is untrusted ingestion until validated."
 *
 * Every observable event in the harness — worker tool calls, container
 * heartbeats, host filesystem mutations, control-plane decisions —
 * normalizes into this single envelope before being persisted.
 *
 * Source-of-truth properties:
 *   - host_observed_at: stamped by the host at ingestion. The audit
 *     timeline is the host's clock, not the worker's.
 *   - worker_emitted_at: nullable. Only set when a worker explicitly
 *     reported a timestamp (e.g. claude's stream-json events). Used for
 *     latency/clock-skew analysis, never for ordering.
 *   - monotonic_seq: per (tenant, task_id) increasing sequence stamped
 *     at ingestion. Gap detection on the consumer side.
 *   - source: who said it. 'worker' = untrusted ingestion stamped by
 *     host. 'host-supervisor' = host observed (docker stats, fs change,
 *     network I/O). 'control-plane' = the harness itself emitted
 *     (dispatch decisions, kill events, manifest commits).
 *   - prev_chain_hash + chain_hash: sha256 chain. Tamper-evident.
 *
 * Versioning: schema_version is hardcoded to '1' for now. When we need
 * to break the schema, we add HermesWorkerEventV2 with adapter; v1
 * stays readable forever (replay/audit doesn't break).
 */
import * as crypto from 'node:crypto';
import { z } from 'zod';

export const SCHEMA_VERSION = '1' as const;

/** All known event kinds. Keep this enum closed — adding a new event
 *  type is a control-plane API change. */
export const HermesWorkerEventKind = z.enum([
  // ── worker-emitted (transformed from engine adapters) ────────────
  'worker.tool_call',          // claude/codex called a tool (Read/Edit/Bash/...)
  'worker.tool_result',        // tool returned (success/error)
  'worker.message_start',      // engine started authoring a message
  'worker.message_stop',       // engine finished a message
  'worker.error',              // engine reported an error
  'worker.session_init',       // engine session started
  'worker.session_end',        // engine session ended (success/failure)

  // ── host-supervisor-observed (docker / filesystem / network) ────
  'host.heartbeat',            // periodic liveness from in-container wrapper
  'host.docker_state_changed', // 'starting' | 'running' | 'exited'
  'host.docker_stats',         // CPU%, memory, network I/O sample
  'host.fs_mutation_observed', // file in allowed_paths created/modified/deleted
  'host.network_io',           // bytes in/out to api.anthropic.com

  // ── control-plane-emitted (the harness deciding things) ─────────
  'cp.dispatch_started',
  'cp.dispatch_finished',
  'cp.liveness_assessed',      // every assessLiveness() call records its verdict
  'cp.kill_decided',           // first-class "why was this worker killed"
  'cp.evidence_manifest_emitted',
  'cp.budget_reserved',
  'cp.budget_recorded',
  'cp.budget_refused',
  'cp.gate_decided',           // postflight/verify-claims/codex verdicts
]);
export type HermesWorkerEventKind = z.infer<typeof HermesWorkerEventKind>;

export const HermesEventSource = z.enum([
  'worker',                    // worker emitted, host-stamped at ingest
  'host-supervisor',           // host observed independently
  'control-plane',             // harness itself emitted
]);
export type HermesEventSource = z.infer<typeof HermesEventSource>;

/**
 * The canonical event envelope. ALL persisted events match this shape.
 */
export const HermesWorkerEventV1 = z.object({
  schema_version: z.literal(SCHEMA_VERSION),

  // Identity
  event_id: z.string().uuid(),
  tenant_id: z.string().min(1),                  // 'default' for single-operator
  correlation_id: z.string().uuid(),             // joins related events (e.g. one tool call's start+end)
  task_id: z.string().optional(),
  run_id: z.string().optional(),

  // Ordering — host-stamped, monotonic per (tenant, task_id)
  monotonic_seq: z.number().int().nonnegative(),
  host_observed_at: z.string(),                  // ISO8601 host wall clock
  worker_emitted_at: z.string().nullable(),      // ISO8601, only when worker reported

  // Provenance + content
  source: HermesEventSource,
  kind: HermesWorkerEventKind,
  payload: z.record(z.unknown()),

  // Tamper-evidence
  prev_chain_hash: z.string(),                   // sha256 hex of prior event's chain_hash; '0'.repeat(64) for first
  chain_hash: z.string(),                        // sha256(prev_chain_hash + canonical(this event without chain_hash))

  // Provenance + replay
  harness_version: z.string(),                   // commit SHA or harness-prod tag at emit time
  /** Optional: which engine/tool/process generated this if 'worker'. */
  emitter_id: z.string().optional(),
  /** Optional: container ID + image digest (host-supervisor stamps these for worker events). */
  container_id: z.string().optional(),
  image_digest: z.string().optional(),
});
export type HermesWorkerEventV1 = z.infer<typeof HermesWorkerEventV1>;

// ─── Construction helpers ───────────────────────────────────────────────

/**
 * Canonical JSON for chain-hash computation. Uses sorted keys + no
 * insignificant whitespace so two events with the same logical content
 * produce the same hash.
 */
function canonicalize(obj: Record<string, unknown>): string {
  const keys = Object.keys(obj).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}

/**
 * Compute the chain_hash for a partial event. Caller passes the event
 * WITHOUT chain_hash (the prev_chain_hash is included). Returns the
 * sha256 hex digest.
 */
export function computeChainHash(eventWithoutChainHash: Omit<HermesWorkerEventV1, 'chain_hash'>): string {
  return crypto.createHash('sha256').update(canonicalize(eventWithoutChainHash as Record<string, unknown>)).digest('hex');
}

export const GENESIS_CHAIN_HASH = '0'.repeat(64);

export interface BuildEventInput {
  tenant_id?: string;             // default 'default'
  correlation_id?: string;        // default fresh uuid
  task_id?: string;
  run_id?: string;
  monotonic_seq: number;
  host_observed_at?: string;      // default now
  worker_emitted_at?: string | null;
  source: HermesEventSource;
  kind: HermesWorkerEventKind;
  payload: Record<string, unknown>;
  prev_chain_hash: string;
  harness_version: string;
  emitter_id?: string;
  container_id?: string;
  image_digest?: string;
}

/**
 * Build a fully-validated event. Caller is responsible for providing
 * a monotonic_seq (one larger than the last persisted event for this
 * task) and the prev_chain_hash. The collector handles both.
 */
export function buildEvent(input: BuildEventInput): HermesWorkerEventV1 {
  const eventWithoutChainHash: Omit<HermesWorkerEventV1, 'chain_hash'> = {
    schema_version: SCHEMA_VERSION,
    event_id: crypto.randomUUID(),
    tenant_id: input.tenant_id ?? 'default',
    correlation_id: input.correlation_id ?? crypto.randomUUID(),
    task_id: input.task_id,
    run_id: input.run_id,
    monotonic_seq: input.monotonic_seq,
    host_observed_at: input.host_observed_at ?? new Date().toISOString(),
    worker_emitted_at: input.worker_emitted_at ?? null,
    source: input.source,
    kind: input.kind,
    payload: input.payload,
    prev_chain_hash: input.prev_chain_hash,
    harness_version: input.harness_version,
    emitter_id: input.emitter_id,
    container_id: input.container_id,
    image_digest: input.image_digest,
  };
  const chain_hash = computeChainHash(eventWithoutChainHash);
  const event: HermesWorkerEventV1 = { ...eventWithoutChainHash, chain_hash };
  return HermesWorkerEventV1.parse(event);
}

/**
 * Strip chain_hash from an event for re-hash verification. Pure function;
 * doesn't mutate input. Returns the partial that computeChainHash expects.
 */
function stripChainHash(ev: HermesWorkerEventV1): Omit<HermesWorkerEventV1, 'chain_hash'> {
  const { chain_hash: _omit, ...rest } = ev;
  void _omit;
  return rest;
}

export interface ChainVerificationResult {
  ok: boolean;
  /** -1 on success; index of first broken link otherwise. */
  broken_at_index: number;
  /** Specific failure mode: 'genesis-mismatch' | 'prev-hash-mismatch' | 'self-hash-mismatch'. */
  reason?: 'genesis-mismatch' | 'prev-hash-mismatch' | 'self-hash-mismatch';
  /** event_id of the broken event (for forensic surfacing). */
  broken_event_id?: string;
}

/**
 * Verify the chain integrity of a sequence of events. Returns
 * structured result with failure-mode classification — used by:
 *   - replay tests
 *   - evidence pack export (proves no event was tampered post-hoc)
 *   - drain CLI (refuses to act on a task whose event log is corrupt)
 *
 * Hardened: distinguishes between genesis violations, broken prev_hash
 * links, and self-hash mismatches (last is the strongest tamper signal —
 * an attacker rewrote the event but left the chain).
 */
export function verifyChain(events: HermesWorkerEventV1[]): ChainVerificationResult {
  if (events.length === 0) return { ok: true, broken_at_index: -1 };
  if (events[0].prev_chain_hash !== GENESIS_CHAIN_HASH) {
    return {
      ok: false,
      broken_at_index: 0,
      reason: 'genesis-mismatch',
      broken_event_id: events[0].event_id,
    };
  }
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    // Link to predecessor
    if (i > 0 && ev.prev_chain_hash !== events[i - 1].chain_hash) {
      return {
        ok: false,
        broken_at_index: i,
        reason: 'prev-hash-mismatch',
        broken_event_id: ev.event_id,
      };
    }
    // Self-hash integrity
    const recomputed = computeChainHash(stripChainHash(ev));
    if (recomputed !== ev.chain_hash) {
      return {
        ok: false,
        broken_at_index: i,
        reason: 'self-hash-mismatch',
        broken_event_id: ev.event_id,
      };
    }
  }
  return { ok: true, broken_at_index: -1 };
}

/**
 * Validate an event's structure WITHOUT chain context. Used at ingestion
 * boundary by the collector when first parsing a worker-emitted line.
 * Throws ZodError on invalid; returns the validated event on success.
 */
export function parseEvent(raw: unknown): HermesWorkerEventV1 {
  return HermesWorkerEventV1.parse(raw);
}

/**
 * Try-parse variant for ingestion paths where invalid events should be
 * dropped/quarantined, not crash the collector.
 */
export interface ParseResult {
  ok: boolean;
  event?: HermesWorkerEventV1;
  error?: string;
}
export function tryParseEvent(raw: unknown): ParseResult {
  try {
    return { ok: true, event: HermesWorkerEventV1.parse(raw) };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
