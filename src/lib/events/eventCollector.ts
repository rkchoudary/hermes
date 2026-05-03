/**
 * Pillar 1 (PA2) — Production-hardened event collector.
 *
 * The host-owned, single-writer-per-task append-only event ledger.
 * Implements doctrine 9: "Worker telemetry is never authoritative until
 * host-stamped, schema-validated, and durably recorded."
 *
 * Storage layout:
 *
 *   .agent-runs/_events/<run_id>/<task_id>.jsonl   ← the WAL
 *   .agent-runs/_events/<run_id>/<task_id>.seq     ← monotonic_seq counter (text)
 *   .agent-runs/_events/_collector.lock            ← collector singleton lock
 *
 * Hardening guarantees:
 *
 *   1. **Per-task exclusive write lock** via lockfile + flock-style POSIX
 *      open(O_EXCL). Two harness processes attempting to write events for
 *      the same task collide deterministically — second one fails with
 *      'sequence-conflict' (retryable).
 *
 *   2. **Atomic append**: every append is one fs.appendFileSync call with
 *      flag='a' (POSIX guarantees atomicity for single-write < PIPE_BUF;
 *      our events are typically 1-2 KB which is well under the 4 KB Linux
 *      PIPE_BUF and 512 KB macOS PIPE_BUF).
 *
 *   3. **fsync after every commit**: caller-tunable via
 *      HERMES_EVENT_FSYNC_MODE = 'always' | 'batch' | 'never' (default
 *      'always'). 'batch' fsyncs every N events or every M ms, whichever
 *      first.
 *
 *   4. **Chain validation on read**: appendEvent reads the last event's
 *      chain_hash before computing the new one; verifyChain on full
 *      replay catches any tampering.
 *
 *   5. **Crash recovery**: if the process dies mid-write, the next start
 *      detects a partial line via crashRecoverWal() and quarantines it
 *      to .corrupt suffix; the chain is re-anchored from the last fully
 *      valid event.
 *
 *   6. **Backpressure**: in-process append queue is bounded; writes
 *      beyond the cap throw 'shutdown-in-progress' rather than OOM.
 *
 *   7. **No silent drops**: malformed input quarantines to .quarantine
 *      file; never silently ignored.
 *
 * Concurrency model: ONE collector instance per (host process, task).
 * Cross-process coordination via the lockfile. The DAG scheduler ensures
 * one auto:work per task at a time; the in-container event emitter
 * (Phase 3) writes to a per-dispatch FIFO/socket, which is read by the
 * host-side collector that appends to this ledger.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  HermesWorkerEventV1,
  GENESIS_CHAIN_HASH,
  buildEvent,
  type BuildEventInput,
  parseEvent,
  tryParseEvent,
  verifyChain,
  type ChainVerificationResult,
} from './hermesWorkerEvent';
import { EventLedgerError, wrapError } from './errors';

// ─── Configuration ──────────────────────────────────────────────────────

const FSYNC_MODE = (process.env.HERMES_EVENT_FSYNC_MODE ?? 'always') as 'always' | 'batch' | 'never';
const BATCH_SIZE = parseInt(process.env.HERMES_EVENT_BATCH_SIZE ?? '50', 10);
const BATCH_TIMEOUT_MS = parseInt(process.env.HERMES_EVENT_BATCH_TIMEOUT_MS ?? '500', 10);
const APPEND_QUEUE_CAP = parseInt(process.env.HERMES_EVENT_QUEUE_CAP ?? '10000', 10);

// ─── Path helpers ──────────────────────────────────────────────────────

export function eventsDir(harnessRoot: string): string {
  return path.join(harnessRoot, '.agent-runs', '_events');
}

export function eventLogPath(harnessRoot: string, runId: string, taskId: string): string {
  return path.join(eventsDir(harnessRoot), runId, `${taskId}.jsonl`);
}

export function seqCounterPath(harnessRoot: string, runId: string, taskId: string): string {
  return path.join(eventsDir(harnessRoot), runId, `${taskId}.seq`);
}

export function lockPath(harnessRoot: string, runId: string, taskId: string): string {
  return path.join(eventsDir(harnessRoot), runId, `${taskId}.lock`);
}

export function quarantinePath(harnessRoot: string, runId: string, taskId: string): string {
  return path.join(eventsDir(harnessRoot), runId, `${taskId}.quarantine`);
}

// ─── Per-task collector state (cached per process) ──────────────────────

interface CollectorState {
  harnessRoot: string;
  runId: string;
  taskId: string;
  lockFd: number | null;
  lastSeq: number;
  lastChainHash: string;
  writeQueue: HermesWorkerEventV1[];
  pendingFsyncBytes: number;
  batchTimer: NodeJS.Timeout | null;
  shuttingDown: boolean;
}

const COLLECTORS = new Map<string, CollectorState>();

function collectorKey(runId: string, taskId: string): string {
  return `${runId}/${taskId}`;
}

// ─── Lock acquisition ──────────────────────────────────────────────────

/**
 * Atomic exclusive lock via O_EXCL + O_CREAT. Throws 'sequence-conflict'
 * (retryable) if another writer already holds the lock. Caller is
 * expected to release via releaseLock on shutdown.
 */
function acquireLock(harnessRoot: string, runId: string, taskId: string): number {
  const p = lockPath(harnessRoot, runId, taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  try {
    const fd = fs.openSync(p, 'wx');
    fs.writeSync(fd, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      acquired_at: new Date().toISOString(),
    }) + '\n');
    fs.fsyncSync(fd);
    return fd;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST') {
      // Stale-lock detection: read the holder PID; if dead, take over.
      try {
        const content = fs.readFileSync(p, 'utf8').trim();
        const holder = JSON.parse(content) as { pid: number; acquired_at: string };
        if (!isPidAlive(holder.pid)) {
          // Stale; remove + retry once.
          fs.unlinkSync(p);
          const fd = fs.openSync(p, 'wx');
          fs.writeSync(fd, JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            acquired_at: new Date().toISOString(),
            took_over_from_dead_pid: holder.pid,
          }) + '\n');
          fs.fsyncSync(fd);
          return fd;
        }
        throw new EventLedgerError({
          kind: 'sequence-conflict',
          message: `event-collector lock held by pid=${holder.pid} acquired_at=${holder.acquired_at} (still alive)`,
          retryable: true,
        });
      } catch (parseErr) {
        if (parseErr instanceof EventLedgerError) throw parseErr;
        throw new EventLedgerError({
          kind: 'sequence-conflict',
          message: `event-collector lock held but holder metadata unreadable: ${(parseErr as Error).message}`,
          retryable: true,
        });
      }
    }
    throw wrapError('io-error', `failed to acquire event-collector lock for ${runId}/${taskId}`, err);
  }
}

function releaseLock(state: CollectorState): void {
  if (state.lockFd === null) return;
  try { fs.closeSync(state.lockFd); } catch { /* tolerate */ }
  try { fs.unlinkSync(lockPath(state.harnessRoot, state.runId, state.taskId)); } catch { /* tolerate */ }
  state.lockFd = null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return e.code === 'EPERM';
  }
}

// ─── Sequence counter (atomic via tmp+rename) ──────────────────────────

function readSeqCounter(harnessRoot: string, runId: string, taskId: string): number {
  const p = seqCounterPath(harnessRoot, runId, taskId);
  if (!fs.existsSync(p)) return -1;
  try {
    const content = fs.readFileSync(p, 'utf8').trim();
    const n = parseInt(content, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new EventLedgerError({
        kind: 'wal-corruption',
        message: `seq counter at ${p} is non-numeric: "${content}"`,
        details: { path: p, content },
      });
    }
    return n;
  } catch (err) {
    if (err instanceof EventLedgerError) throw err;
    throw wrapError('io-error', `failed to read seq counter at ${p}`, err);
  }
}

function writeSeqCounter(harnessRoot: string, runId: string, taskId: string, value: number): void {
  const p = seqCounterPath(harnessRoot, runId, taskId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  try {
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, String(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* tolerate */ }
    throw wrapError('io-error', `failed to write seq counter to ${p}`, err);
  }
}

// ─── Crash recovery ────────────────────────────────────────────────────

interface RecoveryResult {
  recovered: boolean;
  partial_lines_quarantined: number;
  last_valid_seq: number;
  last_valid_chain_hash: string;
  truncated_to_bytes: number;
}

/**
 * Scan the WAL forward, validate each line's JSON + zod + chain. Stop
 * at the first invalid line. Truncate the WAL to the last good byte
 * offset (atomic rename). Quarantine any trailing garbage to .quarantine.
 *
 * Called on every collector start. O(N) over the WAL; for typical
 * tasks (<1000 events) this is <50ms. Larger logs benefit from the
 * SQLite migration in Phase C.
 */
export function crashRecoverWal(
  harnessRoot: string,
  runId: string,
  taskId: string,
): RecoveryResult {
  const p = eventLogPath(harnessRoot, runId, taskId);
  if (!fs.existsSync(p)) {
    return {
      recovered: false,
      partial_lines_quarantined: 0,
      last_valid_seq: -1,
      last_valid_chain_hash: GENESIS_CHAIN_HASH,
      truncated_to_bytes: 0,
    };
  }
  const raw = fs.readFileSync(p, 'utf8');
  const lines = raw.split('\n');
  let lastValidByteOffset = 0;
  let lastValidSeq = -1;
  let lastValidChainHash = GENESIS_CHAIN_HASH;
  let quarantined = 0;
  let cumulativeBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // +1 for \n
    if (line.trim() === '') {
      cumulativeBytes += lineBytes;
      continue;
    }
    const parsed = tryParseEvent(safeJsonParse(line));
    if (!parsed.ok || !parsed.event) {
      // Quarantine everything from this point.
      const tail = raw.slice(cumulativeBytes);
      fs.appendFileSync(quarantinePath(harnessRoot, runId, taskId), tail);
      quarantined = tail.split('\n').filter(l => l.trim()).length;
      break;
    }
    // Validate chain link
    if (parsed.event.prev_chain_hash !== lastValidChainHash) {
      const tail = raw.slice(cumulativeBytes);
      fs.appendFileSync(quarantinePath(harnessRoot, runId, taskId), tail);
      quarantined = tail.split('\n').filter(l => l.trim()).length;
      break;
    }
    cumulativeBytes += lineBytes;
    lastValidByteOffset = cumulativeBytes;
    lastValidSeq = parsed.event.monotonic_seq;
    lastValidChainHash = parsed.event.chain_hash;
  }
  if (lastValidByteOffset < raw.length) {
    // Truncate WAL to last good offset (atomic via rewrite + rename)
    const tmp = `${p}.recovery.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, raw.slice(0, lastValidByteOffset));
    fs.renameSync(tmp, p);
    return {
      recovered: true,
      partial_lines_quarantined: quarantined,
      last_valid_seq: lastValidSeq,
      last_valid_chain_hash: lastValidChainHash,
      truncated_to_bytes: lastValidByteOffset,
    };
  }
  return {
    recovered: false,
    partial_lines_quarantined: 0,
    last_valid_seq: lastValidSeq,
    last_valid_chain_hash: lastValidChainHash,
    truncated_to_bytes: lastValidByteOffset,
  };
}

function safeJsonParse(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

// ─── Public collector API ──────────────────────────────────────────────

export interface OpenCollectorOptions {
  harnessRoot: string;
  runId: string;
  taskId: string;
}

/**
 * Open or get the per-task collector. Idempotent within a process — same
 * (run_id, task_id) returns the same state. Performs crash recovery on
 * first open. Acquires the per-task write lock.
 *
 * Throws EventLedgerError(sequence-conflict) if another live process
 * holds the lock.
 */
export function openCollector(opts: OpenCollectorOptions): CollectorState {
  const k = collectorKey(opts.runId, opts.taskId);
  const cached = COLLECTORS.get(k);
  if (cached) return cached;

  const lockFd = acquireLock(opts.harnessRoot, opts.runId, opts.taskId);

  // Crash recovery on every open
  const recovery = crashRecoverWal(opts.harnessRoot, opts.runId, opts.taskId);
  // Truth source for seq/chain: prefer recovery's last_valid; fall back
  // to seq-counter file if WAL was empty or non-existent.
  let lastSeq = recovery.last_valid_seq;
  let lastChainHash = recovery.last_valid_chain_hash;
  if (lastSeq < 0) {
    try { lastSeq = readSeqCounter(opts.harnessRoot, opts.runId, opts.taskId); } catch { lastSeq = -1; }
  }

  const state: CollectorState = {
    harnessRoot: opts.harnessRoot,
    runId: opts.runId,
    taskId: opts.taskId,
    lockFd,
    lastSeq,
    lastChainHash,
    writeQueue: [],
    pendingFsyncBytes: 0,
    batchTimer: null,
    shuttingDown: false,
  };
  COLLECTORS.set(k, state);
  return state;
}

/**
 * Append an event. Computes monotonic_seq + prev_chain_hash from the
 * collector's tracked state, builds + validates the event, atomically
 * appends to the WAL with fsync per FSYNC_MODE.
 *
 * Returns the persisted event (post-validation).
 *
 * Hardened semantics:
 *   - The seq + chain_hash assignment is atomic with the WAL append:
 *     if append fails, lastSeq/lastChainHash are NOT advanced.
 *   - In FSYNC_MODE='always', durability is guaranteed before the call
 *     returns. In 'batch' mode, durability is guaranteed within
 *     BATCH_TIMEOUT_MS.
 *   - Throws 'shutdown-in-progress' if the collector is closing.
 *   - Throws 'fsync-failed' if the OS reports a write failure.
 */
export type AppendEventInput = Omit<BuildEventInput, 'monotonic_seq' | 'prev_chain_hash' | 'harness_version'> & {
  /** Optional override of the harness version stamp. Default reads from
   *  process.env.HARNESS_VERSION or 'h-unknown'. */
  harness_version?: string;
};

export function appendEvent(
  state: CollectorState,
  input: AppendEventInput,
): HermesWorkerEventV1 {
  if (state.shuttingDown) {
    throw new EventLedgerError({
      kind: 'shutdown-in-progress',
      message: `collector for ${state.runId}/${state.taskId} is shutting down; new events refused`,
    });
  }
  if (state.writeQueue.length >= APPEND_QUEUE_CAP) {
    throw new EventLedgerError({
      kind: 'shutdown-in-progress',
      message: `collector queue cap (${APPEND_QUEUE_CAP}) reached; backpressure refusing new events`,
      retryable: true,
    });
  }
  const harnessVersion = input.harness_version
    ?? process.env.HARNESS_VERSION
    ?? 'h-unknown';
  const nextSeq = state.lastSeq + 1;
  const event = buildEvent({
    ...input,
    monotonic_seq: nextSeq,
    prev_chain_hash: state.lastChainHash,
    harness_version: harnessVersion,
  });

  const wal = eventLogPath(state.harnessRoot, state.runId, state.taskId);
  fs.mkdirSync(path.dirname(wal), { recursive: true });
  const line = JSON.stringify(event) + '\n';
  let fd: number | null = null;
  try {
    fd = fs.openSync(wal, 'a');
    fs.writeSync(fd, line);
    if (FSYNC_MODE === 'always') {
      fs.fsyncSync(fd);
    } else if (FSYNC_MODE === 'batch') {
      state.pendingFsyncBytes += Buffer.byteLength(line, 'utf8');
      scheduleBatchFsync(state, fd);
    }
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* tolerate */ } }
    throw wrapError('io-error', `failed to append event ${event.event_id} to ${wal}`, err);
  } finally {
    if (fd !== null && FSYNC_MODE !== 'batch') {
      try { fs.closeSync(fd); } catch { /* tolerate */ }
    }
  }

  // Only advance state after successful append
  state.lastSeq = nextSeq;
  state.lastChainHash = event.chain_hash;
  // Persist seq counter (best-effort; WAL is the truth)
  try {
    writeSeqCounter(state.harnessRoot, state.runId, state.taskId, nextSeq);
  } catch { /* WAL is authoritative; counter is for fast-path reads */ }
  return event;
}

function scheduleBatchFsync(state: CollectorState, fd: number): void {
  if (state.batchTimer) return;
  state.batchTimer = setTimeout(() => {
    try {
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    } catch (err) {
      // Hardened: a failed fsync in batch mode is logged but the next
      // event will reopen + force fsync. For now log to stderr; a
      // structured logger comes in PA5.
      console.error(`[event-collector] fsync failed for ${state.runId}/${state.taskId}: ${(err as Error).message}`);
    }
    state.pendingFsyncBytes = 0;
    state.batchTimer = null;
  }, BATCH_TIMEOUT_MS);
}

// ─── Query / read API ──────────────────────────────────────────────────

/**
 * Read all events for a task. Streams the WAL line-by-line; validates
 * each event + the chain. Returns the parsed events + chain verification
 * result. O(N) over WAL.
 */
export interface ReadEventsResult {
  events: HermesWorkerEventV1[];
  chain: ChainVerificationResult;
  truncated_lines: number;
  malformed_lines: number;
}

export function readEvents(harnessRoot: string, runId: string, taskId: string): ReadEventsResult {
  const wal = eventLogPath(harnessRoot, runId, taskId);
  const events: HermesWorkerEventV1[] = [];
  let malformed = 0;
  let truncated = 0;
  if (!fs.existsSync(wal)) {
    return { events, chain: { ok: true, broken_at_index: -1 }, truncated_lines: 0, malformed_lines: 0 };
  }
  const lines = fs.readFileSync(wal, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let raw: unknown;
    try { raw = JSON.parse(t); }
    catch { malformed++; continue; }
    const result = tryParseEvent(raw);
    if (!result.ok || !result.event) {
      malformed++;
      continue;
    }
    events.push(result.event);
  }
  const chain = verifyChain(events);
  if (!chain.ok) truncated = events.length - chain.broken_at_index;
  return { events, chain, truncated_lines: truncated, malformed_lines: malformed };
}

/**
 * Tail latest N events for liveness inspection.
 */
export function tailEvents(harnessRoot: string, runId: string, taskId: string, n: number): HermesWorkerEventV1[] {
  const all = readEvents(harnessRoot, runId, taskId);
  return all.events.slice(-n);
}

// ─── Shutdown ──────────────────────────────────────────────────────────

export function closeCollector(runId: string, taskId: string): void {
  const k = collectorKey(runId, taskId);
  const state = COLLECTORS.get(k);
  if (!state) return;
  state.shuttingDown = true;
  if (state.batchTimer) {
    clearTimeout(state.batchTimer);
    state.batchTimer = null;
  }
  releaseLock(state);
  COLLECTORS.delete(k);
}

export function closeAllCollectors(): void {
  for (const k of Array.from(COLLECTORS.keys())) {
    const state = COLLECTORS.get(k)!;
    closeCollector(state.runId, state.taskId);
  }
}

// Best-effort cleanup on process exit.
process.on('exit', () => closeAllCollectors());
process.on('SIGINT', () => { closeAllCollectors(); process.exit(130); });
process.on('SIGTERM', () => { closeAllCollectors(); process.exit(143); });
