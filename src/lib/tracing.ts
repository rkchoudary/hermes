/**
 * OpenTelemetry tracing skeleton — emits OTLP spans for harness operations
 * (dispatch, codex-review, lock-acquire, evidence-bundle, …) when
 * @opentelemetry/api is installed AND OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Hard-deps are avoided: we lazy-load @opentelemetry/api so projects without
 * it pay zero cost. If unavailable, every span is a no-op that still threads
 * trace_id/span_id into the LogContext for the structured logger.
 *
 * Usage:
 *   import { startSpan } from './tracing';
 *   await startSpan('dispatch.claude-code-cli', { task_id, engine }, async (span) => {
 *     // ... work ...
 *     span.setAttribute('exit_code', 0);
 *   });
 */

import { withContextAsync, getCurrentContext, getLogger } from './logger';

const log = getLogger('tracing');

interface SpanLike {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: Error): void;
  end(): void;
  spanContext(): { traceId: string; spanId: string };
}

interface OtelApiSubset {
  trace: {
    getTracer(name: string): {
      startActiveSpan<T>(
        name: string,
        opts: { attributes?: Record<string, string | number | boolean> },
        fn: (span: SpanLike) => Promise<T> | T,
      ): Promise<T> | T;
    };
  };
  SpanStatusCode: { ERROR: number };
}

let cachedApi: OtelApiSubset | null | undefined;

function tryLoadOtel(): OtelApiSubset | null {
  if (cachedApi !== undefined) return cachedApi;
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.AUTO_TRACING !== '1') {
    cachedApi = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const api = require('@opentelemetry/api') as OtelApiSubset;
    cachedApi = api;
    log.info('OTel API loaded', { endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '(unset)' });
    return api;
  } catch {
    cachedApi = null;
    log.debug('OTel API not installed; tracing is a no-op');
    return null;
  }
}

export async function startSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: SpanLike) => Promise<T> | T,
): Promise<T> {
  const api = tryLoadOtel();
  if (!api) {
    // No-op fallback: still wrap in a context with synthesized trace ids so
    // the structured logger has something to log against.
    const traceId = randomHex(32);
    const spanId = randomHex(16);
    return withContextAsync({ trace_id: traceId, span_id: spanId }, async () => {
      const noopSpan: SpanLike = {
        setAttribute: () => undefined,
        recordException: () => undefined,
        end: () => undefined,
        spanContext: () => ({ traceId, spanId }),
      };
      return await fn(noopSpan);
    });
  }
  const tracer = api.trace.getTracer('claude-delivery-harness');
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    const sc = span.spanContext();
    return withContextAsync({ trace_id: sc.traceId, span_id: sc.spanId }, async () => {
      try {
        const out = await fn(span);
        span.end();
        return out;
      } catch (e) {
        span.recordException(e as Error);
        span.end();
        throw e;
      }
    });
  }) as Promise<T>;
}

function randomHex(chars: number): string {
  const bytes = Math.ceil(chars / 2);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const buf = require('node:crypto').randomBytes(bytes) as Buffer;
  return buf.toString('hex').slice(0, chars);
}

/** Best-effort: return whatever trace context is currently active. */
export function currentTraceContext(): { trace_id?: string; span_id?: string } {
  const ctx = getCurrentContext();
  return { trace_id: ctx.trace_id as string | undefined, span_id: ctx.span_id as string | undefined };
}
