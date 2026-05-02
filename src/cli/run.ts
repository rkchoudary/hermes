#!/usr/bin/env node
/**
 * pnpm auto:run TP-… [--max-iterations N] [--dry-run]
 *
 * Composite per-task lifecycle command (Codex tier-plan first-sprint scope).
 * Replaces the manual chain `auto:work TP-X → auto:consensus TP-X → auto:promote TP-X`
 * with a single command that loops applyRubric() decisions until the task
 * reaches a terminal state (merged | ready-for-merge | abandoned) OR a
 * configured max iteration count.
 *
 * Each iteration:
 *   1. Read the latest TaskPack
 *   2. applyRubric(pack) → RubricDecision
 *   3. Map action.kind → child CLI invocation (auto:work | auto:consensus |
 *      auto:promote | auto:escalate)
 *   4. Wait for child to complete; refresh pack
 *   5. If state changed: continue; else break (avoid loops on terminal-idle states)
 *
 * Honors:
 *   - existing CAS locks (each child uses withTaskPackLock internally)
 *   - cost telemetry (each dispatch records into pack.cost_telemetry)
 *   - audit log (every transition + override audited as before)
 *   - kill switch (--apply checks _KILL_SWITCH file before each iteration)
 *
 * Per Codex bgxrqvh58: "Composite auto:run is independent and safe; ship it
 * in T1-lite. Equivalence property test should validate same final state vs
 * manual chain on N fixtures."
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { applyRubric } from '../lib/decisionRubric';
import { getLogger, withContext } from '../lib/logger';
import type { TaskPack } from '../lib/taskPack';

const __filename = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(__filename), '..', '..');
const HARNESS_ROOT = harnessRoot();
const log = getLogger('cli:run');

interface Args {
  taskId: string;
  maxIterations: number;
  dryRun: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let taskId = '';
  let maxIterations = 10;
  let dryRun = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (a === '--max-iterations' && i + 1 < argv.length) maxIterations = parseInt(argv[++i], 10);
    else if (!a.startsWith('--') && !taskId) taskId = a;
  }
  if (!taskId) {
    console.error('usage: pnpm auto:run <TP-…> [--max-iterations N] [--dry-run]');
    process.exit(64);
  }
  return { taskId, maxIterations, dryRun, verbose };
}

function findRun(taskId: string): string | null {
  for (const runId of listRuns()) {
    if (listTasks(runId).includes(taskId)) return runId;
  }
  return null;
}

function isTerminal(state: TaskPack['state']): boolean {
  return state === 'merged' || state === 'ready-for-merge' || state === 'abandoned';
}

function invokeChild(scriptName: string, taskArgs: string[], dryRun: boolean): { exit: number; ms: number } {
  const start = Date.now();
  if (dryRun) {
    console.log(`  [dry-run] would invoke: pnpm ${scriptName} ${taskArgs.join(' ')}`);
    return { exit: 0, ms: 0 };
  }
  const r = spawnSync('pnpm', ['--silent', '--dir', PACKAGE_ROOT, scriptName, ...taskArgs], {
    cwd: PACKAGE_ROOT,
    stdio: 'inherit',
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,  // 30-minute hard cap per child invocation
  });
  return { exit: r.status ?? -1, ms: Date.now() - start };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRun(args.taskId);
  if (!runId) {
    console.error(`task ${args.taskId} not found in any run`);
    process.exit(2);
  }
  log.info('starting composite run', { task_id: args.taskId, run_id: runId, max_iterations: args.maxIterations });

  const startedAt = Date.now();
  const initialState = readTaskPack(runId, args.taskId).state;
  console.log(`══════════════════════════════════════════════════════════════════════════`);
  console.log(`  auto:run ${args.taskId}  (initial state: ${initialState})`);
  console.log(`══════════════════════════════════════════════════════════════════════════`);

  let lastState: TaskPack['state'] = initialState;
  let lastIdleReason = '';
  let consecutiveIdle = 0;
  let iterations = 0;

  await withContext({ task_id: args.taskId, run_id: runId }, async () => {
    for (; iterations < args.maxIterations; iterations++) {
      const pack = readTaskPack(runId, args.taskId);
      if (isTerminal(pack.state)) {
        console.log(`\n[iter ${iterations}] state=${pack.state} (TERMINAL); composite run done.`);
        break;
      }
      const decision = applyRubric(pack);
      console.log(`\n[iter ${iterations}] state=${pack.state} → action=${decision.action.kind}: ${decision.action.reason}`);

      let result: { exit: number; ms: number } = { exit: 0, ms: 0 };
      switch (decision.action.kind) {
        case 'dispatch-worker-fresh':
        case 'dispatch-worker-revise':
          result = invokeChild('auto:work', [args.taskId, '--force'], args.dryRun);
          break;
        case 'dispatch-consensus':
          result = invokeChild('auto:consensus', [args.taskId, '--gate', 'completion', '--apply'], args.dryRun);
          break;
        case 'auto-promote':
          result = invokeChild('auto:promote', [args.taskId], args.dryRun);
          break;
        case 'plateau-pivot': {
          const strat = decision.action.strategy;
          if (strat === 'human-escalate') {
            console.log(`  [composite] human-escalate strategy reached; stopping autonomous loop`);
            iterations = args.maxIterations;
            break;
          }
          // For other pivot strategies, dispatch worker with the strategy
          // flag; auto:work will read and apply it.
          result = invokeChild('auto:work', [args.taskId, '--force', '--pivot-strategy', strat], args.dryRun);
          break;
        }
        case 'escalate':
          console.log(`  [composite] escalate; stopping autonomous loop`);
          iterations = args.maxIterations;
          break;
        case 'idle':
        case 'skip-task':
          // Idle/skip means nothing to do this iteration. Break out unless
          // the state is changing under us (concurrent dispatch elsewhere).
          consecutiveIdle += 1;
          if (decision.action.reason !== lastIdleReason) {
            lastIdleReason = decision.action.reason;
          }
          if (consecutiveIdle >= 3) {
            console.log(`  [composite] 3 consecutive idle iterations; breaking out (likely awaiting external action)`);
            iterations = args.maxIterations;
            break;
          }
          // Sleep briefly before next iteration in case state is changing.
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        default:
          console.log(`  [composite] unhandled action kind '${(decision.action as { kind: string }).kind}'; stopping`);
          iterations = args.maxIterations;
          break;
      }

      if (result.exit !== 0) {
        console.error(`  [composite] child invocation failed (exit ${result.exit}); stopping`);
        process.exit(result.exit);
      }

      // If state didn't move, count as idle iteration
      const after = readTaskPack(runId, args.taskId);
      if (after.state === lastState) {
        consecutiveIdle += 1;
      } else {
        consecutiveIdle = 0;
      }
      lastState = after.state;
    }
  });

  const final = readTaskPack(runId, args.taskId);
  const totalMs = Date.now() - startedAt;
  console.log(`\n══════════════════════════════════════════════════════════════════════════`);
  console.log(`  Composite run summary`);
  console.log(`══════════════════════════════════════════════════════════════════════════`);
  console.log(`  Initial state:  ${initialState}`);
  console.log(`  Final state:    ${final.state}`);
  console.log(`  Iterations:     ${iterations}`);
  console.log(`  Wallclock:      ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  Codex score:    ${final.codex?.score ?? 'n/a'} (${final.codex?.verdict ?? '-'})`);
  if (isTerminal(final.state)) {
    console.log(`  Result: ✓ TERMINAL — task complete`);
  } else {
    console.log(`  Result: ⏸ STOPPED — manual action needed (see state)`);
  }
}

main().catch((e) => {
  console.error(`[auto:run] error: ${(e as Error).message}`);
  process.exit(1);
});
