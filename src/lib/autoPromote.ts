/**
 * v0.5.0 (Codex roadmap-review GO-with-modifications scope item #2):
 * opt-in auto-promotion policy evaluator.
 *
 * The harness moves promotable tasks → ready-for-merge automatically ONLY when
 * THREE independent signals all agree:
 *
 *   1. Caller (e.g. `auto:tick`) explicitly opts in via `--auto-promote` or the
 *      `AUTO_AUTO_PROMOTE=1` env. This protects `auto:tick`'s flush/notify
 *      default semantic from accidentally becoming a state mutator.
 *   2. The task pack itself has `auto_promote_policy.enabled === true`. Per-task
 *      opt-in means a sloppy `auto:tick --auto-promote` invocation still can't
 *      promote tasks the operator never marked safe.
 *   3. The task pack's `type` is in `auto_promote_policy.allowed_task_types`.
 *      Conservative defaults: `frd-polish` + `platform-doc` only. Code-sprint
 *      and audit-log-route remain operator-gated until N-of-M consensus ships
 *      (a v2 governance feature).
 *
 * Plus debouncing: the last `min_consecutive_go` rounds in `score_history` must
 * all have `verdict === 'GO'` with `score >= min_score`. Default 2 rounds.
 *
 * NEVER auto-merges to protected branches. The transition we drive is
 *   promotable → ready-for-merge
 * which opens a PR and marks it ready-for-review. Operators still merge via
 * the GitHub UI per OPERATOR-RUNBOOK.md production-gate rules.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TaskPack } from './taskPack';
import { harnessRoot } from './harnessRoot';

export interface AutoPromoteEvalResult {
  eligible: boolean;
  reason: string;
  /** Diagnostic detail keyed by check name; useful in logs + tests. */
  detail: {
    state_is_promotable: boolean;
    policy_enabled: boolean;
    type_in_allowlist: boolean;
    min_score_met: boolean;
    consecutive_go_met: boolean;
    /**
     * v0.5.0 T2 core (Codex prescription): when pack.ux_validation.enabled,
     * the harness MUST verify the ux-verdict.json passed before allowing
     * auto-promote. If ux_validation is disabled, this predicate is vacuously
     * satisfied (set to true).
     */
    ux_validation_satisfied: boolean;
    /** Same shape: any specialized reviewer's blocking finding denies. */
    specialized_reviewers_satisfied: boolean;
    /**
     * v0.5.x: latest deployed-app E2E result from `pnpm auto:e2e`. INFORMATIONAL
     * for now — does not block promote. A future commit can flip the predicate
     * to required (gated by a per-task `deployed_e2e_required` policy field).
     * `null` when no E2E artifact exists in `.agent-runs/_e2e/`.
     */
    latest_deployed_e2e?: { exit_status: 'pass' | 'fail' | 'crash' | null; run_uuid: string | null; ended_at: string | null; bad_status_count: number };
    current_score?: number;
    consecutive_go_observed?: number;
  };
}

/**
 * Read the most recent E2E run artifact under .agent-runs/_e2e/<uuid>/artifacts.json.
 * Returns null when no artifact exists or directory is missing — caller decides
 * whether that's blocking. Pure file-read; no side effects.
 */
export function getLatestE2eResult(harnessRootOverride?: string): {
  exit_status: 'pass' | 'fail' | 'crash' | null;
  run_uuid: string | null;
  ended_at: string | null;
  bad_status_count: number;
} {
  const root = harnessRootOverride ?? harnessRoot();
  const e2eRoot = path.join(root, '.agent-runs', '_e2e');
  const empty = { exit_status: null, run_uuid: null, ended_at: null, bad_status_count: 0 };
  if (!fs.existsSync(e2eRoot)) return empty;
  let runs: { uuid: string; mtime: number }[];
  try {
    runs = fs.readdirSync(e2eRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => ({
        uuid: e.name,
        mtime: fs.statSync(path.join(e2eRoot, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return empty;
  }
  for (const run of runs) {
    const artifactsPath = path.join(e2eRoot, run.uuid, 'artifacts.json');
    if (!fs.existsSync(artifactsPath)) continue;
    try {
      const a = JSON.parse(fs.readFileSync(artifactsPath, 'utf8'));
      const badCount = Array.isArray(a?.network_summary?.bad_status_urls)
        ? a.network_summary.bad_status_urls.length
        : 0;
      return {
        exit_status: a.exit_status ?? null,
        run_uuid: run.uuid,
        ended_at: a.ended_at ?? null,
        bad_status_count: badCount,
      };
    } catch {
      // malformed artifacts.json — keep walking older runs
    }
  }
  return empty;
}

/**
 * Pure evaluator: given a task pack + the global opt-in flag, return whether
 * it is eligible for auto-promote AND a human-readable reason.
 *
 * Note: this function does NOT call out to the filesystem, GitHub, or any
 * subprocess. That makes it trivial to property-test (see lockCAS pattern).
 */
export function evaluateAutoPromote(
  pack: TaskPack,
  globalOptIn: boolean,
  opts: { runId?: string; harnessRootOverride?: string } = {}
): AutoPromoteEvalResult {
  const policy = pack.auto_promote_policy;
  const detail = {
    state_is_promotable: pack.state === 'promotable',
    policy_enabled: globalOptIn && policy.enabled,
    type_in_allowlist: policy.allowed_task_types.includes(pack.type as never),
    min_score_met: false,
    consecutive_go_met: false,
    ux_validation_satisfied: !pack.ux_validation.enabled,  // vacuous when disabled
    specialized_reviewers_satisfied: pack.consensus.specialized_reviewers.length === 0,  // vacuous when none
    // v0.5.x informational: latest deployed-app E2E run snapshot. Does NOT
    // block promote yet — operator should opt-in via a future required-flag
    // once they're confident in the auto:e2e signal.
    latest_deployed_e2e: getLatestE2eResult(opts.harnessRootOverride),
    current_score: pack.codex?.score,
    consecutive_go_observed: 0,
  };

  if (!detail.state_is_promotable) {
    return {
      eligible: false,
      reason: `state is '${pack.state}', not 'promotable' — only promotable tasks are auto-promote candidates`,
      detail,
    };
  }
  if (!globalOptIn) {
    return {
      eligible: false,
      reason: 'global opt-in absent (need --auto-promote flag or AUTO_AUTO_PROMOTE=1 env)',
      detail,
    };
  }
  if (!policy.enabled) {
    return {
      eligible: false,
      reason: 'task pack auto_promote_policy.enabled is false (per-task opt-in required)',
      detail,
    };
  }
  if (!detail.type_in_allowlist) {
    return {
      eligible: false,
      reason: `task type '${pack.type}' not in policy allowlist [${policy.allowed_task_types.join(', ')}]`,
      detail,
    };
  }

  // Min score check uses the latest codex result.
  const currentScore = pack.codex?.score;
  if (currentScore === undefined) {
    return {
      eligible: false,
      reason: 'no codex score recorded yet (pack.codex.score is undefined)',
      detail,
    };
  }
  detail.min_score_met = currentScore >= policy.min_score;
  if (!detail.min_score_met) {
    return {
      eligible: false,
      reason: `current codex score ${currentScore} < min_score ${policy.min_score}`,
      detail,
    };
  }

  // Consecutive-GO check: walk codex.score_history backwards from latest.
  // CodexRoundScore shape (per taskPack.ts §241-249) has `verdict` (GO|NO-GO)
  // and `score`. We require N consecutive entries with verdict=GO + score>=min.
  const history = pack.codex?.score_history ?? [];
  let consecutive = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const round = history[i];
    if (round.verdict === 'GO' && (round.score ?? 0) >= policy.min_score) {
      consecutive++;
    } else {
      break;
    }
  }
  detail.consecutive_go_observed = consecutive;
  detail.consecutive_go_met = consecutive >= policy.min_consecutive_go;

  if (!detail.consecutive_go_met) {
    return {
      eligible: false,
      reason: `only ${consecutive} consecutive GO round(s) at ≥ ${policy.min_score}; need ${policy.min_consecutive_go}`,
      detail,
    };
  }

  // v0.5.0 T2 core: UX validation predicate. If pack.ux_validation.enabled,
  // we REQUIRE a passing ux-verdict.json in the evidence dir. Without it, we
  // refuse to auto-promote even if all other invariants pass — Codex prescription:
  // "for type=ui-*, UI/UX should be opinionated default, not opt-in. Once the
  // task declares UI type, minimum UX gates should be forced unless explicitly
  // waived with audit reason."
  if (pack.ux_validation.enabled) {
    const root = opts.harnessRootOverride ?? harnessRoot();
    const runId = opts.runId ?? pack.run_id;
    const uxVerdictPath = path.join(root, '.agent-runs', runId, pack.evidence_dir, 'ux', 'ux-verdict.json');
    if (!fs.existsSync(uxVerdictPath)) {
      return {
        eligible: false,
        reason: `ux_validation.enabled but ${uxVerdictPath} not present — run auto:ux-validate before promote`,
        detail,
      };
    }
    try {
      const v = JSON.parse(fs.readFileSync(uxVerdictPath, 'utf8'));
      detail.ux_validation_satisfied = v.passed === true;
      if (!detail.ux_validation_satisfied) {
        return {
          eligible: false,
          reason: `ux-verdict.json: passed=false (${String(v.summary ?? 'no summary').slice(0, 100)})`,
          detail,
        };
      }
    } catch (e) {
      return {
        eligible: false,
        reason: `ux-verdict.json failed to parse: ${(e as Error).message.slice(0, 100)}`,
        detail,
      };
    }
  }

  // v0.5.0 T2 core: specialized-reviewer predicate. For each declared
  // specialized_reviewer, the corresponding reviewer-<name>.json must exist
  // and report `reviewer_blocks: false`.
  if (pack.consensus.specialized_reviewers.length > 0) {
    const root = opts.harnessRootOverride ?? harnessRoot();
    const runId = opts.runId ?? pack.run_id;
    for (const reviewerName of pack.consensus.specialized_reviewers) {
      const reviewerJsonPath = path.join(root, '.agent-runs', runId, pack.evidence_dir, 'ux', `reviewer-${reviewerName}.json`);
      if (!fs.existsSync(reviewerJsonPath)) {
        return {
          eligible: false,
          reason: `specialized_reviewer '${reviewerName}' has no output at ${reviewerJsonPath}`,
          detail,
        };
      }
      try {
        const r = JSON.parse(fs.readFileSync(reviewerJsonPath, 'utf8'));
        if (r.reviewer_blocks === true) {
          return {
            eligible: false,
            reason: `specialized_reviewer '${reviewerName}' has blocking finding(s): ${String(r.summary ?? '').slice(0, 100)}`,
            detail,
          };
        }
      } catch (e) {
        return {
          eligible: false,
          reason: `reviewer-${reviewerName}.json failed to parse: ${(e as Error).message.slice(0, 80)}`,
          detail,
        };
      }
    }
    detail.specialized_reviewers_satisfied = true;
  }

  return {
    eligible: true,
    reason: `${consecutive} consecutive GO at ${currentScore} ≥ ${policy.min_score}, type '${pack.type}' allowlisted, ux+reviewer predicates satisfied, all opt-in flags set`,
    detail,
  };
}

/**
 * Helper: read the global opt-in from CLI args + env.
 * Centralizes the precedence so callers can't accidentally diverge.
 */
export function isGloballyOptedIn(args: { autoPromote?: boolean } = {}): boolean {
  if (args.autoPromote === true) return true;
  const env = process.env.AUTO_AUTO_PROMOTE;
  return env === '1' || env === 'true';
}
