#!/usr/bin/env tsx
/**
 * Smoke test for src/lib/logger.ts + src/lib/tracing.ts.
 *
 * Validates:
 *   1. Plain-text mode renders sensibly.
 *   2. JSON mode emits one valid JSON object per line with required fields.
 *   3. withContext propagates context into nested logger calls.
 *   4. tracing.startSpan in no-op mode still threads trace_id/span_id into ctx.
 *   5. child() inherits component + base extra.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function runChild(env: Record<string, string>, body: string): string[] {
  // Use the project's local tsx binary directly. Avoids npx's resolve-and-
  // download chatter that pollutes stderr when many smokes spawn in parallel
  // (caught by run-smoke-parallel.mjs runner). Same execution semantics; just
  // skips npx's PATH probe + tarball-cache messages.
  const tsxBin = path.resolve(__dirname, '../../../node_modules/.bin/tsx');
  const child = spawnSync(tsxBin, ['-e', body], {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    throw new Error(`child exit=${child.status}\nstdout=${child.stdout}\nstderr=${child.stderr}`);
  }
  // Logger writes to stderr. Filter to lines that LOOK like logger output —
  // either JSON ({"…) or plain-text-mode (ISO-timestamp prefix). This makes
  // the test robust against any stray stderr from the runtime / loaders.
  const looksLikeLog = (l: string) => l.startsWith('{') || /^\d{4}-\d{2}-\d{2}T/.test(l);
  return child.stderr.trim().split('\n').filter((l) => l.length > 0 && looksLikeLog(l));
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

console.log('— logger.smoke');

// 1. Plain-text mode
{
  const lines = runChild({ AUTO_LOG_JSON: '0', AUTO_LOG_LEVEL: 'debug' }, `
    import { getLogger } from '${path.resolve(__dirname, '../logger.ts')}';
    const log = getLogger('test');
    log.info('hello world', { task_id: 'TP-1', count: 7 });
    log.warn('careful');
    log.debug('low-noise');
  `);
  assert(lines.length === 3, `plain-text: 3 lines, got ${lines.length}`);
  assert(lines[0].includes('[test] hello world'), 'plain-text: includes component + msg');
  assert(lines[0].includes('task_id=TP-1'), 'plain-text: includes task_id key=value');
  assert(lines[0].includes('count=7'), 'plain-text: includes count key=value');
  assert(lines[1].includes('WARN '), 'plain-text: WARN level rendered');
  assert(lines[2].includes('DEBUG'), 'plain-text: DEBUG level rendered');
}

// 2. JSON mode — one parseable line per call, has required fields.
{
  const lines = runChild({ AUTO_LOG_JSON: '1', AUTO_LOG_LEVEL: 'info' }, `
    import { getLogger } from '${path.resolve(__dirname, '../logger.ts')}';
    const log = getLogger('test');
    log.info('json line', { task_id: 'TP-2', engine: 'claude-code-cli' });
  `);
  assert(lines.length === 1, `json: exactly 1 line`);
  const obj = JSON.parse(lines[0]);
  assert(typeof obj.ts === 'string' && obj.ts.endsWith('Z'), 'json: ts is ISO');
  assert(obj.level === 'info', 'json: level=info');
  assert(obj.component === 'test', 'json: component');
  assert(obj.msg === 'json line', 'json: msg');
  assert(obj.task_id === 'TP-2', 'json: task_id');
  assert(obj.engine === 'claude-code-cli', 'json: engine');
}

// 3. withContext propagation — nested logger inherits ctx.
{
  const lines = runChild({ AUTO_LOG_JSON: '1', AUTO_LOG_LEVEL: 'info' }, `
    import { getLogger, withContext } from '${path.resolve(__dirname, '../logger.ts')}';
    const log = getLogger('test');
    withContext({ task_id: 'TP-3', run_id: 'R-A' }, () => {
      log.info('inside ctx');
      withContext({ trace_id: 'T-1' }, () => {
        log.info('nested ctx');
      });
    });
    log.info('outside ctx');
  `);
  assert(lines.length === 3, 'withContext: 3 lines');
  const a = JSON.parse(lines[0]); const b = JSON.parse(lines[1]); const c = JSON.parse(lines[2]);
  assert(a.task_id === 'TP-3' && a.run_id === 'R-A', 'withContext: outer has task_id+run_id');
  assert(b.task_id === 'TP-3' && b.run_id === 'R-A' && b.trace_id === 'T-1', 'withContext: nested merges trace_id');
  assert(c.task_id === undefined && c.run_id === undefined, 'withContext: outside has no ctx');
}

// 4. tracing.startSpan no-op threads trace_id/span_id.
{
  const lines = runChild({ AUTO_LOG_JSON: '1', AUTO_LOG_LEVEL: 'info' }, `
    import { getLogger } from '${path.resolve(__dirname, '../logger.ts')}';
    import { startSpan } from '${path.resolve(__dirname, '../tracing.ts')}';
    (async () => {
      const log = getLogger('test');
      await startSpan('test.span', {}, async () => {
        log.info('inside span');
      });
    })();
  `);
  // 1 line for the log inside the span; tracing.ts may emit a debug ('not installed') line that we filter.
  const userLines = lines.filter((l) => {
    try { const o = JSON.parse(l); return o.msg === 'inside span'; } catch { return false; }
  });
  assert(userLines.length === 1, 'tracing: log inside span emitted');
  const obj = JSON.parse(userLines[0]);
  assert(typeof obj.trace_id === 'string' && obj.trace_id.length === 32, 'tracing: trace_id is 32 hex (no-op fallback)');
  assert(typeof obj.span_id === 'string' && obj.span_id.length === 16, 'tracing: span_id is 16 hex');
}

// 5. child logger inherits component + extra
{
  const lines = runChild({ AUTO_LOG_JSON: '1', AUTO_LOG_LEVEL: 'info' }, `
    import { getLogger } from '${path.resolve(__dirname, '../logger.ts')}';
    const root = getLogger('worker', { engine: 'claude-code-cli' });
    const child = root.child({ task_id: 'TP-X' });
    child.info('hello');
  `);
  assert(lines.length === 1, 'child: 1 line');
  const obj = JSON.parse(lines[0]);
  assert(obj.component === 'worker', 'child: component inherited');
  assert(obj.engine === 'claude-code-cli', 'child: engine inherited');
  assert(obj.task_id === 'TP-X', 'child: task_id added');
}

console.log('\n✓ all logger.smoke assertions passed');
