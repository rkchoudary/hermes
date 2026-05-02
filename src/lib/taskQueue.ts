/**
 * Task queue — cross-task path-overlap coordination.
 *
 * Operator gap-roadmap item #6 (2026-04-28): path-overlap detection in
 * `checkPathOverlapAgainstInFlight` correctly catches overlap (TP-101 vs
 * TP-102/103/111/112 all touching M02 paths) but BLOCKS the candidate
 * from dispatch entirely — leaving the operator to manually re-attempt
 * later. This module turns blocks into QUEUED entries that auto-drain
 * when blocking tasks reach a terminal state (merged/abandoned).
 *
 * Design: side-channel queue file `.agent-runs/_task-queue.json` that
 * records "task X is queued behind Y" without introducing a new
 * TaskState. The work.ts dispatch flow checks the queue first; the
 * tick.ts loop drains it.
 *
 * Schema:
 *   QueueEntry { task_id, run_id, blocked_by[], blocked_paths[], queued_at, reason }
 *
 * Lifecycle:
 *   1. auto:work on TP-X, overlap with TP-Y → enqueue(TP-X, blocked_by=[TP-Y])
 *   2. auto:tick drainQueue: walks queue; for each entry, checks if all
 *      blocked_by tasks are now terminal (merged | abandoned). If yes,
 *      removes from queue + emits a notification so next-tick rubric
 *      can re-dispatch via auto:work.
 *   3. auto:work re-invoked on TP-X (after queue drain) → no overlap,
 *      proceeds normally.
 *
 * Idempotency: enqueue de-dupes by task_id; second enqueue updates
 * blocked_by + queued_at. drainQueue is safe to run repeatedly.
 *
 * No state machine changes — queue is observability + scheduling only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { atomicWriteFile, listRuns, listTasks, readTaskPack } from './runState';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const QueuedPathPair = z.object({
  ours: z.string(),
  theirs_task: z.string(),
  theirs_path: z.string(),
});
export type QueuedPathPair = z.infer<typeof QueuedPathPair>;

export const QueueEntry = z.object({
  schema_version: z.literal('1').default('1'),
  task_id: z.string(),
  run_id: z.string(),
  /** task_ids that must reach terminal state before this can dispatch. */
  blocked_by: z.array(z.string()).min(1),
  /** Per-path drilldown for forensic visibility (which file caused which block). */
  blocked_paths: z.array(QueuedPathPair),
  queued_at: z.string(),
  /** Free-text reason — typically "path overlap with N task(s)". */
  reason: z.string(),
});
export type QueueEntry = z.infer<typeof QueueEntry>;

const QUEUE_REL = '.agent-runs/_task-queue.json';
const QUEUE_LOCK_REL = '.agent-runs/.task-queue.lock';
const QUEUE_LOCK_STALE_MS = 30_000;
const QUEUE_LOCK_RETRY_MS = 50;
const QUEUE_LOCK_TIMEOUT_MS = 5_000;

export function queuePath(harnessRoot: string): string {
  return path.join(harnessRoot, QUEUE_REL);
}

/**
 * O_EXCL CAS lock around queue read-modify-write (Codex v0.4.9 review
 * MEDIUM #8). Mirrors the registry lock pattern in processWatchdog.ts.
 */
function withQueueLock<T>(harnessRoot: string, fn: () => T): T {
  const lockPath = path.join(harnessRoot, QUEUE_LOCK_REL);
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  if (fs.existsSync(lockPath)) {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > QUEUE_LOCK_STALE_MS) fs.unlinkSync(lockPath);
    } catch { /* race */ }
  }
  const deadline = Date.now() + QUEUE_LOCK_TIMEOUT_MS;
  let fd = -1;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      break;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      const sab = new SharedArrayBuffer(4);
      const i32 = new Int32Array(sab);
      Atomics.wait(i32, 0, 0, QUEUE_LOCK_RETRY_MS);
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > QUEUE_LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch { /* race */ }
        }
      } catch { /* gone */ }
    }
  }
  if (fd < 0) throw new Error(`[taskQueue] could not acquire queue lock at ${lockPath} within ${QUEUE_LOCK_TIMEOUT_MS}ms`);
  try {
    fs.writeSync(fd, `pid=${process.pid} acquired=${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* */ }
  }
}

// ─── Read / Write ───────────────────────────────────────────────────────────

export function readQueue(harnessRoot: string): QueueEntry[] {
  const p = queuePath(harnessRoot);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r: unknown) => { try { return QueueEntry.parse(r); } catch { return null; } })
      .filter((e): e is QueueEntry => e !== null);
  } catch { return []; }
}

function writeQueue(harnessRoot: string, entries: QueueEntry[]): void {
  const dir = path.dirname(queuePath(harnessRoot));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(queuePath(harnessRoot), JSON.stringify(entries, null, 2));
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Enqueue a task that's blocked by path overlap. Idempotent: second call
 * for the same task_id updates blocked_by + queued_at.
 */
export function enqueue(harnessRoot: string, entry: Omit<QueueEntry, 'schema_version' | 'queued_at'>): void {
  const enriched: QueueEntry = QueueEntry.parse({
    ...entry,
    schema_version: '1',
    queued_at: new Date().toISOString(),
  });
  withQueueLock(harnessRoot, () => {
    const queue = readQueue(harnessRoot);
    const filtered = queue.filter((e) => e.task_id !== enriched.task_id);
    filtered.push(enriched);
    writeQueue(harnessRoot, filtered);
  });
}

/**
 * Remove a task from the queue (e.g., after operator intervention or
 * successful dispatch on next attempt).
 */
export function dequeue(harnessRoot: string, task_id: string): void {
  withQueueLock(harnessRoot, () => {
    const queue = readQueue(harnessRoot);
    const filtered = queue.filter((e) => e.task_id !== task_id);
    if (filtered.length !== queue.length) writeQueue(harnessRoot, filtered);
  });
}

/**
 * Inspect the queue (e.g., for `auto:status` / dashboard).
 */
export function listQueue(harnessRoot: string): QueueEntry[] {
  return readQueue(harnessRoot);
}

// ─── Drain logic ─────────────────────────────────────────────────────────────

const TERMINAL_STATES = new Set(['merged', 'abandoned']);

export interface DrainResult {
  task_id: string;
  before_blocked_by: string[];
  still_blocked_by: string[];
  unblocked: boolean;
  removed_from_queue: boolean;
  reason: string;
}

/**
 * Walk all queued entries; for each, check if all blocked_by tasks are now
 * in a terminal state. If so, remove from queue. apply=false is dry-run
 * (caller can preview before persisting).
 */
export function drainQueue(harnessRoot: string, opts: { apply?: boolean } = {}): DrainResult[] {
  const apply = opts.apply ?? false;

  // v0.4.16 Codex review HIGH: drain MUST read+filter+write inside the
  // queue lock, not compute survivors against a stale read and then
  // overwrite. Otherwise a concurrent enqueue between read and write
  // gets dropped.
  //
  // For apply=false (dry-run), we don't write, so unlocked read is fine.

  // Pre-compute state lookup OUTSIDE the lock — it reads ALL task packs
  // (potentially many MB) and we want to keep the queue lock held for
  // the minimum duration. The state lookup is a snapshot; a task may
  // transition during drain but worst case we miss a single drain cycle.
  const stateByTaskId = new Map<string, string>();
  try {
    for (const runId of listRuns()) {
      for (const taskId of listTasks(runId)) {
        try {
          const pack = readTaskPack(runId, taskId);
          stateByTaskId.set(pack.task_id, pack.state);
        } catch { /* malformed pack */ }
      }
    }
  } catch { /* harness root not initialized */ }

  const computeResults = (queueSnapshot: QueueEntry[]): { results: DrainResult[]; survivors: QueueEntry[] } => {
    const results: DrainResult[] = [];
    const survivors: QueueEntry[] = [];
    for (const entry of queueSnapshot) {
      const stillBlockedBy: string[] = [];
      for (const blocker of entry.blocked_by) {
        const state = stateByTaskId.get(blocker);
        if (!state) {
          stillBlockedBy.push(`${blocker}(unknown)`);
          continue;
        }
        if (!TERMINAL_STATES.has(state)) {
          stillBlockedBy.push(`${blocker}(${state})`);
        }
      }
      const unblocked = stillBlockedBy.length === 0;
      if (unblocked) {
        results.push({
          task_id: entry.task_id,
          before_blocked_by: entry.blocked_by,
          still_blocked_by: [],
          unblocked: true,
          removed_from_queue: apply,
          reason: 'all blockers reached terminal state (merged/abandoned)',
        });
        // Don't add to survivors when apply=true (will be dropped from queue)
        if (!apply) survivors.push(entry);
      } else {
        survivors.push(entry);
        results.push({
          task_id: entry.task_id,
          before_blocked_by: entry.blocked_by,
          still_blocked_by: stillBlockedBy,
          unblocked: false,
          removed_from_queue: false,
          reason: `still blocked by: ${stillBlockedBy.join(', ')}`,
        });
      }
    }
    return { results, survivors };
  };

  if (!apply) {
    // Dry-run: read once, compute, return; no write needed.
    const queue = readQueue(harnessRoot);
    return computeResults(queue).results;
  }

  // apply=true: re-read INSIDE the lock so any concurrent enqueue is
  // visible, recompute survivors against fresh state, then write.
  return withQueueLock(harnessRoot, () => {
    const queue = readQueue(harnessRoot);
    const { results, survivors } = computeResults(queue);
    if (survivors.length !== queue.length) {
      writeQueue(harnessRoot, survivors);
    }
    return results;
  });
}
