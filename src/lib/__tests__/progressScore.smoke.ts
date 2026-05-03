/**
 * Layer 4.B — Progress-score plateau smoke.
 *
 * Validates buildProgressScore + detectPlateau against synthetic round
 * histories that mirror real failure modes from this session.
 */
import { buildProgressScore, detectPlateau, type ProgressScore } from '../progressScore';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('progressScore.smoke — Layer 4.B plateau detector');

// ─── 1. Build score round-trip ────────────────────────────────────────
console.log('\n1. Build score basics');
const r1 = buildProgressScore({
  round: 1,
  failing_test_names: ['foo.test.ts > should A', 'bar.test.ts > should B'],
  location_fingerprints: ['src/foo.ts:42', 'src/bar.ts:13'],
  diff_patch_content: 'diff --git a/foo.ts b/foo.ts\n+const x = 1;\n',
});
assert(r1.failure_count === 2, 'failure_count derived');
assert(r1.diff_sha256.length === 64, 'diff_sha256 is 64 hex chars');
assert(r1.diff_changed_since_prev_round, 'first round always counts as diff-changed');
assert(r1.root_cause_fingerprint.length === 16, 'fingerprint short hash');

// ─── 2. Plateau: identical root_cause across 2 rounds ─────────────────
console.log('\n2. Plateau — same root cause 2 rounds');
const r2_same = buildProgressScore({
  round: 2,
  failing_test_names: ['foo.test.ts > should A', 'bar.test.ts > should B'],
  location_fingerprints: ['src/foo.ts:42', 'src/bar.ts:13'],
  diff_patch_content: 'diff --git a/baz.ts b/baz.ts\n+const y = 2;\n',  // diff DID change
  prior_score: r1,
});
const v_streak = detectPlateau([r1, r2_same]);
assert(!v_streak.ok, 'plateau detected on same root cause');
assert(v_streak.trigger === 'streak-2-same-root-cause', `trigger=streak-2-same-root-cause (got ${v_streak.trigger})`);

// ─── 3. Plateau: identical failures + same diff ───────────────────────
console.log('\n3. Plateau — identical failures + identical diff');
const r2_identical = buildProgressScore({
  round: 2,
  failing_test_names: ['foo.test.ts > should A', 'bar.test.ts > should B'],
  location_fingerprints: ['src/foo.ts:42', 'src/bar.ts:13'],
  diff_patch_content: 'diff --git a/foo.ts b/foo.ts\n+const x = 1;\n',  // same as r1
  prior_score: r1,
});
const v_identical = detectPlateau([r1, r2_identical]);
assert(!v_identical.ok, 'plateau detected on identical full score');
// either trigger is acceptable here
assert(['streak-2-same-root-cause', 'identical-failures-empty-diff', 'identical-full-score'].includes(v_identical.trigger ?? ''),
  `trigger ∈ acceptable set (got ${v_identical.trigger})`);

// ─── 4. Plateau: regression (more new failures than resolved) ─────────
console.log('\n4. Plateau — regression');
const r2_regress = buildProgressScore({
  round: 2,
  failing_test_names: ['baz.test.ts > should X', 'qux.test.ts > should Y', 'qux.test.ts > should Z'],
  location_fingerprints: ['src/baz.ts:1', 'src/qux.ts:1', 'src/qux.ts:2'],
  diff_patch_content: 'diff different\n',
  prior_score: r1,
});
const v_regress = detectPlateau([r1, r2_regress]);
assert(!v_regress.ok, 'plateau detected on regression');
assert(v_regress.trigger === 'regression-net-new-failures', `trigger=regression (got ${v_regress.trigger})`);

// ─── 5. No plateau: real progress ─────────────────────────────────────
console.log('\n5. No plateau — real progress (1 of 2 fixed)');
const r2_progress = buildProgressScore({
  round: 2,
  failing_test_names: ['foo.test.ts > should A'],  // bar.test.ts FIXED
  location_fingerprints: ['src/foo.ts:42'],
  diff_patch_content: 'diff different\n',
  prior_score: r1,
});
const v_progress = detectPlateau([r1, r2_progress]);
assert(v_progress.ok, 'no plateau when 1 of 2 failures resolved with new diff');

// ─── 6. Streak length tracked across ≥3 rounds ────────────────────────
console.log('\n6. Streak length across 3 rounds');
const r3_same = buildProgressScore({
  round: 3,
  failing_test_names: ['foo.test.ts > should A', 'bar.test.ts > should B'],
  location_fingerprints: ['src/foo.ts:42', 'src/bar.ts:13'],
  diff_patch_content: 'diff yet another\n',
  prior_score: r2_same,
});
const v_streak3 = detectPlateau([r1, r2_same, r3_same]);
assert(!v_streak3.ok, 'streak still detected at round 3');
assert(v_streak3.streak_length === 3, `streak_length=3 (got ${v_streak3.streak_length})`);
assert(v_streak3.recommendation === 'park', `recommendation=park at streak 3 (got ${v_streak3.recommendation})`);

// ─── 7. Single round → no plateau ─────────────────────────────────────
console.log('\n7. Single round produces no plateau verdict');
const v_single = detectPlateau([r1]);
assert(v_single.ok, 'single round always passes');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
