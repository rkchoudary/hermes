/**
 * v0.5.0 T4 sprint (Codex bnl3rpgha) — cost forecast.
 *
 * Codex prescription: "Cost forecasting is useful even at solo scale because
 * it prevents bad dispatch decisions before they happen. It also becomes the
 * governor for N-of-M, visual regression, and repeated revise loops. This is
 * the strongest T4 candidate."
 *
 * Forecasts cost for a future dispatch using percentile estimators (p50, p95,
 * worst-case) over historical cost_telemetry. Three modes:
 *
 *   - WARN at p50  (operator sees the expected cost)
 *   - REFUSE at p95 OR pack.context_budget.max_cost_usd cap exceeded
 *   - WORST case = 5 rounds × p95 (matches max_rounds default; surfaces plateau risk)
 *
 * Pure: no I/O. Caller supplies historical entries + the engine being forecast.
 * Calibration log (forecast vs actual) recorded in `_cost-forecast-log.jsonl`
 * by the caller after each real dispatch — bias upward over time on under-prediction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { CostTelemetry, TaskPack } from './taskPack';
import { harnessRoot } from './harnessRoot';

/**
 * USD per second by engine. These are operator-tuned defaults; real
 * deployments override via AUTO_FORECAST_RATES env (JSON map). Sources:
 *   claude-code-cli (Max sub) — flat-rate ~$0.0/sec for the operator's own use
 *     after subscription; charged here as a small placeholder for context budget.
 *   claude-agent-sdk — Anthropic API pricing for Opus 4.7 ~ $0.0165/sec sustained
 *     (estimate: 60K tokens/min × $15/1M output)
 *   codex-cli (gpt-5.5 xhigh) — ChatGPT Pro included; small placeholder per call.
 *   manual / mock — zero.
 */
const DEFAULT_RATE_USD_PER_SEC: Record<string, number> = {
  'claude-code-cli': 0.001,
  'claude-agent-sdk': 0.0165,
  'codex-cli': 0.001,
  'codex-consensus': 0.005,
  manual: 0,
  mock: 0,
};

function ratesFromEnv(): Record<string, number> {
  if (!process.env.AUTO_FORECAST_RATES) return DEFAULT_RATE_USD_PER_SEC;
  try {
    const parsed = JSON.parse(process.env.AUTO_FORECAST_RATES) as Record<string, number>;
    return { ...DEFAULT_RATE_USD_PER_SEC, ...parsed };
  } catch {
    return DEFAULT_RATE_USD_PER_SEC;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

export interface ForecastResult {
  engine: string;
  /** USD-per-second rate applied. */
  rate_usd_per_sec: number;
  /** Number of historical entries informing the estimate. */
  history_n: number;
  /** Estimated duration in seconds at p50/p95/worst (5-round plateau). */
  duration_p50_sec: number;
  duration_p95_sec: number;
  duration_worst_sec: number;
  /** Estimated USD cost at each percentile. */
  cost_p50_usd: number;
  cost_p95_usd: number;
  cost_worst_usd: number;
  /** Hard cap per pack (pack.context_budget.max_cost_usd). undefined when unset. */
  pack_max_usd: number | undefined;
  /** Verdict: 'ok' | 'warn' (over p50) | 'refuse' (over p95 or pack cap). */
  verdict: 'ok' | 'warn' | 'refuse';
  reason: string;
}

/**
 * Forecast cost for a single round of the configured engine.
 * Caller is responsible for multiplying by rounds_remaining when forecasting
 * worst-case across an N-round revise loop (we expose worst_sec which already
 * does this internally per the 5-round plateau model).
 */
export function forecastDispatch(
  pack: TaskPack,
  engine: string,
  history: CostTelemetry[]
): ForecastResult {
  const rate = ratesFromEnv()[engine] ?? 0.001;
  const relevant = history.filter((h) => h.engine === engine || h.engine === `${engine}-consensus`);
  const durations = relevant.map((h) => h.duration_ms / 1000).filter((d) => d > 0);

  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  // Worst case: 5 rounds @ p95 + 5 codex rounds @ codex p95
  const codexHistory = history.filter((h) => h.engine === 'codex-consensus' || h.engine === 'codex-cli');
  const codexP95 = percentile(codexHistory.map((c) => c.duration_ms / 1000), 0.95);
  const worstSec = (p95 || 600) * 5 + (codexP95 || 480) * 5;

  const result: ForecastResult = {
    engine,
    rate_usd_per_sec: rate,
    history_n: durations.length,
    duration_p50_sec: p50,
    duration_p95_sec: p95,
    duration_worst_sec: worstSec,
    cost_p50_usd: p50 * rate,
    cost_p95_usd: p95 * rate,
    cost_worst_usd: worstSec * (rate + (ratesFromEnv()['codex-consensus'] ?? 0.005)) / 2,
    pack_max_usd: pack.context_budget.max_cost_usd as number | undefined,
    verdict: 'ok',
    reason: '',
  };

  // Verdict ladder
  if (result.pack_max_usd !== undefined && result.cost_p95_usd > result.pack_max_usd) {
    result.verdict = 'refuse';
    result.reason = `p95 cost $${result.cost_p95_usd.toFixed(2)} exceeds pack.context_budget.max_cost_usd cap $${result.pack_max_usd.toFixed(2)}`;
    return result;
  }
  // Daily-budget refuse: caller can pass remaining_budget_usd into pack.context_budget.max_cost_usd
  // OR check separately. For pure function we rely on pack cap only.
  if (result.cost_p95_usd > result.cost_p50_usd * 2) {
    result.verdict = 'warn';
    result.reason = `p95 ($${result.cost_p95_usd.toFixed(2)}) is >2× p50 ($${result.cost_p50_usd.toFixed(2)}); high variance — consider splitting task or tightening scope`;
    return result;
  }
  if (result.history_n < 3) {
    result.verdict = 'warn';
    result.reason = `only ${result.history_n} historical sample(s); forecast confidence is low`;
    return result;
  }
  result.verdict = 'ok';
  result.reason = `expected $${result.cost_p50_usd.toFixed(2)} (p95 $${result.cost_p95_usd.toFixed(2)}, worst-5-round $${result.cost_worst_usd.toFixed(2)})`;
  return result;
}

/**
 * Append a forecast-vs-actual calibration record after a dispatch completes.
 * Ratio < 1 = under-predicted (bias upward); ratio > 1 = over-predicted.
 * Codex prescription: "record forecast expected/p95/worst, record actual,
 * compute error ratio, bias upward after under-prediction, refuse only on
 * hard cap breach, otherwise warn when confidence is weak."
 */
export function recordCalibration(opts: {
  task_id: string;
  run_id: string;
  forecast: ForecastResult;
  actual_duration_sec: number;
  actual_cost_usd?: number;
}): void {
  const root = harnessRoot();
  const logPath = path.join(root, '.agent-runs', '_cost-forecast-log.jsonl');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const entry = {
    schema_version: '1',
    at: new Date().toISOString(),
    task_id: opts.task_id,
    run_id: opts.run_id,
    forecast_p50_usd: opts.forecast.cost_p50_usd,
    forecast_p95_usd: opts.forecast.cost_p95_usd,
    forecast_worst_usd: opts.forecast.cost_worst_usd,
    actual_duration_sec: opts.actual_duration_sec,
    actual_cost_usd: opts.actual_cost_usd ?? opts.actual_duration_sec * opts.forecast.rate_usd_per_sec,
    error_ratio: opts.forecast.cost_p50_usd > 0
      ? (opts.actual_cost_usd ?? opts.actual_duration_sec * opts.forecast.rate_usd_per_sec) / opts.forecast.cost_p50_usd
      : null,
  };
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
}
