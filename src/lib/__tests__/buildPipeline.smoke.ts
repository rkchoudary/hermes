/**
 * Smoke tests for buildPipeline. Run via: pnpm auto:test:build
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runStep, runPipeline, formatPipelineHuman, PipelineStep } from '../buildPipeline';

let passed = 0, failed = 0;
function assert(c: unknown, l: string): void { if (c) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}`); } }
function assertEq<T>(a: T, b: T, l: string): void { if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${l}`); } else { failed++; console.error(`  ✗ ${l}\n      actual: ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); } }

import { harnessRoot } from '../harnessRoot';
const HARNESS_ROOT = harnessRoot();

console.log('\n[buildPipeline smoke] starting…\n');

// ─── 1. runStep on a passing command ────────────────────────────────────────
{
  console.log('1. runStep on passing command');
  const step: PipelineStep = {
    id: 'echo-pass',
    description: 'trivial pass',
    cmd: '/bin/sh',
    args: ['-c', 'echo hello && exit 0'],
    timeout_seconds: 30,
    required: true,
  };
  const r = runStep(step, os.tmpdir(), HARNESS_ROOT);
  assertEq(r.ok, true, 'ok=true');
  assertEq(r.exit_code, 0, 'exit_code=0');
  assert(r.stdout_tail.includes('hello'), 'stdout captured');
  assertEq(r.killed_by_watchdog, undefined, 'not killed');
}

// ─── 2. runStep on a failing command ────────────────────────────────────────
{
  console.log('\n2. runStep on failing command');
  const step: PipelineStep = {
    id: 'echo-fail',
    description: 'trivial fail',
    cmd: '/bin/sh',
    args: ['-c', 'echo oops && exit 3'],
    timeout_seconds: 30,
    required: true,
  };
  const r = runStep(step, os.tmpdir(), HARNESS_ROOT);
  assertEq(r.ok, false, 'ok=false');
  assertEq(r.exit_code, 3, 'exit_code=3');
}

// ─── 3. runStep on a timing-out command ─────────────────────────────────────
{
  console.log('\n3. runStep on timeout (signal=SIGTERM)');
  const step: PipelineStep = {
    id: 'sleep-timeout',
    description: 'will time out',
    cmd: '/bin/sh',
    args: ['-c', 'sleep 5'],
    timeout_seconds: 1,
    required: true,
  };
  const r = runStep(step, os.tmpdir(), HARNESS_ROOT);
  assertEq(r.ok, false, 'ok=false on timeout');
  assertEq(r.killed_by_watchdog, true, 'killed_by_watchdog=true');
  assert(r.error?.includes('timeout'), 'error mentions timeout');
}

// ─── 4. runPipeline fail-fast: stops on first required failure ──────────────
{
  console.log('\n4. runPipeline fail-fast');
  const steps: PipelineStep[] = [
    { id: 's1', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
    { id: 's2', description: '', cmd: '/bin/sh', args: ['-c', 'exit 1'], timeout_seconds: 5, required: true },
    { id: 's3', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
  ];
  const r = runPipeline({ cwd: os.tmpdir(), harness_root: HARNESS_ROOT, steps, fail_fast: true });
  assertEq(r.ok, false, 'pipeline FAIL');
  assertEq(r.required_failures, 1, '1 required failure');
  assertEq(r.ran, 2, 'ran 2 steps (s1 + s2; s3 skipped)');
  assertEq(r.skipped, 1, '1 skipped');
}

// ─── 5. runPipeline --no-fail-fast: continues on failure ────────────────────
{
  console.log('\n5. runPipeline no-fail-fast');
  const steps: PipelineStep[] = [
    { id: 's1', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
    { id: 's2', description: '', cmd: '/bin/sh', args: ['-c', 'exit 1'], timeout_seconds: 5, required: true },
    { id: 's3', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
  ];
  const r = runPipeline({ cwd: os.tmpdir(), harness_root: HARNESS_ROOT, steps, fail_fast: false });
  assertEq(r.ok, false, 'pipeline still FAIL (s2 failed)');
  assertEq(r.required_failures, 1, '1 required failure');
  assertEq(r.ran, 3, 'ran all 3 steps');
  assertEq(r.skipped, 0, 'nothing skipped');
}

// ─── 6. optional step failure does NOT fail pipeline ────────────────────────
{
  console.log('\n6. optional step failure non-blocking');
  const steps: PipelineStep[] = [
    { id: 's1', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
    { id: 's2', description: '', cmd: '/bin/sh', args: ['-c', 'exit 1'], timeout_seconds: 5, required: false },
    { id: 's3', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
  ];
  const r = runPipeline({ cwd: os.tmpdir(), harness_root: HARNESS_ROOT, steps });
  assertEq(r.ok, true, 'pipeline PASS (only optional failed)');
  assertEq(r.required_failures, 0, '0 required failures');
  assertEq(r.optional_failures, 1, '1 optional failure');
}

// ─── 7. only + skip filters ─────────────────────────────────────────────────
{
  console.log('\n7. only + skip filters');
  const steps: PipelineStep[] = [
    { id: 's1', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
    { id: 's2', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
    { id: 's3', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true },
  ];
  const onlyR = runPipeline({ cwd: os.tmpdir(), harness_root: HARNESS_ROOT, steps, only: ['s1', 's3'] });
  assertEq(onlyR.ran, 2, '--only ran 2 steps');
  const skipR = runPipeline({ cwd: os.tmpdir(), harness_root: HARNESS_ROOT, steps, skip: ['s2'] });
  assertEq(skipR.ran, 2, '--skip ran 2 steps');
}

// ─── 8. formatPipelineHuman renders without throwing ────────────────────────
{
  console.log('\n8. formatPipelineHuman');
  const steps: PipelineStep[] = [{ id: 's1', description: '', cmd: '/bin/sh', args: ['-c', 'exit 0'], timeout_seconds: 5, required: true }];
  const r = runPipeline({ cwd: os.tmpdir(), harness_root: HARNESS_ROOT, steps });
  const out = formatPipelineHuman(r);
  assert(out.includes('PASS'), 'rendered output mentions PASS');
  assert(out.includes('s1'), 'rendered output names step');
}

console.log(`\n[buildPipeline smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
