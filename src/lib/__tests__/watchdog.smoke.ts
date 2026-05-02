/**
 * Smoke tests for processWatchdog. Run via:
 *   pnpm auto:test:watchdog
 *
 * Covers:
 *   - register / unregister / listRegistered round-trip
 *   - isPidAlive against current process (true) and a clearly-dead pid (false)
 *   - reapStale dry-run vs apply
 *   - dead-pid cleanup
 *   - over-deadline detection (we register an entry with started_at far in past)
 *   - heartbeat-stale detection
 *   - schema validation rejects bad input
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
import {
  registerProcess,
  unregisterProcess,
  listRegistered,
  isPidAlive,
  reapStale,
  registryPath,
  defaultMaxDurationSec,
  ProcessRegistryEntry,
} from '../processWatchdog';

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  const eq = JSON.stringify(actual) === JSON.stringify(expected);
  if (eq) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`); }
}

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-smoke-'));
  fs.mkdirSync(path.join(root, '.agent-runs'), { recursive: true });
  return root;
}

function cleanup(root: string): void {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
}

console.log('\n[watchdog smoke] starting…\n');

// ─── 1. Register / unregister round-trip ─────────────────────────────────────
{
  console.log('1. register / unregister round-trip');
  const root = tmpRoot();
  try {
    assertEq(listRegistered(root).length, 0, 'empty registry initially');
    registerProcess(root, {
      pid: 12345,
      kind: 'codex-consensus',
      task_id: 'TP-test-001',
      run_id: 'test-run',
      started_at: new Date().toISOString(),
      max_duration_sec: 600,
      command: '/bin/true',
      host: os.hostname(),
      heartbeat_ttl_sec: 120,
      restart_policy: 'next-round',
    });
    assertEq(listRegistered(root).length, 1, 'one entry after register');
    assertEq(listRegistered(root)[0].pid, 12345, 'correct pid stored');
    unregisterProcess(root, 12345);
    assertEq(listRegistered(root).length, 0, 'empty after unregister');
    // Idempotent
    unregisterProcess(root, 12345);
    assertEq(listRegistered(root).length, 0, 'unregister idempotent');
  } finally { cleanup(root); }
}

// ─── 2. Liveness ─────────────────────────────────────────────────────────────
{
  console.log('\n2. isPidAlive');
  assert(isPidAlive(process.pid), 'current process pid alive');
  // PID 1 is init/launchd — guaranteed alive on POSIX
  assert(isPidAlive(1), 'pid 1 (init/launchd) alive');
  // Use a high pid we know doesn't exist (max+1; OSes recycle but >1M is safe)
  assert(!isPidAlive(2 ** 22), 'absurd pid not alive');
}

// ─── 3. reapStale: dead-pid cleanup ──────────────────────────────────────────
{
  console.log('\n3. reapStale: dead-pid cleanup');
  const root = tmpRoot();
  try {
    // Spawn a short-lived child, capture pid, register, kill, then reap
    const child = spawn('/bin/sh', ['-c', 'sleep 0.1']);
    const childPid = child.pid!;
    registerProcess(root, {
      pid: childPid,
      kind: 'other',
      started_at: new Date().toISOString(),
      max_duration_sec: 600,
      command: 'sleep 0.1',
      host: os.hostname(),
      heartbeat_ttl_sec: 120,
      restart_policy: 'none',
    });
    assertEq(listRegistered(root).length, 1, 'child registered');
    // Wait for child to exit
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    // Give kernel a moment to fully reap
    await new Promise((r) => setTimeout(r, 200));
    assert(!isPidAlive(childPid), 'child pid no longer alive');
    const dryResults = reapStale(root, { apply: false });
    assertEq(dryResults.length, 1, 'one result in dry-run');
    assertEq(dryResults[0].verdict.action, 'unregister-dead', 'verdict=unregister-dead');
    assertEq(listRegistered(root).length, 1, 'dry-run did NOT mutate registry');
    const applyResults = reapStale(root, { apply: true });
    assertEq(applyResults[0].applied, true, 'apply=true marks applied');
    assertEq(listRegistered(root).length, 0, 'apply mutated registry (dead removed)');
  } finally { cleanup(root); }
}

// ─── 4. reapStale: over-deadline kill ────────────────────────────────────────
{
  console.log('\n4. reapStale: over-deadline kill');
  const root = tmpRoot();
  try {
    // Spawn a child that will outlive our test, then register with started_at
    // backdated so it's already past max_duration_sec.
    const child = spawn('/bin/sh', ['-c', 'sleep 60']);
    const childPid = child.pid!;
    registerProcess(root, {
      pid: childPid,
      kind: 'codex-consensus',
      task_id: 'TP-deadline-test',
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),  // 30 min ago
      max_duration_sec: 60,  // 1 min limit
      command: 'sleep 60',
      host: os.hostname(),
      heartbeat_ttl_sec: 120,
      restart_policy: 'escalate',
    });
    const results = reapStale(root, { apply: true, sigterm_grace_ms: 1000 });
    assertEq(results.length, 1, 'one result for over-deadline');
    assertEq(results[0].verdict.action, 'kill-overdeadline', 'verdict=kill-overdeadline');
    assertEq(results[0].applied, true, 'apply=true marks applied');
    assert(['SIGTERM', 'SIGKILL'].includes(results[0].killed_signal!), 'killed with SIGTERM or SIGKILL');
    // Wait for child to actually die
    await new Promise((r) => setTimeout(r, 1500));
    assert(!isPidAlive(childPid), 'child killed by reaper');
    assertEq(listRegistered(root).length, 0, 'registry pruned after kill');
    // Ensure audit log was written (.agent-runs/_override-audit.jsonl)
    const auditPath = path.join(root, '.agent-runs', '_override-audit.jsonl');
    assert(fs.existsSync(auditPath), 'audit log written');
    const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n');
    const auditEntry = JSON.parse(auditLines[0]);
    assertEq(auditEntry.kind, 'watchdog-reap', 'audit kind=watchdog-reap');
    assertEq(auditEntry.task_id, 'TP-deadline-test', 'audit task_id captured');
  } finally { cleanup(root); }
}

// ─── 5. reapStale: heartbeat stale ───────────────────────────────────────────
{
  console.log('\n5. reapStale: heartbeat stale');
  const root = tmpRoot();
  try {
    const heartbeatPath = path.join(root, 'heartbeat-test.txt');
    // Create heartbeat file with old mtime
    fs.writeFileSync(heartbeatPath, 'beat');
    const past = (Date.now() - 30 * 60 * 1000) / 1000;  // 30 min ago, in seconds
    fs.utimesSync(heartbeatPath, past, past);

    const child = spawn('/bin/sh', ['-c', 'sleep 60']);
    const childPid = child.pid!;
    registerProcess(root, {
      pid: childPid,
      kind: 'claude-cli-worker',
      started_at: new Date().toISOString(),  // recent
      max_duration_sec: 7200,                 // 2hr limit (not deadline)
      heartbeat_path: heartbeatPath,
      heartbeat_ttl_sec: 60,                  // 1 min stale → reap
      command: 'sleep 60',
      host: os.hostname(),
      restart_policy: 'next-round',
    });
    const results = reapStale(root, { apply: true, sigterm_grace_ms: 500 });
    assertEq(results[0].verdict.action, 'kill-stale-heartbeat', 'verdict=kill-stale-heartbeat');
    assertEq(results[0].applied, true, 'applied');
    await new Promise((r) => setTimeout(r, 1000));
    assert(!isPidAlive(childPid), 'child killed for stale heartbeat');
  } finally { cleanup(root); }
}

// ─── 6. reapStale: cross-host left alone ─────────────────────────────────────
{
  console.log('\n6. cross-host entries left alone');
  const root = tmpRoot();
  try {
    // Write a registry entry for a "remote" host directly
    registerProcess(root, {
      pid: 99999,
      kind: 'codex-consensus',
      started_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),  // 1hr ago
      max_duration_sec: 60,  // would be over-deadline locally
      command: 'remote-codex',
      host: 'some-other-host.example.com',
      heartbeat_ttl_sec: 120,
      restart_policy: 'none',
    });
    const results = reapStale(root, { apply: true, current_host: os.hostname() });
    assertEq(results[0].verdict.action, 'keep', 'cross-host kept');
    assertEq(listRegistered(root).length, 1, 'cross-host entry not pruned');
  } finally { cleanup(root); }
}

// ─── 7. Schema validation ────────────────────────────────────────────────────
{
  console.log('\n7. schema validation');
  const root = tmpRoot();
  try {
    let threw = false;
    try {
      registerProcess(root, {
        pid: -1,                  // invalid: must be positive
        kind: 'codex-consensus',
        started_at: new Date().toISOString(),
        max_duration_sec: 600,
        command: 'x',
        host: os.hostname(),
        heartbeat_ttl_sec: 120,
        restart_policy: 'none',
      } as ProcessRegistryEntry);
    } catch { threw = true; }
    assert(threw, 'register rejects negative pid');

    let threw2 = false;
    try {
      registerProcess(root, {
        pid: 1234,
        kind: 'codex-consensus',
        started_at: new Date().toISOString(),
        max_duration_sec: 0,     // invalid: must be positive
        command: 'x',
        host: os.hostname(),
        heartbeat_ttl_sec: 120,
        restart_policy: 'none',
      } as ProcessRegistryEntry);
    } catch { threw2 = true; }
    assert(threw2, 'register rejects zero max_duration_sec');
  } finally { cleanup(root); }
}

// ─── 8. defaultMaxDurationSec sanity ─────────────────────────────────────────
{
  console.log('\n8. defaultMaxDurationSec');
  assert(defaultMaxDurationSec('codex-consensus') >= 5 * 60, 'codex ≥ 5 min');
  assert(defaultMaxDurationSec('codex-consensus') <= 30 * 60, 'codex ≤ 30 min');
  assert(defaultMaxDurationSec('claude-cli-worker') >= 15 * 60, 'worker ≥ 15 min');
  assert(defaultMaxDurationSec('claude-cli-worker') <= 90 * 60, 'worker ≤ 90 min');
}

// Tests 9 & 10 use the REAL harness .agent-runs root because withTaskPackLock
// resolves paths from a module-level constant. We write packs under a unique
// runId so we never collide with real runs, and rm the run dir in finally.
// v0.4.10 path-resolution fix: use harnessRoot() so the test works in
// both vendored (parent-project/.agent-runs) and standalone (repo/.agent-runs) layouts.
import { harnessRoot } from '../harnessRoot';
const HARNESS_ROOT = harnessRoot();
const REAL_RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');

function realTestRunId(suffix: string): { runId: string; taskIdSuffix: string; cleanup: () => void } {
  const runId = `_watchdog-smoke-${process.pid}-${Date.now()}-${suffix}`;
  // task_id must match /^TP-\d{4}-\d{2}-\d{2}-\d{3,}$/. We use today's date
  // and a process-pid suffix in the NNN slot to keep IDs unique across runs.
  const today = new Date().toISOString().slice(0, 10);  // 2026-04-28
  const idTail = String(900 + (process.pid % 100));      // 900..999
  const taskIdSuffix = `TP-${today}-${idTail}`;
  const runDir = path.join(REAL_RUNS_DIR, runId);
  fs.mkdirSync(path.join(runDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'evidence'), { recursive: true });
  return {
    runId,
    taskIdSuffix,
    cleanup: () => { try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* */ } },
  };
}

// ─── 9. reapStale: post-kill task-state rollback (claude-cli-worker only) ────
{
  console.log('\n9. reapStale: post-kill task-state rollback');
  const { runId, taskIdSuffix, cleanup: cleanupRun } = realTestRunId('rollback');
  const root = HARNESS_ROOT;
  try {
    const taskId = taskIdSuffix;
    const tasksDir = path.join(root, '.agent-runs', runId, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskPath = path.join(tasksDir, `${taskId}.json`);

    // Spawn a child to be the "worker" being killed.
    const child = spawn('/bin/sh', ['-c', 'sleep 60']);
    const childPid = child.pid!;

    // Write a minimal task pack mimicking the real schema enough for
    // releaseTaskLock + appendStateTransition to mutate it.
    const taskPack = {
      schema_version: '1',
      task_id: taskId,
      run_id: runId,
      type: 'code-sprint',
      module_or_sprint: 'M99-test',
      version_target: 'v0.0.1',
      objective: 'rollback test',
      acceptance_criteria: ['x'],
      allowed_paths: ['x'],
      forbidden_paths: [],
      context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
      references: { code_paths: [], obsidian_paths: [] },
      commands: { test: ['echo'], typecheck: 'echo' },
      consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 },
      state: 'in-progress',
      state_history: [
        {
          from: 'needs-revision',
          to: 'in-progress',
          at: new Date().toISOString(),
          by: 'auto-worker-claude-code-cli',
          reason: 'auto:work invoked',
        },
      ],
      evidence_dir: path.join(REAL_RUNS_DIR, runId, 'evidence', taskId),
      worker: { type: 'claude-code-cli', worktree_path: '/tmp/x' },
      depends_on: [],
      lock: {
        holder: `auto-worker-claude-code-cli pid ${childPid}`,
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        pid: childPid,
        host: os.hostname(),
        host_boot_time: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      },
      cost_telemetry: [],
      notes: [],
    };
    fs.writeFileSync(taskPath, JSON.stringify(taskPack, null, 2));

    // Register the worker in the watchdog with a backdated started_at to
    // trigger the over-deadline reap path (which is the path that calls
    // rollbackTaskState).
    registerProcess(root, {
      pid: childPid,
      kind: 'claude-cli-worker',
      task_id: taskId,
      run_id: runId,
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      max_duration_sec: 60,
      command: 'sleep 60',
      host: os.hostname(),
      heartbeat_ttl_sec: 120,
      restart_policy: 'next-round',
    });

    // Reap; should kill child + rollback task pack. The test shares the live
    // harness registry with concurrent real workers, so filter by our child pid.
    const allResults = reapStale(root, { apply: true, sigterm_grace_ms: 1000 });
    const myResult = allResults.find((r) => r.entry.pid === childPid);
    assert(myResult !== undefined, 'reap result for our test child present');
    assertEq(myResult!.verdict.action, 'kill-overdeadline', 'verdict=kill-overdeadline');
    assertEq(myResult!.applied, true, 'kill applied');
    await new Promise((r) => setTimeout(r, 1500));
    assert(!isPidAlive(childPid), 'worker child killed');

    // Verify task pack rolled back.
    const after = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    assertEq(after.state, 'needs-revision', 'task state rolled back to needs-revision');
    assertEq(after.lock, null, 'task lock released');
    const lastTransition = after.state_history[after.state_history.length - 1];
    assertEq(lastTransition.by, 'watchdog-rollback', 'state transition by=watchdog-rollback');
    assertEq(lastTransition.from, 'in-progress', 'rollback from=in-progress');
    assertEq(lastTransition.to, 'needs-revision', 'rollback to=needs-revision');
    const rollbackNote = after.notes.find((n: { by?: string }) => n.by === 'watchdog-rollback');
    assert(rollbackNote !== undefined, 'rollback note appended');
  } finally { cleanupRun(); }
}

// ─── 10. rollback skips when lock pid was reassigned to another worker ───────
{
  console.log('\n10. rollback skips when lock pid no longer matches');
  const { runId, taskIdSuffix, cleanup: cleanupRun } = realTestRunId('race');
  const root = HARNESS_ROOT;
  try {
    // Different fake taskId in this run; must satisfy the task_id regex.
    const today = new Date().toISOString().slice(0, 10);
    const idTail = String(800 + (process.pid % 100));
    const taskId = `TP-${today}-${idTail}`;
    void taskIdSuffix;
    const tasksDir = path.join(root, '.agent-runs', runId, 'tasks');
    fs.mkdirSync(tasksDir, { recursive: true });
    const taskPath = path.join(tasksDir, `${taskId}.json`);

    const reapedPid = 88888;  // never registered as alive — simulating a process the watchdog "killed"
    const survivorPid = 77777;

    // Pack: lock points to a DIFFERENT pid (survivorPid) than the one we'll
    // claim to have reaped (reapedPid). Rollback should leave it alone.
    const taskPack = {
      schema_version: '1',
      task_id: taskId,
      run_id: runId,
      type: 'code-sprint',
      module_or_sprint: 'M99-race',
      version_target: 'v0',
      objective: 'race',
      acceptance_criteria: ['x'],
      allowed_paths: ['x'],
      forbidden_paths: [],
      context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
      references: { code_paths: [], obsidian_paths: [] },
      commands: { test: ['echo'], typecheck: 'echo' },
      consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 },
      state: 'in-progress',
      state_history: [{ from: 'needs-revision', to: 'in-progress', at: new Date().toISOString(), by: 'a', reason: 'b' }],
      evidence_dir: path.join(REAL_RUNS_DIR, runId, 'evidence', taskId),
      worker: { type: 'claude-code-cli', worktree_path: '/tmp/x' },
      depends_on: [],
      lock: {
        holder: `auto-worker-claude-code-cli pid ${survivorPid}`,
        acquired_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        last_heartbeat_at: new Date().toISOString(),
        pid: survivorPid,
        host: os.hostname(),
        host_boot_time: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      },
      cost_telemetry: [],
      notes: [],
    };
    fs.writeFileSync(taskPath, JSON.stringify(taskPack, null, 2));

    // Register reapedPid (already dead — we won't actually spawn it). reapStale
    // will see kill -0 fails → 'unregister-dead' verdict. unregister-dead
    // does NOT call rollbackTaskState, so this is not the test we want.
    // Use over-deadline path with a real (different) child pid that will be killed.
    const child = spawn('/bin/sh', ['-c', 'sleep 60']);
    const realPid = child.pid!;
    registerProcess(root, {
      pid: realPid,
      kind: 'claude-cli-worker',
      task_id: taskId,
      run_id: runId,
      started_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      max_duration_sec: 60,
      command: 'sleep 60',
      host: os.hostname(),
      heartbeat_ttl_sec: 120,
      restart_policy: 'next-round',
    });
    reapStale(root, { apply: true, sigterm_grace_ms: 500 });
    await new Promise((r) => setTimeout(r, 1000));
    const after = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
    // Lock points at survivorPid, NOT realPid → rollback should skip.
    assertEq(after.state, 'in-progress', 'state unchanged when lock pid mismatches');
    assert(after.lock !== null, 'lock not released for mismatched pid');
    assertEq(after.lock.pid, survivorPid, 'survivor lock untouched');
  } finally { cleanupRun(); }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n[watchdog smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
