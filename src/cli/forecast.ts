#!/usr/bin/env node
/**
 * pnpm auto:forecast TP-… [--engine claude-code-cli] [--json]
 *
 * Cost forecast for a single task pack's next dispatch. Reads historical
 * cost_telemetry from ALL prior task packs in this run + ancestor runs to
 * compute p50/p95/worst-case estimates.
 *
 * Codex T4 review (bnl3rpgha) prescribed this as the strongest T4 candidate.
 *
 * Verdict ladder:
 *   ok     — within p50 expectation
 *   warn   — high variance OR low confidence (insufficient history)
 *   refuse — p95 exceeds pack.context_budget.max_cost_usd cap
 *
 * Operators can integrate with auto:work via AUTO_FORECAST_REQUIRE=1 to refuse
 * dispatch when verdict !== 'ok'.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { forecastDispatch } from '../lib/costForecast';
import type { CostTelemetry } from '../lib/taskPack';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();

interface Args {
  taskId: string;
  engine: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let taskId = '';
  let engine = 'claude-code-cli';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--engine' && i + 1 < argv.length) engine = argv[++i];
    else if (!a.startsWith('--') && !taskId) taskId = a;
  }
  if (!taskId) {
    console.error('usage: pnpm auto:forecast <TP-…> [--engine claude-code-cli|claude-agent-sdk|codex-cli|manual] [--json]');
    process.exit(64);
  }
  return { taskId, engine, json };
}

function findRun(taskId: string): string | null {
  for (const runId of listRuns()) {
    if (listTasks(runId).includes(taskId)) return runId;
  }
  return null;
}

function gatherHistory(): CostTelemetry[] {
  const all: CostTelemetry[] = [];
  for (const runId of listRuns()) {
    for (const taskId of listTasks(runId)) {
      try {
        const pack = readTaskPack(runId, taskId);
        for (const c of pack.cost_telemetry) all.push(c);
      } catch { /* skip malformed */ }
    }
  }
  return all;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRun(args.taskId);
  if (!runId) {
    console.error(`task ${args.taskId} not found in any run`);
    process.exit(2);
  }
  const pack = readTaskPack(runId, args.taskId);
  const history = gatherHistory();
  const forecast = forecastDispatch(pack, args.engine, history);

  if (args.json) {
    console.log(JSON.stringify(forecast, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:forecast  ${args.taskId}  (engine: ${forecast.engine})`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`History samples:  ${forecast.history_n} entries (across all runs)`);
  console.log(`Rate:             $${forecast.rate_usd_per_sec.toFixed(4)}/sec`);
  console.log('');
  console.log(`Duration:`);
  console.log(`  p50:            ${forecast.duration_p50_sec.toFixed(0)}s  (~${(forecast.duration_p50_sec / 60).toFixed(1)} min)`);
  console.log(`  p95:            ${forecast.duration_p95_sec.toFixed(0)}s  (~${(forecast.duration_p95_sec / 60).toFixed(1)} min)`);
  console.log(`  worst (5-round):${forecast.duration_worst_sec.toFixed(0)}s  (~${(forecast.duration_worst_sec / 60).toFixed(1)} min)`);
  console.log('');
  console.log(`Cost:`);
  console.log(`  p50:            $${forecast.cost_p50_usd.toFixed(2)}`);
  console.log(`  p95:            $${forecast.cost_p95_usd.toFixed(2)}`);
  console.log(`  worst-5-round:  $${forecast.cost_worst_usd.toFixed(2)}`);
  if (forecast.pack_max_usd !== undefined) {
    console.log(`  pack cap:       $${forecast.pack_max_usd.toFixed(2)}`);
  }
  console.log('');
  const icon = forecast.verdict === 'ok' ? '✓' : forecast.verdict === 'warn' ? '⚠' : '✗';
  console.log(`Verdict: ${icon} ${forecast.verdict.toUpperCase()} — ${forecast.reason}`);

  if (forecast.verdict === 'refuse' && process.env.AUTO_FORECAST_REQUIRE === '1') {
    process.exit(3);
  }
}

main();
