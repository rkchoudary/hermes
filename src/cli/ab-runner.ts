#!/usr/bin/env node
/**
 * pnpm auto:ab-runner --a workflow-v1.yaml --b workflow-v2.yaml --task TP-...
 *
 * A/B workflow runner — empirically compare two workflow YAMLs against the
 * same task. Trains workflow design itself: "is the new patch-r3-skip
 * variant actually better than the 3-round default?"
 *
 * What it does:
 *   1. Take 2 workflow YAMLs (call them A and B) + 1 task ID.
 *   2. Snapshot the task pack and create two clones (TP-...-A, TP-...-B).
 *   3. Run yaml-runner on both, in parallel by default (--serial to force serial).
 *   4. Capture per-side: wall time, cost, final state, codex score, evidence
 *      sizes, council verdict, error messages.
 *   5. Diff the outcomes and emit a verdict: A wins / B wins / tie.
 *
 * Output: .agent-runs/_ab-results/<run_id>.json with full metrics + the
 * winner determination + reasoning.
 *
 * Why parallel by default: same wall-clock + same upstream state minimizes
 * confounders. --serial is only useful if both runs touch the same external
 * resource (single CI runner, single deploy slot, etc.).
 *
 * Caveat: an A/B is a single sample. For real workflow-design conclusions
 * you need many tasks. This CLI is the harness; statistical pooling is
 * yours (or future Hermes versions).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs {
  a?: string;
  b?: string;
  task?: string;
  serial: boolean;
  module?: string;
  version?: string;
  outFile?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { serial: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--a' && i + 1 < argv.length) a.a = argv[++i];
    else if (x === '--b' && i + 1 < argv.length) a.b = argv[++i];
    else if (x === '--task' && i + 1 < argv.length) a.task = argv[++i];
    else if (x === '--module' && i + 1 < argv.length) a.module = argv[++i];
    else if (x === '--version' && i + 1 < argv.length) a.version = argv[++i];
    else if (x === '--serial') a.serial = true;
    else if (x === '--out' && i + 1 < argv.length) a.outFile = argv[++i];
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:ab-runner --a <wf-A.yaml> --b <wf-B.yaml> --task <task_id>

Empirically compare two workflow YAMLs against one task. Outputs a JSON
report with per-side wall time / cost / verdict / evidence size, plus a
winner determination.

Required:
  --a <yaml>       Workflow A (e.g., workflows/code-sprint.yaml)
  --b <yaml>       Workflow B (e.g., workflows/code-sprint-v2.yaml)
  --task <id>      Existing task ID (will be cloned per-side)

Optional:
  --module ID      Module ID (defaults from task pack)
  --version V      Version target (defaults from task pack)
  --serial         Run sequentially instead of parallel (default parallel)
  --out PATH       Write report to PATH (default: .agent-runs/_ab-results/<run>.json)

Caveat: A/B is a single sample. Pool many tasks for real workflow conclusions.`);
      process.exit(0);
    }
  }
  return a;
}

interface SidedResult {
  side: 'A' | 'B';
  workflow: string;
  task_id: string;
  exit_code: number;
  wall_seconds: number;
  cost_usd: number;
  final_state: string;
  codex_score: number | null;
  codex_verdict: string | null;
  council_status: string;
  patch_rounds: number;
  evidence_count: number;
  stderr_tail: string;
}

function findRunForTask(taskId: string): { runId: string; tasksDir: string } | null {
  const runsRoot = path.join(harnessRoot(), '.agent-runs');
  if (!fs.existsSync(runsRoot)) return null;
  for (const r of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r)) continue;
    const p = path.join(runsRoot, r, 'tasks', `${taskId}.json`);
    if (fs.existsSync(p)) return { runId: r, tasksDir: path.join(runsRoot, r, 'tasks') };
  }
  return null;
}

function clonePack(srcTaskId: string, runDir: { runId: string; tasksDir: string }, suffix: 'A' | 'B'): string {
  const srcPath = path.join(runDir.tasksDir, `${srcTaskId}.json`);
  const pack = JSON.parse(fs.readFileSync(srcPath, 'utf8')) as Record<string, unknown>;
  const cloneId = `${srcTaskId}-${suffix}`;
  pack.task_id = cloneId;
  pack.state = 'planned';
  pack.state_history = [];
  pack.codex = undefined;
  pack.cost_telemetry = [];
  pack.lock = null;
  const evDir = `evidence/${cloneId}`;
  pack.evidence_dir = evDir;
  // Reset evidence_dir on disk
  const evAbs = path.join(harnessRoot(), '.agent-runs', runDir.runId, evDir);
  if (fs.existsSync(evAbs)) fs.rmSync(evAbs, { recursive: true, force: true });
  fs.mkdirSync(evAbs, { recursive: true });
  const dstPath = path.join(runDir.tasksDir, `${cloneId}.json`);
  fs.writeFileSync(dstPath, JSON.stringify(pack, null, 2));
  return cloneId;
}

function runWorkflow(workflowYaml: string, taskId: string, args: CliArgs): Promise<SidedResult> {
  const harnessHome = path.join(harnessRoot(), 'tools', 'autonomous-delivery');
  const startMs = Date.now();
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      AUTO_HARNESS_DRIVER: '1',
      AUTO_FORCE_REASON: 'A/B run',
    };
    const cliArgs = ['auto:yaml-runner', workflowYaml];
    if (args.module) { cliArgs.push('--module', args.module); }
    if (args.version) { cliArgs.push('--version', args.version); }
    cliArgs.push('--task', taskId);
    const proc = spawn('pnpm', cliArgs, { cwd: harnessHome, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    proc.on('close', (code) => {
      const wallSeconds = (Date.now() - startMs) / 1000;
      // Read final pack state
      const found = findRunForTask(taskId);
      let pack: Record<string, unknown> | null = null;
      if (found) {
        try { pack = JSON.parse(fs.readFileSync(path.join(found.tasksDir, `${taskId}.json`), 'utf8')); } catch { /* skip */ }
      }
      let costUsd = 0;
      let codexScore: number | null = null;
      let codexVerdict: string | null = null;
      let patchRounds = 0;
      let evidenceCount = 0;
      let finalState = 'unknown';
      let councilStatus = 'none';
      if (pack) {
        finalState = String(pack.state || 'unknown');
        const tel = (pack.cost_telemetry as Array<{ est_usd?: number }>) ?? [];
        for (const t of tel) { if (typeof t.est_usd === 'number') costUsd += t.est_usd; }
        const codex = pack.codex as { score?: number; verdict?: string; rounds_executed?: number } | undefined;
        codexScore = codex?.score ?? null;
        codexVerdict = codex?.verdict ?? null;
        patchRounds = codex?.rounds_executed ?? 0;
        if (found) {
          const evDir = path.join(harnessRoot(), '.agent-runs', found.runId, 'evidence', taskId);
          if (fs.existsSync(evDir)) evidenceCount = fs.readdirSync(evDir).length;
          // Council sidecar lookup
          const moduleId = String(pack.module_or_sprint || '').split('-')[0];
          const councilDir = path.join(harnessRoot(), '.agent-runs', '_audit', 'council', moduleId);
          if (fs.existsSync(councilDir)) {
            for (const phase of fs.readdirSync(councilDir)) {
              const phaseDir = path.join(councilDir, phase);
              if (!fs.statSync(phaseDir).isDirectory()) continue;
              for (const verFile of fs.readdirSync(phaseDir)) {
                try {
                  const sc = JSON.parse(fs.readFileSync(path.join(phaseDir, verFile), 'utf8'));
                  if (sc.status === 'failed') councilStatus = 'failed';
                  else if (councilStatus === 'none') councilStatus = sc.status;
                } catch { /* skip */ }
              }
            }
          }
        }
      }
      resolve({
        side: 'A',  // Caller overrides
        workflow: workflowYaml,
        task_id: taskId,
        exit_code: code ?? -1,
        wall_seconds: wallSeconds,
        cost_usd: costUsd,
        final_state: finalState,
        codex_score: codexScore,
        codex_verdict: codexVerdict,
        council_status: councilStatus,
        patch_rounds: patchRounds,
        evidence_count: evidenceCount,
        stderr_tail: stderr.slice(-500),
      });
    });
  });
}

function determineWinner(a: SidedResult, b: SidedResult): { winner: 'A' | 'B' | 'tie'; reasoning: string[] } {
  const reasons: string[] = [];
  let aPoints = 0;
  let bPoints = 0;

  // Final state — promotable / merged > needs-revision > error
  const stateRank: Record<string, number> = { promotable: 4, 'ready-for-merge': 4, merged: 5, 'awaiting-review': 3, 'needs-revision': 2, parked: 1, abandoned: 0, error: -1, unknown: -1 };
  const aRank = stateRank[a.final_state] ?? -1;
  const bRank = stateRank[b.final_state] ?? -1;
  if (aRank > bRank) { aPoints += 3; reasons.push(`A reached ${a.final_state}; B only ${b.final_state}`); }
  else if (bRank > aRank) { bPoints += 3; reasons.push(`B reached ${b.final_state}; A only ${a.final_state}`); }

  // Codex score (if both have)
  if (a.codex_score !== null && b.codex_score !== null) {
    const diff = (a.codex_score ?? 0) - (b.codex_score ?? 0);
    if (Math.abs(diff) >= 0.5) {
      if (diff > 0) { aPoints += 2; reasons.push(`A codex score ${a.codex_score} vs B ${b.codex_score}`); }
      else { bPoints += 2; reasons.push(`B codex score ${b.codex_score} vs A ${a.codex_score}`); }
    }
  }

  // Cost — cheaper is better when quality matches
  const costDiff = a.cost_usd - b.cost_usd;
  if (Math.abs(costDiff) > 0.1 && aRank === bRank) {
    if (costDiff < 0) { aPoints += 1; reasons.push(`A cheaper: $${a.cost_usd.toFixed(2)} vs B $${b.cost_usd.toFixed(2)}`); }
    else { bPoints += 1; reasons.push(`B cheaper: $${b.cost_usd.toFixed(2)} vs A $${a.cost_usd.toFixed(2)}`); }
  }

  // Wall time — faster is better when quality matches
  const timeDiff = a.wall_seconds - b.wall_seconds;
  if (Math.abs(timeDiff) > 60 && aRank === bRank) {
    if (timeDiff < 0) { aPoints += 1; reasons.push(`A faster: ${a.wall_seconds.toFixed(0)}s vs B ${b.wall_seconds.toFixed(0)}s`); }
    else { bPoints += 1; reasons.push(`B faster: ${b.wall_seconds.toFixed(0)}s vs A ${a.wall_seconds.toFixed(0)}s`); }
  }

  // Patch rounds — fewer is better
  if (a.patch_rounds !== b.patch_rounds && aRank === bRank) {
    if (a.patch_rounds < b.patch_rounds) { aPoints += 1; reasons.push(`A used ${a.patch_rounds} patch rounds vs B ${b.patch_rounds}`); }
    else { bPoints += 1; reasons.push(`B used ${b.patch_rounds} patch rounds vs A ${a.patch_rounds}`); }
  }

  if (aPoints > bPoints) return { winner: 'A', reasoning: reasons };
  if (bPoints > aPoints) return { winner: 'B', reasoning: reasons };
  return { winner: 'tie', reasoning: reasons.length > 0 ? reasons : ['no measurable difference'] };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.a || !args.b || !args.task) {
    console.error('Usage: pnpm auto:ab-runner --a <wf-A.yaml> --b <wf-B.yaml> --task <task_id>');
    process.exit(2);
  }

  const found = findRunForTask(args.task);
  if (!found) {
    console.error(`Task ${args.task} not found.`);
    process.exit(1);
  }

  console.log(`A/B run — A=${args.a} vs B=${args.b} on ${args.task}`);
  console.log(`Mode: ${args.serial ? 'serial' : 'parallel'}`);
  console.log('');

  const aId = clonePack(args.task, found, 'A');
  const bId = clonePack(args.task, found, 'B');
  console.log(`Cloned: ${aId} / ${bId}`);

  let aResult: SidedResult, bResult: SidedResult;
  if (args.serial) {
    console.log('Running A…');
    aResult = await runWorkflow(args.a, aId, args);
    aResult.side = 'A';
    console.log(`A done: state=${aResult.final_state} cost=$${aResult.cost_usd.toFixed(2)} time=${aResult.wall_seconds.toFixed(0)}s`);
    console.log('Running B…');
    bResult = await runWorkflow(args.b, bId, args);
    bResult.side = 'B';
    console.log(`B done: state=${bResult.final_state} cost=$${bResult.cost_usd.toFixed(2)} time=${bResult.wall_seconds.toFixed(0)}s`);
  } else {
    console.log('Running A and B in parallel…');
    const [a, b] = await Promise.all([runWorkflow(args.a, aId, args), runWorkflow(args.b, bId, args)]);
    aResult = { ...a, side: 'A' };
    bResult = { ...b, side: 'B' };
  }

  const verdict = determineWinner(aResult, bResult);

  const report = {
    at: new Date().toISOString(),
    task_id: args.task,
    a: aResult,
    b: bResult,
    verdict,
  };

  const outDir = path.join(harnessRoot(), '.agent-runs', '_ab-results');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = args.outFile || path.join(outDir, `${args.task}-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  A/B verdict: ${verdict.winner === 'tie' ? 'TIE' : `${verdict.winner} wins`}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  for (const r of verdict.reasoning) console.log(`  • ${r}`);
  console.log('');
  console.log(`  Full report: ${outPath}`);
}

main().catch((e) => { console.error(`fatal: ${(e as Error).message}`); process.exit(99); });
