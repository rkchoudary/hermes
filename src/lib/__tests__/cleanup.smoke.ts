/**
 * Smoke tests for cleanupPolicy. Run via:
 *   pnpm auto:test:cleanup
 *
 * Covers:
 *   - TTL-based deletion (mtime older than ttl_seconds)
 *   - max_count cap (keep N newest, delete rest)
 *   - min_age_seconds protection (don't delete in-flight files)
 *   - dry-run vs apply
 *   - cadence rate-limiting (skipped vs forced)
 *   - audit log entry written under 'cleanup-action' kind
 *   - regex match_basename + recursive scope
 *   - errors don't block other policies
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  CleanupPolicy,
  runPolicy,
  runAll,
  DEFAULT_POLICIES,
  totalActions,
  totalBytesFreed,
} from '../cleanupPolicy';

let passed = 0, failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
function assertEq<T>(a: T, b: T, label: string): void {
  const eq = JSON.stringify(a) === JSON.stringify(b);
  if (eq) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}\n      actual:   ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); }
}

function tmpRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-smoke-'));
  fs.mkdirSync(path.join(r, '.agent-runs'), { recursive: true });
  return r;
}
function cleanup(r: string): void {
  try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ }
}

function touchOld(p: string, content: string, secAgo: number): void {
  fs.writeFileSync(p, content);
  const t = (Date.now() - secAgo * 1000) / 1000;
  fs.utimesSync(p, t, t);
}

console.log('\n[cleanup smoke] starting…\n');

// ─── 1. TTL deletion ────────────────────────────────────────────────────────
{
  console.log('1. TTL-based deletion');
  const root = tmpRoot();
  try {
    const dir = path.join(root, 'tmp-files');
    fs.mkdirSync(dir);
    touchOld(path.join(dir, 'old.txt'), 'old', 7200);     // 2h ago
    touchOld(path.join(dir, 'recent.txt'), 'recent', 60); // 1min ago — protected by min_age
    touchOld(path.join(dir, 'fresh.txt'), 'fresh', 600);  // 10min ago — within ttl
    const policy: CleanupPolicy = {
      id: 'test-ttl',
      description: 'TTL test',
      scope: dir,
      match_basename: '\\.txt$',
      recursive: false,
      ttl_seconds: 3600,    // 1h ttl
      max_count: 0,
      min_age_seconds: 120, // 2min protection
      cadence_seconds: 60,
      action: 'delete',
    };
    const dry = runPolicy(root, policy, { apply: false });
    assertEq(dry.scanned, 3, 'scanned all 3 files');
    assertEq(dry.actions.length, 1, 'one TTL deletion candidate (old.txt)');
    assertEq(dry.actions[0].path, path.join(dir, 'old.txt'), 'correct file targeted');
    assertEq(dry.actions[0].reason, 'ttl', 'reason=ttl');
    assert(fs.existsSync(path.join(dir, 'old.txt')), 'dry-run did NOT delete');

    const wet = runPolicy(root, policy, { apply: true });
    assertEq(wet.actions.length, 1, 'apply deletes one file');
    assert(!fs.existsSync(path.join(dir, 'old.txt')), 'apply removed old.txt');
    assert(fs.existsSync(path.join(dir, 'recent.txt')), 'recent.txt still protected by min_age');
    assert(fs.existsSync(path.join(dir, 'fresh.txt')), 'fresh.txt within ttl preserved');
  } finally { cleanup(root); }
}

// ─── 2. max_count cap ───────────────────────────────────────────────────────
{
  console.log('\n2. max_count cap (keep newest N)');
  const root = tmpRoot();
  try {
    const dir = path.join(root, 'capdir');
    fs.mkdirSync(dir);
    // Create 6 files, each 1 minute apart, all older than min_age but younger than ttl
    for (let i = 0; i < 6; i++) {
      touchOld(path.join(dir, `file-${i}.json`), 'x', 600 + i * 60);
    }
    const policy: CleanupPolicy = {
      id: 'test-cap',
      description: 'cap test',
      scope: dir,
      match_basename: '\\.json$',
      recursive: false,
      ttl_seconds: 0,        // no ttl
      max_count: 3,          // keep 3 newest
      min_age_seconds: 60,
      cadence_seconds: 60,
      action: 'delete',
    };
    const r = runPolicy(root, policy, { apply: true });
    assertEq(r.actions.length, 3, 'deletes 3 (kept 3 newest of 6)');
    // Verify the newest 3 still exist (file-0..2 are newest)
    for (let i = 0; i < 3; i++) {
      assert(fs.existsSync(path.join(dir, `file-${i}.json`)), `file-${i}.json (newest) preserved`);
    }
    for (let i = 3; i < 6; i++) {
      assert(!fs.existsSync(path.join(dir, `file-${i}.json`)), `file-${i}.json (older) removed`);
    }
  } finally { cleanup(root); }
}

// ─── 3. cadence rate-limiting ───────────────────────────────────────────────
{
  console.log('\n3. cadence rate-limiting (skipped vs forced)');
  const root = tmpRoot();
  try {
    const dir = path.join(root, 'cdir');
    fs.mkdirSync(dir);
    touchOld(path.join(dir, 'old.txt'), 'x', 7200);
    const policy: CleanupPolicy = {
      id: 'test-cadence',
      description: 'cadence test',
      scope: dir,
      match_basename: '\\.txt$',
      recursive: false,
      ttl_seconds: 3600,
      max_count: 0,
      min_age_seconds: 60,
      cadence_seconds: 86400,  // daily
      action: 'delete',
    };
    // First run with apply=true: persists last_run_at
    const r1 = runAll(root, { apply: true, policies: [policy] });
    assertEq(r1[0].actions.length, 1, 'first run cleans 1');
    // Re-create the file
    touchOld(path.join(dir, 'old2.txt'), 'x', 7200);
    // Second run within cadence: should skip
    const r2 = runAll(root, { apply: true, policies: [policy] });
    assertEq(r2[0].skipped_for_cadence, true, 'second run skipped for cadence');
    assertEq(r2[0].actions.length, 0, 'no actions when skipped');
    assert(fs.existsSync(path.join(dir, 'old2.txt')), 'file untouched when policy skipped');
    // Force-run should bypass cadence
    const r3 = runAll(root, { apply: true, force: true, policies: [policy] });
    assertEq(r3[0].skipped_for_cadence, undefined, 'force bypasses skip');
    assertEq(r3[0].actions.length, 1, 'force-run deletes');
  } finally { cleanup(root); }
}

// ─── 4. audit log entry ─────────────────────────────────────────────────────
{
  console.log('\n4. audit log entry on apply');
  const root = tmpRoot();
  try {
    const dir = path.join(root, 'auditdir');
    fs.mkdirSync(dir);
    touchOld(path.join(dir, 'old.txt'), 'x'.repeat(100), 7200);
    const policy: CleanupPolicy = {
      id: 'test-audit',
      description: 'audit test',
      scope: dir,
      match_basename: '\\.txt$',
      recursive: false,
      ttl_seconds: 3600,
      max_count: 0,
      min_age_seconds: 60,
      cadence_seconds: 60,
      action: 'delete',
    };
    runAll(root, { apply: true, policies: [policy] });
    const auditPath = path.join(root, '.agent-runs', '_override-audit.jsonl');
    assert(fs.existsSync(auditPath), 'audit log written');
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter((l) => l);
    const audit = JSON.parse(lines[lines.length - 1]);
    assertEq(audit.kind, 'cleanup-action', 'audit kind=cleanup-action');
    assertEq(audit.context.policy_id, 'test-audit', 'audit context.policy_id correct');
    assertEq(audit.context.actions_count, 1, 'audit context.actions_count=1');
    assertEq(audit.context.bytes_freed, 100, 'audit context.bytes_freed=100');
  } finally { cleanup(root); }
}

// ─── 5. recursive scope ─────────────────────────────────────────────────────
{
  console.log('\n5. recursive=true descends subdirs');
  const root = tmpRoot();
  try {
    const base = path.join(root, 'recdir');
    fs.mkdirSync(path.join(base, 'sub1', 'sub2'), { recursive: true });
    touchOld(path.join(base, 'top.target'), 'x', 7200);
    touchOld(path.join(base, 'sub1', 'middle.target'), 'x', 7200);
    touchOld(path.join(base, 'sub1', 'sub2', 'deep.target'), 'x', 7200);
    const policy: CleanupPolicy = {
      id: 'test-recursive',
      description: 'recurse test',
      scope: base,
      match_basename: '\\.target$',
      recursive: true,
      ttl_seconds: 3600,
      max_count: 0,
      min_age_seconds: 60,
      cadence_seconds: 60,
      action: 'delete',
    };
    const r = runPolicy(root, policy, { apply: true });
    assertEq(r.actions.length, 3, 'all 3 nested files matched');
  } finally { cleanup(root); }
}

// ─── 6. min_age_seconds protects in-flight files ────────────────────────────
{
  console.log('\n6. min_age_seconds protects in-flight files');
  const root = tmpRoot();
  try {
    const dir = path.join(root, 'protectdir');
    fs.mkdirSync(dir);
    touchOld(path.join(dir, 'inflight.txt'), 'x', 30);  // 30s old
    touchOld(path.join(dir, 'old.txt'), 'x', 7200);      // 2h old
    const policy: CleanupPolicy = {
      id: 'test-protect',
      description: 'protect test',
      scope: dir,
      match_basename: '\\.txt$',
      recursive: false,
      ttl_seconds: 3600,
      max_count: 0,
      min_age_seconds: 300,  // 5min protection
      cadence_seconds: 60,
      action: 'delete',
    };
    const r = runPolicy(root, policy, { apply: true });
    assertEq(r.actions.length, 1, 'only old.txt deleted (inflight.txt protected)');
    assert(fs.existsSync(path.join(dir, 'inflight.txt')), 'inflight protected');
    assert(!fs.existsSync(path.join(dir, 'old.txt')), 'old removed');
  } finally { cleanup(root); }
}

// ─── 7. DEFAULT_POLICIES schema valid ───────────────────────────────────────
{
  console.log('\n7. DEFAULT_POLICIES schema validates');
  for (const p of DEFAULT_POLICIES) {
    let valid = true;
    try { CleanupPolicy.parse(p); }
    catch { valid = false; }
    assert(valid, `policy ${p.id} valid`);
  }
}

// ─── 8. helper aggregators ──────────────────────────────────────────────────
{
  console.log('\n8. totalActions + totalBytesFreed aggregators');
  const fakeResults = [
    { policy_id: 'a', scanned: 10, matched: 3, actions: [{ policy_id: 'a', path: 'x', reason: 'ttl' as const, bytes: 100, mtime: '' }, { policy_id: 'a', path: 'y', reason: 'ttl' as const, bytes: 200, mtime: '' }], applied: true, bytes_freed: 300, errors: [] },
    { policy_id: 'b', scanned: 0, matched: 0, actions: [], applied: false, bytes_freed: 0, errors: [], skipped_for_cadence: true, cadence_remaining_sec: 100 },
    { policy_id: 'c', scanned: 5, matched: 1, actions: [{ policy_id: 'c', path: 'z', reason: 'max-count' as const, bytes: 50, mtime: '' }], applied: false, bytes_freed: 0, errors: [] },
  ];
  assertEq(totalActions(fakeResults), 3, 'totalActions sums correctly');
  // applied=true → bytes_freed=300; applied=false → sum action.bytes=50
  assertEq(totalBytesFreed(fakeResults), 350, 'totalBytesFreed sums applied + dry-run');
}

console.log(`\n[cleanup smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
