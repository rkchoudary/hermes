/**
 * Persistent-state worker lease — FR-HARNESS-023.
 *
 * Per Codex prescription: METR-style "24h autonomy unlock" pattern. Workers
 * can pause/resume across session boundaries without losing state. The
 * harness can survive operator-side restarts, network partitions, and
 * worker-process crashes by reaping dead leases and letting fresh workers
 * pick up where the dead one left off.
 *
 * What this gives us beyond the existing acquireTaskLock:
 *   1. Heartbeat-renewable lease (vs. one-shot lock that expires)
 *   2. Cross-session work-state checkpoint (paused → resume from progress
 *      marker rather than restart from scratch)
 *   3. Dead-worker reaping based on heartbeat staleness
 *   4. Backend-agnostic: filesystem CAS for v0.x; Redis for production_use
 *
 * Schema (.agent-runs/leases/<run_id>/<task_id>.json):
 *   {
 *     task_id, run_id, holder_id, leased_at, last_heartbeat_at,
 *     ttl_seconds, work_state: { current_step, completed_steps[], progress_marker },
 *     status: 'leased' | 'paused' | 'completed' | 'abandoned'
 *   }
 *
 * The work.ts dispatcher reads the lease file (if any) and decides whether
 * to resume from progress_marker or start fresh. The lease is renewed every
 * heartbeat_interval_seconds (default 30) and reaped if stale > ttl_seconds.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { harnessRoot } from './harnessRoot';
import { atomicWriteFile } from './runState';

// ─── Schema ───────────────────────────────────────────────────────────────
export const WorkerLease = z.object({
  schema_version: z.literal('1').default('1'),
  task_id: z.string(),
  run_id: z.string(),
  /** Identifier of the holder: "<host>:<pid>:<random>" — unique per worker invocation. */
  holder_id: z.string(),
  /** ISO timestamp when the lease was first acquired. */
  leased_at: z.string(),
  /** ISO timestamp of the most recent heartbeat. Updated on each renew. */
  last_heartbeat_at: z.string(),
  /** Seconds after which a lease without heartbeat is reapable. */
  ttl_seconds: z.number().int().positive(),
  /** Optional progress marker — caller-defined opaque state. */
  work_state: z.object({
    current_step: z.string().optional(),
    completed_steps: z.array(z.string()).default([]),
    progress_marker: z.record(z.string(), z.unknown()).default({}),
  }).default({ completed_steps: [], progress_marker: {} }),
  status: z.enum(['leased', 'paused', 'completed', 'abandoned']),
});
export type WorkerLease = z.infer<typeof WorkerLease>;

// ─── Filesystem layout ────────────────────────────────────────────────────
function leasesDir(): string {
  return path.join(harnessRoot(), '.agent-runs', '_worker-leases');
}
function leasePath(runId: string, taskId: string): string {
  return path.join(leasesDir(), runId, `${taskId}.json`);
}

// ─── Helper: stable holder ID ─────────────────────────────────────────────
export function newHolderId(prefix = 'worker'): string {
  const host = os.hostname();
  const pid = process.pid;
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}:${host}:${pid}:${rand}`;
}

// ─── Read / write ─────────────────────────────────────────────────────────
export function readLease(runId: string, taskId: string): WorkerLease | null {
  const p = leasePath(runId, taskId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return WorkerLease.parse(raw);
  } catch {
    return null;
  }
}

function writeLease(lease: WorkerLease): void {
  const dir = path.dirname(leasePath(lease.run_id, lease.task_id));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(leasePath(lease.run_id, lease.task_id), JSON.stringify(lease, null, 2));
}

// ─── Acquire / renew / release ────────────────────────────────────────────
export interface AcquireOpts {
  task_id: string;
  run_id: string;
  holder_id: string;
  ttl_seconds?: number;
  /** Optional initial work_state (when resuming from a checkpoint). */
  work_state?: WorkerLease['work_state'];
}

export interface AcquireResult {
  acquired: boolean;
  lease?: WorkerLease;
  /** When refused: current holder + remaining TTL + status. */
  current_holder?: string;
  current_remaining_seconds?: number;
  current_status?: WorkerLease['status'];
  /** When previous lease was reaped (dead worker), the prior lease's progress
   *  marker is returned here so caller can decide to resume from it. */
  resumable_progress?: WorkerLease['work_state'];
}

const DEFAULT_TTL_SEC = 600; // 10 min

/**
 * Try to acquire a lease for the (run_id, task_id). Acquisition succeeds when:
 *   - No existing lease, OR
 *   - Existing lease is stale (now - last_heartbeat_at > ttl_seconds) and not
 *     in 'completed' status — caller takes over with resumable_progress
 *   - Existing lease is in 'paused' status (paused leases are explicitly
 *     resumable by anyone)
 *
 * Refuses when:
 *   - Live lease held by a different holder (heartbeat fresh, not paused)
 *   - Lease is in 'completed' status (work done; don't re-do)
 *   - Lease is in 'abandoned' status with no resume signal
 */
export function acquireLease(opts: AcquireOpts): AcquireResult {
  const ttl = opts.ttl_seconds ?? DEFAULT_TTL_SEC;
  const now = new Date();
  const existing = readLease(opts.run_id, opts.task_id);

  if (existing) {
    const elapsedSec = (now.getTime() - new Date(existing.last_heartbeat_at).getTime()) / 1000;
    const remaining = Math.max(0, existing.ttl_seconds - elapsedSec);

    // Completed: refuse — work is done
    if (existing.status === 'completed') {
      return {
        acquired: false,
        current_holder: existing.holder_id,
        current_remaining_seconds: remaining,
        current_status: 'completed',
      };
    }

    // Paused: anyone can resume (intent-to-handoff)
    if (existing.status === 'paused') {
      const lease = WorkerLease.parse({
        ...existing,
        holder_id: opts.holder_id,
        leased_at: now.toISOString(),
        last_heartbeat_at: now.toISOString(),
        ttl_seconds: ttl,
        status: 'leased',
        work_state: opts.work_state ?? existing.work_state,
      });
      writeLease(lease);
      return { acquired: true, lease, resumable_progress: existing.work_state };
    }

    // Stale lease: reap if heartbeat too old
    if (elapsedSec > existing.ttl_seconds) {
      const lease = WorkerLease.parse({
        schema_version: '1',
        task_id: opts.task_id,
        run_id: opts.run_id,
        holder_id: opts.holder_id,
        leased_at: now.toISOString(),
        last_heartbeat_at: now.toISOString(),
        ttl_seconds: ttl,
        work_state: opts.work_state ?? existing.work_state,
        status: 'leased',
      });
      writeLease(lease);
      return { acquired: true, lease, resumable_progress: existing.work_state };
    }

    // Fresh live lease held by someone else: refuse
    return {
      acquired: false,
      current_holder: existing.holder_id,
      current_remaining_seconds: remaining,
      current_status: existing.status,
    };
  }

  // No existing lease — fresh acquisition
  const lease = WorkerLease.parse({
    schema_version: '1',
    task_id: opts.task_id,
    run_id: opts.run_id,
    holder_id: opts.holder_id,
    leased_at: now.toISOString(),
    last_heartbeat_at: now.toISOString(),
    ttl_seconds: ttl,
    work_state: opts.work_state ?? { completed_steps: [], progress_marker: {} },
    status: 'leased',
  });
  writeLease(lease);
  return { acquired: true, lease };
}

export interface RenewOpts {
  task_id: string;
  run_id: string;
  holder_id: string;
  /** Optional progress update merged into work_state. */
  progress_update?: Partial<WorkerLease['work_state']>;
  /** Optional completed_step to push onto completed_steps[]. */
  completed_step?: string;
}

export interface RenewResult {
  ok: boolean;
  lease?: WorkerLease;
  reason?: string;
}

/**
 * Renew a held lease. Atomic via filesystem stat+rename; refuses if the
 * holder mismatches. Optionally accepts progress updates so the caller
 * can checkpoint without a separate write.
 */
export function renewLease(opts: RenewOpts): RenewResult {
  const existing = readLease(opts.run_id, opts.task_id);
  if (!existing) {
    return { ok: false, reason: `No lease found for ${opts.task_id}` };
  }
  if (existing.holder_id !== opts.holder_id) {
    return { ok: false, reason: `Holder mismatch: lease held by ${existing.holder_id}, you are ${opts.holder_id}` };
  }
  if (existing.status !== 'leased') {
    return { ok: false, reason: `Cannot renew lease with status="${existing.status}"` };
  }
  const now = new Date();
  const updatedWorkState: WorkerLease['work_state'] = {
    current_step: opts.progress_update?.current_step ?? existing.work_state.current_step,
    completed_steps: opts.completed_step
      ? [...existing.work_state.completed_steps, opts.completed_step]
      : (opts.progress_update?.completed_steps ?? existing.work_state.completed_steps),
    progress_marker: { ...existing.work_state.progress_marker, ...(opts.progress_update?.progress_marker ?? {}) },
  };
  const lease = WorkerLease.parse({
    ...existing,
    last_heartbeat_at: now.toISOString(),
    work_state: updatedWorkState,
  });
  writeLease(lease);
  return { ok: true, lease };
}

/**
 * Pause a held lease so another worker (or the same worker after
 * restart) can pick it up. The progress marker is preserved.
 */
export function pauseLease(runId: string, taskId: string, holderId: string, reason?: string): RenewResult {
  const existing = readLease(runId, taskId);
  if (!existing) return { ok: false, reason: 'No lease' };
  if (existing.holder_id !== holderId) {
    return { ok: false, reason: `Holder mismatch (lease held by ${existing.holder_id})` };
  }
  const lease = WorkerLease.parse({ ...existing, status: 'paused', last_heartbeat_at: new Date().toISOString() });
  writeLease(lease);
  return { ok: true, lease };
}

/**
 * Mark lease as completed — successor workers will refuse to re-acquire.
 */
export function completeLease(runId: string, taskId: string, holderId: string): RenewResult {
  const existing = readLease(runId, taskId);
  if (!existing) return { ok: false, reason: 'No lease' };
  if (existing.holder_id !== holderId) {
    return { ok: false, reason: `Holder mismatch (lease held by ${existing.holder_id})` };
  }
  const lease = WorkerLease.parse({ ...existing, status: 'completed', last_heartbeat_at: new Date().toISOString() });
  writeLease(lease);
  return { ok: true, lease };
}

/**
 * Abandon a lease (worker giving up). Allows another worker to take over
 * via acquireLease's stale-lease path or if explicitly resumed.
 */
export function abandonLease(runId: string, taskId: string, holderId: string, reason: string): RenewResult {
  const existing = readLease(runId, taskId);
  if (!existing) return { ok: false, reason: 'No lease' };
  if (existing.holder_id !== holderId) {
    return { ok: false, reason: `Holder mismatch (lease held by ${existing.holder_id})` };
  }
  const lease = WorkerLease.parse({
    ...existing,
    status: 'abandoned',
    last_heartbeat_at: new Date().toISOString(),
    work_state: {
      ...existing.work_state,
      progress_marker: { ...existing.work_state.progress_marker, abandon_reason: reason },
    },
  });
  writeLease(lease);
  return { ok: true, lease };
}

// ─── Reaping ──────────────────────────────────────────────────────────────
export interface ReapResult {
  scanned: number;
  stale: WorkerLease[];
  reaped: number;
}

/**
 * Walk all leases under .agent-runs/_worker-leases/ and identify stale ones.
 * Caller decides what to do (delete, mark abandoned, notify operator).
 *
 * "Stale" = status='leased' AND last_heartbeat older than ttl_seconds.
 * The default action is read-only: returns the stale list without mutating.
 *
 * Pass opts.markAbandoned=true to flip stale leases to 'abandoned' so the
 * acquireLease path can pick them up cleanly.
 */
export function scanStaleLeases(opts?: { markAbandoned?: boolean }): ReapResult {
  const dir = leasesDir();
  if (!fs.existsSync(dir)) return { scanned: 0, stale: [], reaped: 0 };
  const stale: WorkerLease[] = [];
  let scanned = 0;
  function walk(d: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.json')) {
        scanned++;
        try {
          const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
          const lease = WorkerLease.parse(raw);
          if (lease.status !== 'leased') continue;
          const elapsedSec = (Date.now() - new Date(lease.last_heartbeat_at).getTime()) / 1000;
          if (elapsedSec > lease.ttl_seconds) {
            stale.push(lease);
          }
        } catch { /* skip malformed */ }
      }
    }
  }
  walk(dir);
  let reaped = 0;
  if (opts?.markAbandoned) {
    for (const lease of stale) {
      const updated = WorkerLease.parse({
        ...lease,
        status: 'abandoned',
        work_state: {
          ...lease.work_state,
          progress_marker: {
            ...lease.work_state.progress_marker,
            reaper_marked_abandoned: true,
            reaper_at: new Date().toISOString(),
          },
        },
      });
      writeLease(updated);
      reaped++;
    }
  }
  return { scanned, stale, reaped };
}
