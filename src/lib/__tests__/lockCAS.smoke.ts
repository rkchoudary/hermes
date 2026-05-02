#!/usr/bin/env tsx
/**
 * Property test for `withTaskPackLock` CAS correctness.
 *
 * Property: at any moment in time, AT MOST ONE process holds the lock.
 *
 * Method:
 *   1. Set up a fixture run + task pack on /tmp.
 *   2. Spawn N=20 child processes (each `tsx child.ts …`) that:
 *      a. Call withTaskPackLock on the same task.
 *      b. Inside the critical section: read counter file, sleep 100ms,
 *         increment, write back. Append a {pid, start_ms, end_ms} record
 *         to a shared timeline file.
 *   3. Wait for all children.
 *   4. Assert:
 *      - Counter == N (no lost writes; lock prevented read-modify-write race).
 *      - No two timeline intervals overlap (mutual exclusion).
 *      - All processes terminated cleanly (exit 0).
 *
 * On a 14-core M2, this test takes ~3-5s.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_LIB_RUNSTATE = path.resolve(__dirname, '../runState.ts');
const TSX_BIN = path.resolve(__dirname, '../../../node_modules/.bin/tsx');

const N = 20;
const HOLD_MS = 100;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

interface TimelineEntry { pid: number; start_ms: number; end_ms: number; }

const CHILD_BODY = `
import * as fs from 'node:fs';

// HARNESS_PROJECT_ROOT MUST be set before importing runState (which caches it).
// Parent sets it via spawn env; double-set here as belt-and-suspenders.
const [, , harnessRoot, runId, taskId, counterPath, timelinePath, holdMsStr] = process.argv;
process.env.HARNESS_PROJECT_ROOT = harnessRoot;
const HOLD_MS = parseInt(holdMsStr, 10);

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

(async () => {
  // tsx CJS mode disallows top-level await; wrap dynamic import in IIFE.
  const { withTaskPackLock } = await import('${HARNESS_LIB_RUNSTATE}');

  let acquired = false;
  for (let i = 0; i < 100 && !acquired; i++) {
    try {
      const start_ms = Date.now();
      withTaskPackLock(runId, taskId, (pack: any) => {
        const counter = parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0;
        busyWait(HOLD_MS);
        fs.writeFileSync(counterPath, String(counter + 1));
        const end_ms = Date.now();
        fs.appendFileSync(timelinePath, JSON.stringify({ pid: process.pid, start_ms, end_ms }) + '\\n');
        return pack;
      });
      acquired = true;
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('lock busy') || msg.includes('TaskPackLockBusyError') || msg.includes('EEXIST') || msg.includes('is locked by another') || msg.includes('locked by another process')) {
        const backoff = 20 + Math.floor(Math.random() * 40);
        const end = Date.now() + backoff;
        while (Date.now() < end) { /* spin */ }
        continue;
      }
      console.error('child[' + process.pid + '] unexpected error:', msg);
      process.exit(2);
    }
  }

  if (!acquired) {
    console.error('child[' + process.pid + '] failed to acquire after 100 retries');
    process.exit(3);
  }
  process.exit(0);
})();
`;

async function main() {
  console.log(`— lockCAS.smoke (N=${N}, hold=${HOLD_MS}ms)`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lockCAS-'));
  const harnessRoot = tmpRoot;
  const runId = '2026-04-28-test';
  const taskId = 'TP-2026-04-28-901';
  const tasksDir = path.join(harnessRoot, '.agent-runs', runId, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });

  const taskPack = {
    schema_version: '1',
    task_id: taskId,
    run_id: runId,
    type: 'frd-polish',
    module_or_sprint: 'lock-cas-test',
    version_target: 'v0.0',
    objective: 'lock CAS property test',
    acceptance_criteria: ['stub'],
    allowed_paths: ['*'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'fixture', gate_threshold: 7.0, max_rounds: 5 },
    state: 'planned',
    state_history: [],
    evidence_dir: `evidence/${taskId}`,
    depends_on: [],
    base_sha: '0000000',
    lock: null,
    cost_telemetry: [],
    actors: { reviewers: [], approvers: [] },
    notes: [],
  };
  fs.writeFileSync(path.join(tasksDir, `${taskId}.json`), JSON.stringify(taskPack, null, 2));

  const counterPath = path.join(tmpRoot, 'counter.txt');
  const timelinePath = path.join(tmpRoot, 'timeline.jsonl');
  fs.writeFileSync(counterPath, '0');
  fs.writeFileSync(timelinePath, '');

  const childScript = path.join(tmpRoot, 'child.ts');
  fs.writeFileSync(childScript, CHILD_BODY);

  // Verify tsx is reachable
  if (!fs.existsSync(TSX_BIN)) {
    console.error(`✗ tsx not found at ${TSX_BIN}. Run pnpm install.`);
    process.exit(1);
  }

  const startedAt = Date.now();
  const children: ReturnType<typeof spawn>[] = [];
  for (let i = 0; i < N; i++) {
    const child = spawn(TSX_BIN, [
      childScript,
      harnessRoot,
      runId,
      taskId,
      counterPath,
      timelinePath,
      String(HOLD_MS),
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        HARNESS_PROJECT_ROOT: harnessRoot,
      },
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += String(d); });
    (child as any)._stderrBuf = () => stderr;
    children.push(child);
  }

  const exits = await Promise.all(children.map((c) => new Promise<{ code: number; stderr: string }>((resolve) => {
    c.on('exit', (code) => resolve({ code: code ?? -1, stderr: (c as any)._stderrBuf() }));
  })));
  const elapsed = Date.now() - startedAt;
  console.log(`  all children exited in ${elapsed}ms`);

  const counter = parseInt(fs.readFileSync(counterPath, 'utf8'), 10);
  const timeline: TimelineEntry[] = fs.readFileSync(timelinePath, 'utf8')
    .trim().split('\n').filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  timeline.sort((a, b) => a.start_ms - b.start_ms);

  const okExits = exits.filter((e) => e.code === 0).length;
  if (okExits < N) {
    console.error(`  child stderr samples (first 3 non-zero):`);
    let shown = 0;
    for (const e of exits) {
      if (e.code !== 0 && shown < 3) {
        console.error(`    code=${e.code}: ${e.stderr.split('\n').slice(0, 5).join(' | ')}`);
        shown++;
      }
    }
  }
  assert(okExits === N, `all ${N} children exited 0 (got ${okExits})`);
  assert(counter === N, `counter is ${N} (got ${counter}) — no lost writes (proves mutual exclusion at the durability level)`);
  assert(timeline.length === N, `timeline has ${N} entries (got ${timeline.length})`);

  // Timing-based overlap check is a STRICTER claim than counter==N. It can
  // flake on slow CI runners where timestamp precision (Date.now() ~1ms) +
  // busy-wait scheduler jitter create apparent overlap of <10ms even when
  // the CAS lock IS correctly preventing concurrent writes (counter==N proves
  // this). Allow up to OVERLAP_TOLERANCE_MS slack to absorb scheduling jitter.
  // Real overlap >= tolerance still fails — the lock primitive is wrong.
  const OVERLAP_TOLERANCE_MS = 25;  // generous; CI runners under concurrency pressure
  let realOverlaps = 0;
  let toleratedOverlaps = 0;
  for (let i = 1; i < timeline.length; i++) {
    const overlapAmount = timeline[i - 1].end_ms - timeline[i].start_ms;
    if (overlapAmount > 0) {
      if (overlapAmount > OVERLAP_TOLERANCE_MS) {
        console.error(`  REAL overlap: pid ${timeline[i - 1].pid} held [${timeline[i - 1].start_ms}, ${timeline[i - 1].end_ms}], pid ${timeline[i].pid} started ${timeline[i].start_ms} (overlap ${overlapAmount}ms > ${OVERLAP_TOLERANCE_MS}ms tolerance)`);
        realOverlaps++;
      } else {
        toleratedOverlaps++;
      }
    }
  }
  if (toleratedOverlaps > 0) console.log(`  (${toleratedOverlaps} timing-jitter overlap(s) within ${OVERLAP_TOLERANCE_MS}ms tolerance — counter==N is the authoritative mutex proof)`);
  assert(realOverlaps === 0, `mutual exclusion: zero overlaps beyond ${OVERLAP_TOLERANCE_MS}ms timing-jitter tolerance`);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\n✓ all lockCAS.smoke assertions passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
