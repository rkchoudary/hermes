/**
 * Shared materializer — turns approved gap candidates into TaskPacks.
 *
 * Codex efficiency review (2026-04-29) Ship-First: factor this out of
 * tick.ts so `auto:approve` can call it inline (no separate
 * `auto:tick --materialize-approvals` shell required) and the daemon's
 * auto-replenish can skip the shell-out → eliminates 30s of dead air per
 * approval cycle.
 *
 * Pure-ish: file-read + file-write only. No subprocess, no network.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { candidateToTaskPack } from './candidateToTaskPack';
import { listRuns, listTasks, writeTaskPack } from './runState';
import { TaskPack } from './taskPack';

export interface MaterializeOptions {
  /** Harness root containing .agent-runs/ */
  harnessRoot: string;
  /** When true, validates + reports but does not write to disk. */
  dryRun?: boolean;
  /** Optional logger; defaults to console.log on verbose path. */
  log?: (msg: string) => void;
}

export interface MaterializeResult {
  pending_before: number;
  materialized: number;
  pending_after: number;
  details: Array<{
    candidate_id: string;
    task_id?: string;
    error?: string;
  }>;
}

/**
 * Read `.agent-runs/_approved-candidates.jsonl`, materialize every entry
 * that doesn't already have `materialized_as`, write the resulting TaskPacks,
 * and rewrite the JSONL with `materialized_as` set.
 *
 * Returns a structured result for telemetry. Callers should NOT assume
 * any specific exit behavior — the function is invoked inline (not as a
 * separate process).
 */
export async function materializeApprovals(opts: MaterializeOptions): Promise<MaterializeResult> {
  const log = opts.log ?? (() => { /* noop */ });
  const approvalsPath = path.join(opts.harnessRoot, '.agent-runs', '_approved-candidates.jsonl');
  const result: MaterializeResult = {
    pending_before: 0,
    materialized: 0,
    pending_after: 0,
    details: [],
  };

  if (!fs.existsSync(approvalsPath)) {
    log(`[materialize] no approvals file at ${approvalsPath}`);
    return result;
  }

  const lines = fs.readFileSync(approvalsPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const entries = lines
    .map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter((x): x is Record<string, unknown> => x !== null);
  const pending = entries.filter((e) => !e.materialized_as);
  result.pending_before = pending.length;

  if (pending.length === 0) {
    log(`[materialize] 0 pending approvals`);
    return result;
  }

  // Target run_id: prefer most-recent existing run; else today's batch
  const runs = listRuns().sort();
  const runId = runs[runs.length - 1] ?? `${new Date().toISOString().slice(0, 10)}-batch-1`;
  // Compute next task_seq within run
  const existingIds = listTasks(runId).filter((t) => /^TP-\d{4}-\d{2}-\d{2}-\d{3,}$/.test(t));
  let nextSeq = existingIds
    .map((t) => parseInt(t.split('-').pop() ?? '0', 10))
    .reduce((a, b) => Math.max(a, b), 0) + 1;

  const updatedLines: string[] = [];
  for (const entry of entries) {
    if (entry.materialized_as) {
      updatedLines.push(JSON.stringify(entry));
      continue;
    }
    const candidate = entry.candidate as Parameters<typeof candidateToTaskPack>[0];
    const candidateId = String(candidate?.candidate_id ?? 'unknown');
    try {
      const pack = candidateToTaskPack(candidate, {
        run_id: runId,
        task_seq: nextSeq++,
        approver_name: String(entry.approver),
        approved_at: String(entry.approved_at),
        approval_batch_id: entry.approval_batch_id ? String(entry.approval_batch_id) : undefined,
        extra_non_goals: Array.isArray(entry.extra_non_goals) ? entry.extra_non_goals as string[] : [],
        evidence_dir_override: typeof entry.evidence_dir_override === 'string' ? entry.evidence_dir_override : undefined,
      });
      const validated = TaskPack.parse(pack);
      if (!opts.dryRun) writeTaskPack(validated);
      entry.materialized_as = {
        task_id: validated.task_id,
        run_id: validated.run_id,
        materialized_at: new Date().toISOString(),
      };
      result.materialized += 1;
      result.details.push({ candidate_id: candidateId, task_id: validated.task_id });
      log(`[materialize] ✓ ${candidateId} → ${validated.task_id}`);
    } catch (e) {
      const error = (e as Error).message.slice(0, 200);
      result.details.push({ candidate_id: candidateId, error });
      log(`[materialize] ✗ ${candidateId}: ${error}`);
    }
    updatedLines.push(JSON.stringify(entry));
  }

  // Atomic rewrite the JSONL with materialized_as updates
  if (!opts.dryRun && result.materialized > 0) {
    const tmp = approvalsPath + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, updatedLines.join('\n') + '\n');
    fs.renameSync(tmp, approvalsPath);
  }

  result.pending_after = pending.length - result.materialized;
  return result;
}
