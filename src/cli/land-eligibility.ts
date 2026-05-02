#!/usr/bin/env node
/**
 * pnpm auto:land-eligibility TP-… [--branch <name>] [--pr <num>] [--auto-land] [--apply] [--json]
 *
 * Auto-land eligibility report (Codex T4 prescription bnl3rpgha):
 * "Auto-land should create a merge event with immutable evidence, not just
 * perform the merge. I would ship an 'auto-land eligibility report' or
 * dry-run first, then the actual merge action behind env flag if time
 * remains."
 *
 * This command:
 *   1. Reads the task pack
 *   2. Evaluates 10 auto-land predicates over immutable evidence
 *   3. Emits a structured "would land / would not land" decision
 *   4. Generates the suggested gh pr merge command + revert command (recorded
 *      for reproducibility; NOT executed unless --apply + AUTO_AUTO_LAND_APPLY=1
 *      AND policy.real_merge_enabled=true)
 *
 * v1 ships report-only by default. The actual merge invocation is gated
 * behind THREE distinct opt-ins (per-task policy + env + CLI flag) so the
 * operator must explicitly authorize at every layer.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { evaluateAutoLand } from '../lib/autoLand';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();
void HARNESS_ROOT;

interface Args {
  taskId: string;
  branch?: string;
  prNumber?: number;
  autoLand: boolean;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let taskId = '';
  let branch: string | undefined;
  let prNumber: number | undefined;
  let autoLand = process.env.AUTO_AUTO_LAND === '1' || process.env.AUTO_AUTO_LAND === 'true';
  let apply = process.env.AUTO_AUTO_LAND_APPLY === '1' || process.env.AUTO_AUTO_LAND_APPLY === 'true';
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--auto-land') autoLand = true;
    else if (a === '--apply') apply = true;
    else if (a === '--branch' && i + 1 < argv.length) branch = argv[++i];
    else if (a === '--pr' && i + 1 < argv.length) prNumber = parseInt(argv[++i], 10);
    else if (!a.startsWith('--') && !taskId) taskId = a;
  }
  if (!taskId) {
    console.error('usage: pnpm auto:land-eligibility <TP-…> [--branch <name>] [--pr <num>] [--auto-land] [--apply] [--json]');
    process.exit(64);
  }
  return { taskId, branch, prNumber, autoLand, apply, json };
}

function findRun(taskId: string): string | null {
  for (const runId of listRuns()) {
    if (listTasks(runId).includes(taskId)) return runId;
  }
  return null;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRun(args.taskId);
  if (!runId) {
    console.error(`task ${args.taskId} not found in any run`);
    process.exit(2);
  }
  const pack = readTaskPack(runId, args.taskId);
  const verdict = evaluateAutoLand(pack, {
    globalOptIn: args.autoLand,
    applyAuthorization: args.apply,
    targetBranch: args.branch,
    prNumber: args.prNumber,
    runId,
  });

  if (args.json) {
    console.log(JSON.stringify(verdict, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:land-eligibility  ${args.taskId}`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Result:    ${verdict.eligible ? '✓ ELIGIBLE' : '✗ NOT ELIGIBLE'}`);
  console.log(`Summary:   ${verdict.summary}`);
  console.log('');
  console.log('Predicates:');
  for (const p of verdict.predicates) {
    const icon = p.passed ? '✓' : '✗';
    console.log(`  ${icon} ${p.name.padEnd(36)} ${p.reason}`);
  }
  if (verdict.eligible) {
    console.log('');
    console.log('Suggested commands (NOT executed by this tool):');
    if (verdict.suggested_merge_command) console.log(`  Merge:  ${verdict.suggested_merge_command}`);
    if (verdict.generated_revert_command) console.log(`  Revert: ${verdict.generated_revert_command}`);
  }
  console.log('');
  if (!verdict.real_merge_authorized) {
    console.log('Real merge NOT authorized. To enable:');
    console.log('  1. Set pack.auto_land_policy.real_merge_enabled = true');
    console.log('  2. Pass --apply OR set AUTO_AUTO_LAND_APPLY=1');
    console.log('  3. Pass --auto-land OR set AUTO_AUTO_LAND=1');
    console.log('  All THREE required (Codex prescription: triple opt-in).');
  } else {
    console.log('⚠ REAL MERGE AUTHORIZED. Operator must run the suggested merge command manually.');
    console.log('  v1 does not auto-execute merge — that requires Wave-B integration with gh CLI.');
  }
}

main();
