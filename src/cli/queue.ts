#!/usr/bin/env node
/**
 * pnpm auto:queue — inspect / drain / dequeue the cross-task coordination queue.
 *
 * Usage:
 *   pnpm auto:queue                           # list queued entries
 *   pnpm auto:queue --drain                   # dry-run drain (which would unblock?)
 *   pnpm auto:queue --drain --apply           # actually unblock + remove drained entries
 *   pnpm auto:queue --dequeue TP-2026-04-28-001  # manually remove from queue (operator override)
 *   pnpm auto:queue --json
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listQueue, drainQueue, dequeue } from '../lib/taskQueue';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_queue = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_queue);
const HARNESS_ROOT = harnessRoot();

interface Args {
  drain: boolean;
  apply: boolean;
  json: boolean;
  dequeue_id?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { drain: false, apply: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--drain') a.drain = true;
    else if (x === '--apply') a.apply = true;
    else if (x === '--json') a.json = true;
    else if (x === '--dequeue' && i + 1 < argv.length) a.dequeue_id = argv[++i];
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.dequeue_id) {
    dequeue(HARNESS_ROOT, args.dequeue_id);
    if (!args.json) console.log(`[queue] dequeued ${args.dequeue_id}`);
    else console.log(JSON.stringify({ dequeued: args.dequeue_id }, null, 2));
    return;
  }

  if (args.drain) {
    const results = drainQueue(HARNESS_ROOT, { apply: args.apply });
    if (args.json) {
      console.log(JSON.stringify({ apply: args.apply, results }, null, 2));
      return;
    }
    const unblocked = results.filter((r) => r.unblocked);
    const stillBlocked = results.filter((r) => !r.unblocked);
    console.log(`[queue drain] apply=${args.apply}  total=${results.length}  unblocked=${unblocked.length}  still-blocked=${stillBlocked.length}`);
    for (const r of unblocked) {
      console.log(`  ✓ ${r.task_id} — was behind ${r.before_blocked_by.join(', ')}; now unblocked${args.apply ? ' (removed)' : ' (dry-run)'}`);
    }
    for (const r of stillBlocked) {
      console.log(`  ⏳ ${r.task_id} — ${r.reason}`);
    }
    return;
  }

  const queue = listQueue(HARNESS_ROOT);
  if (args.json) { console.log(JSON.stringify(queue, null, 2)); return; }
  if (queue.length === 0) { console.log('[queue] (empty)'); return; }
  console.log(`[queue] ${queue.length} entr${queue.length === 1 ? 'y' : 'ies'}:`);
  for (const e of queue) {
    console.log(`  ${e.task_id}  (run=${e.run_id})  queued=${e.queued_at}`);
    console.log(`    blocked-by: ${e.blocked_by.join(', ')}`);
    console.log(`    reason: ${e.reason}`);
    if (e.blocked_paths.length > 0) {
      console.log(`    overlapping paths (first 3):`);
      for (const p of e.blocked_paths.slice(0, 3)) {
        console.log(`      ours=${p.ours} ↔ ${p.theirs_task}:${p.theirs_path}`);
      }
    }
  }
}

try { main(); }
catch (e) {
  console.error(`[queue] error: ${(e as Error).message}`);
  process.exit(1);
}
