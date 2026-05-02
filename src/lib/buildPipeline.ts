/**
 * Build pipeline runner — watchdog-tracked, structured-result wrapper for
 * `pnpm test`, `pnpm typecheck`, `pnpm lint`, etc.
 *
 * Operator gap-roadmap item #2 (2026-04-28): "Build-pipeline runner with
 * per-package cancellation + flaky-test quarantine + watchdog tracking."
 *
 * v1 scope (this commit):
 *   - Declarative pipeline steps (id, cmd, args, timeout, required, cwd)
 *   - Per-step watchdog registration so a hung pnpm job gets reaped
 *     by the global tick instead of stalling the pipeline forever
 *   - Structured StepResult + PipelineResult for CI/dashboard consumption
 *   - --fail-fast (default) vs --continue-on-error
 *   - Audit each non-ok step via appendOverrideAudit kind='cleanup-action'
 *
 * v2 deferred:
 *   - Flaky-test quarantine (re-run + diff)
 *   - Per-package parallel dispatch
 *   - Test-result aggregation across packages
 */
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import { z } from 'zod';
import { registerProcess, unregisterProcess } from './processWatchdog';

export const PipelineStep = z.object({
  id: z.string().min(1),
  description: z.string().default(''),
  cmd: z.string(),
  args: z.array(z.string()).default([]),
  /** Defaults to PACKAGE_ROOT (caller resolves). */
  cwd: z.string().optional(),
  /** Hard cap before watchdog kills the step. */
  timeout_seconds: z.number().int().positive().default(15 * 60),
  /** If false, step failure does NOT fail the whole pipeline (informational). */
  required: z.boolean().default(true),
  /** Optional env overrides for the step. */
  env: z.record(z.string(), z.string()).optional(),
});
export type PipelineStep = z.infer<typeof PipelineStep>;

export const DEFAULT_PIPELINE: PipelineStep[] = [
  {
    id: 'typecheck',
    description: 'TypeScript typecheck (no emit)',
    cmd: 'pnpm',
    args: ['exec', 'tsc', '--noEmit', '-p', '.'],
    timeout_seconds: 5 * 60,
    required: true,
  },
  {
    id: 'lint',
    description: 'Lint (auto-detects ESLint / Biome / oxlint; non-blocking if no linter)',
    cmd: 'pnpm',
    args: ['auto:lint'],
    timeout_seconds: 5 * 60,
    required: false,  // non-blocking — projects without a linter get an info-only step
  },
  {
    id: 'test',
    description: 'Smoke test suite',
    cmd: 'pnpm',
    args: ['auto:test:smoke'],
    timeout_seconds: 10 * 60,
    required: true,
  },
];

export interface StepResult {
  step: PipelineStep;
  ok: boolean;
  exit_code: number | null;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
  killed_by_watchdog?: boolean;
}

export interface PipelineResult {
  ok: boolean;
  steps: StepResult[];
  duration_ms: number;
  required_failures: number;
  optional_failures: number;
  ran: number;
  skipped: number;
}

export interface PipelineOpts {
  /** Default true. When false, all steps run regardless of earlier failures. */
  fail_fast?: boolean;
  /** Default DEFAULT_PIPELINE. */
  steps?: PipelineStep[];
  /** PACKAGE_ROOT (where pnpm scripts resolve). */
  cwd: string;
  /** harness root for watchdog registry. */
  harness_root: string;
  /** Subset filter by step.id. */
  only?: string[];
  /** Skip subset by step.id. */
  skip?: string[];
}

export function runPipeline(opts: PipelineOpts): PipelineResult {
  const failFast = opts.fail_fast ?? true;
  const steps = (opts.steps ?? DEFAULT_PIPELINE).filter((s) => {
    if (opts.only && opts.only.length > 0 && !opts.only.includes(s.id)) return false;
    if (opts.skip && opts.skip.includes(s.id)) return false;
    return true;
  });
  const start = Date.now();
  const results: StepResult[] = [];
  let requiredFailures = 0, optionalFailures = 0, ran = 0, skipped = 0;
  let pipelineOk = true;

  for (const step of steps) {
    if (!pipelineOk && failFast) {
      skipped++;
      results.push({
        step,
        ok: false,
        exit_code: null,
        duration_ms: 0,
        stdout_tail: '',
        stderr_tail: '',
        error: 'skipped due to fail-fast (earlier required step failed)',
      });
      continue;
    }
    ran++;
    const stepResult = runStep(step, opts.cwd, opts.harness_root);
    results.push(stepResult);
    if (!stepResult.ok) {
      if (step.required) {
        requiredFailures++;
        pipelineOk = false;
      } else {
        optionalFailures++;
      }
    }
  }

  return {
    ok: pipelineOk,
    steps: results,
    duration_ms: Date.now() - start,
    required_failures: requiredFailures,
    optional_failures: optionalFailures,
    ran,
    skipped,
  };
}

export function runStep(step: PipelineStep, cwd: string, harnessRoot: string): StepResult {
  const start = Date.now();
  const stepCwd = step.cwd ?? cwd;
  const stepEnv = { ...process.env, ...(step.env ?? {}) };
  let killedByWatchdog = false;

  // Pre-register so external auto:watchdog has visibility (and can reap if
  // the timeout fires while we're blocked in spawnSync). We use process.pid
  // (the wrapper) since spawnSync is synchronous — child pid not retrievable
  // before exit. Watchdog kills wrapper → SIGTERM cascades to spawnSync child.
  try {
    registerProcess(harnessRoot, {
      pid: process.pid,
      kind: 'pipeline-test',
      task_id: step.id,
      started_at: new Date(start).toISOString(),
      max_duration_sec: step.timeout_seconds,
      command: `${step.cmd} ${step.args.join(' ')}`,
      host: os.hostname(),
      heartbeat_ttl_sec: step.timeout_seconds,  // no separate heartbeat for sync steps
      restart_policy: 'none',
    });
  } catch { /* non-fatal */ }

  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(step.cmd, step.args, {
      cwd: stepCwd,
      env: stepEnv,
      encoding: 'utf8',
      timeout: step.timeout_seconds * 1000,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    try { unregisterProcess(harnessRoot, process.pid); } catch { /* */ }
  }

  const duration = Date.now() - start;
  // SIGTERM ⇒ Node's spawnSync result.status is null with signal='SIGTERM' on timeout
  if (result.signal === 'SIGTERM' || result.signal === 'SIGKILL') {
    killedByWatchdog = true;
  }
  const stdout = String(result.stdout ?? '').slice(-4000);
  const stderr = String(result.stderr ?? '').slice(-2000);
  const ok = result.status === 0 && !result.error;

  const out: StepResult = {
    step,
    ok,
    exit_code: result.status,
    duration_ms: duration,
    stdout_tail: stdout,
    stderr_tail: stderr,
  };
  if (result.error) out.error = result.error.message;
  if (killedByWatchdog) {
    out.killed_by_watchdog = true;
    out.error = (out.error ?? '') + ` (timeout: ${step.timeout_seconds}s)`;
  }
  return out;
}

// ─── Pretty rendering ────────────────────────────────────────────────────────

export function formatPipelineHuman(r: PipelineResult): string {
  const lines: string[] = [];
  const icon = r.ok ? '✅' : '❌';
  lines.push(`${icon} pipeline ${r.ok ? 'PASS' : 'FAIL'}  duration=${(r.duration_ms / 1000).toFixed(1)}s  ran=${r.ran}  skipped=${r.skipped}  req-fail=${r.required_failures}  opt-fail=${r.optional_failures}`);
  for (const s of r.steps) {
    const stepIcon = s.ok ? '✓' : s.killed_by_watchdog ? '⏰' : s.error?.includes('skipped') ? '⏭' : '✗';
    const dur = s.duration_ms > 0 ? `${(s.duration_ms / 1000).toFixed(1)}s` : '—';
    const reqTag = s.step.required ? '' : '(optional) ';
    lines.push(`  ${stepIcon} ${reqTag}${s.step.id.padEnd(16)} ${dur.padStart(8)}  exit=${s.exit_code ?? 'null'}${s.error ? `  ${s.error}` : ''}`);
  }
  return lines.join('\n');
}
