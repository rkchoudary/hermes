/**
 * PA3 — Claude stream adapter (production-hardened).
 *
 * Bridges claude-code-cli's `--output-format stream-json --verbose`
 * stream into the canonical HermesWorkerEvent ledger.
 *
 * Codex critique honored: "Make it a versioned adapter:
 * ClaudeStreamEventV1 → HermesWorkerEventV1. Do not leak Claude's raw
 * schema into your control plane."
 *
 * Wire format (Anthropic Claude Code SDK docs):
 *   - Each line of stdout is one JSON message
 *   - Top-level `type` discriminator: 'system' | 'assistant' | 'user' |
 *     'result' (others may exist; we tolerate unknown gracefully)
 *   - 'system' with subtype='init' opens the session
 *   - 'assistant' messages contain content blocks (text, tool_use)
 *   - 'user' messages typically wrap tool_result content
 *   - 'result' is the terminal event with success/error subtype
 *
 * This adapter parses each line, validates against the V1 wire schema
 * (a permissive zod model — claude's schema can add fields without
 * breaking us), and emits one or more HermesWorkerEvent records to the
 * collector. Any line that fails to parse is logged as a worker.error
 * event with the raw payload so audit can replay even malformed traffic.
 *
 * Hardening:
 *   - Line-buffering: handles partial chunks across stdout 'data' events
 *   - Schema versioning: ClaudeStreamMessage validation tolerant of new
 *     subtypes; rejection only on missing `type` discriminator
 *   - Correlation: one correlation_id per claude session (set on init);
 *     joins all events from that turn
 *   - Unknown event types are recorded (not silently dropped)
 */
import { z } from 'zod';
import {
  appendEvent,
  type CollectorState,
} from '../events/eventCollector';
import {
  type HermesWorkerEventKind,
  type HermesEventSource,
} from '../events/hermesWorkerEvent';
import * as crypto from 'node:crypto';

// ─── Wire schemas ───────────────────────────────────────────────────────
//
// These describe what claude-code-cli emits. Permissive — we don't fail
// the adapter on field additions (`passthrough()` everywhere).

const ClaudeContentBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
  z.object({
    type: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string(),
    input: z.record(z.unknown()).optional(),
  }).passthrough(),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string().optional(),
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
  }).passthrough(),
  z.object({
    type: z.literal('thinking'),
    thinking: z.string().optional(),
  }).passthrough(),
]).or(z.object({ type: z.string() }).passthrough());

const ClaudeAssistantMessage = z.object({
  type: z.literal('assistant'),
  message: z.object({
    id: z.string().optional(),
    role: z.literal('assistant').optional(),
    content: z.array(ClaudeContentBlock).optional(),
    stop_reason: z.string().nullable().optional(),
  }).passthrough().optional(),
  session_id: z.string().optional(),
}).passthrough();

const ClaudeUserMessage = z.object({
  type: z.literal('user'),
  message: z.object({
    role: z.literal('user').optional(),
    content: z.array(ClaudeContentBlock).optional(),
  }).passthrough().optional(),
  session_id: z.string().optional(),
}).passthrough();

const ClaudeSystemMessage = z.object({
  type: z.literal('system'),
  subtype: z.string().optional(),
  session_id: z.string().optional(),
  cwd: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
}).passthrough();

const ClaudeResultMessage = z.object({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  session_id: z.string().optional(),
  result: z.unknown().optional(),
  total_cost_usd: z.number().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

const ClaudeUnknownMessage = z.object({
  type: z.string(),
}).passthrough();

const ClaudeStreamMessage = z.union([
  ClaudeAssistantMessage,
  ClaudeUserMessage,
  ClaudeSystemMessage,
  ClaudeResultMessage,
  ClaudeUnknownMessage,
]);
export type ClaudeStreamMessage = z.infer<typeof ClaudeStreamMessage>;

// ─── Adapter state (per claude session) ─────────────────────────────────

export interface AdapterContext {
  /** The collector that receives all transformed events. */
  collector: CollectorState;
  /** Single correlation_id for the entire claude session. Set on
   *  worker.session_init. */
  correlation_id: string;
  /** Set when claude emits its first system.init. Used as emitter_id
   *  on every subsequent event. */
  claude_session_id: string | null;
  /** Container ID + image digest if the session is running in docker
   *  mode. Stamped onto every worker event. */
  container_id?: string;
  image_digest?: string;
  /** Counters for diagnostic metrics. */
  stats: {
    lines_received: number;
    lines_parsed: number;
    lines_malformed: number;
    events_emitted: number;
    last_event_at: string | null;
  };
  /** Internal: stdout chunk buffer for line splitting. */
  buffer: string;
}

export function createAdapter(opts: {
  collector: CollectorState;
  container_id?: string;
  image_digest?: string;
}): AdapterContext {
  return {
    collector: opts.collector,
    correlation_id: crypto.randomUUID(),
    claude_session_id: null,
    container_id: opts.container_id,
    image_digest: opts.image_digest,
    stats: {
      lines_received: 0,
      lines_parsed: 0,
      lines_malformed: 0,
      events_emitted: 0,
      last_event_at: null,
    },
    buffer: '',
  };
}

// ─── Line-buffered ingestion ────────────────────────────────────────────

/**
 * Feed a chunk of stdout from claude --print --output-format stream-json.
 * Splits on newlines, accumulates partial lines in the buffer, processes
 * complete lines.
 *
 * Returns the count of events emitted by this chunk. Never throws —
 * malformed lines become worker.error events instead.
 */
export function feedChunk(ctx: AdapterContext, chunk: string | Buffer): number {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  ctx.buffer += text;
  const newlineIdx = ctx.buffer.lastIndexOf('\n');
  if (newlineIdx === -1) return 0;
  const completeChunk = ctx.buffer.slice(0, newlineIdx);
  ctx.buffer = ctx.buffer.slice(newlineIdx + 1);
  const lines = completeChunk.split('\n');
  let emitted = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    ctx.stats.lines_received++;
    emitted += processLine(ctx, trimmed);
  }
  return emitted;
}

/**
 * Drain any partial line at session end. Called when claude exits;
 * any trailing text in the buffer is treated as one final line.
 */
export function drainBuffer(ctx: AdapterContext): number {
  if (ctx.buffer.trim() === '') return 0;
  const final = ctx.buffer;
  ctx.buffer = '';
  ctx.stats.lines_received++;
  return processLine(ctx, final.trim());
}

function processLine(ctx: AdapterContext, line: string): number {
  // Parse JSON
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    ctx.stats.lines_malformed++;
    emitOne(ctx, {
      kind: 'worker.error',
      payload: {
        reason: 'json-parse-error',
        line: line.slice(0, 500),
      },
    });
    return 1;
  }
  // Validate
  const parsed = ClaudeStreamMessage.safeParse(raw);
  if (!parsed.success) {
    ctx.stats.lines_malformed++;
    emitOne(ctx, {
      kind: 'worker.error',
      payload: {
        reason: 'schema-validation-failed',
        zod_error: parsed.error.message,
        raw: typeof raw === 'object' ? raw : { value: raw },
      },
    });
    return 1;
  }
  ctx.stats.lines_parsed++;
  return transform(ctx, parsed.data);
}

// ─── Transform: ClaudeStreamMessage → HermesWorkerEventV1 ───────────────

function transform(ctx: AdapterContext, msg: ClaudeStreamMessage): number {
  let count = 0;
  switch (msg.type) {
    case 'system': {
      const sys = msg as z.infer<typeof ClaudeSystemMessage>;
      if (sys.subtype === 'init') {
        ctx.claude_session_id = sys.session_id ?? null;
        emitOne(ctx, {
          kind: 'worker.session_init',
          payload: {
            claude_session_id: sys.session_id,
            cwd: sys.cwd,
            model: sys.model,
            tools_available: sys.tools,
          },
        });
        count++;
      } else {
        // Unknown system subtype — log + continue
        emitOne(ctx, {
          kind: 'worker.message_start',
          payload: { system_subtype: sys.subtype, raw: sys },
        });
        count++;
      }
      break;
    }
    case 'assistant': {
      const am = msg as z.infer<typeof ClaudeAssistantMessage>;
      const content = am.message?.content ?? [];
      // Emit message_start once at the start of the content array
      emitOne(ctx, {
        kind: 'worker.message_start',
        payload: { message_id: am.message?.id, role: 'assistant' },
      });
      count++;
      // Each content block becomes an event
      for (const block of content) {
        const t = (block as { type: string }).type;
        if (t === 'tool_use') {
          const tu = block as { type: 'tool_use'; id?: string; name: string; input?: Record<string, unknown> };
          emitOne(ctx, {
            kind: 'worker.tool_call',
            payload: {
              tool_use_id: tu.id,
              tool_name: tu.name,
              tool_input: tu.input ?? {},
            },
          });
          count++;
        } else if (t === 'text') {
          const text = (block as { type: 'text'; text: string }).text;
          emitOne(ctx, {
            kind: 'worker.message_start',
            payload: {
              text_chunk: text.slice(0, 2000),
              text_chunk_truncated: text.length > 2000,
            },
          });
          count++;
        }
        // 'thinking' blocks intentionally NOT logged in detail (privacy +
        // doctrine: don't anthropomorphize). Just record presence.
        else if (t === 'thinking') {
          emitOne(ctx, {
            kind: 'worker.message_start',
            payload: { content_block: 'thinking', present: true },
          });
          count++;
        }
      }
      // message_stop if stop_reason present
      if (am.message?.stop_reason) {
        emitOne(ctx, {
          kind: 'worker.message_stop',
          payload: {
            message_id: am.message.id,
            stop_reason: am.message.stop_reason,
          },
        });
        count++;
      }
      break;
    }
    case 'user': {
      const um = msg as z.infer<typeof ClaudeUserMessage>;
      const content = um.message?.content ?? [];
      for (const block of content) {
        const t = (block as { type: string }).type;
        if (t === 'tool_result') {
          const tr = block as { type: 'tool_result'; tool_use_id?: string; content?: unknown; is_error?: boolean };
          emitOne(ctx, {
            kind: 'worker.tool_result',
            payload: {
              tool_use_id: tr.tool_use_id,
              is_error: tr.is_error ?? false,
              // Truncate content to 4 KB — full content is in raw stdout
              content_preview: typeof tr.content === 'string'
                ? tr.content.slice(0, 4000)
                : JSON.stringify(tr.content).slice(0, 4000),
            },
          });
          count++;
        }
      }
      break;
    }
    case 'result': {
      const rs = msg as z.infer<typeof ClaudeResultMessage>;
      emitOne(ctx, {
        kind: 'worker.session_end',
        payload: {
          subtype: rs.subtype,
          is_error: rs.is_error ?? false,
          duration_ms: rs.duration_ms,
          num_turns: rs.num_turns,
          total_cost_usd: rs.total_cost_usd,
          usage: rs.usage,
          result_preview: typeof rs.result === 'string'
            ? rs.result.slice(0, 4000)
            : rs.result,
        },
      });
      count++;
      break;
    }
    default: {
      // Unknown type — preserved as worker.error so the audit isn't lossy
      emitOne(ctx, {
        kind: 'worker.error',
        payload: {
          reason: 'unknown-claude-message-type',
          raw_type: (msg as { type: string }).type,
          raw: msg,
        },
      });
      count++;
      break;
    }
  }
  return count;
}

function emitOne(ctx: AdapterContext, opts: {
  kind: HermesWorkerEventKind;
  payload: Record<string, unknown>;
}): void {
  const source: HermesEventSource = 'worker';
  const event = appendEvent(ctx.collector, {
    source,
    kind: opts.kind,
    payload: opts.payload,
    correlation_id: ctx.correlation_id,
    task_id: ctx.collector.taskId,
    run_id: ctx.collector.runId,
    emitter_id: ctx.claude_session_id ?? 'claude-code-cli',
    container_id: ctx.container_id,
    image_digest: ctx.image_digest,
    worker_emitted_at: null,                // claude doesn't include explicit timestamps; host-stamp wins
  });
  ctx.stats.events_emitted++;
  ctx.stats.last_event_at = event.host_observed_at;
}
