/**
 * Layer 7 — DAG fan-out scheduler smoke.
 *
 * Validates pickNextDispatches against the real registry order, WIP caps,
 * dependency edges, and module failure exit.
 */
import {
  newSchedulerState,
  pickNextDispatches,
  markStageDispatched,
  markStageCompleted,
  markStageFailed,
  pauseScheduler,
  DEFAULT_WIP_LIMITS,
} from '../fanoutScheduler';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('fanoutScheduler.smoke — Layer 7 DAG scheduler');

// ─── 1. Initial pass: every module wants auto:intake ──────────────────
console.log('\n1. Initial pass — all modules pick first registry stage');
let s = newSchedulerState(['M05', 'M06', 'M07']);
let next = pickNextDispatches(s);
assert(next.length === 3, `3 candidates emitted (got ${next.length})`);
assert(next.every((c) => c.stage === 'auto:intake'), 'every candidate is auto:intake');

// ─── 2. WIP cap respected ─────────────────────────────────────────────
console.log('\n2. WIP cap on auto:work');
// Set up state where auto:work has cap=2 and there are 5 modules ready for it.
s = newSchedulerState(['M01', 'M02', 'M03', 'M04', 'M05']);
const completedDeps = ['auto:intake', 'auto:plan'];
for (const m of ['M01', 'M02', 'M03', 'M04', 'M05']) {
  for (const stg of completedDeps) s = markStageCompleted(s, m, stg);
}
next = pickNextDispatches(s);
const workCands = next.filter((c) => c.stage === 'auto:work');
assert(workCands.length === DEFAULT_WIP_LIMITS.overrides['auto:work'], `auto:work limited to ${DEFAULT_WIP_LIMITS.overrides['auto:work']} candidates (got ${workCands.length})`);

// Mark 2 dispatches in-flight; expect 0 more candidates for auto:work.
s = markStageDispatched(s, workCands[0].module, 'auto:work');
s = markStageDispatched(s, workCands[1].module, 'auto:work');
next = pickNextDispatches(s);
const workCands2 = next.filter((c) => c.stage === 'auto:work');
assert(workCands2.length === 0, `auto:work cap engaged: 0 more candidates (got ${workCands2.length})`);

// ─── 3. Module advances after stage completes ────────────────────────
console.log('\n3. Module advances after stage completes');
s = markStageCompleted(s, workCands[0].module, 'auto:work');
next = pickNextDispatches(s);
const advanceM01 = next.find((c) => c.module === workCands[0].module);
assert(advanceM01 !== undefined, `module ${workCands[0].module} got a new candidate after auto:work completed`);
assert(advanceM01?.stage !== 'auto:work', 'next stage is past auto:work');

// ─── 4. Failed module exits conveyor ─────────────────────────────────
console.log('\n4. Failed module exits conveyor');
s = newSchedulerState(['M10', 'M11']);
s = markStageFailed(s, 'M10', 'auto:plan');
next = pickNextDispatches(s);
const m10Cands = next.filter((c) => c.module === 'M10');
const m11Cands = next.filter((c) => c.module === 'M11');
assert(m10Cands.length === 0, 'M10 (failed) gets no candidates');
assert(m11Cands.length > 0, 'M11 (healthy) keeps advancing');

// ─── 5. Global pause refuses all ─────────────────────────────────────
console.log('\n5. Global pause refuses all');
s = newSchedulerState(['M20', 'M21']);
s = pauseScheduler(s, true);
next = pickNextDispatches(s);
assert(next.length === 0, 'paused scheduler returns 0 candidates');

s = pauseScheduler(s, false);
next = pickNextDispatches(s);
assert(next.length === 2, 'unpaused scheduler resumes; 2 candidates');

// ─── 6. Dependency gating ─────────────────────────────────────────────
console.log('\n6. Dependency gating');
s = newSchedulerState(['M30']);
// auto:work depends on auto:plan which depends on auto:intake. Don't
// complete intake/plan; auto:work should NOT be a candidate.
next = pickNextDispatches(s);
const workForM30 = next.find((c) => c.module === 'M30' && c.stage === 'auto:work');
assert(workForM30 === undefined, 'auto:work blocked by missing intake/plan');
const intakeForM30 = next.find((c) => c.module === 'M30' && c.stage === 'auto:intake');
assert(intakeForM30 !== undefined, 'auto:intake (no deps) is a candidate');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
