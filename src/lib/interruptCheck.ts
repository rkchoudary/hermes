/**
 * interruptCheck.ts — read-side helper for auto:interrupt.
 *
 * Workers (and any long-running CLI) call `isInterrupted(runId, taskId)` at
 * iteration boundaries. If the sentinel file exists, the worker exits with
 * a documented "interrupted" state instead of continuing.
 *
 * Iteration boundaries to check (in work.ts and friends):
 *   - Before each post-flight call
 *   - Between patch rounds
 *   - Before cognitive-recovery dispatch
 *   - Before any external CLI spawn (claude, codex, gh) that takes >5s
 *
 * The sentinel file at `.agent-runs/<run>/_interrupt-<task_id>.json` is
 * written by `auto:interrupt`; it carries operator identity, reason, and
 * timestamp. The worker echoes those into its exit log so the audit trail
 * shows who pulled the cord and why.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';

export interface InterruptSentinel {
  task_id: string;
  run_id: string;
  at: string;
  by: string;
  pid: number;
  host: string;
  reason: string;
}

/** Path of the interrupt sentinel for a given (runId, taskId). */
export function interruptSentinelPath(runId: string, taskId: string): string {
  return path.join(harnessRoot(), '.agent-runs', runId, `_interrupt-${taskId}.json`);
}

/**
 * Check for an interrupt sentinel. Returns the parsed sentinel if present,
 * null otherwise. Cheap (single fs.existsSync + small fs.readFileSync); safe
 * to call frequently inside iteration loops.
 */
export function readInterrupt(runId: string, taskId: string): InterruptSentinel | null {
  const p = interruptSentinelPath(runId, taskId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as InterruptSentinel;
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper: returns true if interrupted. Most callers want this.
 */
export function isInterrupted(runId: string, taskId: string): boolean {
  return readInterrupt(runId, taskId) !== null;
}

/**
 * Throws an `InterruptedError` if the sentinel is present. Intended for
 * call-sites that want to bail loudly.
 */
export class InterruptedError extends Error {
  readonly sentinel: InterruptSentinel;
  constructor(sentinel: InterruptSentinel) {
    super(`Task ${sentinel.task_id} interrupted by ${sentinel.by} at ${sentinel.at}: ${sentinel.reason}`);
    this.name = 'InterruptedError';
    this.sentinel = sentinel;
  }
}

export function throwIfInterrupted(runId: string, taskId: string): void {
  const sentinel = readInterrupt(runId, taskId);
  if (sentinel) throw new InterruptedError(sentinel);
}
