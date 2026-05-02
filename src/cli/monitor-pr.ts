#!/usr/bin/env node
/**
 * pnpm auto:monitor-pr — watch GitHub CI + Vercel deployment status for a PR.
 *
 * Usage:
 *   pnpm auto:monitor-pr <PR>                        # one-shot status check
 *   pnpm auto:monitor-pr <PR> --watch                # poll until terminal
 *   pnpm auto:monitor-pr <PR> --watch --interval 30  # poll every 30s
 *   pnpm auto:monitor-pr <PR> --json                 # machine-readable
 *   pnpm auto:monitor-pr <PR> --evidence-dir <path>  # write failure logs
 *
 * Environment:
 *   AUTO_MONITOR_REPO          GitHub repo (owner/name); defaults to gh detect
 *   AUTO_MONITOR_VERCEL_PROJECT  Vercel project; defaults to local linked project
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPrStatus } from '../lib/prMonitor';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
void __dirname;
void harnessRoot;

interface Args {
  prNumber: number;
  watch: boolean;
  interval: number;
  json: boolean;
  evidence_dir?: string;
  fetch_error_logs: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { prNumber: 0, watch: false, interval: 30, json: false, fetch_error_logs: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--watch') a.watch = true;
    else if (x === '--json') a.json = true;
    else if (x === '--fetch-error-logs') a.fetch_error_logs = true;
    else if (x === '--interval' && i + 1 < argv.length) a.interval = parseInt(argv[++i], 10);
    else if (x === '--evidence-dir' && i + 1 < argv.length) a.evidence_dir = argv[++i];
    else if (x.startsWith('--evidence-dir=')) a.evidence_dir = x.slice('--evidence-dir='.length);
    else if (!x.startsWith('--')) a.prNumber = parseInt(x, 10);
  }
  return a;
}

async function sleep(sec: number): Promise<void> {
  return new Promise((r) => setTimeout(r, sec * 1000));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.prNumber || isNaN(args.prNumber)) {
    console.error('Usage: pnpm auto:monitor-pr <PR> [--watch] [--interval N] [--json] [--evidence-dir PATH]');
    process.exit(1);
  }

  const opts = {
    repo: process.env.AUTO_MONITOR_REPO,
    vercel_project: process.env.AUTO_MONITOR_VERCEL_PROJECT,
    vercel_cwd: process.cwd(),
    evidence_dir: args.evidence_dir,
    fetch_error_logs: args.fetch_error_logs,
  };

  let iter = 0;
  const start = Date.now();
  // Hard cap watch loop at 30 min
  const MAX_WATCH_SEC = 30 * 60;

  while (true) {
    iter += 1;
    const status = checkPrStatus(args.prNumber, opts);
    if (!status) {
      if (args.json) console.log(JSON.stringify({ error: 'PR not found or gh unavailable' }, null, 2));
      else console.error(`PR #${args.prNumber} not found or gh unavailable`);
      process.exit(2);
    }

    if (args.json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      console.log(`[poll #${iter} t+${elapsed}s] ${status.summary}`);
    }

    // Terminal conditions
    const ciTerminal = status.ci_overall === 'passing' || status.ci_overall === 'failing';
    const vercelTerminal = status.vercel_overall === 'ready' || status.vercel_overall === 'error' || status.vercel_overall === 'none';
    const allTerminal = ciTerminal && vercelTerminal;

    if (!args.watch || allTerminal) {
      // Exit code reflects readiness
      if (status.ready_to_promote) process.exit(0);
      if (status.ci_overall === 'failing' || status.vercel_overall === 'error') process.exit(1);
      // Pending and not watching → exit 2
      process.exit(args.watch ? 0 : 2);
    }

    if ((Date.now() - start) / 1000 > MAX_WATCH_SEC) {
      if (!args.json) console.warn(`[monitor-pr] hit MAX_WATCH_SEC (${MAX_WATCH_SEC}s); exiting with last status`);
      process.exit(3);
    }

    await sleep(args.interval);
  }
}

main().catch((e) => {
  console.error(`[monitor-pr] error: ${(e as Error).message}`);
  process.exit(1);
});
