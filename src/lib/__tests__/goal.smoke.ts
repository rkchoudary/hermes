/**
 * Smoke tests for goal contract (LRA-5).
 * Run: pnpm tsx src/lib/__tests__/goal.smoke.ts
 */
import { strict as assert } from 'node:assert';
import {
  GoalContract,
  evaluateGoal,
  defaultGoal,
  type RunStateSnapshot,
} from '../goal';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${(e as Error).message}`); failed++; }
}

const emptySnapshot: RunStateSnapshot = { tasks: [] };

test('defaultGoal parses without error', () => {
  const g = defaultGoal();
  assert.equal(g.goal_id, 'project-v1');
  assert.equal(g.completion_criteria.length, 3);
});

test('Empty snapshot → goal NOT complete', () => {
  const g = defaultGoal();
  const r = evaluateGoal(g, emptySnapshot);
  assert.equal(r.complete, false);
  assert.equal(r.criteria_met, 0);
  assert.equal(r.total_criteria, 3);
});

test('module_at_score criterion counts modules with score >= min_score', () => {
  const g = defaultGoal();
  const snapshot: RunStateSnapshot = {
    tasks: [],
    module_scores: { M01: 7.5, M02: 6.5, M03: 7.0, M04: 8.0 },
  };
  const r = evaluateGoal(g, snapshot);
  const moduleCriterion = r.per_criterion.find((c) => c.id === 'all-modules-at-score')!;
  assert.equal(moduleCriterion.current, 3); // M01, M03, M04 (M02 < 7.0)
  assert.equal(moduleCriterion.met, true); // default target=1; 3 >= 1
});

test('all_modules_merged counts distinct NORMALIZED modules (Codex R2 fix)', () => {
  const g = defaultGoal();
  const snapshot: RunStateSnapshot = {
    tasks: [
      { task_id: 'TP-1', run_id: 'r1', state: 'merged', module_or_sprint: 'M01-impl-1' },
      { task_id: 'TP-2', run_id: 'r1', state: 'merged', module_or_sprint: 'M01-impl-2' }, // same module M01
      { task_id: 'TP-3', run_id: 'r1', state: 'ready-for-merge', module_or_sprint: 'M02-impl-1' },
      { task_id: 'TP-4', run_id: 'r1', state: 'awaiting-review', module_or_sprint: 'M03-impl-1' }, // not yet merged
      { task_id: 'TP-5', run_id: 'r1', state: 'merged', module_or_sprint: 'M02-v0.8' }, // M02 again, different sprint
    ],
  };
  const r = evaluateGoal(g, snapshot);
  const c = r.per_criterion.find((c) => c.id === 'all-modules-merged')!;
  // After normalization (M\d+ prefix): M01 (from impl-1+impl-2) + M02 (from impl-1+v0.8) = 2 distinct.
  // M03 not counted (state=awaiting-review, not merged/ready-for-merge).
  assert.equal(c.current, 2);
});

test('ci_green_streak_days criterion uses snapshot value', () => {
  const g = defaultGoal();
  const snapshot: RunStateSnapshot = { tasks: [], ci_green_streak_days: 5 };
  const r = evaluateGoal(g, snapshot);
  const c = r.per_criterion.find((c) => c.id === 'ci-green-7d')!;
  assert.equal(c.current, 5);
  assert.equal(c.met, false); // 5 < 7
});

test('goal complete when ALL criteria met', () => {
  const g = defaultGoal();
  // Build a snapshot satisfying all 3 criteria
  const moduleScores: Record<string, number> = {};
  for (let i = 1; i <= 87; i++) moduleScores[`M${String(i).padStart(2, '0')}`] = 7.5;
  const tasks = [];
  for (let i = 1; i <= 87; i++) {
    tasks.push({
      task_id: `TP-${i}`,
      run_id: 'r1',
      state: 'merged' as const,
      module_or_sprint: `M${String(i).padStart(2, '0')}-impl-1`,
    });
  }
  const snapshot: RunStateSnapshot = {
    tasks,
    module_scores: moduleScores,
    ci_green_streak_days: 10,
  };
  const r = evaluateGoal(g, snapshot);
  assert.equal(r.complete, true);
  assert.equal(r.criteria_met, 3);
});

test('operator override marks criterion as met (with reason recorded)', () => {
  const g: GoalContract = {
    ...defaultGoal(),
    operator_overrides: [
      {
        criterion_id: 'ci-green-7d',
        reason: 'shipping despite CI flake; tracked separately',
        at: new Date().toISOString(),
        by: 'operator',
      },
    ],
  };
  const snapshot: RunStateSnapshot = { tasks: [], ci_green_streak_days: 0 };
  const r = evaluateGoal(g, snapshot);
  const c = r.per_criterion.find((c) => c.id === 'ci-green-7d')!;
  assert.equal(c.met, false);  // raw predicate not met
  assert.equal(c.override_active, true);  // but override is active
  assert.equal(r.criteria_overridden, 1);
});

test('manual criterion uses persisted current field directly', () => {
  const g: GoalContract = {
    ...defaultGoal(),
    completion_criteria: [
      {
        id: 'manual-test',
        description: 'manual gate',
        predicate_type: 'manual',
        params: {},
        target: 1,
        current: 1,  // operator already marked complete
      },
    ],
  };
  const r = evaluateGoal(g, emptySnapshot);
  assert.equal(r.complete, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
