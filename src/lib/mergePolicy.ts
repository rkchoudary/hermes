/**
 * Policy-as-code merge gate (PUB-9).
 *
 * Per END-TO-END-PUBLISHABILITY-AUDIT.md PUB-9: "no auto-merge to protected
 * `main` until policy rules pass (e.g., 2+ approvers, signed provenance,
 * security scan pass, segregation enforced)."
 *
 * Required to unblock M2 auto:merge (currently deferred per Codex SOTA-bar
 * because auto-merge to a protected branch without policy gates would be a
 * SOX violation).
 *
 * This module evaluates a TaskPack + the evidence dir against a MergePolicy
 * and returns ok=true only when EVERY rule passes. Rules are independent
 * boolean checks; a single failure blocks the merge with a human-readable
 * violation list.
 *
 * Phase 1 rules (this file):
 *   1. min_approvers          ≥ N distinct approvers in actors.approvers
 *   2. require_codex_go       codex.verdict ∈ {GO, SIGNOFF-READY}
 *   3. require_codex_score    codex.score ≥ threshold (default 7.0)
 *   4. require_security_max   M8 security-check.severity ≤ threshold
 *   5. require_conflict_max   M5 conflict-detect.severity ≤ threshold
 *   6. require_red_team_min   BP6 red-team.catch_rate ≥ threshold (default 1.0)
 *   7. require_qualified      every cost_telemetry entry has qualified model
 *                             (PUB-10 inventory check)
 *   8. require_sod_satisfied  PUB-8 enforceSoD passes for current actors
 *   9. require_ci_green       latest CI run on the branch is green (R8+1: real
 *                             gh API integration — `gh run list --branch ...
 *                             --limit 1`; skips if gh unavailable / branch
 *                             unknown / no runs yet; blocks on
 *                             failure/cancelled/timed_out/in_progress)
 *  10. require_operator_overrides_logged
 *                             (R8+1: scans pack.notes for --force /
 *                             --human-override / AUTO_*_OVERRIDE markers,
 *                             verifies _override-audit.jsonl has matching
 *                             task_id entry. Blocks if pack claims bypass
 *                             but audit is missing.)
 *
 * Phase 2 deferred:
 *   - signed_provenance (SLSA-L2/L3 attestations per BP3)
 *   - 2-of-2 quorum reviewers (per N-of-M policy in SoDPolicy Phase 2)
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { TaskPack } from './taskPack';
import { readInventory, isQualified } from './modelInventory';
import { defaultSoDPolicy, enforceSoD } from './sod';
import { readOverrideAudit } from './overrideAudit';

export const MergePolicy = z.object({
  schema_version: z.literal('1').default('1'),
  /** Minimum distinct approvers (PUB-8 SoD-aware). Default 1; strict ≥ 2. */
  min_approvers: z.number().int().min(0).default(1),
  /** Require Codex consensus verdict GO or SIGNOFF-READY. Default true. */
  require_codex_go: z.boolean().default(true),
  /** Minimum Codex score (0-10). Default 7.0. */
  min_codex_score: z.number().min(0).max(10).default(7.0),
  /** Max acceptable severity from M8 security-check. Default 'medium'. */
  max_security_severity: z.enum(['ok', 'low', 'medium', 'high']).default('medium'),
  /** Max acceptable severity from M5 conflict-detect. Default 'medium'. */
  max_conflict_severity: z.enum(['ok', 'low', 'medium', 'high']).default('medium'),
  /** Minimum BP6 red-team catch rate (0-1). Default 1.0 (perfect catch). */
  min_red_team_catch_rate: z.number().min(0).max(1).default(1.0),
  /** Require every dispatched model to be in the PUB-10 inventory. Default true. */
  require_qualified_models: z.boolean().default(true),
  /** Require PUB-8 SoD policy to pass for the current actors. Default true. */
  require_sod_satisfied: z.boolean().default(true),
  /** Require CI green on the branch (gh API check). Phase 2; default true (stub passes). */
  require_ci_green: z.boolean().default(true),
  /** Require any --human-override / --force to have a reason in pack.notes. Default true. */
  require_operator_overrides_logged: z.boolean().default(true),
});
export type MergePolicy = z.infer<typeof MergePolicy>;

export function defaultMergePolicy(): MergePolicy {
  return MergePolicy.parse({});
}

/** Severity ordering for ≤ comparison. */
const SEVERITY_RANK: Record<string, number> = { ok: 0, low: 1, medium: 2, high: 3 };
function severityLE(actual: string, max: string): boolean {
  const a = SEVERITY_RANK[actual] ?? 99;
  const m = SEVERITY_RANK[max] ?? 99;
  return a <= m;
}

export interface PolicyViolation {
  rule: string;
  reason: string;
  remediation: string;
}

export interface MergeGateResult {
  ok: boolean;
  task_id: string;
  evaluated_at: string;
  policy: MergePolicy;
  violations: PolicyViolation[];
  /** R11 fix (MEDIUM): rules that were SKIPPED (not evaluated) due to phase
   * constraints — distinct from violations (evaluated and failed) and from
   * passes (evaluated and ok). For audit honesty: "9 rules evaluated +
   * require_ci_green skipped (pre-land phase)" is more accurate than
   * "10 rules, 0 violations". */
  skipped_rules: Array<{ rule: string; reason: string }>;
  /** Human-readable summary line. */
  summary: string;
  /** Which evaluation phase the gate ran in. */
  phase: 'pre-land' | 'pre-merge';
}

/**
 * R10 fix (HIGH): split policy enforcement by phase.
 *   - 'pre-land': auto:land governance preflight runs BEFORE branch/PR exist.
 *     ruleCiGreen MUST skip cleanly (no branch → no CI to verify).
 *   - 'pre-merge': auto:promote governance preflight + standalone
 *     auto:merge-gate runs AFTER branch/PR exist. ruleCiGreen MUST be strict
 *     (gh missing/unauth/no-runs all BLOCK).
 *
 * Without this split, R9's fail-CLOSED ruleCiGreen blocked normal first-land
 * (where pack.notes has no branch= marker), forcing every operator to use
 * --force on the very first land — exactly the problem PUB-9 was supposed
 * to prevent.
 */
export type EvalPhase = 'pre-land' | 'pre-merge';

interface EvalContext {
  pack: TaskPack;
  evidenceDir: string;
  harnessRoot: string;
  phase: EvalPhase;
  /** R11 fix: rules can push to this when they skip (vs violate vs pass). */
  skipped: Array<{ rule: string; reason: string }>;
}

function ruleApprovers(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  const count = ctx.pack.actors.approvers.length;
  if (count < policy.min_approvers) {
    return {
      rule: 'min_approvers',
      reason: `${count} distinct approvers; policy requires ≥ ${policy.min_approvers}.`,
      remediation: `Have additional operator(s) run pnpm auto:land or auto:promote to record their approval.`,
    };
  }
  return null;
}

function ruleCodexVerdict(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  if (!policy.require_codex_go) return null;
  const verdict = ctx.pack.codex?.verdict;
  if (verdict !== 'GO' && verdict !== 'SIGNOFF-READY') {
    return {
      rule: 'require_codex_go',
      reason: `codex.verdict=${verdict ?? 'unset'}; policy requires GO or SIGNOFF-READY.`,
      remediation: `Re-run pnpm auto:consensus until Codex returns GO, OR use --human-override --reason on auto:land/promote with explicit justification.`,
    };
  }
  return null;
}

function ruleCodexScore(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  const score = ctx.pack.codex?.score;
  if (score === undefined || score === null) {
    return {
      rule: 'min_codex_score',
      reason: `codex.score is unset; policy requires score ≥ ${policy.min_codex_score}.`,
      remediation: `Run pnpm auto:consensus to populate codex.score.`,
    };
  }
  if (score < policy.min_codex_score) {
    return {
      rule: 'min_codex_score',
      reason: `codex.score=${score}; policy requires ≥ ${policy.min_codex_score}.`,
      remediation: `Address Codex review findings + re-run consensus to lift score.`,
    };
  }
  return null;
}

function readJsonEvidence(evidenceDir: string, filename: string): unknown | null {
  const p = path.join(evidenceDir, filename);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function ruleSecurity(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  const report = readJsonEvidence(ctx.evidenceDir, 'security-check.json') as { severity?: string } | null;
  if (!report) {
    return {
      rule: 'max_security_severity',
      reason: `security-check.json missing in ${ctx.evidenceDir}; policy requires severity ≤ ${policy.max_security_severity}.`,
      remediation: `Run pnpm auto:security-check ${ctx.pack.task_id} --apply to produce evidence.`,
    };
  }
  if (!severityLE(report.severity ?? 'high', policy.max_security_severity)) {
    return {
      rule: 'max_security_severity',
      reason: `security-check severity=${report.severity}; policy max is ${policy.max_security_severity}.`,
      remediation: `Address security findings + re-run auto:security-check.`,
    };
  }
  return null;
}

function ruleConflict(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  const report = readJsonEvidence(ctx.evidenceDir, 'conflict-detect.json') as { severity?: string } | null;
  if (!report) {
    return {
      rule: 'max_conflict_severity',
      reason: `conflict-detect.json missing; policy requires severity ≤ ${policy.max_conflict_severity}.`,
      remediation: `Run pnpm auto:conflict-detect ${ctx.pack.task_id} --apply.`,
    };
  }
  if (!severityLE(report.severity ?? 'high', policy.max_conflict_severity)) {
    return {
      rule: 'max_conflict_severity',
      reason: `conflict-detect severity=${report.severity}; policy max is ${policy.max_conflict_severity}.`,
      remediation: `Address conflict findings + re-run auto:conflict-detect.`,
    };
  }
  return null;
}

function ruleRedTeam(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  const report = readJsonEvidence(ctx.evidenceDir, 'red-team-report.json') as { catch_rate?: number } | null;
  if (!report) {
    return {
      rule: 'min_red_team_catch_rate',
      reason: `red-team-report.json missing; policy requires catch_rate ≥ ${policy.min_red_team_catch_rate}.`,
      remediation: `Run pnpm auto:red-team ${ctx.pack.task_id} --apply.`,
    };
  }
  if ((report.catch_rate ?? 0) < policy.min_red_team_catch_rate) {
    return {
      rule: 'min_red_team_catch_rate',
      reason: `red-team catch_rate=${report.catch_rate}; policy min is ${policy.min_red_team_catch_rate}.`,
      remediation: `Tighten blue-team rules in cli/red-team.ts simulators (or in the actual M5/M7/M8 detection rules).`,
    };
  }
  return null;
}

function ruleQualifiedModels(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  if (!policy.require_qualified_models) return null;
  const inventory = readInventory(ctx.harnessRoot);
  if (!inventory) {
    return {
      rule: 'require_qualified_models',
      reason: `No model inventory file at .agent-runs/_model-inventory.json.`,
      remediation: `Run pnpm auto:model init.`,
    };
  }
  for (const ct of ctx.pack.cost_telemetry) {
    const role = ct.engine === 'codex-cli' ? 'codex-reviewer' : 'impl-worker';
    const q = isQualified(inventory, ct.engine, ct.model_id ?? 'unknown', role);
    if (!q.ok) {
      return {
        rule: 'require_qualified_models',
        reason: `cost_telemetry round ${ct.round} used ${ct.engine}/${ct.model_id} (NOT qualified for ${role}).`,
        remediation: q.reason ?? 'Qualify the model in the inventory or use a different model.',
      };
    }
  }
  return null;
}

function ruleSoD(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  if (!policy.require_sod_satisfied) return null;
  const sodPolicy = defaultSoDPolicy();
  // R7 fix: validate the FULL actor chain — reviewers AND approvers — not
  // just the approver chain. Previously a creator==reviewer overlap was only
  // a WARN at consensus dispatch and never re-checked at the gate, so a
  // SOX-violating chain could land via the gate. Now both halves of the
  // chain are validated.

  // Validate every reviewer against pre-review actors.
  for (let i = 0; i < ctx.pack.actors.reviewers.length; i++) {
    const incoming = ctx.pack.actors.reviewers[i];
    const priorActors = {
      creator: ctx.pack.actors.creator,
      reviewers: ctx.pack.actors.reviewers.slice(0, i),
      approvers: [],
    };
    const check = enforceSoD(sodPolicy, priorActors, 'reviewer', incoming);
    if (!check.ok) {
      return {
        rule: 'require_sod_satisfied',
        reason: `SoD violation in reviewer chain: ${check.reason}`,
        remediation: check.remediation ?? '(see PUB-8)',
      };
    }
  }

  if (ctx.pack.actors.approvers.length === 0) {
    return {
      rule: 'require_sod_satisfied',
      reason: `No approvers recorded; SoD requires at least one (and distinct from creator/reviewer).`,
      remediation: `Run pnpm auto:land or auto:promote from a non-creator, non-reviewer identity.`,
    };
  }
  // Validate every approver against pre-approval actors.
  for (let i = 0; i < ctx.pack.actors.approvers.length; i++) {
    const incoming = ctx.pack.actors.approvers[i];
    const priorActors = {
      creator: ctx.pack.actors.creator,
      reviewers: ctx.pack.actors.reviewers,
      approvers: ctx.pack.actors.approvers.slice(0, i),
    };
    const check = enforceSoD(sodPolicy, priorActors, 'approver', incoming);
    if (!check.ok) {
      return {
        rule: 'require_sod_satisfied',
        reason: `SoD violation in approver chain: ${check.reason}`,
        remediation: check.remediation ?? '(see PUB-8)',
      };
    }
  }
  return null;
}

/**
 * R9 fix (HIGH): authoritative + fail-CLOSED CI gate.
 *
 * R8+1 implementation skipped on gh-unavailable / branch-unknown / no-runs,
 * which is fail-OPEN — exactly the gap "bank-grade required CI" was supposed
 * to close. R9 fix:
 *   - Branch resolution: pack.notes "branch=" ONLY (no fallback to operator's
 *     current git HEAD, which can be an unrelated branch)
 *   - gh missing → BLOCK (caller must install gh to use require_ci_green)
 *   - branch unknown → BLOCK (pack hasn't been landed; can't verify CI)
 *   - gh API error → BLOCK (auth/network/perms issue is the operator's problem)
 *   - no runs yet → BLOCK (CI hasn't started; wait + retry)
 *
 * Operator opts out via policy.require_ci_green=false (explicit, audited).
 */
function inferBranch(ctx: EvalContext): string | null {
  // Branch is authoritatively recorded in pack.notes via auto:land at the
  // moment of landing. NO fallback to operator's current git HEAD — that
  // branch may be unrelated to the task being gate-evaluated.
  for (const note of ctx.pack.notes ?? []) {
    const m = note.text.match(/branch=([\w./-]+)/);
    if (m) return m[1];
  }
  return null;
}

function ruleCiGreen(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  if (!policy.require_ci_green) {
    ctx.skipped.push({ rule: 'require_ci_green', reason: 'policy.require_ci_green=false' });
    return null;
  }
  // R10 fix: pre-land context cannot meaningfully verify CI (branch doesn't
  // exist yet). The PRE-merge phase (auto:promote / auto:merge-gate) is
  // where the strict check applies. This restores normal first-land flow
  // while preserving fail-CLOSED semantics where it actually applies.
  if (ctx.phase === 'pre-land') {
    ctx.skipped.push({ rule: 'require_ci_green', reason: 'pre-land phase: branch not yet created; CI cannot meaningfully gate' });
    return null;
  }
  const ghProbe = spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (ghProbe.status !== 0) {
    return {
      rule: 'require_ci_green',
      reason: `gh CLI not on PATH; cannot verify CI green. Bank-grade policy requires authoritative CI check.`,
      remediation: `Install gh CLI (https://cli.github.com), OR set policy.require_ci_green=false to opt out (audited).`,
    };
  }
  const branch = inferBranch(ctx);
  if (!branch) {
    return {
      rule: 'require_ci_green',
      reason: `Cannot infer task branch from pack.notes (no "branch=" marker). Pack has not been landed yet, so there is no CI to verify.`,
      remediation: `Run pnpm auto:land first to create the branch + open the PR; pack.notes will record the branch name. Then re-run merge-gate.`,
    };
  }
  const r = spawnSync(
    'gh',
    ['run', 'list', '--branch', branch, '--limit', '1', '--json', 'status,conclusion,name,headBranch'],
    { encoding: 'utf8', timeout: 10_000 }
  );
  if (r.status !== 0) {
    return {
      rule: 'require_ci_green',
      reason: `gh run list failed for branch '${branch}' (exit ${r.status}). Auth/network/perms issue. stderr: ${(r.stderr ?? '').slice(0, 200)}`,
      remediation: `Verify gh auth status; ensure the remote has CI workflows; re-run merge-gate.`,
    };
  }
  let runs: Array<{ status?: string; conclusion?: string; name?: string }> = [];
  try { runs = JSON.parse(r.stdout) ?? []; } catch {
    return {
      rule: 'require_ci_green',
      reason: `gh run list returned unparseable JSON for branch '${branch}'.`,
      remediation: `Investigate gh CLI behavior; re-run merge-gate.`,
    };
  }
  if (runs.length === 0) {
    return {
      rule: 'require_ci_green',
      reason: `No CI runs found for branch '${branch}'. Either CI hasn't started yet, or no workflows are configured for this branch.`,
      remediation: `Push the branch to trigger CI, or wait for the workflow to start; then re-run merge-gate.`,
    };
  }
  const latest = runs[0];
  // 'success' / 'skipped' / 'neutral' = non-failing. 'failure' / 'cancelled' /
  // 'timed_out' / 'startup_failure' / 'action_required' = failing.
  const NON_FAILING = new Set(['success', 'skipped', 'neutral']);
  if (latest.status === 'in_progress' || latest.status === 'queued' || latest.status === 'requested') {
    return {
      rule: 'require_ci_green',
      reason: `CI run for branch '${branch}' is still ${latest.status} (workflow: ${latest.name ?? '?'}). Wait for completion before merging.`,
      remediation: `Wait for the run to complete, then re-run pnpm auto:merge-gate.`,
    };
  }
  if (!latest.conclusion || !NON_FAILING.has(latest.conclusion)) {
    return {
      rule: 'require_ci_green',
      reason: `CI run for branch '${branch}' concluded as '${latest.conclusion}' (workflow: ${latest.name ?? '?'}). Merging would land red CI on main.`,
      remediation: `Investigate failure, push fix, re-run CI green, then re-run pnpm auto:merge-gate.`,
    };
  }
  return null;
}

/**
 * R8+1: real implementation of require_operator_overrides_logged.
 *
 * Scans pack.notes for any "--force" / "--human-override" / "AUTO_*_OVERRIDE"
 * / "AUTO_*_BYPASS" markers; for each, verifies a corresponding entry exists
 * in .agent-runs/_override-audit.jsonl with task_id matching this pack and
 * a non-empty reason. If pack.notes claims a bypass happened but no audit
 * record exists, blocks the merge (someone bypassed without audit — exactly
 * the SOX gap the audit log was designed to close).
 */
function ruleOverridesLogged(ctx: EvalContext, policy: MergePolicy): PolicyViolation | null {
  if (!policy.require_operator_overrides_logged) return null;
  const noteText = (ctx.pack.notes ?? []).map((n) => n.text).join(' ');
  const claimsBypass =
    /(--force|--human-override|AUTO_SOD_REVIEWER_OVERRIDE|AUTO_MODEL_INVENTORY_BYPASS|AUTO_FORCE_REASON)/i.test(noteText);
  if (!claimsBypass) return null; // No bypass claimed → no audit required
  // Verify audit log has at least one entry for this task
  const audit = readOverrideAudit(ctx.harnessRoot);
  const matches = audit.filter((e) => e.task_id === ctx.pack.task_id);
  if (matches.length === 0) {
    return {
      rule: 'require_operator_overrides_logged',
      reason:
        `pack.notes references a bypass (--force / --human-override / AUTO_*_OVERRIDE) but ` +
        `_override-audit.jsonl has no entry for ${ctx.pack.task_id}. SOX requires every bypass to have a durable audit record.`,
      remediation:
        `Either remove the bypass claim from pack.notes, OR ensure every bypass site calls appendOverrideAudit. ` +
        `If the bypass happened before the audit-log was wired (pre-951661e), document the historical bypass with a manual audit entry.`,
    };
  }
  return null;
}

export function evaluateMergePolicy(
  pack: TaskPack,
  evidenceDir: string,
  harnessRoot: string,
  policy: MergePolicy = defaultMergePolicy(),
  opts: { phase?: EvalPhase } = {}
): MergeGateResult {
  const phase: EvalPhase = opts.phase ?? 'pre-merge';
  const ctx: EvalContext = { pack, evidenceDir, harnessRoot, phase, skipped: [] };
  const violations: PolicyViolation[] = [];
  const rules: Array<(ctx: EvalContext, p: MergePolicy) => PolicyViolation | null> = [
    ruleApprovers,
    ruleCodexVerdict,
    ruleCodexScore,
    ruleSecurity,
    ruleConflict,
    ruleRedTeam,
    ruleQualifiedModels,
    ruleSoD,
    ruleCiGreen,
    ruleOverridesLogged,
  ];
  for (const r of rules) {
    const v = r(ctx, policy);
    if (v) violations.push(v);
  }
  const ok = violations.length === 0;
  const evaluated = 10 - ctx.skipped.length;
  const skipNote = ctx.skipped.length > 0
    ? ` (${ctx.skipped.length} skipped: ${ctx.skipped.map((s) => s.rule).join(', ')})`
    : '';
  return {
    ok,
    task_id: pack.task_id,
    evaluated_at: new Date().toISOString(),
    policy,
    violations,
    skipped_rules: ctx.skipped,
    phase,
    summary: ok
      ? `MERGE-GATE PASS (${phase}): ${evaluated} rules evaluated, 0 violations${skipNote}. Safe to ${phase === 'pre-land' ? 'land' : 'auto-merge'} per policy.`
      : `MERGE-GATE BLOCK (${phase}): ${violations.length}/${evaluated} evaluated rule(s) violated${skipNote}. Failed: ${violations.map((v) => v.rule).join(', ')}.`,
  };
}
