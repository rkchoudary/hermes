#!/usr/bin/env node
/**
 * pnpm auto:budget — budget contract management (M9 / LRA-3).
 *
 * Subcommands:
 *   init [--force]            create .agent-runs/_budget.json with defaults
 *                             ($50/day, $250/week, $800/month). Refuses if
 *                             file exists unless --force.
 *   show                      print current budget contract + evaluation
 *                             against live cost_telemetry.
 *
 * Operator workflow:
 *   pnpm auto:budget init     # bootstrap once
 *   pnpm auto:budget show     # check spend + utilization
 *
 * The runtime path (auto:work + auto:daemon) ALWAYS evaluates budget; if the
 * contract file is missing they fall back to defaultBudget() — same caps as
 * `init` produces. So `init` is purely about persisting the operator's
 * preferences so they survive review.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { harnessRoot } from '../lib/harnessRoot';
import {
  readBudget,
  writeBudget,
  evaluateBudget,
  defaultBudget,
  budgetPath,
} from '../lib/budget';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();

function usage(): never {
  console.error(`Usage:
  pnpm auto:budget init [--force]
  pnpm auto:budget show`);
  process.exit(2);
}

function cmdInit(force: boolean): void {
  const p = budgetPath(HARNESS_ROOT);
  if (fs.existsSync(p) && !force) {
    console.error(`[init] BLOCKED: ${p} already exists. Pass --force to overwrite.`);
    process.exit(1);
  }
  const budget = defaultBudget();
  writeBudget(HARNESS_ROOT, budget);
  console.log(`✓ wrote ${p}`);
  console.log(``);
  console.log(`Default budget contract:`);
  for (const w of budget.windows) {
    console.log(`  ${w.period.padEnd(8)}  $${w.cap_usd.toFixed(2).padStart(8)} cap` +
      `  · engage_threshold ${(w.engage_threshold * 100).toFixed(0)}%` +
      `  · disengage_threshold ${(w.disengage_threshold * 100).toFixed(0)}%`);
  }
  console.log(``);
  console.log(`Edit ${p} directly to customize caps + per-engine sub-caps.`);
}

function cmdShow(): void {
  const persisted = readBudget(HARNESS_ROOT);
  const budget = persisted ?? defaultBudget();
  if (!persisted) {
    console.log(`(using default budget — no custom contract at ${budgetPath(HARNESS_ROOT)})`);
    console.log(`Run pnpm auto:budget init to persist defaults.`);
    console.log(``);
  }
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  const evaluation = evaluateBudget(budget, runsDir);
  console.log(`Budget evaluation @ ${evaluation.evaluated_at}`);
  console.log(``);
  for (const w of evaluation.windows) {
    const pct = (w.utilization * 100).toFixed(1);
    const icon = w.status === 'ok' ? '✓' : (w.status === 'warning' ? '⚠' : '🚨');
    console.log(`  ${icon} ${w.period.padEnd(8)}  spent $${w.spent_usd.toFixed(2).padStart(8)} / cap $${w.cap_usd.toFixed(2).padStart(8)}  (${pct}%)`);
    if (w.per_engine_utilization && Object.keys(w.per_engine_utilization).length > 0) {
      for (const [engine, util] of Object.entries(w.per_engine_utilization)) {
        console.log(`      ${engine.padEnd(20)}  ${(util * 100).toFixed(1)}%`);
      }
    }
  }
  console.log(``);
  console.log(`Kill switch:`);
  console.log(`  should_engage:  ${evaluation.should_engage_kill_switch ? 'YES' : 'no'}`);
  console.log(`  should_release: ${evaluation.should_release_kill_switch ? 'yes' : 'no'}`);
  if (evaluation.worst_window) {
    console.log(`  worst window:   ${evaluation.worst_window.period} (${(evaluation.worst_window.utilization * 100).toFixed(1)}%)`);
  }
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub) usage();
  if (sub === 'init') {
    cmdInit(argv.includes('--force'));
  } else if (sub === 'show') {
    cmdShow();
  } else {
    usage();
  }
}

main();
