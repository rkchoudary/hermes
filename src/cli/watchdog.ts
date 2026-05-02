#!/usr/bin/env node
/**
 * pnpm auto:watchdog — reap stale / hung / over-deadline processes from the
 * harness process registry. Idempotent. Operator-runnable; also called by
 * auto:tick every cycle so reaping happens automatically without me waiting.
 *
 * Usage:
 *   pnpm auto:watchdog               # dry-run (default)
 *   pnpm auto:watchdog --apply       # actually kill + unregister
 *   pnpm auto:watchdog --json        # machine-readable for dashboard
 */
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { listRegistered, reapStale } from '../lib/processWatchdog';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_watchdog = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_watchdog);
const HARNESS_ROOT = harnessRoot();

interface Args {
  apply: boolean;
  json: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
    verbose: argv.includes('--verbose'),
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const reg = listRegistered(HARNESS_ROOT);
  const results = reapStale(HARNESS_ROOT, { apply: args.apply });

  if (args.json) {
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      apply: args.apply,
      host: os.hostname(),
      registered: reg.length,
      results: results.map((r) => ({
        pid: r.entry.pid,
        kind: r.entry.kind,
        task_id: r.entry.task_id,
        verdict: r.verdict.action,
        reason: r.verdict.reason,
        applied: r.applied,
        killed_signal: r.killed_signal,
      })),
    }, null, 2));
    return;
  }

  // Human-readable
  console.log(`[watchdog ${new Date().toISOString()}] host=${os.hostname()} registered=${reg.length} apply=${args.apply}`);
  if (results.length === 0) {
    console.log('[watchdog] no in-flight processes registered');
    return;
  }

  let kept = 0, deadCleaned = 0, killedTimeout = 0, killedHeartbeat = 0;
  for (const r of results) {
    const tag = r.entry.task_id ? `[${r.entry.task_id}] ` : '';
    const sig = r.killed_signal ? ` signal=${r.killed_signal}` : '';
    switch (r.verdict.action) {
      case 'keep':
        kept++;
        if (args.verbose) console.log(`  ✓ pid=${r.entry.pid} ${r.entry.kind} ${tag}${r.verdict.reason}`);
        break;
      case 'unregister-dead':
        deadCleaned++;
        console.log(`  ⚰ pid=${r.entry.pid} ${r.entry.kind} ${tag}${r.verdict.reason}${args.apply ? ' [unregistered]' : ' [dry-run]'}`);
        break;
      case 'kill-overdeadline':
        killedTimeout++;
        console.log(`  ⏰ pid=${r.entry.pid} ${r.entry.kind} ${tag}${r.verdict.reason}${args.apply ? ` [killed${sig}]` : ' [dry-run]'}`);
        break;
      case 'kill-stale-heartbeat':
        killedHeartbeat++;
        console.log(`  💔 pid=${r.entry.pid} ${r.entry.kind} ${tag}${r.verdict.reason}${args.apply ? ` [killed${sig}]` : ' [dry-run]'}`);
        break;
    }
  }
  console.log(`[watchdog] summary: kept=${kept} dead-cleaned=${deadCleaned} killed-timeout=${killedTimeout} killed-stale-heartbeat=${killedHeartbeat}`);

  if (!args.apply && (deadCleaned + killedTimeout + killedHeartbeat) > 0) {
    console.log(`[watchdog] re-run with --apply to actually reap (${deadCleaned + killedTimeout + killedHeartbeat} action${(deadCleaned + killedTimeout + killedHeartbeat) === 1 ? '' : 's'} pending)`);
  }
}

try { main(); }
catch (e) {
  console.error(`[watchdog] error: ${(e as Error).message}`);
  process.exit(1);
}
