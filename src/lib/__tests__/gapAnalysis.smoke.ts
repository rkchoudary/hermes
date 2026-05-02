#!/usr/bin/env tsx
/**
 * Smoke test for v0.5.0 Sprint 2 — gapAnalysis (Codex bdjec7m74).
 *
 * Codex prescription: "Add real-ish golden fixture tests and invariant tests:
 *   - no sibling allowed_paths
 *   - no duplicate in-flight candidates
 *   - dependencies valid
 *   - effort cap respected
 *   - stable ranking under irrelevant file changes"
 *
 * Asserts:
 *   1. Empty inventory → zero candidates
 *   2. Module with FRD UNKNOWN → emits frd-polish candidate
 *   3. Module with in-flight task → SKIPPED (no duplicate)
 *   4. Cold-listed module → SKIPPED
 *   5. Hot module → ranked above non-hot at same FRD status
 *   6. max_candidates_per_run cap respected
 *   7. Stable ranking: same input twice → same output
 *   8. Property test: 50 randomized inventories satisfy invariants:
 *      - candidates_capped_to ≤ max_candidates_per_run
 *      - no candidate for module already in-flight
 *      - no candidate for cold module
 *      - ranking is monotonic non-decreasing in priority
 */

import type { GoalContract } from '../goal';
import { rankCandidates, classifyPrBranch, type ModuleSummary, type GapCandidate } from '../gapAnalysis';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makeGoal(overrides: Partial<GoalContract> = {}): GoalContract {
  return {
    schema_version: '1',
    goal_id: 'g-test',
    name: 'test goal',
    created_at: '2026-04-29T10:00:00Z',
    completion_criteria: [{
      id: 'c1',
      description: 'all modules at FRD GO',
      predicate_type: 'all_modules_merged',
      target: 87,
      current: 0,
      params: {},
    }],
    operator_overrides: [],
    broadcast_on_completion: ['log'],
    status: 'active',
    planning_hints: {
      hot_modules: [],
      cold_modules: [],
      module_weights: {},
      max_candidates_per_run: 10,
    },
    ...overrides,
  };
}

function makeModule(overrides: Partial<ModuleSummary> = {}): ModuleSummary {
  return {
    module_id: 'M01',
    frd_status: 'UNKNOWN',
    frd_score: null,
    has_impl: false,
    has_tests: false,
    code_paths: [],
    existing_tasks: [],
    last_active_at: null,
    open_prs: [],
    merged_prs: [],
    ...overrides,
  };
}

console.log('— gapAnalysis.smoke');

// 1. Empty inventory → zero candidates
{
  const r = rankCandidates({ goal: makeGoal(), inventory: { modules: [], existingTasks: [] } });
  assert(r.candidates.length === 0, '1. empty inventory → 0 candidates');
}

// 2. Module with UNKNOWN FRD status → emits frd-polish candidate
{
  const r = rankCandidates({
    goal: makeGoal(),
    inventory: { modules: [makeModule({ module_id: 'M02', frd_status: 'UNKNOWN' })], existingTasks: [] },
  });
  assert(r.candidates.length === 1, '2a. UNKNOWN status → 1 candidate');
  assert(r.candidates[0].type === 'frd-polish', '2b. type=frd-polish');
  assert(r.candidates[0].module_or_sprint === 'M02', '2c. module=M02');
  assert(r.candidates[0].rationale.includes('UNKNOWN'), '2d. rationale cites status');
}

// 3. Module with in-flight task → SKIPPED
{
  const r = rankCandidates({
    goal: makeGoal(),
    inventory: {
      modules: [makeModule({
        module_id: 'M03',
        frd_status: 'PARTIAL',
        existing_tasks: [{ task_id: 'TP-X', state: 'awaiting-review', type: 'frd-polish' }],
      })],
      existingTasks: [],
    },
  });
  assert(r.candidates.length === 0, '3. module with in-flight task → 0 candidates (no duplicate)');
}

// 4. Cold-listed module → SKIPPED
{
  const r = rankCandidates({
    goal: makeGoal({ planning_hints: { hot_modules: [], cold_modules: ['M04'], module_weights: {}, max_candidates_per_run: 10 } }),
    inventory: { modules: [makeModule({ module_id: 'M04', frd_status: 'PARTIAL' })], existingTasks: [] },
  });
  assert(r.candidates.length === 0, '4. cold-listed module → SKIPPED');
}

// 5. Hot module ranked above non-hot at same FRD status
{
  const r = rankCandidates({
    goal: makeGoal({ planning_hints: { hot_modules: ['M05'], cold_modules: [], module_weights: {}, max_candidates_per_run: 10 } }),
    inventory: {
      modules: [
        makeModule({ module_id: 'M06', frd_status: 'PARTIAL' }),
        makeModule({ module_id: 'M05', frd_status: 'PARTIAL' }),
      ],
      existingTasks: [],
    },
  });
  assert(r.candidates.length === 2, '5a. 2 candidates');
  assert(r.candidates[0].module_or_sprint === 'M05', '5b. M05 (hot) ranked first');
  assert(r.candidates[0].ranking.operator_priority > r.candidates[1].ranking.operator_priority, '5c. priority M05 > M06');
}

// 6. max_candidates_per_run cap respected
{
  const modules = Array.from({ length: 25 }, (_, i) => makeModule({ module_id: `M${(i + 10).toString().padStart(2, '0')}`, frd_status: 'PARTIAL' as const }));
  const r = rankCandidates({
    goal: makeGoal({ planning_hints: { hot_modules: [], cold_modules: [], module_weights: {}, max_candidates_per_run: 5 } }),
    inventory: { modules, existingTasks: [] },
  });
  assert(r.candidates.length === 5, '6a. cap=5 enforced (got ' + r.candidates.length + ')');
  assert(r.inventory_summary.candidates_before_cap === 25, '6b. before-cap=25');
  assert(r.inventory_summary.candidates_capped_to === 5, '6c. capped-to=5');
}

// 7. Stable ranking: same input twice → same output
{
  const goal = makeGoal();
  const inventory = { modules: [
    makeModule({ module_id: 'M11', frd_status: 'PARTIAL' as const }),
    makeModule({ module_id: 'M12', frd_status: 'GO' as const, has_impl: true }),
    makeModule({ module_id: 'M13', frd_status: 'DRAFT' as const }),
  ], existingTasks: [] };
  const r1 = rankCandidates({ goal, inventory });
  const r2 = rankCandidates({ goal, inventory });
  assert(r1.candidates.length === r2.candidates.length, '7a. same length both runs');
  for (let i = 0; i < r1.candidates.length; i++) {
    assert(r1.candidates[i].candidate_id === r2.candidates[i].candidate_id, `7b.${i} candidate_id stable`);
  }
}

// 8. Property test
{
  console.log('\n8. Property test: 50 randomized inventories');
  let violations = 0;
  const rand = mulberry32(7);
  for (let it = 0; it < 50; it++) {
    const cap = 1 + Math.floor(rand() * 15);
    const moduleCount = Math.floor(rand() * 30);
    const cold = new Set<string>();
    const modules: ModuleSummary[] = [];
    for (let i = 0; i < moduleCount; i++) {
      const id = `M${(i + 20).toString().padStart(2, '0')}`;
      if (rand() < 0.2) cold.add(id);
      const inFlight = rand() < 0.3;
      const statuses: Array<'GO' | 'PARTIAL' | 'DRAFT' | 'UNKNOWN'> = ['GO', 'PARTIAL', 'DRAFT', 'UNKNOWN'];
      const frdStatus = statuses[Math.floor(rand() * 4)];
      modules.push(makeModule({
        module_id: id,
        frd_status: frdStatus,
        has_impl: rand() < 0.5,
        has_tests: rand() < 0.5,
        existing_tasks: inFlight ? [{ task_id: `TP-${id}`, state: 'in-progress' as const, type: 'frd-polish' as const }] : [],
      }));
    }
    const r = rankCandidates({
      goal: makeGoal({ planning_hints: { hot_modules: [], cold_modules: Array.from(cold), module_weights: {}, max_candidates_per_run: cap } }),
      inventory: { modules, existingTasks: [] },
    });
    // Invariant: cap respected
    if (r.candidates.length > cap) violations++;
    // Invariant: no candidate for in-flight module
    for (const c of r.candidates) {
      const m = modules.find((x) => x.module_id === c.module_or_sprint);
      if (m?.existing_tasks.some((t) => !['merged', 'ready-for-merge', 'abandoned'].includes(t.state))) violations++;
      if (cold.has(c.module_or_sprint)) violations++;
    }
    // Invariant: ranking monotonic (priority DESC)
    for (let i = 1; i < r.candidates.length; i++) {
      if (r.candidates[i].ranking.operator_priority > r.candidates[i - 1].ranking.operator_priority) violations++;
    }
  }
  assert(violations === 0, `   property holds for all 50 iterations (zero invariant violations)`);
}

// 9. PR-awareness: open authoring/refresh PR pre-empts re-suggestion of same kind
{
  // 9a. classifyPrBranch correctness
  assert(classifyPrBranch('docs/frd-m05-auth')?.module_id === 'M05', '9a1. docs/frd-m05-auth → M05');
  assert(classifyPrBranch('docs/frd-m05-auth')?.kind === 'frd', '9a2. docs/frd-m05-auth → kind=frd');
  assert(classifyPrBranch('claude/m02-impl-1c')?.module_id === 'M02', '9a3. claude/m02-impl-1c → M02');
  assert(classifyPrBranch('claude/m02-impl-1c')?.kind === 'impl', '9a4. claude/m02-impl-1c → kind=impl');
  assert(classifyPrBranch('docs/frd-m07-refresh')?.module_id === 'M07', '9a5. docs/frd-m07-refresh → M07');
  assert(classifyPrBranch('main') === null, '9a6. main → null');
  assert(classifyPrBranch('feat/random-thing') === null, '9a7. unrelated branch → null');

  // 9b. Module with open frd-kind PR → frd-polish candidate suppressed
  {
    const r = rankCandidates({
      goal: makeGoal(),
      inventory: {
        modules: [makeModule({
          module_id: 'M05',
          frd_status: 'PARTIAL',
          open_prs: [{ number: 32, branch: 'docs/frd-m05-auth', title: 'docs(frd-m05): refresh', kind: 'frd' }],
        })],
        existingTasks: [],
      },
    });
    assert(r.candidates.length === 0, '9b. M05 with open frd PR → 0 candidates (no re-suggestion)');
  }

  // 9c. Module with open impl-kind PR → frd-polish candidate STILL emits
  // (the PR is impl, the gap is FRD — different work-kinds)
  {
    const r = rankCandidates({
      goal: makeGoal(),
      inventory: {
        modules: [makeModule({
          module_id: 'M03',
          frd_status: 'PARTIAL',
          open_prs: [{ number: 99, branch: 'claude/m03-impl-2', title: 'M03 impl', kind: 'impl' }],
        })],
        existingTasks: [],
      },
    });
    assert(r.candidates.length === 1, '9c. M03 with open impl PR but PARTIAL FRD → still emits frd-polish');
    assert(r.candidates[0].type === 'frd-polish', '9c. type=frd-polish (different work-kind from impl PR)');
  }

  // 9d. Multiple PRs on same module → still only one suppression
  {
    const r = rankCandidates({
      goal: makeGoal(),
      inventory: {
        modules: [makeModule({
          module_id: 'M07',
          frd_status: 'PARTIAL',
          open_prs: [
            { number: 31, branch: 'docs/frd-m07-auth', title: 'M07 author', kind: 'frd' },
            { number: 50, branch: 'docs/frd-m07-refresh', title: 'M07 refresh', kind: 'frd' },
          ],
        })],
        existingTasks: [],
      },
    });
    assert(r.candidates.length === 0, '9d. multiple frd PRs on same module → 0 candidates');
  }
}

console.log('\n✓ all gapAnalysis.smoke assertions passed');

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
