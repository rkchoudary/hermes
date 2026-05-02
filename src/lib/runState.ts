/**
 * Run-state file management.
 *
 * Each autonomous run is a directory under .agent-runs/<run_id>/ that holds
 * task packs, evidence, logs, and a state transition log. This module owns
 * the file layout + read/write primitives.
 *
 * v0.1: synchronous fs only (Node.js / pnpm). v0.2 may add async + locking.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TaskPack, parseTaskPack } from './taskPack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Codex v0.4.9 review CRITICAL: 4-up walk was broken in standalone repo
// (resolved to /Users/<user>, NOT the package root). Now routes through
// resolveHarnessRoot() which honors HARNESS_PROJECT_ROOT env-var override
// and detects vendored vs standalone layout via package.json + .agent-runs/
// markers.
import { harnessRoot } from './harnessRoot';
const REPO_ROOT = harnessRoot();
const RUNS_DIR = path.join(REPO_ROOT, '.agent-runs');

export interface RunManifest {
  run_id: string;
  created_at: string;
  owner: string;
  scope: string; // e.g., "FRD-batch-1: M05/M06/M07/M10/M11"
  budget: {
    max_concurrent_workers: number;
    target_task_count: number;
  };
  notes?: string;
}

// ─── Path helpers ──────────────────────────────────────────────────────────

export function runDir(runId: string): string {
  return path.join(RUNS_DIR, runId);
}

export function manifestPath(runId: string): string {
  return path.join(runDir(runId), 'manifest.json');
}

export function stateLogPath(runId: string): string {
  return path.join(runDir(runId), 'state-log.jsonl');
}

export function tasksDir(runId: string): string {
  return path.join(runDir(runId), 'tasks');
}

export function evidenceDir(runId: string, taskId: string): string {
  return path.join(runDir(runId), 'evidence', taskId);
}

export function taskPackPath(runId: string, taskId: string): string {
  return path.join(tasksDir(runId), `${taskId}.json`);
}

export function logsDir(runId: string): string {
  return path.join(runDir(runId), 'logs');
}

// ─── Run lifecycle ─────────────────────────────────────────────────────────

/**
 * Create a new run directory + manifest. Returns the run_id.
 * Throws if the directory already exists.
 */
export function createRun(manifest: RunManifest): string {
  const dir = runDir(manifest.run_id);
  if (fs.existsSync(dir)) {
    throw new Error(`Run directory already exists: ${dir}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(tasksDir(manifest.run_id), { recursive: true });
  fs.mkdirSync(path.join(dir, 'evidence'), { recursive: true });
  fs.mkdirSync(logsDir(manifest.run_id), { recursive: true });
  fs.writeFileSync(manifestPath(manifest.run_id), JSON.stringify(manifest, null, 2));
  // Initialize empty state log
  fs.writeFileSync(stateLogPath(manifest.run_id), '');
  return manifest.run_id;
}

/**
 * Read the manifest for a given run.
 */
export function readManifest(runId: string): RunManifest {
  const json = fs.readFileSync(manifestPath(runId), 'utf8');
  return JSON.parse(json) as RunManifest;
}

/**
 * List all runs (returns run_ids sorted by mtime desc).
 */
export function listRuns(): string[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    // _-prefixed entries are reserved for harness internals (memory tiers
    // like _long-term, _codex, _e2e, plus singletons like _goal.json).
    // Found by industrial.smoke 2026-04-29: materializer was picking
    // _long-term as a run_id and trying to write TaskPacks into it.
    .filter((name) => !name.startsWith('_'))
    .filter((name) => {
      try { return fs.statSync(path.join(RUNS_DIR, name)).isDirectory(); }
      catch { return false; }
    })
    .sort((a, b) => {
      const aMtime = fs.statSync(path.join(RUNS_DIR, a)).mtimeMs;
      const bMtime = fs.statSync(path.join(RUNS_DIR, b)).mtimeMs;
      return bMtime - aMtime;
    });
}

// ─── Task pack persistence ────────────────────────────────────────────────

/**
 * Write a task pack to disk + create its evidence directory.
 *
 * v0.4.3 (Codex C1): writes are now ATOMIC via tempfile + rename. Two parallel
 * writers can both call writeTaskPack() but the rename is atomic on POSIX, so
 * the file on disk is always either the old or new state — never partial.
 *
 * Note: this still has a TOCTOU window (read → modify → write); callers MUST
 * acquire the OS lock via withTaskPackLock() to get true CAS semantics.
 */
export function writeTaskPack(pack: TaskPack): void {
  const dir = tasksDir(pack.run_id);
  if (!fs.existsSync(dir)) {
    throw new Error(`Run does not exist: ${pack.run_id}. Call createRun() first.`);
  }
  const evDir = evidenceDir(pack.run_id, pack.task_id);
  if (!fs.existsSync(evDir)) {
    fs.mkdirSync(evDir, { recursive: true });
  }
  const finalPath = taskPackPath(pack.run_id, pack.task_id);
  const tempPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(pack, null, 2));
  // Atomic rename — POSIX rename() is atomic within a filesystem.
  fs.renameSync(tempPath, finalPath);
}

/**
 * v0.4.3 (Codex C1): OS-level exclusive lock for read-modify-write on a task
 * pack. Uses an `O_EXCL` sentinel file as the CAS primitive — `fs.openSync` with
 * O_CREAT|O_EXCL fails atomically if the file exists, making this a true
 * atomic test-and-set on POSIX systems.
 *
 * Usage:
 *     const result = withTaskPackLock(runId, taskId, (pack) => {
 *         pack.state = 'in-progress';
 *         pack.lock = ...;
 *         return pack;
 *     });
 *
 * The callback receives the freshly-read pack and returns the modified pack;
 * write happens inside the lock, then the lock is released. If the lock can't
 * be acquired (sentinel exists + isn't stale), throws TaskPackLockBusyError.
 */
export class TaskPackLockBusyError extends Error {
  constructor(public taskId: string, public sentinelPath: string, public ageMs: number) {
    super(
      `Task pack ${taskId} is locked by another process (sentinel: ${sentinelPath}, ` +
      `age ${(ageMs / 1000).toFixed(1)}s). Either wait, or remove the sentinel ` +
      `if you've verified the holder is dead.`
    );
    this.name = 'TaskPackLockBusyError';
  }
}

/**
 * Sentinel file for OS-level lock. Stale sentinels (>15min old) are auto-cleared.
 */
function lockSentinelPath(runId: string, taskId: string): string {
  return path.join(tasksDir(runId), `.${taskId}.lock`);
}

const SENTINEL_STALE_MS = 15 * 60_000; // 15 minutes

/**
 * Synchronous CAS lock + read-modify-write.
 * Caller's fn() must be sync. For async, use withTaskPackLockAsync().
 *
 * Codex R3 fix: split sync/async into two functions to eliminate the bug
 * where the outer finally{} released the sentinel before the async promise
 * resolved. With separate functions, each has correct lifetime semantics.
 */
export function withTaskPackLock(
  runId: string,
  taskId: string,
  fn: (pack: TaskPack) => TaskPack
): TaskPack {
  const sentinel = lockSentinelPath(runId, taskId);
  acquireSentinel(runId, taskId, sentinel);
  try {
    const pack = readTaskPack(runId, taskId);
    const result = fn(pack);
    writeTaskPack(result);
    return result;
  } finally {
    releaseSentinel(sentinel);
  }
}

/**
 * Async variant — Codex R3 fix.
 * Sentinel is released ONLY after the promise resolves. The critical
 * section is held for the entire async lifetime of the callback.
 */
export async function withTaskPackLockAsync(
  runId: string,
  taskId: string,
  fn: (pack: TaskPack) => Promise<TaskPack>
): Promise<TaskPack> {
  const sentinel = lockSentinelPath(runId, taskId);
  acquireSentinel(runId, taskId, sentinel);
  try {
    const pack = readTaskPack(runId, taskId);
    const result = await fn(pack);
    writeTaskPack(result);
    return result;
  } finally {
    releaseSentinel(sentinel);
  }
}

/**
 * Internal helper — acquire sentinel via CAS open.
 * Throws TaskPackLockBusyError on contention.
 */
function acquireSentinel(runId: string, taskId: string, sentinel: string): void {
  // Auto-clear stale sentinel (operator left process running, or it crashed)
  if (fs.existsSync(sentinel)) {
    try {
      const stat = fs.statSync(sentinel);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > SENTINEL_STALE_MS) {
        fs.unlinkSync(sentinel);
      }
    } catch { /* race — proceed to open */ }
  }

  // CAS: O_CREAT | O_EXCL fails atomically if file exists.
  let fd: number;
  try {
    fd = fs.openSync(sentinel, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      let ageMs = -1;
      try { ageMs = Date.now() - fs.statSync(sentinel).mtimeMs; } catch { /* ignore */ }
      throw new TaskPackLockBusyError(taskId, sentinel, ageMs);
    }
    throw err;
  }

  try {
    fs.writeSync(fd, `pid=${process.pid} acquired=${new Date().toISOString()}\n`);
    fs.closeSync(fd);
  } catch {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Internal helper — release sentinel.
 */
function releaseSentinel(sentinel: string): void {
  try {
    if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
  } catch { /* ignore */ }
}

/**
 * Read a task pack from disk.
 */
export function readTaskPack(runId: string, taskId: string): TaskPack {
  const json = fs.readFileSync(taskPackPath(runId, taskId), 'utf8');
  return parseTaskPack(JSON.parse(json));
}

/**
 * List all task IDs for a given run.
 */
export function listTasks(runId: string): string[] {
  const dir = tasksDir(runId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort();
}

// ─── State log (append-only audit trail) ──────────────────────────────────

export interface StateLogEntry {
  task_id: string;
  from: string;
  to: string;
  at: string;
  by: string;
  reason?: string;
  /**
   * v0.7+ tamper-evident chain (Codex AUDIT-TRAIL gate). sha256 hex of
   * (prev_chain_hash || canonical_json(entryWithoutChainHash)). Optional for
   * backwards compat — pre-v0.7 entries don't have this field and are
   * treated as legacy by `verifyStateLogChain`.
   */
  chain_hash?: string;
}

/**
 * Compute the chain hash for an entry given the prior chain hash. Uses a
 * stable canonical JSON serialization (keys sorted) so hash is reproducible
 * across writers.
 */
export function computeChainHash(prevChainHash: string, entry: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(entry).sort()) {
    ordered[k] = entry[k];
  }
  return createHash('sha256').update(prevChainHash).update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Append a single state transition to the run's state-log.jsonl. Computes and
 * stores the cryptographic chain hash so `verifyStateLogChain` can detect
 * tampering or torn writes.
 */
export function appendStateLog(runId: string, entry: StateLogEntry): void {
  let entryToWrite: StateLogEntry = entry;
  if (!entry.chain_hash) {
    const existing = readStateLog(runId);
    const prev = existing.length > 0 ? (existing[existing.length - 1].chain_hash ?? '') : '';
    const { chain_hash: _omit, ...rest } = entry;
    entryToWrite = { ...rest, chain_hash: computeChainHash(prev, rest) };
  }
  fs.appendFileSync(stateLogPath(runId), JSON.stringify(entryToWrite) + '\n');
}

/**
 * Read all state log entries for a run.
 */
export function readStateLog(runId: string): StateLogEntry[] {
  if (!fs.existsSync(stateLogPath(runId))) return [];
  const content = fs.readFileSync(stateLogPath(runId), 'utf8');
  return content
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as StateLogEntry);
}

/**
 * Verify the cryptographic chain across a run's state-log.
 */
export interface ChainVerification {
  ok: boolean;
  mode: 'chained' | 'legacy' | 'mixed' | 'empty' | 'broken';
  count: number;
  legacy_count?: number;
  broken_at?: number;
  expected?: string;
  found?: string;
  reason?: string;
}

export function verifyStateLogChain(runId: string): ChainVerification {
  const entries = readStateLog(runId);
  if (entries.length === 0) return { ok: true, mode: 'empty', count: 0 };

  let firstChainedIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].chain_hash) {
      firstChainedIdx = i;
      break;
    }
  }

  if (firstChainedIdx === -1) {
    return { ok: true, mode: 'legacy', count: entries.length };
  }

  let prev = firstChainedIdx === 0 ? '' : (entries[firstChainedIdx - 1].chain_hash ?? '');
  for (let i = firstChainedIdx; i < entries.length; i++) {
    const e = entries[i];
    if (!e.chain_hash) {
      return {
        ok: false,
        mode: 'broken',
        count: entries.length,
        broken_at: i,
        reason: `Entry ${i} missing chain_hash but earlier entries had one (truncation or chain-skip)`,
      };
    }
    const { chain_hash: stored, ...rest } = e;
    const expected = computeChainHash(prev, rest);
    if (expected !== stored) {
      return {
        ok: false,
        mode: 'broken',
        count: entries.length,
        broken_at: i,
        expected,
        found: stored,
        reason: `Chain mismatch at entry ${i}: expected ${expected.slice(0, 16)}…, found ${stored.slice(0, 16)}…`,
      };
    }
    prev = stored;
  }

  return firstChainedIdx === 0
    ? { ok: true, mode: 'chained', count: entries.length }
    : { ok: true, mode: 'mixed', count: entries.length, legacy_count: firstChainedIdx };
}

// ─── Evidence file helpers ────────────────────────────────────────────────

/**
 * Atomic file write helper — tempfile + rename. POSIX rename() is atomic
 * within a filesystem, so the file on disk is always either the old or the
 * new content, never partial. Use for any evidence/prompt/review write
 * where a crash mid-write would leave downstream consumers reading a
 * truncated file. Codex R5 fix (authority-of-state).
 */
export function atomicWriteFile(fullPath: string, content: string): void {
  const tempPath = `${fullPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, content);
  fs.renameSync(tempPath, fullPath);
}

/**
 * Write an evidence file for a task. Path is relative to the evidence dir.
 *
 * Codex R5 fix (authority-of-state): routes through atomicWriteFile so
 * downstream consumers (consensus dispatch, CI claim verification) never
 * read a truncated evidence file.
 */
export function writeEvidence(
  runId: string,
  taskId: string,
  filename: string,
  content: string
): string {
  const dir = evidenceDir(runId, taskId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const fullPath = path.join(dir, filename);
  atomicWriteFile(fullPath, content);
  return fullPath;
}

/**
 * Read an evidence file for a task.
 */
export function readEvidence(runId: string, taskId: string, filename: string): string {
  const fullPath = path.join(evidenceDir(runId, taskId), filename);
  return fs.readFileSync(fullPath, 'utf8');
}

/**
 * List evidence files for a task.
 */
export function listEvidence(runId: string, taskId: string): string[] {
  const dir = evidenceDir(runId, taskId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort();
}
