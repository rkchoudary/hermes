/**
 * Smoke test for v0.4.3 industrial-scale guards.
 * Run: tsx src/lib/__tests__/taskPackGuards.smoke.ts
 *
 * No test framework dep added — uses node:assert. Vitest comes in Sprint H2.
 */
import { strict as assert } from 'node:assert';
import {
  parseTaskPack,
  appendStateTransition,
  checkReDispatchAllowed,
  checkDependenciesResolved,
  acquireTaskLock,
  releaseTaskLock,
  renewTaskLock,
  detectDependencyCycle,
  checkPathOverlapAgainstInFlight,
  SHIPPED_STATES,
  DISPATCHABLE_STATES,
  type TaskPack,
} from '../taskPack';

// Minimal valid TaskPack fixture (matches Zod schema)
function fixture(state: TaskPack['state'] = 'planned', overrides: Partial<TaskPack> = {}): TaskPack {
  return parseTaskPack({
    task_id: 'TP-2026-04-27-999',
    run_id: '2026-04-27-test',
    type: 'code-sprint',
    module_or_sprint: 'M00-test',
    version_target: 'v0.0',
    objective: 'smoke test',
    acceptance_criteria: ['ac1'],
    allowed_paths: ['src/'],
    forbidden_paths: ['NEXT-SESSION.md'],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: '/tmp/x.txt', gate_threshold: 7, max_rounds: 2 },
    state,
    state_history: [],
    evidence_dir: '/tmp/test',
    depends_on: [],
    cost_telemetry: [],
    lock: null,
    notes: [],
    ...overrides,
  });
}

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`✓ ${name}`); passed++; }
  catch (e) { console.error(`✗ ${name}\n  ${(e as Error).message}`); failed++; }
}

// ─── G4: re-run guard ─────────────────────────────────────────────────────
test('G4 — planned state allows dispatch', () => {
  const r = checkReDispatchAllowed(fixture('planned'));
  assert.equal(r.ok, true);
});
test('G4 — needs-revision state allows dispatch (re-run after fix)', () => {
  const r = checkReDispatchAllowed(fixture('needs-revision'));
  assert.equal(r.ok, true);
});
test('G4 — awaiting-review BLOCKS without --force', () => {
  const r = checkReDispatchAllowed(fixture('awaiting-review'));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /shipped\/queued state/);
});
test('G4 — merged BLOCKS without --force', () => {
  const r = checkReDispatchAllowed(fixture('merged'));
  assert.equal(r.ok, false);
});
test('G4 — --force overrides shipped guard', () => {
  const r = checkReDispatchAllowed(fixture('merged'), { force: true });
  assert.equal(r.ok, true);
});
test('G4 — in-progress BLOCKS (lock held)', () => {
  const r = checkReDispatchAllowed(fixture('in-progress'));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /already in-progress/);
});
test('G4 — abandoned BLOCKS (use auto:revise)', () => {
  const r = checkReDispatchAllowed(fixture('abandoned'));
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /abandoned/);
});

// ─── G1: dependency resolution ────────────────────────────────────────────
test('G1 — empty depends_on resolves OK', () => {
  const r = checkDependenciesResolved(fixture('planned'), () => null);
  assert.equal(r.ok, true);
  assert.equal(r.unresolved.length, 0);
});
test('G1 — dep in merged state is OK', () => {
  const dep = fixture('merged');
  dep.task_id = 'TP-2026-04-27-001';
  const pack = fixture('planned', { depends_on: ['TP-2026-04-27-001'] });
  const r = checkDependenciesResolved(pack, (id) => (id === 'TP-2026-04-27-001' ? dep : null));
  assert.equal(r.ok, true);
});
test('G1 — dep in awaiting-review BLOCKS', () => {
  const dep = fixture('awaiting-review');
  dep.task_id = 'TP-2026-04-27-001';
  const pack = fixture('planned', { depends_on: ['TP-2026-04-27-001'] });
  const r = checkDependenciesResolved(pack, (id) => (id === 'TP-2026-04-27-001' ? dep : null));
  assert.equal(r.ok, false);
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].state, 'awaiting-review');
});
test('G1 — missing dep BLOCKS', () => {
  const pack = fixture('planned', { depends_on: ['TP-2026-04-27-MISSING'] });
  const r = checkDependenciesResolved(pack, () => null);
  assert.equal(r.ok, false);
  assert.match(r.unresolved[0].reason, /not found/);
});
test('G1 — multiple deps, one unresolved BLOCKS only on the unresolved', () => {
  const ok = fixture('merged'); ok.task_id = 'TP-A';
  const bad = fixture('in-progress'); bad.task_id = 'TP-B';
  const pack = fixture('planned', { depends_on: ['TP-A', 'TP-B'] });
  const r = checkDependenciesResolved(pack, (id) => (id === 'TP-A' ? ok : id === 'TP-B' ? bad : null));
  assert.equal(r.ok, false);
  assert.equal(r.unresolved.length, 1);
  assert.equal(r.unresolved[0].task_id, 'TP-B');
});
test('G1 — ready-for-merge state counts as resolved (PR open + green)', () => {
  const dep = fixture('ready-for-merge'); dep.task_id = 'TP-X';
  const pack = fixture('planned', { depends_on: ['TP-X'] });
  const r = checkDependenciesResolved(pack, (id) => (id === 'TP-X' ? dep : null));
  assert.equal(r.ok, true);
});

// ─── G5: lock semantics ───────────────────────────────────────────────────
test('G5 — fresh acquire OK', () => {
  const pack = fixture('planned');
  const r = acquireTaskLock(pack, 'worker-A', 1234);
  assert.equal(r.ok, true);
  assert.equal(pack.lock?.holder, 'worker-A');
  assert.equal(pack.lock?.pid, 1234);
});
test('G5 — second acquire on fresh lock BLOCKS', () => {
  const pack = fixture('planned');
  acquireTaskLock(pack, 'worker-A', 1234);
  const r = acquireTaskLock(pack, 'worker-B', 5678);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /locked by worker-A/);
});
test('G5 — release allows re-acquire', () => {
  const pack = fixture('planned');
  acquireTaskLock(pack, 'worker-A', 1234);
  releaseTaskLock(pack);
  assert.equal(pack.lock, null);
  const r = acquireTaskLock(pack, 'worker-B', 5678);
  assert.equal(r.ok, true);
});
test('G5 (Codex C3) — expired lease auto-stealable; fresh worker acquires', () => {
  const pack = fixture('planned');
  // Manually set an expired lease (expires_at in the past)
  pack.lock = {
    holder: 'crashed-worker',
    pid: 9999,
    acquired_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    expires_at: new Date(Date.now() - 30 * 60_000).toISOString(), // expired 30min ago
    last_heartbeat_at: new Date(Date.now() - 90 * 60_000).toISOString(),
  };
  const r = acquireTaskLock(pack, 'fresh-worker', 1111);
  assert.equal(r.ok, true);
  assert.equal(pack.lock?.holder, 'fresh-worker');
});
test('G5 (Codex C3) — heartbeat renew extends expires_at', () => {
  const pack = fixture('planned');
  acquireTaskLock(pack, 'worker-A', 1234, 1); // 1-min lease
  const originalExpiry = pack.lock!.expires_at;
  // Wait a moment, then renew with longer lease
  const r = renewTaskLock(pack, 30); // 30-min lease
  assert.equal(r.ok, true);
  assert.notEqual(pack.lock!.expires_at, originalExpiry);
  // New expiry should be ~30 min in the future
  const newMs = new Date(pack.lock!.expires_at).getTime();
  const expectedMs = Date.now() + 30 * 60_000;
  assert.ok(Math.abs(newMs - expectedMs) < 5000, 'renewed lease ~30min ahead');
});
test('G5 (Codex C3) — fresh lease vs old TTL-style: ttl_minutes field is GONE from schema', () => {
  // schema regression check — accidental re-introduction of ttl_minutes would break
  const pack = fixture('planned');
  acquireTaskLock(pack, 'worker', 123);
  assert.ok(pack.lock?.expires_at);
  assert.ok(pack.lock?.last_heartbeat_at);
  assert.equal((pack.lock as Record<string, unknown>).ttl_minutes, undefined);
});

// ─── Codex C4: cycle detection ────────────────────────────────────────────
test('C4 — empty deps has no cycle', () => {
  const pack = fixture('planned');
  const r = detectDependencyCycle(pack, () => null);
  assert.equal(r.hasCycle, false);
});
test('C4 — self-dependency detected', () => {
  const pack = fixture('planned', { depends_on: ['TP-2026-04-27-999'] }); // self-ref via task_id
  const r = detectDependencyCycle(pack, () => null);
  assert.equal(r.hasCycle, true);
  assert.match(r.reason ?? '', /Self-dependency/);
});
test('C4 — A→B→A cycle detected', () => {
  const a = fixture('planned', { depends_on: ['TP-B'] });
  a.task_id = 'TP-A';
  const b = fixture('planned', { depends_on: ['TP-A'] });
  b.task_id = 'TP-B';
  const r = detectDependencyCycle(a, (id) => (id === 'TP-A' ? a : id === 'TP-B' ? b : null));
  assert.equal(r.hasCycle, true);
  assert.match(r.reason ?? '', /cycle detected/);
});
test('C4 — A→B→C linear has no cycle', () => {
  const a = fixture('planned', { depends_on: ['TP-B'] }); a.task_id = 'TP-A';
  const b = fixture('planned', { depends_on: ['TP-C'] }); b.task_id = 'TP-B';
  const c = fixture('planned'); c.task_id = 'TP-C';
  const lookup = (id: string) => ({ 'TP-A': a, 'TP-B': b, 'TP-C': c }[id] ?? null);
  const r = detectDependencyCycle(a, lookup);
  assert.equal(r.hasCycle, false);
});

// ─── Operator directive: path-overlap detection ───────────────────────────
test('OVERLAP — disjoint paths are OK', () => {
  const candidate = fixture('planned', { allowed_paths: ['platform/pipeline/'] });
  const other = fixture('in-progress', { allowed_paths: ['platform/auth/'] });
  other.task_id = 'TP-OTHER';
  const r = checkPathOverlapAgainstInFlight(candidate, [other]);
  assert.equal(r.ok, true);
});
test('OVERLAP — exact-match paths conflict', () => {
  const candidate = fixture('planned', { allowed_paths: ['platform/pipeline/'] });
  const other = fixture('in-progress', { allowed_paths: ['platform/pipeline/'] });
  other.task_id = 'TP-OTHER';
  const r = checkPathOverlapAgainstInFlight(candidate, [other]);
  assert.equal(r.ok, false);
  assert.equal(r.overlaps[0].other_task_id, 'TP-OTHER');
});
test('OVERLAP — prefix conflict (parent contains child)', () => {
  const candidate = fixture('planned', { allowed_paths: ['platform/'] });
  const other = fixture('in-progress', { allowed_paths: ['platform/pipeline/'] });
  other.task_id = 'TP-OTHER';
  const r = checkPathOverlapAgainstInFlight(candidate, [other]);
  assert.equal(r.ok, false);
});
test('OVERLAP — completed/abandoned tasks are NOT in-flight, no conflict', () => {
  const candidate = fixture('planned', { allowed_paths: ['platform/pipeline/'] });
  const other = fixture('merged', { allowed_paths: ['platform/pipeline/'] });
  other.task_id = 'TP-OTHER';
  const r = checkPathOverlapAgainstInFlight(candidate, [other]);
  assert.equal(r.ok, true);
});
test('OVERLAP — glob wildcard ** matches like prefix', () => {
  const candidate = fixture('planned', { allowed_paths: ['platform/pipeline/**'] });
  const other = fixture('in-progress', { allowed_paths: ['platform/pipeline/src/'] });
  other.task_id = 'TP-OTHER';
  const r = checkPathOverlapAgainstInFlight(candidate, [other]);
  assert.equal(r.ok, false);
});

// ─── invariants ───────────────────────────────────────────────────────────
test('SHIPPED_STATES + DISPATCHABLE_STATES are disjoint', () => {
  for (const s of SHIPPED_STATES) {
    assert.equal(DISPATCHABLE_STATES.includes(s), false, `${s} in both lists`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
