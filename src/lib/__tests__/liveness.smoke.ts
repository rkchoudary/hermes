/**
 * Smoke for assessLiveness. Pure function, so tests are dense:
 * synthesize event histories + supervisor inputs, assert verdict.
 */
import { assessLiveness, type LivenessInputs, type VerdictKind } from '../liveness';
import type { HermesWorkerEventV1 } from '../events/hermesWorkerEvent';
import { buildEvent, GENESIS_CHAIN_HASH } from '../events/hermesWorkerEvent';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function ev(kind: HermesWorkerEventV1['kind'], ageSec: number, payload: Record<string, unknown> = {}, prevHash = GENESIS_CHAIN_HASH, seq = 0): HermesWorkerEventV1 {
  const ts = new Date(Date.now() - ageSec * 1000).toISOString();
  return buildEvent({
    monotonic_seq: seq,
    source: 'worker',
    kind,
    payload,
    prev_chain_hash: prevHash,
    harness_version: 'h-test',
    host_observed_at: ts,
  });
}

console.log('liveness.smoke');

// 1. Empty events + no supervisor signals → low_signal_active
console.log('\n1. Empty inputs');
const v1 = assessLiveness({ events: [] });
assert(['low_signal_active', 'no_recent_control_events'].includes(v1.kind), `empty input → low_signal/no_recent (got ${v1.kind})`);

// 2. Container exited → confirmed_terminated, sigkill-and-reap
console.log('\n2. Container exited');
const v2 = assessLiveness({
  events: [],
  container_state: 'exited',
  container_exit_code: 137,
});
assert(v2.kind === 'confirmed_terminated', `container exit → confirmed_terminated (got ${v2.kind})`);
assert(v2.recommended_action === 'sigkill-and-reap', 'recommended_action=sigkill-and-reap');
assert(v2.confidence === 1.0, 'confidence=1.0');

// 3. session_end ok → completed, continue
console.log('\n3. Engine self-completion');
const v3 = assessLiveness({
  events: [ev('worker.session_end', 5, { is_error: false, duration_ms: 12_000, total_cost_usd: 0.04 })],
});
assert(v3.kind === 'completed', `session_end → completed (got ${v3.kind})`);
assert(v3.recommended_action === 'continue', 'v3 continue');

// 4. Recent tool calls → active
console.log('\n4. Active tooling');
const v4 = assessLiveness({
  events: [
    ev('worker.tool_call', 5, { tool_name: 'Read' }),
    ev('worker.tool_call', 10, { tool_name: 'Edit' }),
  ],
});
assert(v4.kind === 'active', `recent tool_calls → active (got ${v4.kind})`);
assert(v4.recommended_action === 'continue', 'v4 continue');

// 5. Heartbeat lost (30s+) → heartbeat_lost, log-warning
console.log('\n5. Heartbeat missing');
const v5 = assessLiveness({
  events: [ev('worker.tool_call', 60)],
  heartbeat_age_s: 45,
});
assert(v5.kind === 'heartbeat_lost', `heartbeat 45s → heartbeat_lost (got ${v5.kind})`);
assert(v5.recommended_action === 'log-warning', 'v5 log-warning');

// 6. Heartbeat terminal (300s+) → confirmed_terminated, sigkill-and-reap
console.log('\n6. Heartbeat terminal');
const v6 = assessLiveness({
  events: [ev('worker.tool_call', 60)],
  heartbeat_age_s: 600,
});
assert(v6.kind === 'confirmed_terminated', `heartbeat 600s → confirmed_terminated (got ${v6.kind})`);
assert(v6.recommended_action === 'sigkill-and-reap', 'v6 sigkill');

// 7. FS mutation but no events → recent_filesystem_activity
console.log('\n7. Filesystem activity proxy');
const v7 = assessLiveness({
  events: [ev('worker.tool_call', 90)],   // last event >60s ago, so not 'active'
  fs_mutations_last_60s: 5,
});
assert(v7.kind === 'recent_filesystem_activity', `fs activity → recent_filesystem_activity (got ${v7.kind})`);
assert(v7.recommended_action === 'continue', 'v7 continue');

// 8. Tool call without result for >quiet_warn → awaiting_tool
console.log('\n8. Awaiting tool result');
const v8 = assessLiveness({
  events: [ev('worker.tool_call', 90, { tool_name: 'Bash' })],
});
assert(v8.kind === 'awaiting_tool', `unmatched tool_call >60s → awaiting_tool (got ${v8.kind})`);
assert(v8.recommended_action === 'continue', 'v8 continue');

// 9. Awaiting tool past sigterm threshold
console.log('\n9. Awaiting tool past SIGTERM');
const v9 = assessLiveness({
  events: [ev('worker.tool_call', 700, { tool_name: 'Bash' })],
});
assert(v9.kind === 'awaiting_tool', `still awaiting_tool kind (got ${v9.kind})`);
assert(v9.recommended_action === 'sigterm', `sigterm beyond quiet_sigterm_s (got ${v9.recommended_action})`);

// 10. CPU low + anthropic egress + matched tool result → awaiting_model
//     (i.e. tool finished, claude is now thinking about the result)
console.log('\n10. Awaiting model');
const tcAt100 = ev('worker.tool_call', 100, { tool_name: 'Read' });
const trAt95 = buildEvent({
  monotonic_seq: 1,
  source: 'worker',
  kind: 'worker.tool_result',
  payload: { tool_use_id: 'tu_x', is_error: false },
  prev_chain_hash: tcAt100.chain_hash,
  harness_version: 'h-test',
  host_observed_at: new Date(Date.now() - 95_000).toISOString(),
});
const v10 = assessLiveness({
  events: [tcAt100, trAt95],
  container_cpu_pct: 1.2,
  container_anthropic_egress_bytes_per_s: 800,
});
assert(v10.kind === 'awaiting_model', `low CPU + egress + no unmatched tool → awaiting_model (got ${v10.kind})`);
assert(v10.recommended_action === 'continue', 'v10 continue');
assert(v10.confidence >= 0.7, `confidence reasonable (got ${v10.confidence})`);

// 11. Quiet >sigterm threshold + no progress signals → no_recent_control_events + sigterm
console.log('\n11. Total silence');
const tcOld = ev('worker.tool_call', 700);
const trOld = buildEvent({
  monotonic_seq: 1,
  source: 'worker',
  kind: 'worker.tool_result',
  payload: { tool_use_id: 'tu_y', is_error: false },
  prev_chain_hash: tcOld.chain_hash,
  harness_version: 'h-test',
  host_observed_at: new Date(Date.now() - 700_000).toISOString(),
});
const v11 = assessLiveness({
  events: [tcOld, trOld],
  fs_mutations_last_60s: 0,
  container_cpu_pct: 0.1,
  container_anthropic_egress_bytes_per_s: 0,
});
assert(v11.kind === 'no_recent_control_events', `silent worker → no_recent (got ${v11.kind})`);
assert(v11.recommended_action === 'sigterm', `sigterm at silence (got ${v11.recommended_action})`);

// 12. Verdict carries observed_at + supporting_signals
console.log('\n12. Verdict structure');
assert(typeof v10.observed_at === 'string' && v10.observed_at.length > 0, 'observed_at populated');
assert(typeof v10.supporting_signals === 'object', 'supporting_signals is an object');
assert(typeof v10.primary_signal === 'string', 'primary_signal labeled');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
