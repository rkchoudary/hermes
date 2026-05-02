#!/usr/bin/env node
/**
 * pnpm auto:cost — cost telemetry rollup report.
 *
 * Usage:
 *   pnpm auto:cost                  # daily (today, UTC midnight → now)
 *   pnpm auto:cost --weekly         # trailing 7 days
 *   pnpm auto:cost --since 2026-04-27T00:00:00Z   # custom start
 *   pnpm auto:cost --json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rollupToday, rollupWeek, rollup, formatRollupHuman } from '../lib/costRollup';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_cost = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_cost);
const HARNESS_ROOT = harnessRoot();

interface Args {
  weekly: boolean;
  since?: Date;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { weekly: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--weekly') a.weekly = true;
    else if (x === '--json') a.json = true;
    else if (x === '--since' && i + 1 < argv.length) {
      const d = new Date(argv[++i]);
      if (!isNaN(d.getTime())) a.since = d;
    }
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // Optional budget for est_usd derivation
  const budgetPath = path.join(HARNESS_ROOT, '.agent-runs', '_budget.json');
  let budget: import('../lib/budget').BudgetContract | undefined;
  if (fs.existsSync(budgetPath)) {
    try { budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8')); } catch { /* */ }
  }

  let r;
  let label: string;
  if (args.since) {
    r = rollup(HARNESS_ROOT, { start: args.since, end: new Date(), budget });
    label = `since ${args.since.toISOString()}`;
  } else if (args.weekly) {
    r = rollupWeek(HARNESS_ROOT, budget);
    label = 'trailing 7 days';
  } else {
    r = rollupToday(HARNESS_ROOT, budget);
    label = 'today (UTC)';
  }

  if (args.json) {
    console.log(JSON.stringify({ label, rollup: r }, null, 2));
    return;
  }
  console.log(formatRollupHuman(r, label));
}

try { main(); }
catch (e) {
  console.error(`[cost] error: ${(e as Error).message}`);
  process.exit(1);
}
