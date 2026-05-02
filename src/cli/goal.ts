#!/usr/bin/env node
/**
 * pnpm auto:goal — operator-facing CLI for managing the goal contract (LRA-5).
 *
 * Subcommands:
 *   pnpm auto:goal init               # bootstrap default project goal
 *   pnpm auto:goal status [--json]    # show current per-criterion evaluation
 *   pnpm auto:goal show               # print goal.json
 *   pnpm auto:goal override --criterion <id> --reason "<reason>"
 *                                     # operator emergency override; recorded w/ reason+at+by
 *   pnpm auto:goal complete --criterion <id>
 *                                     # mark a manual-type criterion complete
 *   pnpm auto:goal clear-override --criterion <id>
 *                                     # remove a previous override
 *
 * Closes Phase 1 mandate: operator can interact with the goal contract; not
 * just see it scroll past in tick output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessRoot } from '../lib/harnessRoot';
import {
  readGoal,
  writeGoal,
  evaluateGoal,
  defaultGoal,
  goalPath,
  buildGoalSnapshot,
  type GoalContract,
  type RunStateSnapshot,
} from '../lib/goal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();
const RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');

function parseArgs(argv: string[]): {
  cmd: string;
  json: boolean;
  criterion?: string;
  reason?: string;
} {
  const cmd = argv[0] ?? 'status';
  let json = false;
  let criterion: string | undefined;
  let reason: string | undefined;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--criterion' && i + 1 < argv.length) criterion = argv[++i];
    else if (a === '--reason' && i + 1 < argv.length) reason = argv[++i];
  }
  return { cmd, json, criterion, reason };
}

function buildSnapshot(): RunStateSnapshot {
  // Codex R4 fix: delegate to centralized buildGoalSnapshot helper.
  const packageRoot = path.resolve(__dirname, '..', '..');
  return buildGoalSnapshot(HARNESS_ROOT, packageRoot);
}

function cmdInit(): void {
  const existing = readGoal(HARNESS_ROOT);
  if (existing) {
    console.error(`Goal already exists at ${goalPath(HARNESS_ROOT)}`);
    console.error(`Use 'pnpm auto:goal show' to inspect, or remove the file to re-init.`);
    process.exit(2);
  }
  const goal = defaultGoal();
  writeGoal(HARNESS_ROOT, goal);
  console.log(`✓ initialized goal at ${goalPath(HARNESS_ROOT)}`);
  console.log(`  goal_id: ${goal.goal_id}`);
  console.log(`  criteria: ${goal.completion_criteria.length}`);
  for (const c of goal.completion_criteria) {
    console.log(`    - ${c.id}: ${c.description} (target: ${c.target})`);
  }
}

function cmdStatus(json: boolean): void {
  const goal = readGoal(HARNESS_ROOT);
  if (!goal) {
    if (json) {
      console.log(JSON.stringify({ exists: false, hint: "run 'pnpm auto:goal init'" }, null, 2));
    } else {
      console.error(`No goal contract found. Run 'pnpm auto:goal init' to bootstrap.`);
    }
    process.exit(1);
  }
  const snapshot = buildSnapshot();
  const e = evaluateGoal(goal, snapshot);

  if (json) {
    console.log(JSON.stringify(e, null, 2));
    return;
  }

  console.log(`Goal: ${goal.name} (${goal.goal_id})`);
  console.log(`Status: ${e.complete ? '🎉 MISSION COMPLETE' : 'in progress'}`);
  console.log(`Criteria met: ${e.criteria_met}/${e.total_criteria}` + (e.criteria_overridden > 0 ? `  (${e.criteria_overridden} via operator override)` : ''));
  console.log('');
  console.log('Per-criterion:');
  for (const c of e.per_criterion) {
    const mark = c.met ? '✓' : c.override_active ? '⚠' : ' ';
    const tag = c.override_active ? ` [OVERRIDE: ${c.override_reason}]` : '';
    console.log(`  ${mark} ${c.id}: ${c.current}/${c.target}${tag}`);
  }
}

function cmdShow(): void {
  const p = goalPath(HARNESS_ROOT);
  if (!fs.existsSync(p)) {
    console.error(`No goal contract at ${p}`);
    process.exit(1);
  }
  console.log(fs.readFileSync(p, 'utf8'));
}

function cmdOverride(criterion: string, reason: string): void {
  if (!reason) {
    console.error(`--reason is required for override (operator must justify in writing for audit)`);
    process.exit(2);
  }
  const goal = readGoal(HARNESS_ROOT);
  if (!goal) {
    console.error(`No goal contract. Run 'pnpm auto:goal init' first.`);
    process.exit(1);
  }
  const exists = goal.completion_criteria.find((c) => c.id === criterion);
  if (!exists) {
    console.error(`Criterion not found: ${criterion}`);
    console.error(`Valid: ${goal.completion_criteria.map((c) => c.id).join(', ')}`);
    process.exit(2);
  }
  // Remove any existing override on this criterion (re-override replaces)
  goal.operator_overrides = goal.operator_overrides.filter((o) => o.criterion_id !== criterion);
  goal.operator_overrides.push({
    criterion_id: criterion,
    reason,
    at: new Date().toISOString(),
    by: process.env.USER || process.env.LOGNAME || 'operator',
  });
  writeGoal(HARNESS_ROOT, goal);
  console.log(`✓ override recorded for ${criterion}: ${reason}`);
}

function cmdComplete(criterion: string): void {
  const goal = readGoal(HARNESS_ROOT);
  if (!goal) {
    console.error(`No goal contract. Run 'pnpm auto:goal init' first.`);
    process.exit(1);
  }
  const c = goal.completion_criteria.find((x) => x.id === criterion);
  if (!c) {
    console.error(`Criterion not found: ${criterion}`);
    process.exit(2);
  }
  if (c.predicate_type !== 'manual') {
    console.error(`Criterion '${criterion}' is type '${c.predicate_type}' — not manual.`);
    console.error(`Use 'pnpm auto:goal override --criterion ${criterion} --reason "..."' instead.`);
    process.exit(2);
  }
  c.current = c.target;
  c.last_evaluated_at = new Date().toISOString();
  writeGoal(HARNESS_ROOT, goal);
  console.log(`✓ marked manual criterion '${criterion}' as complete`);
}

function cmdClearOverride(criterion: string): void {
  const goal = readGoal(HARNESS_ROOT);
  if (!goal) {
    console.error(`No goal contract. Run 'pnpm auto:goal init' first.`);
    process.exit(1);
  }
  const before = goal.operator_overrides.length;
  goal.operator_overrides = goal.operator_overrides.filter((o) => o.criterion_id !== criterion);
  if (goal.operator_overrides.length === before) {
    console.error(`No override on '${criterion}' to clear.`);
    process.exit(2);
  }
  writeGoal(HARNESS_ROOT, goal);
  console.log(`✓ cleared override on ${criterion}`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case 'init':
      cmdInit();
      break;
    case 'status':
      cmdStatus(args.json);
      break;
    case 'show':
      cmdShow();
      break;
    case 'override':
      if (!args.criterion) {
        console.error(`--criterion required`);
        process.exit(2);
      }
      cmdOverride(args.criterion, args.reason ?? '');
      break;
    case 'complete':
      if (!args.criterion) {
        console.error(`--criterion required`);
        process.exit(2);
      }
      cmdComplete(args.criterion);
      break;
    case 'clear-override':
      if (!args.criterion) {
        console.error(`--criterion required`);
        process.exit(2);
      }
      cmdClearOverride(args.criterion);
      break;
    default:
      console.error(`Unknown command: ${args.cmd}`);
      console.error(`Usage: pnpm auto:goal {init|status|show|override|complete|clear-override} [args]`);
      process.exit(2);
  }
}

main();
