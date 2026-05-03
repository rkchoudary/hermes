/**
 * Layer 1 — Cost admission smoke.
 *
 * Validates:
 *   - reserveBudget() refuses when no budget config (fail-closed doctrine)
 *   - reserveBudget() refuses when per-task cap would be exceeded
 *   - reserveBudget() returns ok=true with reservation_id under cap
 *   - recordSpend finalizes a reservation; second call rejects
 *   - releaseReservation marks status=released; idempotent
 *   - circuit breaker sentinel file forces all reservations to refuse
 *   - reapExpiredReservations transitions stale reservations → expired
 *
 * Uses HERMES_PROJECT_ROOT pointing at a tmp dir so we don't pollute
 * real .agent-runs state.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _resetHarnessRootCacheForTest } from '../harnessRoot';

// runState.ts (transitively imported by budget) calls harnessRoot() at
// module-load time, so the cached value is the REAL project root, not our
// tmp dir. Reset that cache after we set HERMES_PROJECT_ROOT, then late-
// import everything else so they resolve against tmp.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'l1-budget-smoke-'));
process.env.HERMES_PROJECT_ROOT = TMP;
fs.mkdirSync(path.join(TMP, '.agent-runs'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'package.json'), '{}');
_resetHarnessRootCacheForTest();

const { writeBudget } = await import('../budget');
type BudgetContract = import('../budget').BudgetContract;
const {
  reserveBudget,
  recordSpend,
  releaseReservation,
  engageCircuitBreaker,
  disengageCircuitBreaker,
  reapExpiredReservations,
  readReservations,
} = await import('../budgetReservation');

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('budgetReservation.smoke — Layer 1 cost admission');

// ─── 1. Fail-closed when no budget config ─────────────────────────────
console.log('\n1. Fail-closed when no budget config');
const noBudget = reserveBudget({
  stage: 'auto:work',
  engine: 'claude-code-cli',
  task_id: 'TP-test',
});
assert(!noBudget.ok, 'reserveBudget refuses with no config');
if (!noBudget.ok) {
  assert(noBudget.kind === 'meter-unavailable', 'kind=meter-unavailable on no config');
  assert(noBudget.reason.includes('fail closed'), 'reason mentions fail-closed doctrine');
}

// ─── 2. Seed budget config ────────────────────────────────────────────
console.log('\n2. Seed budget config');
const budget: BudgetContract = {
  schema_version: '1',
  windows: [{
    period: 'daily',
    cap_usd: 10,
    engage_threshold: 0.9,
    disengage_threshold: 0.7,
  }],
  cost_per_output_byte_usd: {
    'claude-code-cli': 0.000015,
    'codex-cli': 0.00001,
    'manual': 0,
  },
  per_task_cap_usd: 2,
  per_tenant_daily_cap_usd: 0,
};
writeBudget(TMP, budget);
assert(fs.existsSync(path.join(TMP, '.agent-runs', '_budget.json')), 'budget written to disk');

// ─── 3. Reserve under cap (gate stage = noop) ─────────────────────────
console.log('\n3. Reserve gate stage (noop, $0)');
const gate = reserveBudget({
  stage: 'auto:postflight',
  engine: 'claude-code-cli',
  task_id: 'TP-postflight',
});
assert(gate.ok, 'gate stage reservation succeeds');
if (gate.ok) {
  assert(gate.reservation_id.startsWith('noop-gate-'), 'gate reservation_id has noop-gate prefix');
  assert(gate.reserved_usd === 0, 'gate reservation $0');
}

// ─── 4. Reserve LLM stage (codex-cli, real $) ─────────────────────────
console.log('\n4. Reserve LLM stage (codex-cli, real $)');
// auto:consensus uses codex-cli with tokens_p95=120_000 → $1.20 estimated
const llm = reserveBudget({
  stage: 'auto:consensus',
  engine: 'codex-cli',
  task_id: 'TP-consensus-1',
});
assert(llm.ok, 'LLM stage reservation succeeds under per-task cap');
if (llm.ok) {
  assert(llm.reservation_id.startsWith('RSV-'), 'real reservation_id has RSV- prefix');
  assert(llm.reserved_usd > 0, `reserved_usd > 0 (got $${llm.reserved_usd.toFixed(4)})`);
}

// ─── 5. Reservation refuses when per-task cap would exceed ────────────
console.log('\n5. Per-task cap enforcement');
// Reserve another against same task_id; cumulative > $2 cap should refuse.
const llm2 = reserveBudget({
  stage: 'auto:consensus',
  engine: 'codex-cli',
  task_id: 'TP-consensus-1',  // same task
});
assert(!llm2.ok, 'second reservation against same task refused');
if (!llm2.ok) {
  assert(llm2.kind === 'budget-exceeded', 'kind=budget-exceeded');
  assert(llm2.cap === 'per-task', 'cap=per-task');
}

// ─── 6. recordSpend finalizes; second call rejects ────────────────────
console.log('\n6. recordSpend lifecycle');
if (llm.ok) {
  recordSpend(llm.reservation_id, 1.10);
  const after = readReservations().find((r) => r.reservation_id === llm.reservation_id);
  assert(after?.status === 'spent', `reservation status flipped to spent (got ${after?.status})`);
  assert(after?.actual_usd === 1.10, 'actual_usd recorded');
  // Second recordSpend should throw (already finalized).
  let threw = false;
  try { recordSpend(llm.reservation_id, 1.10); } catch { threw = true; }
  assert(threw, 'second recordSpend on same reservation throws');
}

// ─── 7. releaseReservation idempotent ─────────────────────────────────
console.log('\n7. releaseReservation idempotent');
const fresh = reserveBudget({
  stage: 'auto:diagnose',
  engine: 'claude-code-cli',
  task_id: 'TP-diagnose-1',
});
if (fresh.ok) {
  releaseReservation(fresh.reservation_id, 'dispatch never happened');
  const after = readReservations().find((r) => r.reservation_id === fresh.reservation_id);
  assert(after?.status === 'released', `released status (got ${after?.status})`);
  // Idempotent: second release is a noop, not throw.
  let threw = false;
  try { releaseReservation(fresh.reservation_id, 'second call'); } catch { threw = true; }
  assert(!threw, 'second release is idempotent (no throw)');
}

// ─── 8. Circuit breaker sentinel ──────────────────────────────────────
console.log('\n8. Circuit breaker sentinel');
engageCircuitBreaker('synthetic operator pause');
const cbDeny = reserveBudget({
  stage: 'auto:work',
  engine: 'codex-cli',  // use codex-cli so it's a non-zero estimate
  task_id: 'TP-cb',
});
assert(!cbDeny.ok, 'reservation refused while circuit breaker engaged');
if (!cbDeny.ok) {
  assert(cbDeny.kind === 'circuit-breaker', 'kind=circuit-breaker');
}
disengageCircuitBreaker();
const cbOk = reserveBudget({
  stage: 'auto:diagnose',
  engine: 'codex-cli',
  task_id: 'TP-after-cb',
});
assert(cbOk.ok, 'reservation succeeds after circuit breaker disengaged');

// ─── 9. Expired reservation reaper ────────────────────────────────────
console.log('\n9. Expired reservation reaper');
// reserve with 1-second TTL, wait 1.5s, reap.
const expiring = reserveBudget({
  stage: 'auto:diagnose',
  engine: 'codex-cli',
  task_id: 'TP-expire',
  ttl_sec: 1,
});
if (expiring.ok) {
  await new Promise((r) => setTimeout(r, 1500));
  const reaped = reapExpiredReservations();
  assert(reaped >= 1, `reaper expired ≥1 reservation (got ${reaped})`);
  const expired = readReservations().find((r) => r.reservation_id === expiring.reservation_id);
  assert(expired?.status === 'expired', `expired status (got ${expired?.status})`);
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
// Cleanup tmp dir.
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }
if (failed > 0) process.exit(1);
process.exit(0);
