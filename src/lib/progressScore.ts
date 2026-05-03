/**
 * Layer 4.B — Progress-score plateau detector.
 *
 * Codex critique on the v1 plan: "Failure tuple equality is too crude.
 * It will miss progress when round 2 fixes 3 of 5 failures but leaves
 * the same check categories." We score across multiple signals and
 * abort on plateau OR oscillation, not on tuple equality alone.
 *
 * Inputs (per round): worker-handoff.json + test-summary.md + diff.patch
 * + postflight failures from the registry/L0 envelope.
 *
 * Output: a comparable ProgressScore that the driver feeds into the
 * plateau check after each round.
 *
 * Abort triggers (any one):
 *   - same `root_cause_fingerprint` for 2 consecutive rounds
 *     (two rounds didn't move the needle on the underlying issue)
 *   - failing tests unchanged AND diff_sha256_since_prev unchanged
 *     (literally re-emitted the same code)
 *   - more new failures than failures resolved
 *     (regression — round made things worse)
 *   - identical full progress score across two rounds
 *     (oscillation — same shape twice in a row)
 *
 * A round that fixes 3 of 5 failures with a non-empty diff continues:
 * the score's `failing_test_names` set shrinks and the diff hash changes.
 *
 * A round that "fixes by deleting the failing test" is caught by
 * `new_failures_introduced` (because the test stops existing — the
 * assertion that previously failed is no longer scored, but the
 * `tests_removed_unjustified` field flags it).
 */
import * as crypto from 'node:crypto';

export interface ProgressScore {
  round: number;
  /** Stable order; identity = test-name set. */
  failing_test_names: string[];
  failure_count: number;
  /** Sum of severity weights (test=1, typecheck=2, gate-critical=3). */
  failure_severity_sum: number;
  /** "<file>:<line>" identifiers extracted from failures. */
  location_fingerprints: string[];
  /** sha256 of diff.patch — empty when no diff. */
  diff_sha256: string;
  /** True iff diff_sha256 is unchanged from prior round (no real edit). */
  diff_changed_since_prev_round: boolean;
  /** Tests present in this round's evidence that were not in the prior round's. */
  new_failures_introduced: string[];
  /** Tests present in prior round but absent here — distinguishes 'fixed' (file unchanged but expected pass) from 'removed' (file deleted/skipped without justification). */
  tests_removed_unjustified: string[];
  /** Hash over the failure shape (failing_test_names + location_fingerprints). Used for plateau-streak detection. */
  root_cause_fingerprint: string;
  /** When this score was computed. */
  computed_at: string;
}

export interface PlateauVerdict {
  ok: boolean;
  /** When ok=false: which trigger fired. */
  trigger?:
    | 'streak-2-same-root-cause'
    | 'identical-failures-empty-diff'
    | 'regression-net-new-failures'
    | 'identical-full-score';
  reason?: string;
  /** How many rounds the streak has lasted. */
  streak_length?: number;
  /** Recommendation for the driver. */
  recommendation?: 'park' | 'try-different-reviewer' | 'tighten-scope' | 'cognitive-recovery';
}

// ─── Building a ProgressScore ────────────────────────────────────────────

export interface BuildScoreInput {
  round: number;
  failing_test_names: string[];
  failure_severity_weights?: Record<string, number>;
  location_fingerprints: string[];
  diff_patch_content?: string;
  /** Prior round's score for delta calculations; null on first round. */
  prior_score?: ProgressScore | null;
  /** Set of test names known from the worker's evidence; used to detect
   *  test-removal-without-justification. */
  observed_test_universe?: string[];
}

export function buildProgressScore(input: BuildScoreInput): ProgressScore {
  const failure_count = input.failing_test_names.length;
  const weights = input.failure_severity_weights ?? {};
  const failure_severity_sum = input.failing_test_names.reduce((s, name) => s + (weights[name] ?? 1), 0);
  const sortedNames = [...input.failing_test_names].sort();
  const sortedLocs = [...input.location_fingerprints].sort();
  const diff_sha256 = input.diff_patch_content
    ? crypto.createHash('sha256').update(input.diff_patch_content).digest('hex')
    : '';
  const diff_changed_since_prev_round =
    input.prior_score === undefined || input.prior_score === null
      ? true
      : diff_sha256 !== input.prior_score.diff_sha256;
  const prior_failing = new Set(input.prior_score?.failing_test_names ?? []);
  const cur_failing = new Set(sortedNames);
  const new_failures_introduced = sortedNames.filter((n) => !prior_failing.has(n));
  // Test removed unjustified: in prior set, NOT in current observed universe.
  const universe = new Set(input.observed_test_universe ?? sortedNames);
  const tests_removed_unjustified = (input.prior_score?.failing_test_names ?? []).filter(
    (n) => !cur_failing.has(n) && !universe.has(n),
  );
  const root_cause_fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ names: sortedNames, locs: sortedLocs }))
    .digest('hex')
    .slice(0, 16);
  return {
    round: input.round,
    failing_test_names: sortedNames,
    failure_count,
    failure_severity_sum,
    location_fingerprints: sortedLocs,
    diff_sha256,
    diff_changed_since_prev_round,
    new_failures_introduced,
    tests_removed_unjustified,
    root_cause_fingerprint,
    computed_at: new Date().toISOString(),
  };
}

// ─── Plateau detection ───────────────────────────────────────────────────

/**
 * Evaluate plateau against the rolling score history. Caller passes the
 * full history (oldest first); the most recent entry is the score that
 * was just computed.
 */
export function detectPlateau(history: ProgressScore[]): PlateauVerdict {
  if (history.length < 2) {
    return { ok: true };  // need ≥2 rounds to compare
  }
  const cur = history[history.length - 1];
  const prev = history[history.length - 2];

  // Trigger A: same root-cause for 2 consecutive rounds.
  if (cur.root_cause_fingerprint === prev.root_cause_fingerprint) {
    // Plateau streak length = how many trailing rounds share this fingerprint.
    let streak = 1;
    for (let i = history.length - 1; i > 0; i--) {
      if (history[i].root_cause_fingerprint === history[i - 1].root_cause_fingerprint) streak++;
      else break;
    }
    return {
      ok: false,
      trigger: 'streak-2-same-root-cause',
      reason: `same root_cause_fingerprint (${cur.root_cause_fingerprint}) across ${streak} consecutive rounds — driver should pivot rather than continue patching`,
      streak_length: streak,
      recommendation: streak >= 3 ? 'park' : 'cognitive-recovery',
    };
  }

  // Trigger B: identical failure set + no diff change.
  if (
    !cur.diff_changed_since_prev_round &&
    arraysEqual(cur.failing_test_names, prev.failing_test_names)
  ) {
    return {
      ok: false,
      trigger: 'identical-failures-empty-diff',
      reason: 'failing test set unchanged AND diff.patch sha unchanged — worker emitted the same code as prior round',
      recommendation: 'park',
    };
  }

  // Trigger C: regression — more new failures than resolved.
  const resolved = prev.failing_test_names.filter((n) => !cur.failing_test_names.includes(n));
  if (cur.new_failures_introduced.length > resolved.length) {
    return {
      ok: false,
      trigger: 'regression-net-new-failures',
      reason: `${cur.new_failures_introduced.length} new failures introduced vs ${resolved.length} resolved — net regression`,
      recommendation: 'tighten-scope',
    };
  }

  // Trigger D: identical full score (very tight oscillation).
  if (
    cur.diff_sha256 === prev.diff_sha256 &&
    cur.failure_severity_sum === prev.failure_severity_sum &&
    arraysEqual(cur.location_fingerprints, prev.location_fingerprints)
  ) {
    return {
      ok: false,
      trigger: 'identical-full-score',
      reason: 'full progress score is byte-identical to prior round',
      recommendation: 'park',
    };
  }

  return { ok: true };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
