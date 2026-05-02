/**
 * Structured JSON logger — drop-in replacement for console.{log,warn,error}
 * that emits one line of JSON per call (or plain text when AUTO_LOG_JSON is
 * unset/0). All log lines go to stderr so stdout stays clean for command
 * output that the operator pipes/parses.
 *
 * Standard fields on every line (when JSON):
 *   ts         — ISO 8601 with ms
 *   level      — debug | info | warn | error
 *   component  — module/CLI name (e.g. "work", "consensus", "watchdog")
 *   msg        — human-readable message
 *   task_id    — when set on the LogContext
 *   run_id     — when set on the LogContext
 *   trace_id   — when set on the LogContext (OTel span context, see tracing.ts)
 *   …          — arbitrary key/value pairs passed as the second arg
 *
 * Usage:
 *   import { getLogger, withContext } from './logger';
 *   const log = getLogger('work');
 *   log.info('dispatch complete', { engine: 'claude-code-cli', duration_ms: 558212 });
 *   withContext({ task_id: 'TP-…', run_id: '2026-04-27-batch-1' }, () => {
 *     log.info('starting round'); // includes task_id, run_id automatically
 *   });
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  task_id?: string;
  run_id?: string;
  trace_id?: string;
  span_id?: string;
  [key: string]: unknown;
}

const contextStorage = new AsyncLocalStorage<LogContext>();

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function activeLevel(): LogLevel {
  const env = (process.env.AUTO_LOG_LEVEL || 'info').toLowerCase();
  return (['debug', 'info', 'warn', 'error'] as const).includes(env as LogLevel)
    ? (env as LogLevel)
    : 'info';
}

function jsonMode(): boolean {
  return process.env.AUTO_LOG_JSON === '1' || process.env.AUTO_LOG_JSON === 'true';
}

function emit(component: string, level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
  if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[activeLevel()]) return;

  const ctx = contextStorage.getStore() ?? {};
  const ts = new Date().toISOString();

  if (jsonMode()) {
    const line = JSON.stringify({
      ts,
      level,
      component,
      msg,
      ...ctx,
      ...(extra ?? {}),
    });
    process.stderr.write(line + '\n');
    return;
  }

  // Plain-text mode for interactive dev. Compact prefix: TS LEVEL [component] msg key=val key=val
  const ctxStr = Object.entries({ ...ctx, ...(extra ?? {}) })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  process.stderr.write(`${ts} ${level.toUpperCase().padEnd(5)} [${component}] ${msg}${ctxStr ? ' ' + ctxStr : ''}\n`);
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(extraContext: LogContext): Logger;
}

export function getLogger(component: string, baseExtra?: Record<string, unknown>): Logger {
  return {
    debug(msg, extra) { emit(component, 'debug', msg, { ...baseExtra, ...extra }); },
    info(msg, extra) { emit(component, 'info', msg, { ...baseExtra, ...extra }); },
    warn(msg, extra) { emit(component, 'warn', msg, { ...baseExtra, ...extra }); },
    error(msg, extra) { emit(component, 'error', msg, { ...baseExtra, ...extra }); },
    child(extraContext) {
      return getLogger(component, { ...(baseExtra ?? {}), ...extraContext });
    },
  };
}

export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...(contextStorage.getStore() ?? {}), ...ctx };
  return contextStorage.run(merged, fn);
}

export async function withContextAsync<T>(ctx: LogContext, fn: () => Promise<T>): Promise<T> {
  const merged = { ...(contextStorage.getStore() ?? {}), ...ctx };
  return contextStorage.run(merged, fn);
}

export function getCurrentContext(): LogContext {
  return contextStorage.getStore() ?? {};
}
