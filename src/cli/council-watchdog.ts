#!/usr/bin/env node
/**
 * pnpm auto:council-watchdog [--interval-min 30] [--auto-rollback]
 *
 * Sprint M v2 final (2026-05-02): retroactive council enforcement daemon.
 *
 * Long-running cron-friendly process that periodically:
 *   1. Walks council sidecars (status='failed' or 'eval-error')
 *   2. Checks if module's PRs are merged to main
 *   3. With --auto-rollback: invokes auto:rollback automatically
 *
 * Closes the "ship first, fail later" risk of async-council; converts
 * council from advisory to retroactively-enforced. Safe-by-default: writes
 * notification log; rolls back only when --auto-rollback explicitly passed.
 *
 * Run as systemd unit, GitHub Actions cron, or `pnpm auto:council-watchdog`.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs {
  intervalMin: number;
  autoRollback: boolean;
  oneShot: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { intervalMin: 30, autoRollback: false, oneShot: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--interval-min' && i + 1 < argv.length) a.intervalMin = parseInt(argv[++i], 10);
    else if (argv[i] === '--auto-rollback') a.autoRollback = true;
    else if (argv[i] === '--one-shot') a.oneShot = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:council-watchdog [--interval-min 30] [--auto-rollback] [--one-shot]

Periodic council retroactive enforcement. By default: warns on failed
sidecars whose modules are merged. With --auto-rollback: opens revert PRs.

  --interval-min   Polling cadence (default: 30 min)
  --auto-rollback  Open revert PRs automatically when sidecar fails post-merge
  --one-shot       Run once + exit (for cron use)`);
      process.exit(0);
    }
  }
  return a;
}

function runOnce(autoRollback: boolean): { reviewed: number; flagged: number; rolled_back: number } {
  console.log(`[council-watchdog] sweep starting at ${new Date().toISOString()}`);
  const args = ['auto:council-sweep', '--json'];
  if (autoRollback) args.push('--auto-rollback');
  const r = spawnSync('pnpm', args, { encoding: 'utf8', cwd: path.join(harnessRoot(), 'tools', 'autonomous-delivery') });
  let parsed: { total_sidecars?: number; failed_count?: number; flagged?: Array<{ merged?: boolean }> } = {};
  // pnpm prepends header lines (`> name`, `> tsx ...`, blank line) before the
  // JSON body. Slice from the first '{' so the parse succeeds.
  const out = r.stdout || '';
  const jsonStart = out.indexOf('{');
  if (jsonStart >= 0) {
    try { parsed = JSON.parse(out.slice(jsonStart)); } catch { /* skip */ }
  }
  const flagged = (parsed.flagged || []).filter((f) => f.merged).length;
  console.log(`[council-watchdog] reviewed=${parsed.total_sidecars ?? 0} failed=${parsed.failed_count ?? 0} merged-but-failed=${flagged}`);
  // Persist to history log
  const histPath = path.join(harnessRoot(), '.agent-runs', '_council-watchdog.jsonl');
  try {
    fs.appendFileSync(histPath, JSON.stringify({
      at: new Date().toISOString(),
      reviewed: parsed.total_sidecars ?? 0,
      flagged: parsed.failed_count ?? 0,
      merged_flagged: flagged,
      auto_rollback: autoRollback,
    }) + '\n');
  } catch { /* skip */ }
  return { reviewed: parsed.total_sidecars ?? 0, flagged: parsed.failed_count ?? 0, rolled_back: autoRollback ? flagged : 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.oneShot) {
    runOnce(args.autoRollback);
    return;
  }
  console.log(`[council-watchdog] starting daemon — interval=${args.intervalMin}min auto-rollback=${args.autoRollback}`);
  // Run immediately, then periodically
  runOnce(args.autoRollback);
  setInterval(() => {
    try { runOnce(args.autoRollback); } catch (e) {
      console.error(`[council-watchdog] sweep error: ${(e as Error).message.slice(0, 200)}`);
    }
  }, args.intervalMin * 60 * 1000);
}

main().catch((e) => { console.error(`[council-watchdog] fatal: ${(e as Error).message}`); process.exit(99); });
