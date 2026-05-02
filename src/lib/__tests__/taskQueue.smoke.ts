/**
 * Smoke tests for taskQueue. Run via: pnpm auto:test:queue
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { enqueue, dequeue, listQueue, drainQueue, queuePath } from '../taskQueue';

let passed = 0, failed = 0;
function assert(c: unknown, l: string): void { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}`); } }
function assertEq<T>(a: T, b: T, l: string): void { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}\n      actual: ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); } }

import { harnessRoot } from '../harnessRoot';
const HARNESS_ROOT = harnessRoot();
const REAL_RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');

function makeRun(suffix: string): { runId: string; cleanup: () => void } {
  const runId = `queue-smoke-${process.pid}-${Date.now()}-${suffix}`;
  fs.mkdirSync(path.join(REAL_RUNS_DIR, runId, 'tasks'), { recursive: true });
  return { runId, cleanup: () => { try { fs.rmSync(path.join(REAL_RUNS_DIR, runId), { recursive: true, force: true }); } catch { /* */ } } };
}

function writePack(runId: string, taskId: string, state: string): void {
  const today = new Date().toISOString().slice(0, 10);
  const pack = {
    schema_version: '1', task_id: taskId, run_id: runId, type: 'code-sprint',
    module_or_sprint: 'mod', version_target: 'v1', objective: 'x', acceptance_criteria: ['x'],
    allowed_paths: ['x'], forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 },
    state, state_history: [{ from: 'planned', to: state, at: new Date().toISOString(), by: 't', reason: 'x' }],
    evidence_dir: '/tmp/x', actors: { reviewers: [], approvers: [] },
    depends_on: [], lock: null, cost_telemetry: [], notes: [],
  };
  fs.writeFileSync(path.join(REAL_RUNS_DIR, runId, 'tasks', `${taskId}.json`), JSON.stringify(pack, null, 2));
}

console.log('\n[taskQueue smoke] starting…\n');

// Save + restore real queue file so the live one isn't clobbered
const SAVED_QUEUE_PATH = queuePath(HARNESS_ROOT) + '.smoke-backup';
const realQueueExists = fs.existsSync(queuePath(HARNESS_ROOT));
if (realQueueExists) fs.copyFileSync(queuePath(HARNESS_ROOT), SAVED_QUEUE_PATH);
function emptyQueueFile(): void { try { fs.unlinkSync(queuePath(HARNESS_ROOT)); } catch { /* */ } }
function restoreQueue(): void {
  if (realQueueExists) {
    fs.copyFileSync(SAVED_QUEUE_PATH, queuePath(HARNESS_ROOT));
    fs.unlinkSync(SAVED_QUEUE_PATH);
  } else { try { fs.unlinkSync(queuePath(HARNESS_ROOT)); } catch { /* */ } }
}

try {
  // ─── 1. enqueue + listQueue + dequeue round-trip ────────────────────────
  {
    console.log('1. enqueue / dequeue round-trip');
    emptyQueueFile();
    const today = new Date().toISOString().slice(0, 10);
    const id1 = `TP-${today}-${String(901 + (process.pid % 100))}`;
    const id2 = `TP-${today}-${String(902 + (process.pid % 100))}`;
    enqueue(HARNESS_ROOT, {
      task_id: id1, run_id: 'r1', blocked_by: [id2],
      blocked_paths: [{ ours: 'a/**', theirs_task: id2, theirs_path: 'a/x.ts' }],
      reason: 'overlap',
    });
    const q1 = listQueue(HARNESS_ROOT);
    assertEq(q1.length, 1, 'one entry after enqueue');
    assertEq(q1[0].task_id, id1, 'task_id preserved');
    assertEq(q1[0].blocked_by, [id2], 'blocked_by preserved');
    dequeue(HARNESS_ROOT, id1);
    assertEq(listQueue(HARNESS_ROOT).length, 0, 'empty after dequeue');
    dequeue(HARNESS_ROOT, id1);
    assertEq(listQueue(HARNESS_ROOT).length, 0, 'dequeue idempotent');
  }

  // ─── 2. enqueue de-dupes by task_id ──────────────────────────────────────
  {
    console.log('\n2. enqueue de-dupes');
    emptyQueueFile();
    const today = new Date().toISOString().slice(0, 10);
    const id1 = `TP-${today}-${String(811 + (process.pid % 100))}`;
    enqueue(HARNESS_ROOT, { task_id: id1, run_id: 'r1', blocked_by: ['B1'], blocked_paths: [], reason: 'first' });
    enqueue(HARNESS_ROOT, { task_id: id1, run_id: 'r1', blocked_by: ['B1', 'B2'], blocked_paths: [], reason: 'updated' });
    const q = listQueue(HARNESS_ROOT);
    assertEq(q.length, 1, 'still one entry after re-enqueue');
    assertEq(q[0].blocked_by, ['B1', 'B2'], 'updated blocked_by takes precedence');
    assertEq(q[0].reason, 'updated', 'updated reason takes precedence');
    dequeue(HARNESS_ROOT, id1);
  }

  // ─── 3. drainQueue: blocker still active → still blocked ────────────────
  {
    console.log('\n3. drainQueue: active blocker keeps task queued');
    emptyQueueFile();
    const { runId, cleanup } = makeRun('drain-active');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const blocker = `TP-${today}-${String(721 + (process.pid % 100))}`;
      const blocked = `TP-${today}-${String(722 + (process.pid % 100))}`;
      writePack(runId, blocker, 'in-progress');
      writePack(runId, blocked, 'planned');
      enqueue(HARNESS_ROOT, { task_id: blocked, run_id: runId, blocked_by: [blocker], blocked_paths: [], reason: 'overlap' });
      const r = drainQueue(HARNESS_ROOT, { apply: true });
      assertEq(r.length, 1, 'one drain candidate');
      assertEq(r[0].unblocked, false, 'still blocked because blocker is in-progress');
      assert(r[0].still_blocked_by.length > 0, 'still_blocked_by populated');
      assertEq(listQueue(HARNESS_ROOT).length, 1, 'queue unchanged');
      dequeue(HARNESS_ROOT, blocked);
    } finally { cleanup(); }
  }

  // ─── 4. drainQueue: blocker terminal → unblocked ────────────────────────
  {
    console.log('\n4. drainQueue: terminal blocker unblocks task');
    emptyQueueFile();
    const { runId, cleanup } = makeRun('drain-terminal');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const blocker = `TP-${today}-${String(631 + (process.pid % 100))}`;
      const blocked = `TP-${today}-${String(632 + (process.pid % 100))}`;
      writePack(runId, blocker, 'merged');  // terminal!
      writePack(runId, blocked, 'planned');
      enqueue(HARNESS_ROOT, { task_id: blocked, run_id: runId, blocked_by: [blocker], blocked_paths: [], reason: 'overlap' });
      const dry = drainQueue(HARNESS_ROOT, { apply: false });
      assertEq(dry[0].unblocked, true, 'dry-run reports unblocked');
      assertEq(dry[0].removed_from_queue, false, 'dry-run does NOT remove');
      assertEq(listQueue(HARNESS_ROOT).length, 1, 'dry-run preserves queue');
      const wet = drainQueue(HARNESS_ROOT, { apply: true });
      assertEq(wet[0].unblocked, true, 'apply reports unblocked');
      assertEq(wet[0].removed_from_queue, true, 'apply removed from queue');
      assertEq(listQueue(HARNESS_ROOT).length, 0, 'queue empty after drain+apply');
    } finally { cleanup(); }
  }

  // ─── 5. drainQueue: multiple blockers, one still active → still blocked ─
  {
    console.log('\n5. multiple blockers, partial terminal');
    emptyQueueFile();
    const { runId, cleanup } = makeRun('drain-partial');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const blocker1 = `TP-${today}-${String(541 + (process.pid % 100))}`;
      const blocker2 = `TP-${today}-${String(542 + (process.pid % 100))}`;
      const blocked = `TP-${today}-${String(543 + (process.pid % 100))}`;
      writePack(runId, blocker1, 'merged');
      writePack(runId, blocker2, 'in-progress');  // still active
      writePack(runId, blocked, 'planned');
      enqueue(HARNESS_ROOT, { task_id: blocked, run_id: runId, blocked_by: [blocker1, blocker2], blocked_paths: [], reason: 'overlap' });
      const r = drainQueue(HARNESS_ROOT, { apply: true });
      assertEq(r[0].unblocked, false, 'still blocked when partial');
      assert(r[0].still_blocked_by.some((b) => b.includes(blocker2)), 'still_blocked_by names the active one');
      dequeue(HARNESS_ROOT, blocked);
    } finally { cleanup(); }
  }
} finally {
  restoreQueue();
}

console.log(`\n[taskQueue smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
