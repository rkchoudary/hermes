/**
 * Cost Guardian (M9 / LRA-3) — token-budget kill-switch.
 *
 * Operator directive: "long running jobs for days and weeks without any
 * intervention to finish the goal including running out of tokens."
 *
 * Solution: daily + weekly + monthly budget caps per engine, evaluated against
 * cost_telemetry from all task packs. When utilization crosses thresholds:
 *   - 70% utilization → log warning
 *   - 90% utilization → engage kill switch with reason
 *   - 100% utilization → kill switch active until next budget window
 *   - <70% utilization → if previously kill-switch-engaged-by-budget, release
 *
 * Automatic resume on budget replenishment closes the "weeks-long autonomy"
 * directive: when the daily/monthly window rolls over, fresh budget is
 * available, kill switch auto-disengages, and dispatch resumes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { TaskPack } from './taskPack';
import { listTasks, readTaskPack } from './runState';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const BudgetWindow = z.object({
  /** "daily" | "weekly" | "monthly" — automatic rollover at boundary. */
  period: z.enum(['daily', 'weekly', 'monthly']),
  /** Cap in USD. */
  cap_usd: z.number().nonnegative(),
  /** Per-engine caps (optional; falls back to total cap). */
  per_engine_usd: z.record(z.string(), z.number().nonnegative()).optional(),
  /** Threshold (0-1) at which kill switch auto-engages. Default 0.9. */
  engage_threshold: z.number().min(0).max(1).default(0.9),
  /** Threshold (0-1) at which kill switch auto-disengages. Default 0.7. */
  disengage_threshold: z.number().min(0).max(1).default(0.7),
});

export const BudgetContract = z.object({
  schema_version: z.literal('1').default('1'),
  windows: z.array(BudgetWindow).min(1),
  /**
   * Estimated USD cost per output_byte for each engine. Calibrated from
   * Anthropic + OpenAI pricing at the time the budget was authored.
   * Approximate; refined when actual billing API data is available (Phase 2).
   */
  cost_per_output_byte_usd: z.record(z.string(), z.number().nonnegative()).default({
    'claude-code-cli': 0.000015,    // claude-opus-4-7 ≈ $15/M output tokens; bytes ≈ tokens for English
    'claude-agent-sdk': 0.000015,
    'codex-cli': 0.00001,            // gpt-5.5 estimated
    'manual': 0,                     // human-time, not API cost
  }),
});

export type BudgetContract = z.infer<typeof BudgetContract>;
export type BudgetWindow = z.infer<typeof BudgetWindow>;

// ─── Persistence ────────────────────────────────────────────────────────────

export function budgetPath(harnessRoot: string): string {
  return path.join(harnessRoot, '.agent-runs', '_budget.json');
}

export function readBudget(harnessRoot: string): BudgetContract | null {
  const p = budgetPath(harnessRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return BudgetContract.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    throw new Error(`budget.json is malformed: ${(e as Error).message}`);
  }
}

export function writeBudget(harnessRoot: string, budget: BudgetContract): void {
  const p = budgetPath(harnessRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(budget, null, 2));
  fs.renameSync(tmp, p);
}

// ─── Window boundary helpers ────────────────────────────────────────────────

export function windowStart(period: BudgetWindow['period'], now: Date = new Date()): Date {
  const d = new Date(now);
  switch (period) {
    case 'daily':
      d.setHours(0, 0, 0, 0);
      return d;
    case 'weekly': {
      // Start of week = Sunday 00:00 UTC for stability
      const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dow = utc.getUTCDay(); // 0=Sun
      utc.setUTCDate(utc.getUTCDate() - dow);
      return utc;
    }
    case 'monthly':
      return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  }
}

// ─── Spend computation ──────────────────────────────────────────────────────

export interface SpendPerEngine {
  total_usd: number;
  per_engine: Record<string, number>;
  dispatch_count: number;
}

/**
 * Compute total spend across all task packs in all runs since the given start
 * timestamp. Uses cost_telemetry entries; converts output_bytes to USD via
 * budget.cost_per_output_byte_usd. For dispatches with explicit est_usd, that
 * value is used directly (overrides the byte heuristic).
 */
export function computeSpendSince(
  start: Date,
  budget: BudgetContract,
  runsDir: string
): SpendPerEngine {
  const result: SpendPerEngine = { total_usd: 0, per_engine: {}, dispatch_count: 0 };
  if (!fs.existsSync(runsDir)) return result;

  for (const runId of fs.readdirSync(runsDir)) {
    const runPath = path.join(runsDir, runId);
    if (!fs.statSync(runPath).isDirectory() || runId.startsWith('_')) continue;
    for (const taskId of listTasks(runId)) {
      let pack: TaskPack;
      try {
        pack = readTaskPack(runId, taskId);
      } catch {
        continue;
      }
      for (const t of pack.cost_telemetry) {
        const at = new Date(t.at);
        if (at < start) continue;
        const usd = t.est_usd ?? (t.output_bytes * (budget.cost_per_output_byte_usd[t.engine] ?? 0));
        result.total_usd += usd;
        result.per_engine[t.engine] = (result.per_engine[t.engine] ?? 0) + usd;
        result.dispatch_count += 1;
      }
    }
  }
  return result;
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

export interface BudgetWindowEvaluation {
  period: BudgetWindow['period'];
  window_start: string;
  cap_usd: number;
  spent_usd: number;
  utilization: number;
  per_engine_utilization?: Record<string, number>;
  status: 'ok' | 'warning' | 'engaged' | 'exhausted';
  reason: string;
}

export interface BudgetEvaluation {
  evaluated_at: string;
  windows: BudgetWindowEvaluation[];
  /** Should the kill switch be engaged because of budget? */
  should_engage_kill_switch: boolean;
  /** Should the kill switch be released (if previously budget-engaged)? */
  should_release_kill_switch: boolean;
  /** Most-utilized window for operator messaging. */
  worst_window?: BudgetWindowEvaluation;
}

export function evaluateBudget(
  budget: BudgetContract,
  runsDir: string,
  now: Date = new Date()
): BudgetEvaluation {
  const evaluations: BudgetWindowEvaluation[] = [];
  let shouldEngage = false;
  let allBelowDisengage = true;

  for (const w of budget.windows) {
    const start = windowStart(w.period, now);
    const spend = computeSpendSince(start, budget, runsDir);
    const utilization = w.cap_usd > 0 ? spend.total_usd / w.cap_usd : 0;

    let status: BudgetWindowEvaluation['status'];
    let reason: string;
    if (utilization >= 1.0) {
      status = 'exhausted';
      reason = `${w.period} budget exhausted: $${spend.total_usd.toFixed(2)} / $${w.cap_usd.toFixed(2)} (${(utilization * 100).toFixed(1)}%)`;
    } else if (utilization >= w.engage_threshold) {
      status = 'engaged';
      reason = `${w.period} budget at ${(utilization * 100).toFixed(1)}% — kill switch engaged (engage_threshold=${(w.engage_threshold * 100).toFixed(0)}%)`;
    } else if (utilization >= 0.7) {
      status = 'warning';
      reason = `${w.period} budget at ${(utilization * 100).toFixed(1)}% — approaching cap`;
    } else {
      status = 'ok';
      reason = `${w.period} budget at ${(utilization * 100).toFixed(1)}% — healthy`;
    }

    if (status === 'engaged' || status === 'exhausted') {
      shouldEngage = true;
    }
    if (utilization >= w.disengage_threshold) {
      allBelowDisengage = false;
    }

    const perEngineUtilization: Record<string, number> = {};
    if (w.per_engine_usd) {
      for (const [engine, cap] of Object.entries(w.per_engine_usd)) {
        if (cap > 0) {
          perEngineUtilization[engine] = (spend.per_engine[engine] ?? 0) / cap;
          if (perEngineUtilization[engine] >= w.engage_threshold) {
            shouldEngage = true;
          }
        }
      }
    }

    evaluations.push({
      period: w.period,
      window_start: start.toISOString(),
      cap_usd: w.cap_usd,
      spent_usd: spend.total_usd,
      utilization,
      per_engine_utilization: Object.keys(perEngineUtilization).length > 0 ? perEngineUtilization : undefined,
      status,
      reason,
    });
  }

  evaluations.sort((a, b) => b.utilization - a.utilization);
  return {
    evaluated_at: now.toISOString(),
    windows: evaluations,
    should_engage_kill_switch: shouldEngage,
    should_release_kill_switch: !shouldEngage && allBelowDisengage,
    worst_window: evaluations[0],
  };
}

// ─── Default contract ────────────────────────────────────────────────────────

export function defaultBudget(): BudgetContract {
  return BudgetContract.parse({
    windows: [
      { period: 'daily', cap_usd: 50, engage_threshold: 0.9, disengage_threshold: 0.7 },
      { period: 'weekly', cap_usd: 250, engage_threshold: 0.9, disengage_threshold: 0.7 },
      { period: 'monthly', cap_usd: 800, engage_threshold: 0.9, disengage_threshold: 0.7 },
    ],
  });
}
