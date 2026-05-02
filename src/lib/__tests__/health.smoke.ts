/**
 * Smoke tests for systemHealth. Run via:
 *   pnpm auto:test:health
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runHealthChecks,
  checkProcessRegistry,
  checkAuditLogSize,
  checkStaleLocks,
  checkEscalations,
  checkTmpDrift,
  checkSessionHistoryDrift,
} from '../systemHealth';
import { harnessRoot as harnessRootFn } from '../harnessRoot';

let passed = 0, failed = 0;
function assert(c: unknown, l: string): void {
  if (c) { passed++; console.log(`  ✓ ${l}`); }
  else { failed++; console.error(`  ✗ ${l}`); }
}
function assertEq<T>(a: T, b: T, l: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${l}`); }
  else { failed++; console.error(`  ✗ ${l}\n      actual: ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); }
}

function tmpRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'health-smoke-'));
  fs.mkdirSync(path.join(r, '.agent-runs'), { recursive: true });
  return r;
}
function rm(r: string): void {
  try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ }
}

console.log('\n[health smoke] starting…\n');

// ─── 1. Empty harness root reports valid structure ──────────────────────────
{
  console.log('1. Empty harness root → all checks return valid structure');
  const root = tmpRoot();
  try {
    const r = runHealthChecks(root);
    // Note: tmp-drift reads the real /tmp so overall may not be 'ok'.
    // The shape + harness-root-specific checks should all be ok though.
    assert(['ok', 'info', 'warning', 'critical'].includes(r.overall), `overall is valid (${r.overall})`);
    assertEq(r.checks.length, 7, 'all 7 checks reported');
    const harnessSpecific = r.checks.filter((c) =>
      ['process-registry', 'audit-log-size', 'stale-locks', 'open-escalations', 'session-history-drift'].includes(c.id)
    );
    assert(harnessSpecific.every((c) => c.severity === 'ok'), 'all harness-root-scoped checks ok on empty root');
  } finally { rm(root); }
}

// ─── 2. Process registry size escalation ─────────────────────────────────────
{
  console.log('\n2. process-registry warnings + critical');
  const root = tmpRoot();
  try {
    const regPath = path.join(root, '.agent-runs', '_process-registry.json');
    // 12 entries → warning
    const big = Array.from({ length: 12 }, (_, i) => ({
      pid: 1000 + i, kind: 'codex-consensus', started_at: new Date().toISOString(),
      max_duration_sec: 900, command: 'x', host: os.hostname(),
      heartbeat_ttl_sec: 120, restart_policy: 'none',
    }));
    fs.writeFileSync(regPath, JSON.stringify(big));
    let c = checkProcessRegistry(root);
    assertEq(c.severity, 'warning', '12 entries → warning');
    // 30 entries → critical
    const bigger = Array.from({ length: 30 }, (_, i) => ({
      pid: 1000 + i, kind: 'codex-consensus', started_at: new Date().toISOString(),
      max_duration_sec: 900, command: 'x', host: os.hostname(),
      heartbeat_ttl_sec: 120, restart_policy: 'none',
    }));
    fs.writeFileSync(regPath, JSON.stringify(bigger));
    c = checkProcessRegistry(root);
    assertEq(c.severity, 'critical', '30 entries → critical');
  } finally { rm(root); }
}

// ─── 3. Audit log size escalation (synthetic) ────────────────────────────────
{
  console.log('\n3. audit-log-size thresholds');
  const root = tmpRoot();
  try {
    const auditPath = path.join(root, '.agent-runs', '_override-audit.jsonl');
    // Empty / missing → ok
    let c = checkAuditLogSize(root);
    assertEq(c.severity, 'ok', 'missing audit log → ok');
    // 200 MB → warning (truncate to that size)
    fs.writeFileSync(auditPath, '');
    fs.truncateSync(auditPath, 200 * 1024 * 1024);
    c = checkAuditLogSize(root);
    assertEq(c.severity, 'warning', '200 MB → warning');
    // 600 MB → critical
    fs.truncateSync(auditPath, 600 * 1024 * 1024);
    c = checkAuditLogSize(root);
    assertEq(c.severity, 'critical', '600 MB → critical');
  } finally { rm(root); }
}

// ─── 4. Stale locks detection (dead pid in pack.lock) ────────────────────────
{
  console.log('\n4. stale-locks check');
  const root = tmpRoot();
  try {
    const taskDir = path.join(root, '.agent-runs', 'test-run', 'tasks');
    fs.mkdirSync(taskDir, { recursive: true });
    // Pack with dead pid in lock
    const pack = {
      task_id: 'TP-2026-04-28-100',
      run_id: 'test-run',
      state: 'in-progress',
      lock: { pid: 2 ** 22, holder: 'fake', acquired_at: '', expires_at: '', last_heartbeat_at: '' },
    };
    fs.writeFileSync(path.join(taskDir, 'TP-2026-04-28-100.json'), JSON.stringify(pack));
    const c = checkStaleLocks(root);
    // Value is now a label that may include a "+N cross-host" suffix; coerce.
    assertEq(String(c.value).split(' ')[0], '1', 'one same-host stale-lock detected');
    assertEq(c.severity, 'warning', 'severity=warning');
  } finally { rm(root); }
}

// ─── 5. Escalations open count ───────────────────────────────────────────────
{
  console.log('\n5. open-escalations check');
  const root = tmpRoot();
  try {
    const escPath = path.join(root, '.agent-runs', '_escalation-log.jsonl');
    // 2 open + 1 cleared
    const open = JSON.stringify({ at: '2026-04-28T00:00:00Z', reason: 'consecutive-nogo', detail: 'a', detector: {} });
    const open2 = JSON.stringify({ at: '2026-04-28T00:00:01Z', reason: 'manual', detail: 'b', detector: {} });
    const cleared = JSON.stringify({ at: '2026-04-28T00:00:02Z', reason: 'manual', detail: 'c', detector: {}, cleared_by: 'op', cleared_at: '2026-04-28T00:01:00Z' });
    fs.writeFileSync(escPath, [open, open2, cleared].join('\n') + '\n');
    const c = checkEscalations(root);
    assertEq(c.value, 2, '2 open escalations counted');
    assertEq(c.severity, 'warning', 'severity=warning');
  } finally { rm(root); }
}

// ─── 6. Tmp + session-history are scanned (don't assert specific value, just severity is one of expected) ─
{
  console.log('\n6. tmp/session-history checks return valid severity');
  const tmpC = checkTmpDrift();
  assert(['ok', 'warning', 'critical'].includes(tmpC.severity), `tmp severity is valid (${tmpC.severity})`);
  const root = tmpRoot();
  try {
    const c = checkSessionHistoryDrift(root);
    assertEq(c.severity, 'ok', 'empty session-history → ok');
  } finally { rm(root); }
}

// ─── 7. runHealthChecks on real harness root produces a sane report ──────────
{
  console.log('\n7. runHealthChecks on real harness root');
  // v0.4.10: use the harnessRoot helper for layout-agnostic resolution
  const harnessRoot = harnessRootFn();
  const r = runHealthChecks(harnessRoot);
  assert(['ok', 'info', 'warning', 'critical'].includes(r.overall), 'overall is a valid severity');
  assertEq(r.checks.length, 7, 'all 7 checks present');
  assert(r.host.length > 0, 'host populated');
}

console.log(`\n[health smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
