#!/usr/bin/env node
/**
 * pnpm auto:interrupt <task_id> [--reason "..."]
 *
 * Signals a soft-stop to a single in-flight worker. Cleaner than
 * `_KILL_SWITCH` (which halts ALL dispatch globally) — this targets one
 * task and lets sibling work continue.
 *
 * Mechanism: writes `.agent-runs/<run>/_interrupt-<task_id>.json` with
 * { at, by, reason }. Workers check this file at iteration boundaries
 * (post-flight, between patch rounds, between cognitive-recovery phases)
 * and exit cleanly with a documented "interrupted" state — preserves the
 * audit trail for the work done so far.
 *
 * Usage:
 *   pnpm auto:interrupt TP-2026-05-02-001
 *   pnpm auto:interrupt TP-2026-05-02-001 --reason "scope changed"
 *   pnpm auto:interrupt --list                 # show in-flight tasks
 *   pnpm auto:interrupt --clear TP-...         # rescind an interrupt
 *
 * Resumption: `pnpm auto:work TP-... --force` after clearing the interrupt.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { harnessRoot } from '../lib/harnessRoot';
import { appendOverrideAudit } from '../lib/overrideAudit';

interface CliArgs { taskId?: string; reason: string; list: boolean; clear?: string; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { reason: 'operator interrupt', list: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--list') a.list = true;
    else if (x === '--clear' && i + 1 < argv.length) a.clear = argv[++i];
    else if (x === '--reason' && i + 1 < argv.length) a.reason = argv[++i];
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:interrupt <task_id> [--reason "..."]

Signal a soft-stop to a single in-flight worker. Targeted alternative to
the global _KILL_SWITCH.

  --list           Show in-flight tasks (interruptable)
  --clear <id>     Rescind an existing interrupt (allows resume)
  --reason "..."   Reason recorded in audit log (default: "operator interrupt")
`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.taskId) a.taskId = x;
  }
  return a;
}

function findRunsRoot(): string {
  return path.join(harnessRoot(), '.agent-runs');
}

function findTaskFile(taskId: string): { runId: string; pack: string; runDir: string } | null {
  const runsRoot = findRunsRoot();
  if (!fs.existsSync(runsRoot)) return null;
  for (const runId of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(runId)) continue;
    const pack = path.join(runsRoot, runId, 'tasks', `${taskId}.json`);
    if (fs.existsSync(pack)) {
      return { runId, pack, runDir: path.join(runsRoot, runId) };
    }
  }
  return null;
}

function listInflight(): void {
  const runsRoot = findRunsRoot();
  if (!fs.existsSync(runsRoot)) {
    console.log('No .agent-runs/ directory yet.');
    return;
  }
  const runs = fs.readdirSync(runsRoot).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latestRun = runs[runs.length - 1];
  if (!latestRun) {
    console.log('No runs found.');
    return;
  }
  const tasksDir = path.join(runsRoot, latestRun, 'tasks');
  if (!fs.existsSync(tasksDir)) {
    console.log(`No tasks in run ${latestRun}.`);
    return;
  }
  const interruptableStates = new Set(['claimed', 'in-progress', 'codex-reviewing']);
  const rows: Array<{ id: string; state: string; locked: string; interrupted: string }> = [];
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const pack = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
      const interruptFile = path.join(runsRoot, latestRun, `_interrupt-${pack.task_id}.json`);
      if (interruptableStates.has(pack.state)) {
        rows.push({
          id: pack.task_id,
          state: pack.state,
          locked: pack.lock?.held_by ? 'yes' : 'no',
          interrupted: fs.existsSync(interruptFile) ? 'YES' : '',
        });
      }
    } catch { /* skip */ }
  }
  if (rows.length === 0) {
    console.log(`No interruptable tasks in run ${latestRun}.`);
    return;
  }
  console.log(`Run: ${latestRun}\n`);
  console.log('TASK_ID                       STATE             LOCKED  INTERRUPTED');
  console.log('───────────────────────────── ───────────────── ─────── ───────────');
  for (const r of rows) {
    console.log(`${r.id.padEnd(30)}${r.state.padEnd(18)}${r.locked.padEnd(8)}${r.interrupted}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    listInflight();
    return;
  }

  if (args.clear) {
    const found = findTaskFile(args.clear);
    if (!found) {
      console.error(`Task ${args.clear} not found in any run.`);
      process.exit(1);
    }
    const interruptFile = path.join(found.runDir, `_interrupt-${args.clear}.json`);
    if (fs.existsSync(interruptFile)) {
      fs.rmSync(interruptFile);
      console.log(`✓ Cleared interrupt for ${args.clear}.`);
      console.log(`  Resume with: pnpm auto:work ${args.clear} --force`);
    } else {
      console.log(`No active interrupt for ${args.clear}.`);
    }
    return;
  }

  if (!args.taskId) {
    console.error('Usage: pnpm auto:interrupt <task_id> [--reason "..."]');
    console.error('       pnpm auto:interrupt --list');
    process.exit(2);
  }

  const found = findTaskFile(args.taskId);
  if (!found) {
    console.error(`Task ${args.taskId} not found in any run under ${findRunsRoot()}.`);
    process.exit(1);
  }

  const interruptFile = path.join(found.runDir, `_interrupt-${args.taskId}.json`);
  if (fs.existsSync(interruptFile)) {
    console.error(`Interrupt sentinel already exists for ${args.taskId}.`);
    console.error(`  ${interruptFile}`);
    console.error(`  Use --clear ${args.taskId} to rescind first if you want to update the reason.`);
    process.exit(1);
  }

  const operator = process.env.HERMES_OPERATOR || os.userInfo().username || 'unknown';
  const payload = {
    task_id: args.taskId,
    run_id: found.runId,
    at: new Date().toISOString(),
    by: operator,
    pid: process.pid,
    host: os.hostname(),
    reason: args.reason,
  };
  fs.writeFileSync(interruptFile, JSON.stringify(payload, null, 2));

  // Mirror to the chain-hashed override audit log so the interrupt is
  // immutably recorded across all runs.
  appendOverrideAudit(harnessRoot(), {
    schema_version: '1',
    at: payload.at,
    actor: {
      name: operator,
      source: process.env.HERMES_OPERATOR ? 'env-override' : 'os-user',
      captured_at: payload.at,
    },
    kind: 'interrupt-task',
    reason: args.reason,
    task_id: args.taskId,
    run_id: found.runId,
    context: { interrupt_file: interruptFile },
    pid: process.pid,
    host: os.hostname(),
  });

  console.log(`✓ Interrupt sentinel written: ${interruptFile}`);
  console.log(`  Worker will exit cleanly at the next iteration boundary`);
  console.log(`  (post-flight, patch round, cognitive-recovery phase).`);
  console.log('');
  console.log(`  To resume:   pnpm auto:interrupt --clear ${args.taskId}`);
  console.log(`               pnpm auto:work ${args.taskId} --force`);
}

main();
