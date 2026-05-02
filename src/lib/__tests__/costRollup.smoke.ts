/**
 * Smoke tests for costRollup. Run via:
 *   pnpm auto:test:cost
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { rollup, rollupToday, rollupWeek, entryUsd, formatRollupHuman } from '../costRollup';
import type { BudgetContract } from '../budget';
import type { CostTelemetry } from '../taskPack';

let passed = 0, failed = 0;
function assert(c: unknown, l: string): void {
  if (c) { passed++; console.log(`  ✓ ${l}`); }
  else { failed++; console.error(`  ✗ ${l}`); }
}
function assertEq<T>(a: T, b: T, l: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${l}`); }
  else { failed++; console.error(`  ✗ ${l}\n      actual: ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); }
}

// We use a unique sub-run-id under the REAL .agent-runs since runState
// resolves paths from a module-level constant.
import { harnessRoot } from '../harnessRoot';
const HARNESS_ROOT = harnessRoot();
const REAL_RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');

function makeRun(suffix: string): { runId: string; cleanup: () => void } {
  // Note: runId must NOT start with '_' (collectTelemetry skips those).
  const runId = `cost-smoke-${process.pid}-${Date.now()}-${suffix}`;
  const dir = path.join(REAL_RUNS_DIR, runId, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  return {
    runId,
    cleanup: () => { try { fs.rmSync(path.join(REAL_RUNS_DIR, runId), { recursive: true, force: true }); } catch { /* */ } },
  };
}

function writeTaskPack(runId: string, taskId: string, module: string, telemetry: CostTelemetry[]): void {
  const today = new Date().toISOString().slice(0, 10);
  const pack = {
    schema_version: '1',
    task_id: taskId,
    run_id: runId,
    type: 'code-sprint',
    module_or_sprint: module,
    version_target: 'v1',
    objective: 'x',
    acceptance_criteria: ['x'],
    allowed_paths: ['x'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 },
    state: 'awaiting-review',
    state_history: [{ from: 'planned', to: 'awaiting-review', at: new Date().toISOString(), by: 'test', reason: 'x' }],
    evidence_dir: '/tmp/x',
    actors: { reviewers: [], approvers: [] },
    depends_on: [],
    lock: null,
    cost_telemetry: telemetry,
    notes: [],
  };
  fs.writeFileSync(path.join(REAL_RUNS_DIR, runId, 'tasks', `${taskId}.json`), JSON.stringify(pack, null, 2));
}

function tel(round: number, engine: string, est_usd: number, at: string, output_bytes = 0): CostTelemetry {
  return {
    round,
    engine,
    duration_ms: 60_000,
    exit_code: 0,
    output_bytes,
    est_usd,
    at,
  };
}

console.log('\n[costRollup smoke] starting…\n');

// ─── 1. entryUsd: explicit est_usd wins over byte heuristic ─────────────────
{
  console.log('1. entryUsd');
  const t1 = tel(1, 'claude-cli', 0.05, '2026-04-28T12:00:00Z', 100_000);
  assertEq(entryUsd(t1), 0.05, 'explicit est_usd used directly');
  const budget: BudgetContract = {
    schema_version: '1',
    description: 'test',
    windows: [],
    cost_per_output_byte_usd: { 'claude-cli': 0.000001 },
    actions_on_threshold: { warning_pct: 50, engaged_pct: 80, exhausted_pct: 100, action: 'warn-only' },
  } as BudgetContract;
  const t2 = { ...t1, est_usd: undefined };
  assertEq(entryUsd(t2, budget), 100_000 * 0.000001, 'byte heuristic used when est_usd missing');
  assertEq(entryUsd(t2), 0, 'no budget + no est_usd → 0');
}

// ─── 2. rollup window filters correctly ─────────────────────────────────────
{
  console.log('\n2. rollup window filtering');
  const { runId, cleanup } = makeRun('window');
  try {
    writeTaskPack(runId, `TP-2026-04-28-${String(901 + (process.pid % 100))}`, 'mod-A', [
      tel(1, 'claude-cli', 0.10, '2026-04-28T08:00:00Z'),
      tel(2, 'claude-cli', 0.20, '2026-04-28T12:00:00Z'),
      tel(3, 'claude-cli', 0.30, '2026-04-28T16:00:00Z'),
    ]);
    const r = rollup(HARNESS_ROOT, {
      start: new Date('2026-04-28T10:00:00Z'),
      end: new Date('2026-04-28T15:00:00Z'),
    });
    // Only round-2 (12:00) falls in window
    assert(r.total.dispatch_count >= 1, 'at least 1 in window');
    // Find this task in by_task
    const taskId = `TP-2026-04-28-${String(901 + (process.pid % 100))}`;
    if (r.by_task[taskId]) {
      assertEq(r.by_task[taskId].dispatch_count, 1, 'only mid-window dispatch counted');
      assertEq(r.by_task[taskId].total_usd, 0.20, '$0.20 from mid-window dispatch');
    }
  } finally { cleanup(); }
}

// ─── 3. rollup aggregates by engine + module ────────────────────────────────
{
  console.log('\n3. rollup aggregates by engine + module');
  const { runId, cleanup } = makeRun('agg');
  try {
    const taskA = `TP-2026-04-28-${String(801 + (process.pid % 100))}`;
    const taskB = `TP-2026-04-28-${String(802 + (process.pid % 100))}`;
    writeTaskPack(runId, taskA, 'mod-A', [
      tel(1, 'claude-cli', 0.50, '2026-04-28T12:00:00Z'),
      tel(2, 'claude-agent-sdk', 0.30, '2026-04-28T13:00:00Z'),
    ]);
    writeTaskPack(runId, taskB, 'mod-B', [
      tel(1, 'claude-cli', 0.20, '2026-04-28T14:00:00Z'),
    ]);
    const r = rollup(HARNESS_ROOT, {
      start: new Date('2026-04-28T00:00:00Z'),
      end: new Date('2026-04-28T23:59:59Z'),
    });
    // by_engine: claude-cli should be > 0
    assert(r.by_engine['claude-cli']?.total_usd >= 0.70, 'claude-cli aggregated');
    assert(r.by_engine['claude-agent-sdk']?.total_usd >= 0.30, 'claude-agent-sdk aggregated');
    // by_module
    assert(r.by_module['mod-A']?.total_usd >= 0.80, 'mod-A aggregated ≥ $0.80');
    assert(r.by_module['mod-B']?.total_usd >= 0.20, 'mod-B aggregated ≥ $0.20');
  } finally { cleanup(); }
}

// ─── 4. top_tasks ranking ───────────────────────────────────────────────────
{
  console.log('\n4. top_tasks ranking');
  const { runId, cleanup } = makeRun('top');
  try {
    const tIds = [701, 702, 703].map((n) => `TP-2026-04-28-${String(n + (process.pid % 100))}`);
    writeTaskPack(runId, tIds[0], 'mod-X', [tel(1, 'claude-cli', 1.00, '2026-04-28T12:00:00Z')]);
    writeTaskPack(runId, tIds[1], 'mod-Y', [tel(1, 'claude-cli', 0.50, '2026-04-28T12:00:00Z')]);
    writeTaskPack(runId, tIds[2], 'mod-Z', [tel(1, 'claude-cli', 0.10, '2026-04-28T12:00:00Z')]);
    const r = rollup(HARNESS_ROOT, {
      start: new Date('2026-04-28T00:00:00Z'),
      end: new Date('2026-04-28T23:59:59Z'),
      top_n: 3,
    });
    // Find our tasks in top_tasks; at minimum they should be ordered by USD desc
    const ours = r.top_tasks.filter((t) => tIds.includes(t.task_id));
    if (ours.length === 3) {
      assertEq(ours[0].total_usd, 1.00, 'top-1 = $1.00');
      assertEq(ours[1].total_usd, 0.50, 'top-2 = $0.50');
      assertEq(ours[2].total_usd, 0.10, 'top-3 = $0.10');
    } else {
      // At least verify ours are present
      assert(ours.length >= 1, `at least 1 of our tasks present (got ${ours.length})`);
    }
  } finally { cleanup(); }
}

// ─── 5. by_day buckets ──────────────────────────────────────────────────────
{
  console.log('\n5. by_day buckets');
  const { runId, cleanup } = makeRun('day');
  try {
    const taskId = `TP-2026-04-27-${String(601 + (process.pid % 100))}`;
    writeTaskPack(runId, taskId, 'mod-D', [
      tel(1, 'claude-cli', 0.10, '2026-04-27T10:00:00Z'),
      tel(2, 'claude-cli', 0.20, '2026-04-28T11:00:00Z'),
    ]);
    const r = rollup(HARNESS_ROOT, {
      start: new Date('2026-04-27T00:00:00Z'),
      end: new Date('2026-04-28T23:59:59Z'),
    });
    assert(r.by_day['2026-04-27']?.total_usd >= 0.10, '2026-04-27 bucket has ≥ $0.10');
    assert(r.by_day['2026-04-28']?.total_usd >= 0.20, '2026-04-28 bucket has ≥ $0.20');
  } finally { cleanup(); }
}

// ─── 6. formatRollupHuman renders without error ─────────────────────────────
{
  console.log('\n6. formatRollupHuman renders');
  const r = rollup(HARNESS_ROOT, {
    start: new Date('2025-01-01T00:00:00Z'),
    end: new Date('2025-01-02T00:00:00Z'),
  });
  const out = formatRollupHuman(r, 'test-empty');
  assert(out.includes('cost rollup'), 'rendered output contains "cost rollup"');
  assert(out.includes('test-empty'), 'rendered output contains label');
}

// ─── 7. rollupToday + rollupWeek convenience wrappers don't throw ───────────
{
  console.log('\n7. rollupToday + rollupWeek');
  const today = rollupToday(HARNESS_ROOT);
  assert(today.window_start.length > 0, 'rollupToday returns window_start');
  const week = rollupWeek(HARNESS_ROOT);
  assert(week.window_start.length > 0, 'rollupWeek returns window_start');
}

console.log(`\n[costRollup smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
