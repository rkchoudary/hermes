#!/usr/bin/env tsx
/**
 * Smoke test for v0.5.0 Sprint 3 — decomposer + scheduler.
 *
 * Codex bdjec7m74 pushed back HARD on these (especially decomposer).
 * Operator overrode and asked for the deferred items. Tests enforce
 * Codex's safety constraints:
 *   - decomposed subtasks NEVER widen allowed_paths (only narrow)
 *   - scheduler uses transparent tuple, NOT weighted scalar
 *   - fan-out is LATE tie-breaker (after operator priority + criterion impact)
 *   - blocked items rank below ready items
 */

import type { GapCandidate } from '../gapAnalysis';
import { decomposeCandidate, decomposeAll } from '../decomposer';
import { schedule } from '../scheduler';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makeCandidate(overrides: Partial<GapCandidate> = {}): GapCandidate {
  return {
    candidate_id: 'gap-M01-frd-polish',
    module_or_sprint: 'M01',
    type: 'frd-polish',
    rationale: 'FRD status PARTIAL',
    contributes_to_criterion: 'c1',
    evidence: [],
    proposed_allowed_paths: ['docs/frd-m01/**'],
    unblocks: [],
    depends_on: [],
    estimated_effort_hours: 2,
    ranking: {
      dependency_readiness: true,
      operator_priority: 1.0,
      criterion_impact: 1.0,
      estimated_cost_usd: 1.5,
      freshness_days: 30,
    },
    uncertainty: [],
    ...overrides,
  };
}

console.log('— scheduling.smoke');

// === DECOMPOSER ===
console.log('\nDecomposer:');

// 1. Under threshold → passthrough
{
  const r = decomposeCandidate(makeCandidate({ estimated_effort_hours: 2 }));
  assert(r.passthrough === true, '1a. ≤4h passthrough');
  assert(r.subtasks.length === 1, '1b. one subtask');
  assert(r.subtasks[0].decomposition_uncertainty.length === 0, '1c. zero uncertainty for passthrough');
}

// 2. Over threshold + multiple paths + code-sprint → split per file
{
  const r = decomposeCandidate(makeCandidate({
    candidate_id: 'gap-M02-code-sprint',
    type: 'code-sprint',
    estimated_effort_hours: 12,
    proposed_allowed_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  }));
  assert(r.passthrough === false, '2a. decomposed (not passthrough)');
  assert(r.subtasks.length === 3, '2b. 3 subtasks');
  // Codex non-negotiable: NEVER widen allowed_paths
  for (const s of r.subtasks) {
    assert(s.allowed_paths.length === 1, `2c. subtask ${s.subtask_id} narrows to 1 path`);
    assert(['src/a.ts', 'src/b.ts', 'src/c.ts'].includes(s.allowed_paths[0]), `2d. subtask path is subset of parent`);
  }
  // Subtask N depends on subtask N-1 (sequential within decomposition)
  assert(r.subtasks[0].depends_on.length === 0, '2e. first subtask no deps');
  assert(r.subtasks[1].depends_on.includes(r.subtasks[0].subtask_id), '2f. second subtask deps on first');
  assert(r.subtasks[2].depends_on.includes(r.subtasks[1].subtask_id), '2g. third subtask deps on second');
}

// 3. Over threshold but no decomposition heuristic → passthrough with uncertainty
{
  const r = decomposeCandidate(makeCandidate({
    type: 'frd-polish',
    estimated_effort_hours: 8,
  }));
  assert(r.passthrough === true, '3a. frd-polish 8h passthrough');
  assert(r.subtasks[0].decomposition_uncertainty.length > 0, '3b. uncertainty cited');
  assert(r.subtasks[0].decomposition_uncertainty[0].includes('exceeds'), '3c. uncertainty mentions threshold');
}

// 4. decomposeAll batches
{
  const r = decomposeAll([
    makeCandidate({ candidate_id: 'a', estimated_effort_hours: 1 }),
    makeCandidate({ candidate_id: 'b', type: 'code-sprint', estimated_effort_hours: 8, proposed_allowed_paths: ['x.ts', 'y.ts'] }),
  ]);
  assert(r.length === 2, '4a. 2 results');
  assert(r[0].passthrough && !r[1].passthrough, '4b. first passthrough; second decomposed');
}

// === SCHEDULER ===
console.log('\nScheduler:');

// 5. Empty input → empty schedule
{
  const r = schedule({ candidates: [], decomposed: [], in_flight_or_done: new Set(), completed_modules: new Set() });
  assert(r.items.length === 0, '5. empty input → 0 scheduled');
}

// 6. Higher operator_priority comes first (transparent tuple)
{
  const r = schedule({
    candidates: [
      makeCandidate({ candidate_id: 'low', module_or_sprint: 'M-low', ranking: { ...makeCandidate().ranking, operator_priority: 1.0 } }),
      makeCandidate({ candidate_id: 'hi', module_or_sprint: 'M-hi', ranking: { ...makeCandidate().ranking, operator_priority: 3.0 } }),
    ],
    decomposed: [],
    in_flight_or_done: new Set(),
    completed_modules: new Set(),
  });
  assert(r.items[0].scheduled_id === 'hi', '6a. hi-priority item ranked first');
  assert(r.items[1].scheduled_id === 'low', '6b. low-priority item ranked second');
}

// 7. Blocked items rank BELOW ready items (Codex-non-negotiable)
{
  const r = schedule({
    candidates: [
      makeCandidate({ candidate_id: 'blocked', module_or_sprint: 'M-blocked', depends_on: ['M-other'], ranking: { ...makeCandidate().ranking, operator_priority: 5.0 } }),
      makeCandidate({ candidate_id: 'ready', module_or_sprint: 'M-ready', ranking: { ...makeCandidate().ranking, operator_priority: 1.0 } }),
    ],
    decomposed: [],
    in_flight_or_done: new Set(),
    completed_modules: new Set(),  // M-other not completed
  });
  assert(r.items[0].scheduled_id === 'ready', '7a. ready item ranks above blocked even at lower priority');
  assert(r.items[0].ready === true, '7b. first item ready=true');
  assert(r.items[1].ready === false, '7c. second item ready=false (blocked)');
  assert(r.ready_through_rank === 1, '7d. ready_through_rank=1');
}

// 8. Fan-out is LATE tie-breaker, not main optimizer (Codex non-negotiable)
{
  const r = schedule({
    candidates: [
      makeCandidate({ candidate_id: 'big-fanout-low-prio', module_or_sprint: 'M-fan', ranking: { ...makeCandidate().ranking, operator_priority: 1.0 } }),
      makeCandidate({ candidate_id: 'small-fanout-high-prio', module_or_sprint: 'M-prio', ranking: { ...makeCandidate().ranking, operator_priority: 3.0 } }),
      // Big fan-out comes from lots of dependents on M-fan; we'll fake by adding 5 candidates depending on it
      ...Array.from({ length: 5 }, (_, i) => makeCandidate({
        candidate_id: `dep${i}`,
        module_or_sprint: `M-dep${i}`,
        depends_on: ['big-fanout-low-prio'],
        ranking: { ...makeCandidate().ranking, operator_priority: 0.1 },
      })),
    ],
    decomposed: [],
    in_flight_or_done: new Set(),
    completed_modules: new Set(),
  });
  // High priority should still beat high fan-out
  assert(r.items[0].scheduled_id === 'small-fanout-high-prio', '8. high priority beats high fan-out (fan-out is late tie-breaker)');
}

// 9. Decomposed subtasks honored
{
  const decomposition = decomposeCandidate(makeCandidate({
    candidate_id: 'big',
    type: 'code-sprint',
    estimated_effort_hours: 8,
    proposed_allowed_paths: ['src/a.ts', 'src/b.ts'],
  }));
  const r = schedule({
    candidates: [makeCandidate({ candidate_id: 'big', type: 'code-sprint' })],
    decomposed: decomposition.subtasks,
    in_flight_or_done: new Set(),
    completed_modules: new Set(),
  });
  // Parent candidate should be absorbed; only subtasks scheduled
  const parentInSchedule = r.items.find((i) => i.scheduled_id === 'big');
  assert(parentInSchedule === undefined, '9a. parent candidate absorbed by subtasks (not scheduled)');
  assert(r.items.length === 2, '9b. 2 subtasks scheduled');
  assert(r.items[0].scheduled_id.endsWith('-1'), '9c. first subtask first');
  assert(r.items[1].scheduled_id.endsWith('-2'), '9d. second subtask second');
}

// 10. ranking_reason is human-readable
{
  const r = schedule({
    candidates: [makeCandidate({ candidate_id: 'x', depends_on: ['Y'] })],
    decomposed: [],
    in_flight_or_done: new Set(),
    completed_modules: new Set(),
  });
  assert(r.items[0].ranking_reason.includes('blocked by Y'), '10a. blocked item ranking_reason cites blocker');
  const r2 = schedule({
    candidates: [makeCandidate({ candidate_id: 'x' })],
    decomposed: [],
    in_flight_or_done: new Set(),
    completed_modules: new Set(),
  });
  assert(r2.items[0].ranking_reason.includes('priority'), '10b. ready item ranking_reason cites priority');
}

console.log('\n✓ all scheduling.smoke assertions passed');
