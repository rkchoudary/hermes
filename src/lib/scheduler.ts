/**
 * v0.5.0 Sprint 3 — Critical-path scheduler.
 *
 * Codex bdjec7m74 strong caution: "Critical-path scheduling should not treat
 * fan-out as priority. Fan-out is only one dimension. Use a transparent
 * tuple, not a weighted scalar score."
 *
 * Compromise: ship the scheduler but
 *   1. EXPLICIT TUPLE comparator — caller can see exactly which axes drive
 *      ordering (no weighted scalar that hides reasoning)
 *   2. Operator-priority lexicographically beats fan-out
 *   3. Each ranking decision recorded with `ranking_reason` so replay can
 *      explain WHY a task was scheduled before another
 *   4. Fan-out is a LATE tie-breaker, not the main optimizer
 */

import { z } from 'zod';

import type { GapCandidate } from './gapAnalysis';
import type { DecomposedSubtask } from './decomposer';

export const ScheduledItem = z.object({
  /** Either candidate_id (no decomposition) or subtask_id (decomposed). */
  scheduled_id: z.string(),
  module_or_sprint: z.string(),
  type: z.string(),
  /** Position in the schedule (1 = first). */
  rank: z.number().int().positive(),
  /** Comma-separated tuple values for transparent ordering. */
  ranking_tuple: z.string(),
  /** Human-readable reason this item ranks where it does. */
  ranking_reason: z.string(),
  /** depends_on chain hold — true when something blocks this. */
  blocked_by: z.array(z.string()).default([]),
  /** Ready to dispatch (no blockers + dependency_readiness). */
  ready: z.boolean(),
});
export type ScheduledItem = z.infer<typeof ScheduledItem>;

export const ScheduleResult = z.object({
  schema_version: z.literal('1').default('1'),
  generated_at: z.string(),
  items: z.array(ScheduledItem),
  /** Index of the first item that's blocked (everything before is ready). */
  ready_through_rank: z.number().int().nonnegative(),
});
export type ScheduleResult = z.infer<typeof ScheduleResult>;

interface SchedulerInput {
  candidates: GapCandidate[];
  decomposed: DecomposedSubtask[];
  /** Set of task_ids currently in flight or terminal (skip from schedule). */
  in_flight_or_done: Set<string>;
  /** Set of completed module IDs (drives dependency_readiness for downstream). */
  completed_modules: Set<string>;
}

/**
 * Critical-path scheduler. Orders items by transparent tuple:
 *   1. dependency_readiness DESC (true first; ready tasks before blocked)
 *   2. operator_priority DESC (hot modules first)
 *   3. criterion_impact DESC (bigger impact first)
 *   4. fan_out DESC (unblocks more tasks; LATE tie-breaker per Codex)
 *   5. estimated_cost_usd ASC (cheaper first within tie)
 *   6. module_id ASC (stable final tie-break)
 *
 * Returns ordered list with explicit ranking_reason per item.
 */
export function schedule(input: SchedulerInput): ScheduleResult {
  const now = new Date().toISOString();

  // Treat decomposed subtasks as schedulable units. If a subtask has a parent
  // candidate, use the subtask. Otherwise use the candidate directly.
  type Schedulable = {
    id: string;
    module_or_sprint: string;
    type: string;
    operator_priority: number;
    criterion_impact: number;
    cost_usd: number;
    fan_out: number;
    dependency_readiness: boolean;
    blocked_by: string[];
  };

  const schedulables: Schedulable[] = [];

  // Build lookup for fan_out (count tasks that depend on each)
  const dependentsOf = new Map<string, number>();
  const allItems: Array<{ id: string; depends_on: string[] }> = [
    ...input.candidates.map((c) => ({ id: c.candidate_id, depends_on: c.depends_on })),
    ...input.decomposed.map((s) => ({ id: s.subtask_id, depends_on: s.depends_on })),
  ];
  for (const item of allItems) {
    for (const dep of item.depends_on) {
      dependentsOf.set(dep, (dependentsOf.get(dep) ?? 0) + 1);
    }
  }

  // Decomposed subtasks have priority; their parent candidates are absorbed.
  const decomposedParents = new Set(input.decomposed.map((s) => s.parent_candidate_id));

  for (const c of input.candidates) {
    if (decomposedParents.has(c.candidate_id)) continue; // absorbed by subtasks
    if (input.in_flight_or_done.has(c.candidate_id)) continue;
    const blockedBy = c.depends_on.filter((d) => !input.completed_modules.has(d) && !input.in_flight_or_done.has(d));
    schedulables.push({
      id: c.candidate_id,
      module_or_sprint: c.module_or_sprint,
      type: c.type,
      operator_priority: c.ranking.operator_priority,
      criterion_impact: c.ranking.criterion_impact,
      cost_usd: c.ranking.estimated_cost_usd,
      fan_out: dependentsOf.get(c.candidate_id) ?? 0,
      dependency_readiness: blockedBy.length === 0 && c.ranking.dependency_readiness,
      blocked_by: blockedBy,
    });
  }

  for (const s of input.decomposed) {
    if (input.in_flight_or_done.has(s.subtask_id)) continue;
    const blockedBy = s.depends_on.filter((d) => !input.completed_modules.has(d) && !input.in_flight_or_done.has(d));
    // Inherit operator_priority + criterion_impact from parent candidate
    const parent = input.candidates.find((c) => c.candidate_id === s.parent_candidate_id);
    schedulables.push({
      id: s.subtask_id,
      module_or_sprint: s.module_or_sprint,
      type: s.type,
      operator_priority: parent?.ranking.operator_priority ?? 1.0,
      criterion_impact: parent?.ranking.criterion_impact ?? 1.0,
      cost_usd: parent?.ranking.estimated_cost_usd ?? 1.5,
      fan_out: dependentsOf.get(s.subtask_id) ?? 0,
      dependency_readiness: blockedBy.length === 0,
      blocked_by: blockedBy,
    });
  }

  // Tuple sort (transparent, no weighted scalar)
  schedulables.sort((a, b) => {
    if (a.dependency_readiness !== b.dependency_readiness) return a.dependency_readiness ? -1 : 1;
    if (a.operator_priority !== b.operator_priority) return b.operator_priority - a.operator_priority;
    if (a.criterion_impact !== b.criterion_impact) return b.criterion_impact - a.criterion_impact;
    if (a.fan_out !== b.fan_out) return b.fan_out - a.fan_out;
    if (a.cost_usd !== b.cost_usd) return a.cost_usd - b.cost_usd;
    return a.module_or_sprint.localeCompare(b.module_or_sprint);
  });

  const items: ScheduledItem[] = schedulables.map((s, idx) => ({
    scheduled_id: s.id,
    module_or_sprint: s.module_or_sprint,
    type: s.type,
    rank: idx + 1,
    ranking_tuple: `ready=${s.dependency_readiness} prio=${s.operator_priority.toFixed(1)} impact=${s.criterion_impact.toFixed(1)} fan=${s.fan_out} cost=$${s.cost_usd.toFixed(2)}`,
    ranking_reason: !s.dependency_readiness
      ? `blocked by ${s.blocked_by.join(', ')}`
      : `priority ${s.operator_priority.toFixed(1)}, impact ${s.criterion_impact.toFixed(1)}, unblocks ${s.fan_out}, cost $${s.cost_usd.toFixed(2)}`,
    blocked_by: s.blocked_by,
    ready: s.dependency_readiness,
  }));

  let readyThroughRank = 0;
  for (const item of items) {
    if (item.ready) readyThroughRank = item.rank;
    else break;
  }

  return { schema_version: '1', generated_at: now, items, ready_through_rank: readyThroughRank };
}
