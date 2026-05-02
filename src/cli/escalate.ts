#!/usr/bin/env node
/**
 * pnpm auto:escalate — operator-facing escalation control (M10 / LRA-6).
 *
 * Subcommands:
 *   pnpm auto:escalate trigger --reason "<reason>" [--task <task-id>]
 *     Manually engage escalation (kill switch + log entry + optional task pin)
 *
 *   pnpm auto:escalate status
 *     Show open (uncleared) escalations + the kill-switch file's state
 *
 *   pnpm auto:escalate clear --by "<operator-name>" [--note "<note>"]
 *     Operator clears the most recent open escalation + removes [escalation]
 *     marker from kill switch (if it was the only thing engaging it)
 *
 *   pnpm auto:escalate detect
 *     Run detection + show would-be-triggered escalations (dry-run preview)
 *     Useful to see what auto:tick would auto-escalate next.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessRoot } from '../lib/harnessRoot';
import {
  appendEscalation,
  readEscalationLog,
  detectEscalations,
  engageEscalation,
  isDuplicateEscalation,
  escalationLogPath,
  DEFAULT_DETECTION,
  type EscalationReason,
  type EscalationEntry,
} from '../lib/escalation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();
const RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');
const KILL_SWITCH_PATH = path.join(RUNS_DIR, '_KILL_SWITCH');

interface Args {
  cmd: string;
  reason?: string;
  task?: string;
  by?: string;
  note?: string;
}

function parseArgs(argv: string[]): Args {
  const cmd = argv[0] ?? 'status';
  const args: Args = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason' && i + 1 < argv.length) args.reason = argv[++i];
    else if (a === '--task' && i + 1 < argv.length) args.task = argv[++i];
    else if (a === '--by' && i + 1 < argv.length) args.by = argv[++i];
    else if (a === '--note' && i + 1 < argv.length) args.note = argv[++i];
  }
  return args;
}

function cmdTrigger(reason: string, task?: string): void {
  if (!reason) {
    console.error(`--reason is required (operator must justify in writing for audit)`);
    process.exit(2);
  }
  engageEscalation(HARNESS_ROOT, 'manual', reason, task);
  console.log(`✓ escalation triggered`);
  console.log(`  reason: manual — ${reason}`);
  if (task) console.log(`  task: ${task}`);
  console.log(`  kill switch: ENGAGED at ${KILL_SWITCH_PATH}`);
  console.log(`  log: ${escalationLogPath(HARNESS_ROOT)}`);
  console.log(``);
  console.log(`To resume: investigate the reason, then run:`);
  console.log(`  pnpm auto:escalate clear --by "<operator>" --note "<resolution>"`);
}

function cmdStatus(): void {
  const log = readEscalationLog(HARNESS_ROOT);
  const open = log.filter((e) => !e.cleared_at);
  const ksExists = fs.existsSync(KILL_SWITCH_PATH);
  let ksContent = '';
  if (ksExists) {
    try { ksContent = fs.readFileSync(KILL_SWITCH_PATH, 'utf8').trim(); } catch { /* ignore */ }
  }

  console.log(`Kill switch: ${ksExists ? 'ENGAGED' : 'released'}`);
  if (ksExists && ksContent) console.log(`  reason: ${ksContent.slice(0, 200)}`);
  console.log(``);

  console.log(`Open escalations: ${open.length} (total log entries: ${log.length})`);
  for (const e of open) {
    console.log(`  • ${e.at} [${e.reason}] ${e.task_id ?? '(no task)'}`);
    console.log(`    ${e.detail.slice(0, 200)}`);
    if (e.detector.host) console.log(`    detector: ${e.detector.host} pid=${e.detector.pid}`);
  }
  if (open.length === 0) {
    console.log(`  (none)`);
  }
}

function cmdClear(by: string, note?: string): void {
  if (!by) {
    console.error(`--by is required (operator name for audit trail)`);
    process.exit(2);
  }
  const log = readEscalationLog(HARNESS_ROOT);
  const open = log.filter((e) => !e.cleared_at);
  if (open.length === 0) {
    console.log(`No open escalations to clear.`);
    return;
  }
  // Mark all open entries as cleared (rewrite log; append-only-ish is OK since we own it)
  const now = new Date().toISOString();
  const cleared = log.map((e) => {
    if (!e.cleared_at) {
      return { ...e, cleared_by: by, cleared_at: now };
    }
    return e;
  });
  fs.writeFileSync(escalationLogPath(HARNESS_ROOT), cleared.map((e) => JSON.stringify(e)).join('\n') + '\n');

  // Append a "cleared" record for full audit trail
  appendEscalation(HARNESS_ROOT, {
    at: now,
    reason: 'manual',
    detail: `cleared ${open.length} open escalation(s) by ${by}${note ? `: ${note}` : ''}`,
    detector: {},
    cleared_by: by,
    cleared_at: now,
  });

  // Remove kill switch IF it was engaged by escalation (marker prefix)
  if (fs.existsSync(KILL_SWITCH_PATH)) {
    try {
      const body = fs.readFileSync(KILL_SWITCH_PATH, 'utf8');
      if (body.startsWith('[escalation]')) {
        fs.rmSync(KILL_SWITCH_PATH);
        console.log(`✓ removed [escalation] kill switch`);
      } else {
        console.warn(`⚠ kill switch not removed — file does not have [escalation] marker (was engaged by ${body.slice(0, 30)}...)`);
        console.warn(`   Run 'pnpm auto:kill-off' separately if you want to release a non-escalation kill switch.`);
      }
    } catch (e) {
      console.warn(`⚠ failed to inspect kill switch: ${(e as Error).message}`);
    }
  }
  console.log(`✓ cleared ${open.length} open escalation(s); operator: ${by}${note ? ` (${note})` : ''}`);
}

function cmdDetect(): void {
  const detection = detectEscalations({
    ...DEFAULT_DETECTION,
    runs_dir: RUNS_DIR,
  });
  console.log(`Detection scan complete:`);
  console.log(`  Tasks scanned: ${Object.keys(detection.per_task_consecutive_nogo).length}`);
  console.log(`  Would-trigger: ${detection.triggered.length}`);
  for (const e of detection.triggered) {
    const dup = isDuplicateEscalation(HARNESS_ROOT, e);
    console.log(`  ${dup ? '(dedup' : '⚠ NEW'}) [${e.reason}] ${e.task_id ?? '(no task)'} — ${e.detail.slice(0, 200)})`);
  }
  if (detection.triggered.length === 0) {
    console.log(`  (none — no escalations needed)`);
  }
  // Surface per-task NO-GO counts where >0 for operator awareness
  const withNogo = Object.entries(detection.per_task_consecutive_nogo).filter(([, n]) => n > 0);
  if (withNogo.length > 0) {
    console.log(``);
    console.log(`Tasks with consecutive NO-GO transitions:`);
    for (const [tid, n] of withNogo) {
      console.log(`  ${tid}: ${n}`);
    }
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'trigger':
      if (!args.reason) {
        console.error(`--reason required for trigger`);
        process.exit(2);
      }
      cmdTrigger(args.reason, args.task);
      break;
    case 'status':
      cmdStatus();
      break;
    case 'clear':
      if (!args.by) {
        console.error(`--by required for clear`);
        process.exit(2);
      }
      cmdClear(args.by, args.note);
      break;
    case 'detect':
      cmdDetect();
      break;
    default:
      console.error(`Unknown command: ${args.cmd}`);
      console.error(`Usage: pnpm auto:escalate {trigger|status|clear|detect} [args]`);
      process.exit(2);
  }
}

main();
