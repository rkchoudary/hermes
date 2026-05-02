#!/usr/bin/env node
/**
 * pnpm auto:merge-gate <task-id> [--apply] [--json]
 *
 * PUB-9 closure — policy-as-code merge gate. Evaluates the 10 merge-policy
 * rules against a TaskPack + its evidence dir and exits 0 (PASS) or 1 (BLOCK).
 *
 * Usage:
 *   pnpm auto:merge-gate TP-XXX            # console report
 *   pnpm auto:merge-gate TP-XXX --apply    # also write merge-gate.json
 *   pnpm auto:merge-gate TP-XXX --json     # machine-readable to stdout
 *
 * Wire-up (next tick): auto:land + auto:promote will call this gate as a
 * final pre-transition check. M2 auto:merge (currently deferred per Codex
 * SOTA-bar) becomes safe to build once this gate is wired.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTaskPack, evidenceDir } from '../lib/runState';
import { evaluateMergePolicy, defaultMergePolicy } from '../lib/mergePolicy';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();

interface Args {
  taskId: string;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { taskId: '', apply: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (positional.length < 1) throw new Error('Required: <task_id>');
  args.taskId = positional[0];
  return args;
}

function findRunForTask(taskId: string): string {
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) throw new Error(`No .agent-runs/`);
  for (const r of fs.readdirSync(runsDir)) {
    if (fs.existsSync(path.join(runsDir, r, 'tasks', `${taskId}.json`))) return r;
  }
  throw new Error(`Task ${taskId} not found`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRunForTask(args.taskId);
  const pack = readTaskPack(runId, args.taskId);
  const evDir = evidenceDir(runId, args.taskId);

  const result = evaluateMergePolicy(pack, evDir, HARNESS_ROOT, defaultMergePolicy());

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  }

  console.log(`Task: ${args.taskId} (run: ${runId})`);
  console.log(`Evaluated at: ${result.evaluated_at}`);
  console.log('');
  if (result.ok) {
    console.log(`✓ ${result.summary}`);
  } else {
    console.error(`✗ ${result.summary}`);
    console.error('');
    console.error(`Violations:`);
    for (const v of result.violations) {
      console.error(`  - [${v.rule}] ${v.reason}`);
      console.error(`      remediation: ${v.remediation}`);
    }
  }

  if (args.apply) {
    const outPath = path.join(evDir, 'merge-gate.json');
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log('');
    console.log(`✓ wrote ${outPath}`);
  }

  process.exit(result.ok ? 0 : 1);
}

main();
