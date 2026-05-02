#!/usr/bin/env node
/**
 * pnpm auto:steer <task_id> "<directive>"
 *
 * Conversational steering — write a directive the in-flight worker reads
 * at its next iteration boundary. Mirrors the "no, use Postgres not MySQL"
 * mid-task correction pattern from Cursor / Devin without abandoning the
 * task pack contract.
 *
 * Mechanism:
 *   - Writes .agent-runs/<run>/_steering-<task_id>.jsonl (append-only).
 *   - Each entry carries timestamp + operator + directive text + ttl_rounds.
 *   - Worker prepends ALL unconsumed steering directives to its next
 *     dispatch prompt under a "PRIORITY OPERATOR DIRECTIVES" header.
 *   - After consumption, entries are marked consumed=true (not deleted —
 *     audit trail).
 *
 * Why JSONL append-only: multiple operators can stack directives, audit
 * sees full history, no race on overwrite.
 *
 * Usage:
 *   pnpm auto:steer TP-2026-05-02-001 "Use Postgres, not MySQL"
 *   pnpm auto:steer TP-2026-05-02-001 "Skip the migration test for now" --ttl 1
 *   pnpm auto:steer TP-2026-05-02-001 --list
 *   pnpm auto:steer TP-2026-05-02-001 --clear     # rescind all unconsumed
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { harnessRoot } from '../lib/harnessRoot';
import { appendOverrideAudit } from '../lib/overrideAudit';

interface CliArgs { taskId?: string; directive?: string; ttl: number; list: boolean; clear: boolean; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { ttl: 99, list: false, clear: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--list') a.list = true;
    else if (x === '--clear') a.clear = true;
    else if (x === '--ttl' && i + 1 < argv.length) a.ttl = parseInt(argv[++i], 10) || 99;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:steer <task_id> "<directive>"

Send a priority directive to a running worker. The worker reads pending
directives at iteration boundaries and prepends them to its prompt under
a "PRIORITY OPERATOR DIRECTIVES" header.

  --ttl <N>   Apply for next N iterations only (default 99 = always-on)
  --list      Show pending + consumed directives for this task
  --clear     Rescind all unconsumed directives (consumed=true)

Examples:
  pnpm auto:steer TP-... "Use Postgres, not MySQL"
  pnpm auto:steer TP-... "Drop the e2e test on /admin for this round" --ttl 1
  pnpm auto:steer TP-... --list
`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.taskId) a.taskId = x;
    else if (!x.startsWith('-') && !a.directive) a.directive = x;
  }
  return a;
}

interface SteeringEntry {
  at: string;
  by: string;
  pid: number;
  host: string;
  directive: string;
  ttl_rounds: number;
  consumed_at?: string;
  consumed_in_round?: number;
}

function findTaskRun(taskId: string): { runId: string; runDir: string } | null {
  const runsRoot = path.join(harnessRoot(), '.agent-runs');
  if (!fs.existsSync(runsRoot)) return null;
  for (const r of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r)) continue;
    const p = path.join(runsRoot, r, 'tasks', `${taskId}.json`);
    if (fs.existsSync(p)) return { runId: r, runDir: path.join(runsRoot, r) };
  }
  return null;
}

function steeringPath(runDir: string, taskId: string): string {
  return path.join(runDir, `_steering-${taskId}.jsonl`);
}

function readEntries(steeringFile: string): SteeringEntry[] {
  if (!fs.existsSync(steeringFile)) return [];
  const out: SteeringEntry[] = [];
  for (const line of fs.readFileSync(steeringFile, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId) {
    console.error('Usage: pnpm auto:steer <task_id> "<directive>"');
    console.error('       pnpm auto:steer <task_id> --list');
    process.exit(2);
  }

  const found = findTaskRun(args.taskId);
  if (!found) {
    console.error(`Task ${args.taskId} not found.`);
    process.exit(1);
  }
  const steeringFile = steeringPath(found.runDir, args.taskId);

  if (args.list) {
    const entries = readEntries(steeringFile);
    if (entries.length === 0) {
      console.log(`No steering directives for ${args.taskId}.`);
      return;
    }
    console.log(`Steering history for ${args.taskId}:\n`);
    for (const e of entries) {
      const status = e.consumed_at ? `consumed @ R${e.consumed_in_round} (${e.consumed_at})` : 'pending';
      console.log(`  ${e.at}  by ${e.by}  ttl=${e.ttl_rounds}  [${status}]`);
      console.log(`    "${e.directive}"`);
    }
    return;
  }

  if (args.clear) {
    const entries = readEntries(steeringFile);
    const now = new Date().toISOString();
    const updated = entries.map(e => e.consumed_at ? e : { ...e, consumed_at: now, consumed_in_round: -1 });
    fs.writeFileSync(steeringFile, updated.map(e => JSON.stringify(e)).join('\n') + (updated.length ? '\n' : ''));
    const cleared = entries.filter(e => !e.consumed_at).length;
    console.log(`✓ Cleared ${cleared} pending directive(s) for ${args.taskId}.`);
    return;
  }

  if (!args.directive) {
    console.error('Directive text is required as the second positional arg, OR use --list / --clear.');
    process.exit(2);
  }

  const operator = process.env.HERMES_OPERATOR || os.userInfo().username || 'unknown';
  const entry: SteeringEntry = {
    at: new Date().toISOString(),
    by: operator,
    pid: process.pid,
    host: os.hostname(),
    directive: args.directive,
    ttl_rounds: args.ttl,
  };
  fs.appendFileSync(steeringFile, JSON.stringify(entry) + '\n');

  // Mirror to override audit so steering is part of the chain-hashed record.
  appendOverrideAudit(harnessRoot(), {
    schema_version: '1',
    at: entry.at,
    actor: {
      name: operator,
      source: process.env.HERMES_OPERATOR ? 'env-override' : 'os-user',
      captured_at: entry.at,
    },
    kind: 'steer-task',
    reason: `steer: ${args.directive.slice(0, 200)}`,
    task_id: args.taskId,
    run_id: found.runId,
    context: { directive: args.directive, ttl_rounds: args.ttl },
    pid: process.pid,
    host: os.hostname(),
  });

  console.log(`✓ Steering directive recorded for ${args.taskId}.`);
  console.log(`  Worker will pick it up at the next iteration boundary.`);
  console.log(`  TTL: ${args.ttl === 99 ? 'always-on' : args.ttl + ' rounds'}`);
  console.log('');
  console.log(`  View history: pnpm auto:steer ${args.taskId} --list`);
  console.log(`  Rescind:      pnpm auto:steer ${args.taskId} --clear`);
}

main();
