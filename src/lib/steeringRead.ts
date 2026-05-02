/**
 * steeringRead.ts — read-side helper for auto:steer.
 *
 * Workers call `consumePendingSteering(runId, taskId, currentRound)` at
 * iteration boundaries (start of each work/postflight/patch round). It:
 *   1. Reads .agent-runs/<run>/_steering-<task_id>.jsonl
 *   2. Selects unconsumed entries whose ttl_rounds > 0
 *   3. Marks them consumed (writes back the updated jsonl atomically)
 *   4. Returns the formatted prompt insert ready to prepend to the dispatch
 *
 * Pure read+update — no LLM dispatch. The worker is responsible for actually
 * including the returned text in its next prompt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';

export interface SteeringEntry {
  at: string;
  by: string;
  pid: number;
  host: string;
  directive: string;
  ttl_rounds: number;
  consumed_at?: string;
  consumed_in_round?: number;
}

function steeringFilePath(runId: string, taskId: string): string {
  return path.join(harnessRoot(), '.agent-runs', runId, `_steering-${taskId}.jsonl`);
}

function readAll(file: string): SteeringEntry[] {
  if (!fs.existsSync(file)) return [];
  const out: SteeringEntry[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

/**
 * Consume pending directives. Returns the markdown-formatted block to
 * prepend to the worker's prompt, or empty string if no pending directives.
 *
 * Side effect: marks the consumed entries with consumed_at + consumed_in_round
 * and rewrites the jsonl file atomically (tempfile + rename).
 *
 * Idempotent within a single round: calling twice in the same round
 * returns the same text the first time (entries become consumed); the
 * second call returns empty.
 */
export function consumePendingSteering(runId: string, taskId: string, currentRound: number): string {
  const file = steeringFilePath(runId, taskId);
  const entries = readAll(file);
  if (entries.length === 0) return '';

  const now = new Date().toISOString();
  const consumed: SteeringEntry[] = [];
  const updated: SteeringEntry[] = [];

  for (const e of entries) {
    if (e.consumed_at) {
      updated.push(e);
      continue;
    }
    if (e.ttl_rounds <= 0) {
      // Expired without being consumed — mark as such for audit.
      updated.push({ ...e, consumed_at: now, consumed_in_round: -1 });
      continue;
    }
    // Consume this entry now.
    consumed.push(e);
    updated.push({ ...e, consumed_at: now, consumed_in_round: currentRound, ttl_rounds: e.ttl_rounds - 1 });
  }

  if (consumed.length === 0) return '';

  // Atomic rewrite
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, updated.map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.renameSync(tmp, file);

  // Format for prompt insertion
  const lines: string[] = [];
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  PRIORITY OPERATOR DIRECTIVES');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('The operator has issued the following directive(s) since the last round.');
  lines.push('Treat these as overriding the original objective where they conflict:');
  lines.push('');
  for (const e of consumed) {
    lines.push(`  • [${e.at}] from ${e.by}: ${e.directive}`);
  }
  lines.push('');
  return lines.join('\n');
}

/** List pending (unconsumed) steering for a task — for diagnostic UI. */
export function listPendingSteering(runId: string, taskId: string): SteeringEntry[] {
  return readAll(steeringFilePath(runId, taskId)).filter(e => !e.consumed_at && e.ttl_rounds > 0);
}
