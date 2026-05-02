/**
 * Process watchdog — active timeout, restart, and cleanup for long-running ops.
 *
 * Operator directive (2026-04-28): "build some time out and restarts that
 * would help into the system with best practices including clean up especially
 * the hung process or process that does not respond in timely fashion. The
 * processes need to poll on ping in timely fashion so you are not there just
 * waiting proactively."
 *
 * Three-layer model:
 *
 *   Layer 1 — REGISTRATION. Every long-running op (codex consensus, claude-cli
 *   worker, …) registers its (pid, kind, task_id, started_at, max_duration_sec,
 *   heartbeat_path) into `.agent-runs/_process-registry.json` BEFORE
 *   spawning, and unregisters in a finally block. Atomic writes + locked
 *   read-modify-write so concurrent ops don't clobber.
 *
 *   Layer 2 — HEARTBEAT. Long-running children optionally touch a heartbeat
 *   file every N seconds (caller's responsibility — for Codex which is sync
 *   and one-shot we use the start-deadline only; for the worker process
 *   which can stream tokens for many minutes the worker's own loop touches
 *   the file). Watchdog considers heartbeat stale when age > heartbeat_ttl_sec.
 *
 *   Layer 3 — REAPING. `reapStale({apply})` walks the registry and decides
 *   per-entry: (a) pid dead → unregister + clean up lockfile; (b) duration
 *   past max_duration_sec → SIGTERM, wait 10s, SIGKILL, audit, escalate;
 *   (c) heartbeat stale → same as (b). Audited via `appendOverrideAudit`
 *   with kind='watchdog-reap'. Every reap is loggable + reversible (we
 *   record the action; the killed process's own state machine handles
 *   what comes next, e.g., needs-revision → next round).
 *
 * Why a single registry file (not per-pid): so `pnpm auto:watchdog` and
 * `pnpm auto:tick` can see the WHOLE in-flight set without globbing
 * directories. Cheap to read/write under our concurrency (~10 active ops max).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { execSync } from 'node:child_process';
import { atomicWriteFile, withTaskPackLock } from './runState';
import { releaseTaskLock, appendStateTransition } from './taskPack';
import { captureIdentity } from './sod';
import { appendOverrideAudit } from './overrideAudit';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const ProcessKind = z.enum([
  'codex-consensus',     // Codex CLI dispatched by auto:consensus
  'claude-cli-worker',   // Claude Code CLI dispatched by auto:work
  'auto-promote',        // pnpm auto:promote subprocess
  'auto-land',           // pnpm auto:land subprocess
  'pipeline-test',       // verification test runner
  'other',               // catchall for ad-hoc registrations
]);
export type ProcessKind = z.infer<typeof ProcessKind>;

export const ProcessRegistryEntry = z.object({
  pid: z.number().int().positive(),
  kind: ProcessKind,
  /** Optional task association (most ops have one; some maintenance jobs don't). */
  task_id: z.string().optional(),
  /** Optional run association. */
  run_id: z.string().optional(),
  started_at: z.string(),  // ISO
  /** Hard deadline; reaper kills past this. */
  max_duration_sec: z.number().int().positive(),
  /** Optional path the process touches every heartbeat_ttl_sec. Stale → reap. */
  heartbeat_path: z.string().optional(),
  heartbeat_ttl_sec: z.number().int().positive().default(120),
  /** What command was launched (forensic). */
  command: z.string(),
  /** Hostname (for cross-host registries; reaper only kills same-host pids). */
  host: z.string().default(() => os.hostname()),
  /** If set, we should auto-restart on timeout-kill (Phase 2; for now we just log). */
  restart_policy: z.enum(['none', 'next-round', 'escalate']).default('escalate'),
  /**
   * OS-reported process start-time (epoch sec). Used to defend against PID
   * reuse: if we register pid=12345 today and the kernel later recycles that
   * pid for an unrelated process, the start_time mismatch lets the reaper
   * detect it and refuse to kill. Captured at registerProcess() via `ps`.
   * Optional for backward compat with old registry entries.
   */
  pid_start_epoch: z.number().int().nonnegative().optional(),
});
export type ProcessRegistryEntry = z.infer<typeof ProcessRegistryEntry>;

const REGISTRY_REL = '.agent-runs/_process-registry.json';
const REGISTRY_LOCK_REL = '.agent-runs/.process-registry.lock';
const REGISTRY_LOCK_STALE_MS = 30_000;  // 30s — registry RMW is fast
const REGISTRY_LOCK_RETRY_MS = 50;
const REGISTRY_LOCK_TIMEOUT_MS = 5_000;

export function registryPath(harnessRoot: string): string {
  return path.join(harnessRoot, REGISTRY_REL);
}

/**
 * O_EXCL CAS lock around registry read-modify-write to close the race the
 * Codex harness review HIGH #4 flagged: register / unregister / reapStale
 * all do RMW on the same JSON file. Without a lock, a concurrent register +
 * reap can lose entries.
 */
function withRegistryLock<T>(harnessRoot: string, fn: () => T): T {
  const lockPath = path.join(harnessRoot, REGISTRY_LOCK_REL);
  const lockDir = path.dirname(lockPath);
  if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
  // Auto-clear stale lock (caller crashed without releasing)
  if (fs.existsSync(lockPath)) {
    try {
      const stat = fs.statSync(lockPath);
      if (Date.now() - stat.mtimeMs > REGISTRY_LOCK_STALE_MS) fs.unlinkSync(lockPath);
    } catch { /* race */ }
  }
  // Acquire with bounded retry. Registry RMW is fast (~ms) so 5s timeout
  // is generous; if we can't get it in 5s, something is very wrong.
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
  let fd = -1;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o644);
      break;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw err;
      // Spin-wait via Atomics
      const sab = new SharedArrayBuffer(4);
      const i32 = new Int32Array(sab);
      Atomics.wait(i32, 0, 0, REGISTRY_LOCK_RETRY_MS);
      // Re-clear if went stale during wait
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > REGISTRY_LOCK_STALE_MS) {
          try { fs.unlinkSync(lockPath); } catch { /* race */ }
        }
      } catch { /* gone */ }
    }
  }
  if (fd < 0) {
    throw new Error(`[watchdog] could not acquire registry lock at ${lockPath} within ${REGISTRY_LOCK_TIMEOUT_MS}ms`);
  }
  try {
    fs.writeSync(fd, `pid=${process.pid} acquired=${new Date().toISOString()}\n`);
    fs.closeSync(fd);
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch { /* may have been cleared as stale */ }
  }
}

/**
 * Capture OS-reported process start-time for PID-reuse defense (Codex
 * harness review MEDIUM #9). Best-effort; returns undefined on failure
 * (older entries will fall back to old liveness check).
 */
function pidStartEpoch(pid: number): number | undefined {
  try {
    // ps -o lstart= returns RFC-style date; convert to epoch.
    // Use -p to scope to just this pid; -o lstart= for header-less output.
    const out = execSync(`ps -p ${pid} -o lstart=`, { encoding: 'utf8', timeout: 2000 });
    const parsed = Date.parse(out.trim());
    if (!isNaN(parsed)) return Math.floor(parsed / 1000);
  } catch { /* pid gone or ps failed */ }
  return undefined;
}

// ─── Read / Write ────────────────────────────────────────────────────────────

function readRegistry(harnessRoot: string): ProcessRegistryEntry[] {
  const p = registryPath(harnessRoot);
  if (!fs.existsSync(p)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((r: unknown) => {
        try { return ProcessRegistryEntry.parse(r); }
        catch { return null; }
      })
      .filter((e): e is ProcessRegistryEntry => e !== null);
  } catch {
    return [];
  }
}

function writeRegistry(harnessRoot: string, entries: ProcessRegistryEntry[]): void {
  const p = registryPath(harnessRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(p, JSON.stringify(entries, null, 2));
}

// ─── Public API: register / unregister ───────────────────────────────────────

/**
 * Register an in-flight process. Call BEFORE spawning so that if the parent
 * crashes between register and spawn, the watchdog sees a dead pid and
 * unregisters cleanly.
 */
export function registerProcess(
  harnessRoot: string,
  entry: ProcessRegistryEntry,
): void {
  // Capture OS start-time at registration for PID-reuse defense.
  const enriched = entry.pid_start_epoch === undefined
    ? { ...entry, pid_start_epoch: pidStartEpoch(entry.pid) }
    : entry;
  const validated = ProcessRegistryEntry.parse(enriched);
  withRegistryLock(harnessRoot, () => {
    const reg = readRegistry(harnessRoot);
    // De-dupe by pid (last-writer-wins; if a pid is reused after the previous
    // entry should have been unregistered, the new entry replaces it).
    const filtered = reg.filter((e) => e.pid !== validated.pid);
    filtered.push(validated);
    writeRegistry(harnessRoot, filtered);
  });
}

/**
 * Remove a process from the registry. Idempotent — safe to call from a
 * finally block whether or not the registration succeeded.
 */
export function unregisterProcess(harnessRoot: string, pid: number): void {
  withRegistryLock(harnessRoot, () => {
    const reg = readRegistry(harnessRoot);
    const filtered = reg.filter((e) => e.pid !== pid);
    if (filtered.length !== reg.length) writeRegistry(harnessRoot, filtered);
  });
}

/** Inspector for tick/CLI/dashboard. */
export function listRegistered(harnessRoot: string): ProcessRegistryEntry[] {
  return readRegistry(harnessRoot);
}

// ─── Liveness checks ─────────────────────────────────────────────────────────

/** True iff the OS reports the pid is alive (POSIX kill -0). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    // EPERM = process exists, owned by another user. ESRCH = no such pid.
    return err.code === 'EPERM';
  }
}

function ageSeconds(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 1000;
}

function heartbeatAgeSeconds(p?: string): number | null {
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    return (Date.now() - st.mtimeMs) / 1000;
  } catch {
    return null;
  }
}

// ─── Reaper ──────────────────────────────────────────────────────────────────

export type ReapVerdict =
  | { action: 'keep'; reason: string }
  | { action: 'unregister-dead'; reason: string }
  | { action: 'kill-overdeadline'; reason: string; age_sec: number }
  | { action: 'kill-stale-heartbeat'; reason: string; heartbeat_age_sec: number };

export interface ReapResult {
  entry: ProcessRegistryEntry;
  verdict: ReapVerdict;
  applied: boolean;
  killed_signal?: 'SIGTERM' | 'SIGKILL';
}

export interface ReapOpts {
  /** Actually kill / unregister; default is dry-run. */
  apply?: boolean;
  /** Used to skip cross-host pids. */
  current_host?: string;
  /** SIGTERM grace before SIGKILL. */
  sigterm_grace_ms?: number;
}

/**
 * Decide what to do with each registry entry. Pure logic + side effects
 * (process.kill + audit) only when apply=true. Returns per-entry verdict.
 */
export function reapStale(harnessRoot: string, opts: ReapOpts = {}): ReapResult[] {
  const apply = opts.apply ?? false;
  // Codex v0.4.9 review HIGH: reapStale RMW must be CAS-locked too. Wrap
  // the whole walk-and-write in withRegistryLock so concurrent
  // register/unregister can't lose entries during reap. Side effects
  // (process.kill + audit + rollback) happen INSIDE the lock; this is
  // bounded since killGracefully has a 10s grace + the registry lock has
  // a 5s timeout → total worst case ~15s lock holding for reaps that
  // SIGKILL. In practice reaps without kills hold lock <100ms.
  if (apply) {
    return withRegistryLock(harnessRoot, () => doReapStale(harnessRoot, opts));
  }
  return doReapStale(harnessRoot, opts);
}

/** Internal — caller has the registry lock if apply=true. */
function doReapStale(harnessRoot: string, opts: ReapOpts): ReapResult[] {
  const apply = opts.apply ?? false;
  const currentHost = opts.current_host ?? os.hostname();
  const grace = opts.sigterm_grace_ms ?? 10_000;
  const reg = readRegistry(harnessRoot);
  const results: ReapResult[] = [];
  const survivors: ProcessRegistryEntry[] = [];

  for (const e of reg) {
    // Cross-host: don't touch (different daemon owns it).
    if (e.host !== currentHost) {
      survivors.push(e);
      results.push({ entry: e, verdict: { action: 'keep', reason: `cross-host (${e.host})` }, applied: false });
      continue;
    }

    const alive = isPidAlive(e.pid);
    if (!alive) {
      const verdict: ReapVerdict = { action: 'unregister-dead', reason: `pid ${e.pid} not alive (kill -0 ESRCH)` };
      results.push({
        entry: e,
        verdict,
        applied: apply,
      });
      // Codex harness review HIGH #3: dead-pid path now also audits + rolls
      // back task state. Otherwise a crashed claude-cli-worker leaves the
      // task in 'in-progress' with a dead lock + no durable reap audit.
      if (apply) {
        auditReap(harnessRoot, e, verdict);
        rollbackTaskState(harnessRoot, e, verdict);
      } else {
        survivors.push(e);
      }
      continue;
    }

    // Codex harness review MEDIUM #9: PID-reuse defense. If the registered
    // entry has a captured pid_start_epoch and the live process's start time
    // differs by more than a tolerance, the kernel has reused this PID for a
    // different process — refuse to kill, alert via verdict.
    if (e.pid_start_epoch !== undefined) {
      const liveStart = pidStartEpoch(e.pid);
      if (liveStart !== undefined && Math.abs(liveStart - e.pid_start_epoch) > 5) {
        // Mismatch — different process now occupies this pid. Don't kill it.
        results.push({
          entry: e,
          verdict: {
            action: 'unregister-dead',
            reason: `pid ${e.pid} reused: registered_start=${e.pid_start_epoch} live_start=${liveStart} (Δ${Math.abs(liveStart - e.pid_start_epoch)}s) — refusing to kill`,
          },
          applied: apply,
        });
        if (apply) auditReap(harnessRoot, e, {
          action: 'unregister-dead',
          reason: `pid ${e.pid} reused — registered_start=${e.pid_start_epoch} live_start=${liveStart}`,
        });
        else survivors.push(e);
        continue;
      }
    }

    const age = ageSeconds(e.started_at);
    if (age > e.max_duration_sec) {
      // Past hard deadline → kill.
      const verdict: ReapVerdict = {
        action: 'kill-overdeadline',
        reason: `pid ${e.pid} alive ${age.toFixed(0)}s > max ${e.max_duration_sec}s`,
        age_sec: age,
      };
      const result: ReapResult = { entry: e, verdict, applied: false };
      if (apply) {
        result.killed_signal = killGracefully(e.pid, grace);
        result.applied = true;
        auditReap(harnessRoot, e, verdict);
        rollbackTaskState(harnessRoot, e, verdict);
      } else {
        survivors.push(e);
      }
      results.push(result);
      continue;
    }

    const hbAge = heartbeatAgeSeconds(e.heartbeat_path);
    if (hbAge !== null && hbAge > e.heartbeat_ttl_sec) {
      const verdict: ReapVerdict = {
        action: 'kill-stale-heartbeat',
        reason: `pid ${e.pid} heartbeat ${hbAge.toFixed(0)}s stale > ttl ${e.heartbeat_ttl_sec}s`,
        heartbeat_age_sec: hbAge,
      };
      const result: ReapResult = { entry: e, verdict, applied: false };
      if (apply) {
        result.killed_signal = killGracefully(e.pid, grace);
        result.applied = true;
        auditReap(harnessRoot, e, verdict);
        rollbackTaskState(harnessRoot, e, verdict);
      } else {
        survivors.push(e);
      }
      results.push(result);
      continue;
    }

    // Healthy — keep
    survivors.push(e);
    results.push({ entry: e, verdict: { action: 'keep', reason: `alive ${age.toFixed(0)}s of ${e.max_duration_sec}s` }, applied: false });
  }

  if (apply) writeRegistry(harnessRoot, survivors);
  return results;
}

/**
 * Codex v0.4.9 review HIGH #4: kill the WHOLE process group, not just the
 * registered PID. Many spawn sites (work.ts spawnSync, buildPipeline.ts,
 * consensus.ts) register a wrapper PID and rely on SIGTERM cascading via
 * pipe-close. That's not reliable — a child that ignores SIGPIPE or has its
 * own signal handlers can survive. Solution: spawn detached (sets new
 * process group via setsid), kill `-pid` (negative pid → kill the group).
 *
 * Best-effort fallback: if the entry doesn't have a process group (older
 * registration without detached:true), fall back to single-pid kill.
 */
function killGracefully(pid: number, graceMs: number): 'SIGTERM' | 'SIGKILL' {
  // Try process-group kill first; fall back to single-pid if EPERM/ESRCH
  // (group doesn't exist or insufficient permission).
  const sendSignal = (signal: NodeJS.Signals): boolean => {
    try {
      process.kill(-pid, signal);  // negative → kill process group
      return true;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ESRCH') {
        // No such process group — fall back to single PID.
        try { process.kill(pid, signal); return true; } catch { return false; }
      }
      // EPERM means we don't own the group. Try single PID.
      try { process.kill(pid, signal); return true; } catch { return false; }
    }
  };

  const sentTerm = sendSignal('SIGTERM');
  if (!sentTerm) return 'SIGTERM';  // already gone; record intent

  // Synchronous spin-wait (we're a CLI — blocking is acceptable; this only
  // runs on actual reap, not in hot path). Verifies LEADER pid is dead;
  // for process-group kill, individual children may still be terminating.
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return 'SIGTERM';
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    Atomics.wait(i32, 0, 0, 250);
  }
  // Still alive after grace → SIGKILL the whole group.
  sendSignal('SIGKILL');
  return 'SIGKILL';
}

/**
 * Post-kill task-state rollback. After the watchdog reaps a worker process,
 * the task pack is left in 'in-progress' with a dead lock — blocking the
 * next dispatch (operator-pid lock won't expire for 90 min, and resurrect
 * needs STALE_LOCK_THRESHOLD_MIN to elapse before acting). Without this
 * rollback, every reaped worker requires manual cleanup — defeating the
 * "you are not there just waiting proactively" directive (2026-04-28).
 *
 * Best-effort: imports runState/taskPack lazily to avoid circular deps and
 * swallows errors so a rollback failure never breaks the kill path. Caller
 * has already audited via appendOverrideAudit; this is the recovery step.
 *
 * Only rolls back for kinds that actually hold task locks ('claude-cli-worker').
 */
function rollbackTaskState(
  harnessRoot: string,
  entry: ProcessRegistryEntry,
  verdict: ReapVerdict,
): void {
  if (entry.kind !== 'claude-cli-worker') return;
  if (!entry.task_id || !entry.run_id) return;
  try {
    withTaskPackLock(entry.run_id, entry.task_id, (fresh) => {
      // Only rollback if the lock points at the dead pid we just killed.
      // Defensive: another worker may have taken over since registration.
      if (fresh.lock && fresh.lock.pid !== entry.pid) {
        return fresh;
      }
      releaseTaskLock(fresh);
      fresh.notes.push({
        at: new Date().toISOString(),
        by: 'watchdog-rollback',
        text: `released lock + transitioned to needs-revision after watchdog reaped pid ${entry.pid} (${verdict.reason})`,
      });
      return appendStateTransition(
        fresh,
        'needs-revision',
        'watchdog-rollback',
        `rollback after watchdog reaped pid ${entry.pid} mid-dispatch (${verdict.action})`,
      );
    });
  } catch (e) {
    console.error(`[watchdog] post-kill rollback failed for ${entry.task_id}: ${(e as Error).message}`);
  }
}

function auditReap(
  harnessRoot: string,
  entry: ProcessRegistryEntry,
  verdict: ReapVerdict,
): void {
  try {
    const actor = captureIdentity();
    appendOverrideAudit(harnessRoot, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor,
      kind: 'watchdog-reap',
      reason: `watchdog reaped ${entry.kind} pid=${entry.pid}: ${verdict.reason}`,
      task_id: entry.task_id,
      run_id: entry.run_id,
      context: {
        verdict_action: verdict.action,
        process_kind: entry.kind,
        started_at: entry.started_at,
        max_duration_sec: entry.max_duration_sec,
        command: entry.command,
        restart_policy: entry.restart_policy,
        host: entry.host,
      },
      pid: process.pid,
      host: os.hostname(),
    });
  } catch (e) {
    // Audit failure must NOT prevent reap; print to stderr so tick log shows it.
    console.error(`[watchdog] audit failed: ${(e as Error).message}`);
  }
}

// ─── Convenience wrapper: run a child with watchdog registration ─────────────

/**
 * Wrap a synchronous spawn (caller passes the pid AFTER spawn). Pattern:
 *
 *   const child = spawn(...);
 *   registerProcess(root, { pid: child.pid!, kind: 'codex-consensus', ... });
 *   try {
 *     await waitForChild(child);
 *   } finally {
 *     unregisterProcess(root, child.pid!);
 *   }
 *
 * For execSync-style synchronous calls where we don't get the pid back, use
 * the registerByCommand/unregisterByMatch helpers via process tree scan. (Not
 * implemented in MVP — execSync callers should refactor to spawn + wait.)
 */
export function defaultMaxDurationSec(kind: ProcessKind): number {
  switch (kind) {
    case 'codex-consensus':   return 15 * 60;   // 15 min hard ceiling for Codex sync
    case 'claude-cli-worker': return 45 * 60;   // 45 min for worker dispatch (large diffs)
    case 'auto-promote':      return 5 * 60;
    case 'auto-land':         return 10 * 60;
    case 'pipeline-test':     return 30 * 60;
    case 'other':             return 10 * 60;
  }
}
