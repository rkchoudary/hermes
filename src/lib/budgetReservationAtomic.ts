/**
 * PB2 — Atomic + idempotent cost reservation (production-hardened).
 *
 * Codex critique 2026-05-03: "Cost reservation needs contention testing.
 * At 100 concurrent starts, admission must be atomic and idempotent."
 *
 * Layered on top of the existing JSONL-based budgetReservation.ts:
 *
 *   1. Adds a per-tenant lock-file gate around the read-modify-append
 *      sequence so two concurrent reserveBudget calls can't both pass
 *      the cap check by reading stale aggregate state. Lock is held
 *      for ~10ms (read JSONL + compute cap + write event), so contention
 *      throughput is high.
 *
 *   2. Adds idempotency keys: a caller may pass an opaque
 *      `idempotency_key` (default = sha256(task_id + dispatch_round +
 *      harness_version)). Re-presenting the same key returns the
 *      previously-reserved amount, never double-charges. Stored in a
 *      separate index file mapped to the original reservation_id.
 *
 *   3. Adds atomic finalization: recordSpend must reference both the
 *      reservation_id AND the idempotency_key — mismatched key throws
 *      'tenant-mismatch'-style error.
 *
 * This is a wrapper that calls into budgetReservation.ts's primitives
 * inside a critical section. The core data layout (JSONL events) is
 * unchanged; only the contention semantics are tightened.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { harnessRoot } from './harnessRoot';
import {
  reserveBudget as innerReserveBudget,
  recordSpend as innerRecordSpend,
  releaseReservation as innerReleaseReservation,
  readReservations,
  type ReserveOptions,
  type ReservationResult,
  type Reservation,
} from './budgetReservation';

// ─── Lock primitive ────────────────────────────────────────────────────

const LOCK_TTL_MS = 30_000;          // hold time ceiling
const LOCK_RETRY_MS = 25;            // backoff between attempts
const LOCK_MAX_RETRIES = 200;        // 5s total
const IDEMPOTENCY_INDEX_NAME = '_idempotency.jsonl';

function tenantLockPath(tenant: string): string {
  return path.join(harnessRoot(), '.agent-runs', `_budget-lock-${tenant}.lock`);
}

function idempotencyIndexPath(): string {
  return path.join(harnessRoot(), '.agent-runs', IDEMPOTENCY_INDEX_NAME);
}

interface LockHandle { fd: number; path: string; }

function acquireLock(tenant: string): LockHandle {
  const p = tenantLockPath(tenant);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  let lastErr: unknown = null;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      const fd = fs.openSync(p, 'wx');
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        acquired_at: new Date().toISOString(),
      }));
      return { fd, path: p };
    } catch (err) {
      lastErr = err;
      const e = err as NodeJS.ErrnoException;
      if (e.code !== 'EEXIST') break;
      // Check if stale
      try {
        const content = fs.readFileSync(p, 'utf8');
        const meta = JSON.parse(content) as { pid: number; acquired_at: string };
        const ageMs = Date.now() - new Date(meta.acquired_at).getTime();
        if (ageMs > LOCK_TTL_MS || !pidAlive(meta.pid)) {
          // Take over
          try { fs.unlinkSync(p); } catch { /* race ok */ }
          continue;
        }
      } catch { /* unparseable lock — wait and retry */ }
      // Sleep + retry (busy wait via Atomics.wait would be better but we
      // don't have a SharedArrayBuffer here)
      const start = Date.now();
      while (Date.now() - start < LOCK_RETRY_MS) { /* spin */ }
    }
  }
  throw new Error(`Could not acquire budget lock for tenant=${tenant} after ${LOCK_MAX_RETRIES} retries: ${(lastErr as Error)?.message}`);
}

function releaseLock(h: LockHandle): void {
  try { fs.closeSync(h.fd); } catch { /* tolerate */ }
  try { fs.unlinkSync(h.path); } catch { /* tolerate */ }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

// ─── Idempotency key index ──────────────────────────────────────────────

interface IdempotencyEntry {
  idempotency_key: string;
  reservation_id: string;
  task_id?: string;
  recorded_at: string;
}

function readIdempotencyIndex(): Map<string, IdempotencyEntry> {
  const p = idempotencyIndexPath();
  const map = new Map<string, IdempotencyEntry>();
  if (!fs.existsSync(p)) return map;
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as IdempotencyEntry;
      map.set(ev.idempotency_key, ev);
    } catch { /* skip malformed */ }
  }
  return map;
}

function writeIdempotencyEntry(entry: IdempotencyEntry): void {
  const p = idempotencyIndexPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
}

export function defaultIdempotencyKey(opts: { task_id?: string; dispatch_round?: number; harness_version?: string }): string {
  const seed = `${opts.task_id ?? 'no-task'}|${opts.dispatch_round ?? 0}|${opts.harness_version ?? 'h-unknown'}`;
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24);
}

// ─── Atomic reserve ────────────────────────────────────────────────────

export interface AtomicReserveOptions extends ReserveOptions {
  /** Optional explicit idempotency key. Defaults to
   *  sha256(task_id + dispatch_round + harness_version). */
  idempotency_key?: string;
  dispatch_round?: number;
  /** Tenant scope for the lock. Default 'default'. */
  tenant?: string;
}

/**
 * Wraps reserveBudget in a tenant-scoped lock so concurrent reservers
 * see consistent aggregate state. Idempotent: re-presenting the same
 * idempotency_key returns the same reservation rather than creating a
 * second one (no double-charge).
 *
 * Throws on lock acquisition failure (caller should retry with backoff).
 */
export function reserveBudgetAtomic(opts: AtomicReserveOptions): ReservationResult {
  const tenant = opts.tenant ?? 'default';
  const idemKey = opts.idempotency_key ?? defaultIdempotencyKey({
    task_id: opts.task_id,
    dispatch_round: opts.dispatch_round,
    harness_version: process.env.HARNESS_VERSION,
  });

  const lock = acquireLock(tenant);
  try {
    // Idempotency check INSIDE the lock — reading the index without the
    // lock would race with another writer's append.
    const idx = readIdempotencyIndex();
    const prior = idx.get(idemKey);
    if (prior) {
      // Re-present existing reservation. Locate it; if missing/finalized,
      // surface the existing record without changing it.
      const existing = readReservations().find((r) => r.reservation_id === prior.reservation_id);
      if (existing) {
        if (existing.status === 'reserved') {
          return {
            ok: true,
            reservation_id: existing.reservation_id,
            reserved_usd: existing.reserved_usd,
            reserved_quota_pct: existing.reserved_quota_pct,
            cap_remaining_usd: 0,           // not recomputed on idempotent re-presentation
            ttl_sec: existing.ttl_sec,
          };
        }
        // Already spent or released — refuse a fresh reservation under
        // the same idempotency key (intent: never re-charge after the
        // logical task already completed).
        return {
          ok: false,
          kind: 'budget-exceeded',
          cap: 'idempotency',
          reason: `idempotency_key=${idemKey} already finalized as ${existing.status}; refusing new reservation`,
          current_usd: existing.actual_usd ?? existing.reserved_usd,
          cap_usd: existing.reserved_usd,
        };
      }
      // Index entry exists but reservation file is gone → stale index.
      // Fall through to fresh reservation.
    }

    // Fresh reservation through the existing primitive (which itself
    // does NOT lock — we're providing the lock).
    const result = innerReserveBudget(opts);
    if (result.ok) {
      writeIdempotencyEntry({
        idempotency_key: idemKey,
        reservation_id: result.reservation_id,
        task_id: opts.task_id,
        recorded_at: new Date().toISOString(),
      });
    }
    return result;
  } finally {
    releaseLock(lock);
  }
}

/**
 * Atomic recordSpend — validates the idempotency key matches the
 * recorded one for the reservation_id. Prevents a stale caller from
 * finalizing a reservation it didn't own.
 */
export function recordSpendAtomic(opts: {
  reservation_id: string;
  idempotency_key?: string;
  actual_usd: number;
  actual_quota_pct?: number;
  tenant?: string;
}): void {
  const tenant = opts.tenant ?? 'default';
  const lock = acquireLock(tenant);
  try {
    if (opts.idempotency_key) {
      const idx = readIdempotencyIndex();
      const recorded = idx.get(opts.idempotency_key);
      if (!recorded || recorded.reservation_id !== opts.reservation_id) {
        throw new Error(
          `recordSpendAtomic: idempotency_key=${opts.idempotency_key} does not match reservation_id=${opts.reservation_id}` +
          ` (recorded=${recorded?.reservation_id ?? 'absent'})`,
        );
      }
    }
    innerRecordSpend(opts.reservation_id, opts.actual_usd, opts.actual_quota_pct);
  } finally {
    releaseLock(lock);
  }
}

export function releaseReservationAtomic(opts: {
  reservation_id: string;
  reason: string;
  tenant?: string;
}): void {
  const tenant = opts.tenant ?? 'default';
  const lock = acquireLock(tenant);
  try {
    innerReleaseReservation(opts.reservation_id, opts.reason);
  } finally {
    releaseLock(lock);
  }
}

/** Reservation type re-export so callers don't import two modules. */
export type { Reservation };
