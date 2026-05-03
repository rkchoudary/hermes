/**
 * Smoke for the claude → HermesWorkerEvent adapter.
 *
 * Validates:
 *   1. system.init → worker.session_init with claude_session_id
 *   2. assistant message with tool_use block → worker.tool_call event
 *   3. user message with tool_result block → worker.tool_result event
 *   4. result message → worker.session_end with duration + cost + usage
 *   5. Unknown message type → worker.error (lossless audit, not silent drop)
 *   6. Malformed JSON line → worker.error
 *   7. Multi-line chunk (partial last line) buffered correctly
 *   8. correlation_id is stable across one session
 *   9. host_observed_at is host-stamped (not from claude)
 *  10. Chain integrity preserved across all emitted events
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  openCollector,
  closeCollector,
  readEvents,
} from '../../events/eventCollector';
import { createAdapter, feedChunk, drainBuffer } from '../claudeStreamAdapter';

process.env.HERMES_EVENT_FSYNC_MODE = 'never';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-cstream-')); }

console.log('claudeStreamAdapter.smoke');

// ─── 1+2+3+4+8: full session round-trip ───────────────────────────────
console.log('\n1-4. Full session round-trip (init → tool_use → tool_result → result)');
const T1 = tmp();
const c = openCollector({ harnessRoot: T1, runId: 'R1', taskId: 'TP-cstream' });
const ad = createAdapter({ collector: c });

// Synthesize a realistic claude --output-format stream-json sequence
const lines = [
  // 1. system.init
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'sess-abc-123',
    cwd: '/work',
    model: 'claude-opus-4-7',
    tools: ['Read', 'Edit', 'Write', 'Bash'],
  }),
  // 2. assistant with tool_use
  JSON.stringify({
    type: 'assistant',
    session_id: 'sess-abc-123',
    message: {
      id: 'msg_01',
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will read the file.' },
        { type: 'tool_use', id: 'tu_01', name: 'Read', input: { file_path: '/work/sum.ts' } },
      ],
    },
  }),
  // 3. user with tool_result
  JSON.stringify({
    type: 'user',
    session_id: 'sess-abc-123',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_01', content: 'export function sum(a, b) { return 0; }', is_error: false },
      ],
    },
  }),
  // 4. assistant with another tool_use
  JSON.stringify({
    type: 'assistant',
    session_id: 'sess-abc-123',
    message: {
      id: 'msg_02',
      content: [
        { type: 'tool_use', id: 'tu_02', name: 'Edit', input: { file_path: '/work/sum.ts', old_string: 'return 0', new_string: 'return a + b' } },
      ],
    },
  }),
  // 5. tool_result for the edit
  JSON.stringify({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'tu_02', content: 'edited' },
      ],
    },
  }),
  // 6. result terminator
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 12_400,
    num_turns: 4,
    session_id: 'sess-abc-123',
    total_cost_usd: 0.045,
    usage: { input_tokens: 18_400, output_tokens: 320, cache_read_input_tokens: 12_000 },
    result: 'fixed sum.ts',
  }),
];
const blob = lines.join('\n') + '\n';
const emittedCount = feedChunk(ad, blob);
const flushed = drainBuffer(ad);
assert(emittedCount + flushed >= 6, `≥6 events emitted in one chunk feed (got ${emittedCount + flushed})`);

const r = readEvents(T1, 'R1', 'TP-cstream');
assert(r.chain.ok, `chain valid (reason=${r.chain.reason ?? 'none'})`);

// 1. session_init
const initEv = r.events.find((e) => e.kind === 'worker.session_init');
assert(initEv !== undefined, 'worker.session_init emitted');
assert(initEv?.payload?.claude_session_id === 'sess-abc-123', 'session_init carries claude_session_id');
assert(initEv?.payload?.model === 'claude-opus-4-7', 'session_init carries model');

// 2. tool_call
const toolCalls = r.events.filter((e) => e.kind === 'worker.tool_call');
assert(toolCalls.length === 2, `2 tool_call events (got ${toolCalls.length})`);
const readCall = toolCalls.find((e) => e.payload?.tool_name === 'Read');
const editCall = toolCalls.find((e) => e.payload?.tool_name === 'Edit');
assert(readCall !== undefined && editCall !== undefined, 'Read + Edit tool_calls present');
assert((readCall?.payload?.tool_input as Record<string, unknown> | undefined)?.file_path === '/work/sum.ts', 'tool_input carries file_path');

// 3. tool_result
const toolResults = r.events.filter((e) => e.kind === 'worker.tool_result');
assert(toolResults.length === 2, `2 tool_result events (got ${toolResults.length})`);
assert(toolResults[0].payload?.tool_use_id === 'tu_01', 'tool_result.tool_use_id matches tool_use.id');

// 4. session_end
const endEv = r.events.find((e) => e.kind === 'worker.session_end');
assert(endEv !== undefined, 'worker.session_end emitted');
assert(endEv?.payload?.duration_ms === 12_400, 'session_end carries duration_ms');
assert(endEv?.payload?.total_cost_usd === 0.045, 'session_end carries total_cost_usd');
assert((endEv?.payload?.usage as { input_tokens: number } | undefined)?.input_tokens === 18_400, 'session_end carries usage.input_tokens');

// 8. correlation_id stable across session
const corrIds = new Set(r.events.map((e) => e.correlation_id));
assert(corrIds.size === 1, `single correlation_id across the session (got ${corrIds.size})`);

// 9. host_observed_at is set + worker_emitted_at is null (claude doesn't ship timestamps)
const sample = r.events[0];
assert(typeof sample.host_observed_at === 'string' && sample.host_observed_at.length > 0, 'host_observed_at populated');
assert(sample.worker_emitted_at === null, 'worker_emitted_at = null when claude doesn\'t supply');

closeCollector('R1', 'TP-cstream');

// ─── 5. Unknown message type → worker.error (not silent drop) ─────────
console.log('\n5. Unknown message type lossless audit');
const T2 = tmp();
const c2 = openCollector({ harnessRoot: T2, runId: 'R2', taskId: 'TP-cstream2' });
const ad2 = createAdapter({ collector: c2 });
feedChunk(ad2, JSON.stringify({ type: 'experimental_new_type', payload: { foo: 'bar' } }) + '\n');
const r2 = readEvents(T2, 'R2', 'TP-cstream2');
const errEv = r2.events.find((e) => e.kind === 'worker.error');
assert(errEv !== undefined, 'unknown type recorded as worker.error');
assert(errEv?.payload?.reason === 'unknown-claude-message-type', 'unknown-type reason set');
closeCollector('R2', 'TP-cstream2');

// ─── 6. Malformed JSON → worker.error ──────────────────────────────────
console.log('\n6. Malformed JSON');
const T3 = tmp();
const c3 = openCollector({ harnessRoot: T3, runId: 'R3', taskId: 'TP-cstream3' });
const ad3 = createAdapter({ collector: c3 });
feedChunk(ad3, '{not valid json\n');
const r3 = readEvents(T3, 'R3', 'TP-cstream3');
const malformedEv = r3.events.find((e) => e.kind === 'worker.error' && e.payload?.reason === 'json-parse-error');
assert(malformedEv !== undefined, 'malformed JSON recorded as worker.error');
assert(ad3.stats.lines_malformed === 1, 'lines_malformed counter advanced');
closeCollector('R3', 'TP-cstream3');

// ─── 7. Multi-chunk + partial line buffering ──────────────────────────
console.log('\n7. Multi-chunk partial-line buffering');
const T4 = tmp();
const c4 = openCollector({ harnessRoot: T4, runId: 'R4', taskId: 'TP-cstream4' });
const ad4 = createAdapter({ collector: c4 });
const fullLine = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's4', model: 'm' });
// Split the line in three chunks
feedChunk(ad4, fullLine.slice(0, 20));
feedChunk(ad4, fullLine.slice(20, 40));
const beforeFlush = readEvents(T4, 'R4', 'TP-cstream4').events.length;
feedChunk(ad4, fullLine.slice(40) + '\n');
const afterFlush = readEvents(T4, 'R4', 'TP-cstream4').events.length;
assert(beforeFlush === 0, 'no events emitted while partial line buffered');
assert(afterFlush === 1, 'event emitted after final \\n delimiter');
closeCollector('R4', 'TP-cstream4');

// ─── 10. Chain integrity across many events ───────────────────────────
console.log('\n10. Chain integrity over many events');
const T5 = tmp();
const c5 = openCollector({ harnessRoot: T5, runId: 'R5', taskId: 'TP-cstream5' });
const ad5 = createAdapter({ collector: c5 });
// Synthesize 50 tool_call events
for (let i = 0; i < 50; i++) {
  feedChunk(ad5, JSON.stringify({
    type: 'assistant',
    message: {
      id: `msg_${i}`,
      content: [{ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { i } }],
    },
  }) + '\n');
}
const r5 = readEvents(T5, 'R5', 'TP-cstream5');
assert(r5.events.length >= 50, `≥50 events from 50 messages (got ${r5.events.length})`);
assert(r5.chain.ok, `chain valid across ${r5.events.length} events`);
closeCollector('R5', 'TP-cstream5');

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
