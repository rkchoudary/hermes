/**
 * Cost telemetry rollup — aggregate cost_telemetry[] across task packs into
 * daily / weekly / per-module / per-engine / per-task buckets.
 *
 * Operator gap-roadmap item #3 (2026-04-28): "Cost telemetry rollup + budget
 * alerts". Pairs with budget.ts which already does total-spend kill-switch
 * triggering; this module provides the OBSERVABILITY layer (where is the
 * money going? which module? which engine? which task burns most?).
 *
 * Pure functions over the existing CostTelemetry schema (taskPack.ts:135).
 * No mutation, no side effects — caller decides whether to print, post to
 * Slack, persist as a snapshot, etc.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CostTelemetry, TaskPack } from './taskPack';
import { listRuns, listTasks, readTaskPack } from './runState';
import type { BudgetContract } from './budget';

// ─── Aggregation primitives ─────────────────────────────────────────────────

export interface CostBucket {
  total_usd: number;
  dispatch_count: number;
  total_duration_ms: number;
  total_output_bytes: number;
}

export interface CostRollup {
  window_start: string;
  window_end: string;
  total: CostBucket;
  by_engine: Record<string, CostBucket>;
  by_module: Record<string, CostBucket>;
  by_task: Record<string, CostBucket & { module: string }>;
  by_day: Record<string, CostBucket>;  // ISO date YYYY-MM-DD
  /** Top-N expensive tasks (dispatch-count + total cost). */
  top_tasks: { task_id: string; module: string; total_usd: number; dispatches: number }[];
}

interface RolledTelemetry {
  task_id: string;
  module: string;
  entry: CostTelemetry;
  est_usd: number;
}

function emptyBucket(): CostBucket {
  return { total_usd: 0, dispatch_count: 0, total_duration_ms: 0, total_output_bytes: 0 };
}

function addToBucket(b: CostBucket, t: RolledTelemetry): void {
  b.total_usd += t.est_usd;
  b.dispatch_count += 1;
  b.total_duration_ms += t.entry.duration_ms;
  b.total_output_bytes += t.entry.output_bytes;
}

function bucketKey<K extends string>(map: Record<K, CostBucket>, key: K): CostBucket {
  if (!map[key]) map[key] = emptyBucket();
  return map[key];
}

/**
 * Compute USD cost for a single telemetry entry. Uses the explicit est_usd
 * if the engine reported it (claude-agent-sdk for v0.4.3+); otherwise falls
 * back to the byte-heuristic in the budget contract.
 */
export function entryUsd(entry: CostTelemetry, budget?: BudgetContract): number {
  if (typeof entry.est_usd === 'number') return entry.est_usd;
  if (!budget) return 0;
  const rate = budget.cost_per_output_byte_usd[entry.engine] ?? 0;
  return entry.output_bytes * rate;
}

// ─── Walk all runs/tasks and collect telemetry ──────────────────────────────

function collectTelemetry(
  runsDir: string,
  start: Date,
  end: Date,
  budget?: BudgetContract,
): RolledTelemetry[] {
  const out: RolledTelemetry[] = [];
  if (!fs.existsSync(runsDir)) return out;
  for (const runId of fs.readdirSync(runsDir)) {
    const runPath = path.join(runsDir, runId);
    let isDir = false;
    try { isDir = fs.statSync(runPath).isDirectory(); } catch { continue; }
    if (!isDir || runId.startsWith('_')) continue;
    for (const taskId of listTasks(runId)) {
      let pack: TaskPack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      const module = pack.module_or_sprint;
      for (const t of pack.cost_telemetry) {
        const at = new Date(t.at);
        if (at < start || at > end) continue;
        out.push({
          task_id: pack.task_id,
          module,
          entry: t,
          est_usd: entryUsd(t, budget),
        });
      }
    }
  }
  return out;
}

// ─── Public API: rollup ─────────────────────────────────────────────────────

export interface RollupOpts {
  /** Default: 24h ago. */
  start?: Date;
  /** Default: now. */
  end?: Date;
  /** If provided, est_usd derived via budget.cost_per_output_byte_usd for entries
   *  without est_usd. Without budget, those entries contribute 0 USD. */
  budget?: BudgetContract;
  /** Top-N expensive tasks. Default 10. */
  top_n?: number;
}

export function rollup(harnessRoot: string, opts: RollupOpts = {}): CostRollup {
  const end = opts.end ?? new Date();
  const start = opts.start ?? new Date(end.getTime() - 24 * 3600 * 1000);
  const topN = opts.top_n ?? 10;
  const runsDir = path.join(harnessRoot, '.agent-runs');
  const collected = collectTelemetry(runsDir, start, end, opts.budget);

  const r: CostRollup = {
    window_start: start.toISOString(),
    window_end: end.toISOString(),
    total: emptyBucket(),
    by_engine: {},
    by_module: {},
    by_task: {},
    by_day: {},
    top_tasks: [],
  };
  for (const t of collected) {
    addToBucket(r.total, t);
    addToBucket(bucketKey(r.by_engine, t.entry.engine), t);
    addToBucket(bucketKey(r.by_module, t.module), t);
    const taskBucket = (r.by_task[t.task_id] ??= { ...emptyBucket(), module: t.module });
    addToBucket(taskBucket, t);
    const isoDay = t.entry.at.slice(0, 10);
    addToBucket(bucketKey(r.by_day, isoDay), t);
  }
  // Top-N tasks
  r.top_tasks = Object.entries(r.by_task)
    .map(([task_id, b]) => ({
      task_id,
      module: b.module,
      total_usd: b.total_usd,
      dispatches: b.dispatch_count,
    }))
    .sort((a, b) => b.total_usd - a.total_usd || b.dispatches - a.dispatches)
    .slice(0, topN);
  return r;
}

/**
 * Daily windowed convenience: midnight UTC today through now.
 */
export function rollupToday(harnessRoot: string, budget?: BudgetContract): CostRollup {
  const now = new Date();
  const startOfDayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return rollup(harnessRoot, { start: startOfDayUtc, end: now, budget });
}

/**
 * Trailing-7-day rollup.
 */
export function rollupWeek(harnessRoot: string, budget?: BudgetContract): CostRollup {
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 24 * 3600 * 1000);
  return rollup(harnessRoot, { start, end, budget });
}

// ─── Pretty-printing ────────────────────────────────────────────────────────

export function formatRollupHuman(r: CostRollup, label = ''): string {
  const lines: string[] = [];
  lines.push(`[cost rollup${label ? ` — ${label}` : ''}] window=${r.window_start} → ${r.window_end}`);
  lines.push(`  total: $${r.total.total_usd.toFixed(4)} across ${r.total.dispatch_count} dispatch${r.total.dispatch_count === 1 ? '' : 'es'} (${(r.total.total_duration_ms / 60_000).toFixed(1)} min, ${(r.total.total_output_bytes / 1024).toFixed(1)} KB output)`);
  if (Object.keys(r.by_engine).length > 0) {
    lines.push(`  by engine:`);
    for (const [eng, b] of Object.entries(r.by_engine).sort(([, a], [, b]) => b.total_usd - a.total_usd)) {
      lines.push(`    ${eng.padEnd(24)} $${b.total_usd.toFixed(4)}  (${b.dispatch_count} disp)`);
    }
  }
  if (Object.keys(r.by_module).length > 0) {
    lines.push(`  by module (top 5):`);
    const entries = Object.entries(r.by_module).sort(([, a], [, b]) => b.total_usd - a.total_usd).slice(0, 5);
    for (const [mod, b] of entries) {
      lines.push(`    ${mod.padEnd(24)} $${b.total_usd.toFixed(4)}  (${b.dispatch_count} disp)`);
    }
  }
  if (r.top_tasks.length > 0) {
    lines.push(`  top tasks:`);
    for (const t of r.top_tasks.slice(0, 5)) {
      lines.push(`    ${t.task_id} (${t.module})  $${t.total_usd.toFixed(4)}  (${t.dispatches} disp)`);
    }
  }
  return lines.join('\n');
}
