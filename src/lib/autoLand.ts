/**
 * v0.5.0 T4 (Codex bnl3rpgha) — auto-land eligibility evaluator.
 *
 * Pure evaluator. NO actual merge. Returns a structured "would land / would
 * not land" decision over immutable evidence — Codex prescription:
 *
 *   "Auto-land should create a merge event with immutable evidence, not just
 *   perform the merge. Auto-land should start narrower than your proposed
 *   allowed types. I would begin with platform-doc and docs-only changes."
 *
 * Required predicates (all must pass for eligibility):
 *
 *   1. pack.auto_land_policy.enabled === true
 *   2. global opt-in: AUTO_AUTO_LAND env=1 OR --auto-land flag
 *   3. pack.state === 'ready-for-merge' (must already be at the post-promote stage)
 *   4. pack.type ∈ pack.auto_land_policy.allowed_task_types
 *   5. codex.score ≥ policy.min_score (default 8.0; raise above auto-promote 7.5)
 *   6. last N consecutive rounds all GO (debounce flukes)
 *   7. branch is NOT in policy.protected_branches_excluded
 *   8. all auto-promote predicates also passed (UX validation, specialized reviewers)
 *   9. zero unresolved escalations for this task
 *  10. SoD distinctness: creator ≠ approver (we already enforce this in promote.ts;
 *      auto-land must verify the recorded actors satisfy it)
 *
 * For real merge: pack.auto_land_policy.real_merge_enabled === true AND
 * AUTO_AUTO_LAND_APPLY=1 env. Both must agree. Default = report-only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TaskPack } from './taskPack';
import { harnessRoot } from './harnessRoot';

export interface AutoLandEvalResult {
  eligible: boolean;
  /** Whether the harness should ACTUALLY merge (vs just report). */
  real_merge_authorized: boolean;
  /** One-line summary suitable for state-log + Slack. */
  summary: string;
  predicates: Array<{ name: string; passed: boolean; reason: string }>;
  /** When eligible: the suggested merge command (gh pr merge), recorded for
   *  reproducibility even when not executed. */
  suggested_merge_command?: string;
  /** When eligible: an auto-revert command operator can keep handy if the
   *  merge needs to be undone. Codex: "require generated revert metadata." */
  generated_revert_command?: string;
}

export interface AutoLandOptions {
  /** Set when invoking from CLI: --auto-land flag OR AUTO_AUTO_LAND=1 env. */
  globalOptIn: boolean;
  /** Set when --apply OR AUTO_AUTO_LAND_APPLY=1. */
  applyAuthorization: boolean;
  /** Branch the merge would target. */
  targetBranch?: string;
  /** PR number if known (used for merge command + revert metadata). */
  prNumber?: number;
  /** Run id for evidence-dir lookups. */
  runId?: string;
  /** Override harness root for testing. */
  harnessRootOverride?: string;
}

function predicate(name: string, passed: boolean, reason: string): { name: string; passed: boolean; reason: string } {
  return { name, passed, reason };
}

/** Match a branch name against a glob pattern (only `*` supported, no `**`). */
function branchMatches(branch: string, pattern: string): boolean {
  if (pattern === branch) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(branch);
}

export function evaluateAutoLand(pack: TaskPack, opts: AutoLandOptions): AutoLandEvalResult {
  const policy = pack.auto_land_policy;
  const predicates = [];

  // 1. Policy enabled
  predicates.push(predicate(
    'policy-enabled',
    policy.enabled === true,
    policy.enabled ? 'pack.auto_land_policy.enabled=true' : 'pack.auto_land_policy.enabled=false (per-task opt-in required)',
  ));
  // 2. Global opt-in
  predicates.push(predicate(
    'global-opt-in',
    opts.globalOptIn,
    opts.globalOptIn ? '--auto-land flag or AUTO_AUTO_LAND env set' : 'no global opt-in (need --auto-land or AUTO_AUTO_LAND=1)',
  ));
  // 3. State must be ready-for-merge
  predicates.push(predicate(
    'state-ready-for-merge',
    pack.state === 'ready-for-merge',
    `pack.state=${pack.state}; auto-land requires ready-for-merge (run auto:promote first)`,
  ));
  // 4. Task type in allowlist
  predicates.push(predicate(
    'type-in-allowlist',
    policy.allowed_task_types.includes(pack.type as never),
    `pack.type=${pack.type}; allowlist=[${policy.allowed_task_types.join(', ')}]`,
  ));
  // 5. Score floor
  const score = pack.codex?.score ?? 0;
  predicates.push(predicate(
    'min-score-met',
    score >= policy.min_score,
    `codex.score=${score}; policy.min_score=${policy.min_score}`,
  ));
  // 6. Consecutive GO
  const history = pack.codex?.score_history ?? [];
  let consecutive = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = history[i];
    if (r.verdict === 'GO' && (r.score ?? 0) >= policy.min_score) consecutive++;
    else break;
  }
  predicates.push(predicate(
    'consecutive-go-met',
    consecutive >= policy.min_consecutive_go,
    `${consecutive}/${policy.min_consecutive_go} consecutive GO rounds at ≥ ${policy.min_score}`,
  ));
  // 7. Branch not protected
  if (opts.targetBranch !== undefined) {
    const isProtected = policy.protected_branches_excluded.some((p) => branchMatches(opts.targetBranch!, p));
    predicates.push(predicate(
      'branch-not-protected',
      !isProtected,
      isProtected
        ? `target branch '${opts.targetBranch}' matches protected pattern in policy.protected_branches_excluded`
        : `target branch '${opts.targetBranch}' is not protected`,
    ));
  } else {
    predicates.push(predicate(
      'branch-not-protected',
      false,
      'target branch unknown (must be passed as opts.targetBranch)',
    ));
  }

  // 8. All auto-promote predicates passed (UX + specialized reviewers)
  const root = opts.harnessRootOverride ?? harnessRoot();
  const runId = opts.runId ?? pack.run_id;
  let uxOk = true;
  let uxReason = 'ux_validation disabled (vacuous true)';
  if (pack.ux_validation.enabled) {
    const uxPath = path.join(root, '.agent-runs', runId, pack.evidence_dir, 'ux', 'ux-verdict.json');
    if (!fs.existsSync(uxPath)) {
      uxOk = false;
      uxReason = `ux-verdict.json missing at ${uxPath}`;
    } else {
      try {
        const v = JSON.parse(fs.readFileSync(uxPath, 'utf8'));
        uxOk = v.passed === true;
        uxReason = uxOk ? 'ux-verdict.json: passed=true' : `ux-verdict.json: passed=false (${v.summary ?? ''})`;
      } catch {
        uxOk = false;
        uxReason = 'ux-verdict.json corrupt';
      }
    }
  }
  predicates.push(predicate('ux-validation-passed', uxOk, uxReason));

  let revOk = true;
  let revReason = 'no specialized reviewers configured';
  if (pack.consensus.specialized_reviewers.length > 0) {
    const failures: string[] = [];
    for (const reviewer of pack.consensus.specialized_reviewers) {
      const p = path.join(root, '.agent-runs', runId, pack.evidence_dir, 'ux', `reviewer-${reviewer}.json`);
      if (!fs.existsSync(p)) {
        failures.push(`${reviewer}: no output`);
      } else {
        try {
          const r = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (r.reviewer_blocks === true) failures.push(`${reviewer}: blocking findings`);
        } catch {
          failures.push(`${reviewer}: corrupt JSON`);
        }
      }
    }
    revOk = failures.length === 0;
    revReason = revOk ? `${pack.consensus.specialized_reviewers.length} reviewer(s) all non-blocking` : `failing: ${failures.join('; ')}`;
  }
  predicates.push(predicate('specialized-reviewers-clear', revOk, revReason));

  // 9. Zero unresolved escalations
  const escalPath = path.join(root, '.agent-runs', '_escalation-log.jsonl');
  let openEscalations = 0;
  if (fs.existsSync(escalPath)) {
    const lines = fs.readFileSync(escalPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.task_id === pack.task_id && !e.cleared_by) openEscalations++;
      } catch { /* skip */ }
    }
  }
  predicates.push(predicate(
    'no-open-escalations',
    openEscalations === 0,
    openEscalations === 0 ? 'zero open escalations' : `${openEscalations} unresolved escalation(s)`,
  ));

  // 10. SoD: at least one approver recorded AND distinct from creator
  const creator = pack.actors?.creator?.name;
  const approvers = pack.actors?.approvers ?? [];
  const sodOk = approvers.length > 0 && approvers.every((a) => a.name !== creator);
  predicates.push(predicate(
    'sod-creator-approver-distinct',
    sodOk,
    sodOk
      ? `${approvers.length} approver(s) recorded; all distinct from creator`
      : approvers.length === 0
        ? 'no approvers recorded (must run auto:promote first)'
        : 'creator appears in approvers (SoD violation)',
  ));

  const eligible = predicates.every((p) => p.passed);
  const realMergeAuthorized = eligible && policy.real_merge_enabled && opts.applyAuthorization;

  return {
    eligible,
    real_merge_authorized: realMergeAuthorized,
    summary: eligible
      ? `eligible for auto-land${realMergeAuthorized ? ' (REAL MERGE AUTHORIZED)' : ' (DRY-RUN — both real_merge_enabled and AUTO_AUTO_LAND_APPLY=1 required for real merge)'}`
      : `NOT eligible: ${predicates.filter((p) => !p.passed).map((p) => p.name).join(', ')}`,
    predicates,
    suggested_merge_command: eligible && opts.prNumber
      ? `gh pr merge ${opts.prNumber} --squash --delete-branch`
      : undefined,
    generated_revert_command: eligible && opts.prNumber
      ? `gh pr view ${opts.prNumber} --json mergeCommit --jq .mergeCommit.oid | xargs -I {} git revert {}`
      : undefined,
  };
}
