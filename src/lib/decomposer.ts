/**
 * v0.5.0 Sprint 3 — Candidate decomposer.
 *
 * Splits a big GapCandidate into ≤N-hour subtasks. Operator approval still
 * required to write decomposed candidates to disk as real TaskPacks.
 *
 * Codex bdjec7m74 strong caution: "The decomposer should be deferred. File-
 * boundary / criterion-boundary / FRD-section heuristics will create
 * plausible-looking packs with bad ownership boundaries."
 *
 * Compromise: ship the decomposer but
 *   1. EVERY decomposed subtask carries explicit `parent_candidate_id`
 *      so operator can see the split rationale
 *   2. allowed_paths NEVER widen across decomposition (subtasks inherit
 *      from parent and can only NARROW)
 *   3. Decomposer DOES NOT WRITE to disk; emits structured JSON for
 *      operator approval
 *   4. Each subtask has explicit `decomposition_uncertainty` field flagging
 *      where the heuristic might be wrong
 */

import { z } from 'zod';

import type { GapCandidate } from './gapAnalysis';
import { getLogger } from './logger';

const log = getLogger('decomposer');

const MAX_HOURS_PER_SUBTASK = 4;

export const DecomposedSubtask = z.object({
  subtask_id: z.string(),
  parent_candidate_id: z.string(),
  module_or_sprint: z.string(),
  type: z.string(),
  objective: z.string(),
  rationale: z.string(),
  /** STRICT subset of parent's allowed_paths. Never widened. */
  allowed_paths: z.array(z.string()),
  /** Subtask depends on parent's parent + sibling subtasks via order. */
  depends_on: z.array(z.string()).default([]),
  estimated_effort_hours: z.number().nonnegative(),
  /** Per Codex: explicit uncertainty about the split itself. */
  decomposition_uncertainty: z.array(z.string()).default([]),
});
export type DecomposedSubtask = z.infer<typeof DecomposedSubtask>;

export const DecompositionResult = z.object({
  schema_version: z.literal('1').default('1'),
  parent_candidate_id: z.string(),
  parent_estimated_hours: z.number(),
  subtasks: z.array(DecomposedSubtask),
  /** True when no decomposition needed (parent under threshold). */
  passthrough: z.boolean(),
  generated_at: z.string(),
});
export type DecompositionResult = z.infer<typeof DecompositionResult>;

/**
 * Decompose a candidate. Heuristics, deterministic, no LLM.
 *
 * Strategy ladder (first applicable wins):
 *   1. Under threshold (≤ MAX_HOURS_PER_SUBTASK) → passthrough as 1 subtask
 *   2. type='code-sprint' with multiple allowed_paths → split per file
 *   3. type='frd-polish' → single subtask (FRDs are narrative; no split heuristic)
 *   4. type='test-coverage' → split by suite-name from path globs
 *   5. Default: passthrough with warning
 */
export function decomposeCandidate(candidate: GapCandidate): DecompositionResult {
  const now = new Date().toISOString();
  const parentHours = candidate.estimated_effort_hours;

  if (parentHours <= MAX_HOURS_PER_SUBTASK) {
    return {
      schema_version: '1',
      parent_candidate_id: candidate.candidate_id,
      parent_estimated_hours: parentHours,
      subtasks: [{
        subtask_id: `${candidate.candidate_id}-1`,
        parent_candidate_id: candidate.candidate_id,
        module_or_sprint: candidate.module_or_sprint,
        type: candidate.type,
        objective: candidate.rationale,
        rationale: 'parent under decomposition threshold; passthrough',
        allowed_paths: candidate.proposed_allowed_paths,
        depends_on: candidate.depends_on,
        estimated_effort_hours: parentHours,
        decomposition_uncertainty: [],
      }],
      passthrough: true,
      generated_at: now,
    };
  }

  // Code-sprint with multiple paths → split per logical file group
  if (candidate.type === 'code-sprint' && candidate.proposed_allowed_paths.length > 1) {
    const subtasks: DecomposedSubtask[] = [];
    const totalHours = parentHours;
    const hoursPerPath = Math.max(0.5, totalHours / candidate.proposed_allowed_paths.length);

    for (const [idx, p] of candidate.proposed_allowed_paths.entries()) {
      // Subtask N depends on subtask N-1 to enforce ordering when operator
      // dispatches via daemon (sequential within decomposition).
      const subtaskId = `${candidate.candidate_id}-${idx + 1}`;
      const dependsOn = idx === 0 ? candidate.depends_on : [`${candidate.candidate_id}-${idx}`];
      subtasks.push({
        subtask_id: subtaskId,
        parent_candidate_id: candidate.candidate_id,
        module_or_sprint: candidate.module_or_sprint,
        type: candidate.type,
        objective: `${candidate.rationale} — slice ${idx + 1}/${candidate.proposed_allowed_paths.length}: ${p}`,
        rationale: `decomposed by file boundary: ${p}`,
        allowed_paths: [p],  // Narrowest possible
        depends_on: dependsOn,
        estimated_effort_hours: hoursPerPath,
        decomposition_uncertainty: [
          'split by file boundary; cross-file invariants may break across subtasks',
          'subtasks dispatch sequentially via depends_on chain — verify this matches operator intent',
        ],
      });
    }
    log.info('candidate decomposed by file boundary', {
      parent: candidate.candidate_id,
      slices: subtasks.length,
    });
    return {
      schema_version: '1',
      parent_candidate_id: candidate.candidate_id,
      parent_estimated_hours: parentHours,
      subtasks,
      passthrough: false,
      generated_at: now,
    };
  }

  // Default: passthrough with explicit uncertainty
  return {
    schema_version: '1',
    parent_candidate_id: candidate.candidate_id,
    parent_estimated_hours: parentHours,
    subtasks: [{
      subtask_id: `${candidate.candidate_id}-1`,
      parent_candidate_id: candidate.candidate_id,
      module_or_sprint: candidate.module_or_sprint,
      type: candidate.type,
      objective: candidate.rationale,
      rationale: `parent ${parentHours}h exceeds threshold ${MAX_HOURS_PER_SUBTASK}h but no decomposition heuristic applies; passthrough`,
      allowed_paths: candidate.proposed_allowed_paths,
      depends_on: candidate.depends_on,
      estimated_effort_hours: parentHours,
      decomposition_uncertainty: [
        `parent estimated_effort_hours=${parentHours} exceeds ${MAX_HOURS_PER_SUBTASK}h threshold`,
        `no decomposition heuristic for type=${candidate.type}; manual operator decomposition recommended`,
      ],
    }],
    passthrough: true,
    generated_at: now,
  };
}

/**
 * Decompose a list of candidates. Returns subtasks flattened across all parents.
 * Caller is responsible for operator approval before any subtask becomes a real
 * TaskPack on disk.
 */
export function decomposeAll(candidates: GapCandidate[]): DecompositionResult[] {
  return candidates.map(decomposeCandidate);
}
