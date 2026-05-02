#!/usr/bin/env node
/**
 * pnpm auto:cleanup — proactive resource cleanup per declarative policies.
 *
 * Usage:
 *   pnpm auto:cleanup                          # dry-run summary across ALL policies
 *   pnpm auto:cleanup --apply                  # actually delete + audit + persist state
 *   pnpm auto:cleanup --apply --force          # bypass cadence rate-limit
 *   pnpm auto:cleanup --only tmp-worker-prompts,session-history-cap  # subset
 *   pnpm auto:cleanup --json                   # machine-readable output for dashboard
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runAll, DEFAULT_POLICIES, totalActions, totalBytesFreed } from '../lib/cleanupPolicy';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_cleanup = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_cleanup);
const HARNESS_ROOT = harnessRoot();

interface Args {
  apply: boolean;
  force: boolean;
  json: boolean;
  verbose: boolean;
  only: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, force: false, json: false, verbose: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force') args.force = true;
    else if (a === '--json') args.json = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--only' && i + 1 < argv.length) {
      args.only = argv[++i].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    }
  }
  return args;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const results = runAll(HARNESS_ROOT, {
    apply: args.apply,
    force: args.force,
    only: args.only.length > 0 ? args.only : undefined,
    host: os.hostname(),
  });

  if (args.json) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      apply: args.apply,
      force: args.force,
      host: os.hostname(),
      total_actions: totalActions(results),
      total_bytes: totalBytesFreed(results),
      results,
    }, null, 2));
    return;
  }

  console.log(`[cleanup ${new Date().toISOString()}] host=${os.hostname()} apply=${args.apply} force=${args.force} policies=${DEFAULT_POLICIES.length}`);
  let runCount = 0, skipCount = 0;
  for (const r of results) {
    if (r.skipped_for_cadence) {
      skipCount++;
      if (args.verbose) {
        console.log(`  ⏭ ${r.policy_id} — cadence skip (${r.cadence_remaining_sec}s remaining)`);
      }
      continue;
    }
    runCount++;
    const verb = args.apply ? 'deleted' : 'would-delete';
    console.log(`  ▸ ${r.policy_id}: scanned=${r.scanned} matched=${r.matched} ${verb}=${r.actions.length} bytes=${fmtBytes(r.actions.reduce((s, a) => s + a.bytes, 0))}`);
    if (args.verbose) {
      for (const a of r.actions.slice(0, 5)) {
        console.log(`      - ${a.path} (${fmtBytes(a.bytes)}, mtime=${a.mtime}, reason=${a.reason})`);
      }
      if (r.actions.length > 5) console.log(`      … +${r.actions.length - 5} more`);
    }
    for (const e of r.errors) console.warn(`      ⚠ ${e}`);
  }
  console.log(`[cleanup] summary: ran=${runCount} skipped-cadence=${skipCount} total-actions=${totalActions(results)} total-bytes=${fmtBytes(totalBytesFreed(results))}`);

  if (!args.apply && totalActions(results) > 0) {
    console.log(`[cleanup] re-run with --apply to actually clean up (${totalActions(results)} action${totalActions(results) === 1 ? '' : 's'} pending; ${fmtBytes(totalBytesFreed(results))} reclaimable)`);
  }
}

try { main(); }
catch (e) {
  console.error(`[cleanup] error: ${(e as Error).message}`);
  process.exit(1);
}
