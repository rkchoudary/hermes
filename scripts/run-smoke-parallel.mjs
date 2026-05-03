#!/usr/bin/env node
/**
 * Parallel smoke test runner. Replaces the `&& `-chained pnpm auto:test:smoke
 * with Promise.all-style concurrent execution.
 *
 * Each smoke test is independent (writes to its own /tmp dir, doesn't touch
 * shared .agent-runs/), so parallelism is safe. We cap concurrency at the
 * physical CPU count so we don't thrash the box.
 *
 * Codex tier-plan review (bgxrqvh58) prescription: "Independent: parallel
 * smoke runner, one-pass discovery, basic prompt caching, composite auto:run,
 * streaming consensus parse." This is the lowest-risk efficiency win — same
 * test outputs, ~3× wallclock.
 *
 * Usage:
 *   node scripts/run-smoke-parallel.mjs            # default concurrency = CPU count
 *   node scripts/run-smoke-parallel.mjs --serial   # fall back to sequential (debug)
 *   node scripts/run-smoke-parallel.mjs --concurrency 4
 */

import { spawn } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const SMOKES = [
  'auto:test:contracts',
  'auto:test:event-collector',
  'auto:test:claude-stream',
  'auto:test:liveness',
  'auto:test:budget-reservation',
  'auto:test:progress-score',
  'auto:test:fanout-scheduler',
  'auto:test:guards',
  'auto:test:goal',
  'auto:test:governance',
  'auto:test:watchdog',
  'auto:test:cleanup',
  'auto:test:health',
  'auto:test:plateau',
  'auto:test:cost',
  'auto:test:queue',
  'auto:test:notifications',
  'auto:test:build',
  'auto:test:logger',
  'auto:test:lockCAS',
  'auto:test:autoPromote',
  'auto:test:uxValidate',
  'auto:test:pillar5',
  'auto:test:operatorControl',
  'auto:test:scenario',
  'auto:test:autoLand',
  'auto:test:gapAnalysis',
  'auto:test:scheduling',
  'auto:test:candidateToTaskPack',
];

function parseArgs() {
  const a = process.argv.slice(2);
  const serial = a.includes('--serial');
  const idx = a.indexOf('--concurrency');
  const concurrency = idx >= 0 ? parseInt(a[idx + 1], 10) : Math.min(SMOKES.length, os.cpus().length);
  const verbose = a.includes('--verbose') || a.includes('-v');
  return { serial, concurrency: serial ? 1 : concurrency, verbose };
}

function runOne(scriptName, idx, total) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn('pnpm', ['--silent', scriptName], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => {
      const ms = Date.now() - startedAt;
      resolve({ scriptName, exit: code ?? -1, ms, stdout, stderr });
    });
  });
}

async function main() {
  const { concurrency, verbose } = parseArgs();
  const startAll = Date.now();
  console.log(`[smoke-parallel] running ${SMOKES.length} suites with concurrency=${concurrency}…`);

  const results = [];
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < SMOKES.length) {
      const i = nextIdx++;
      const r = await runOne(SMOKES[i], i, SMOKES.length);
      results.push(r);
      const icon = r.exit === 0 ? '✓' : '✗';
      console.log(`  ${icon} ${r.scriptName.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s`);
      if (r.exit !== 0 && verbose) {
        process.stderr.write(r.stderr.slice(-2000));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const totalMs = Date.now() - startAll;
  const failed = results.filter((r) => r.exit !== 0);
  console.log('');
  console.log(`[smoke-parallel] ${SMOKES.length - failed.length}/${SMOKES.length} passed in ${(totalMs / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    console.log('');
    console.log('Failed suites:');
    for (const f of failed) {
      console.log(`  ✗ ${f.scriptName} (exit ${f.exit})`);
      const tail = (f.stdout + '\n' + f.stderr).split('\n').slice(-15).join('\n');
      console.log(tail.split('\n').map((l) => `    | ${l}`).join('\n'));
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
