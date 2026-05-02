/**
 * Sprint J — per-phase LLM call budget cap (Codex council review item 13).
 *
 * Today, a single phase can fire ~50-100 LLM calls (5 council rounds ×
 * 10 calls/round + 5 worker rounds + auto-reviewers + retries) before
 * either converging or plateauing. Forward-pass dramatically cuts that
 * (1 author + 1 council pass + 1 patch worst-case = ~12 LLM calls).
 * The budget cap enforces the discipline: any phase that consumes more
 * than the hard cap MUST have an explicit, audit-logged operator override.
 *
 * Counts:
 *   - Worker dispatch (claude-code-cli, claude-agent-sdk, codex-cli)
 *     = 1 call per cost_telemetry entry
 *   - Council judge invocation (one criterion-call per entry)
 *     = 1 call per cost_telemetry entry (5 criteria × 2 judges = 10 entries)
 *   - Auto-reviewer LLM call
 *     = 1 call per cost_telemetry entry
 *
 * So total LLM calls in the phase = pack.cost_telemetry.length, filtered
 * to LLM-engine entries (excludes deterministic post-flight runs which
 * are not engine dispatches).
 *
 * Caps (per Codex):
 *   - soft (warn): 10-12 calls
 *   - hard (block): 20 calls
 *   - override (with typed rationale + audit): 30 calls (critical)
 *
 * Override path: caller passes --budget-override "reason" to auto:work
 * or auto:consensus; reason recorded in _override-audit.jsonl.
 */
import type { TaskPack } from './taskPack';

export interface LlmBudgetPolicy {
  /** Warning threshold; dispatch proceeds with WARN log. */
  soft_cap: number;
  /** Block threshold; dispatch refused without --budget-override. */
  hard_cap: number;
  /** Override threshold; dispatch refused even with --budget-override unless
   *  pack.risk_class === 'critical'. */
  override_cap: number;
}

export const DEFAULT_LLM_BUDGET: LlmBudgetPolicy = {
  soft_cap: 12,
  hard_cap: 20,
  override_cap: 30,
};

/**
 * LLM-engine identifiers that count toward the budget. Deterministic
 * runs (post-flight, citation-validate, etc) are NOT recorded in
 * cost_telemetry, so this filter is mostly defensive.
 */
const LLM_ENGINES = new Set([
  'claude-cli',
  'claude-code-cli',
  'claude-agent-sdk',
  'codex-cli',
  'codex-mock',
  'codex-5.5-xhigh',
  'claude',
  'gpt55',
  'gpt-5.5',
]);

/**
 * Count LLM calls for the given task pack. Returns the number of
 * cost_telemetry entries whose engine is a known LLM engine.
 */
export function countLlmCallsForTask(pack: TaskPack): number {
  return pack.cost_telemetry.filter((ct) =>
    LLM_ENGINES.has(ct.engine) || ct.engine.includes('claude') || ct.engine.includes('gpt') || ct.engine.includes('codex')
  ).length;
}

export type BudgetMode = 'within-soft' | 'soft-warn' | 'hard-block' | 'override-required' | 'override-denied';

export interface BudgetEvaluation {
  mode: BudgetMode;
  used: number;
  planned: number;
  total_after_dispatch: number;
  policy: LlmBudgetPolicy;
  /** Human-readable explanation suitable for surfacing to operator. */
  reason: string;
  /** Should the dispatch proceed? */
  proceed: boolean;
  /** True iff the dispatch requires --budget-override + reason. */
  override_required: boolean;
}

/**
 * Evaluate budget BEFORE dispatch. `planned_calls` is what this dispatch
 * is about to add (1 for worker, 10 for council, etc).
 *
 * @param pack — task pack with current cost_telemetry
 * @param planned_calls — number of LLM calls this dispatch will fire
 * @param overrideReason — operator-supplied --budget-override rationale (if any)
 * @param policy — budget caps (default DEFAULT_LLM_BUDGET)
 */
export function evaluateLlmBudget(
  pack: TaskPack,
  planned_calls: number,
  overrideReason?: string,
  policy: LlmBudgetPolicy = DEFAULT_LLM_BUDGET,
): BudgetEvaluation {
  const used = countLlmCallsForTask(pack);
  const total = used + planned_calls;
  const isFinanceCritical = pack.risk_class === 'critical';

  // Within soft cap — proceed silently
  if (total <= policy.soft_cap) {
    return {
      mode: 'within-soft',
      used, planned: planned_calls, total_after_dispatch: total, policy,
      reason: `${used} calls used + ${planned_calls} planned = ${total} ≤ soft_cap ${policy.soft_cap}; proceed.`,
      proceed: true,
      override_required: false,
    };
  }

  // Between soft + hard caps — proceed with WARN
  if (total <= policy.hard_cap) {
    return {
      mode: 'soft-warn',
      used, planned: planned_calls, total_after_dispatch: total, policy,
      reason: `WARN: ${total} calls (after dispatch) > soft_cap ${policy.soft_cap}. Below hard_cap ${policy.hard_cap}; dispatch proceeds. Investigate why this phase needs ${total} calls.`,
      proceed: true,
      override_required: false,
    };
  }

  // Between hard + override caps — require --budget-override
  if (total <= policy.override_cap) {
    if (!overrideReason) {
      return {
        mode: 'hard-block',
        used, planned: planned_calls, total_after_dispatch: total, policy,
        reason: `HARD BLOCK: ${total} calls (after dispatch) > hard_cap ${policy.hard_cap}. Pass --budget-override "<rationale>" to proceed (logged to _override-audit.jsonl).`,
        proceed: false,
        override_required: true,
      };
    }
    return {
      mode: 'override-required',
      used, planned: planned_calls, total_after_dispatch: total, policy,
      reason: `OVERRIDE: ${total} calls > hard_cap ${policy.hard_cap}; operator-supplied rationale: "${overrideReason}". Below override_cap ${policy.override_cap}; dispatch proceeds (audited).`,
      proceed: true,
      override_required: true,
    };
  }

  // Above override cap — only critical packs can proceed, with rationale
  if (!isFinanceCritical) {
    return {
      mode: 'override-denied',
      used, planned: planned_calls, total_after_dispatch: total, policy,
      reason: `OVERRIDE DENIED: ${total} calls > override_cap ${policy.override_cap}. Only risk_class=critical packs may exceed override_cap (current pack risk_class=${pack.risk_class}). Stop and reassess phase scope.`,
      proceed: false,
      override_required: true,
    };
  }
  if (!overrideReason) {
    return {
      mode: 'hard-block',
      used, planned: planned_calls, total_after_dispatch: total, policy,
      reason: `HARD BLOCK: ${total} calls > override_cap ${policy.override_cap}. Finance-critical pack may proceed with --budget-override "<rationale>"; otherwise stop and reassess.`,
      proceed: false,
      override_required: true,
    };
  }
  return {
    mode: 'override-required',
    used, planned: planned_calls, total_after_dispatch: total, policy,
    reason: `EXCEPTIONAL OVERRIDE: ${total} calls > override_cap ${policy.override_cap} for critical pack; rationale: "${overrideReason}". Dispatch proceeds (audited at exceptional level).`,
    proceed: true,
    override_required: true,
  };
}

/**
 * Convenience: format a budget evaluation for stderr/log output.
 */
export function formatBudgetEvaluation(b: BudgetEvaluation): string {
  const icon = b.proceed ? (b.mode === 'soft-warn' ? '⚠' : '✓') : '✗';
  return `[llm-budget ${icon}] ${b.mode}: used=${b.used} planned=${b.planned} total=${b.total_after_dispatch} caps=${b.policy.soft_cap}/${b.policy.hard_cap}/${b.policy.override_cap}\n  → ${b.reason}`;
}
