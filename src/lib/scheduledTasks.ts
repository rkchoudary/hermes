/**
 * Scheduled tasks engine — periodic invocation of long-cadence CLIs from
 * auto:tick (rebase-stale daily, cleanup-worktree weekly, etc.).
 *
 * Operator directive 2026-04-28: "we need to ensure system is healthy all
 * the time and performing at its peak." The cleanup-policy engine handles
 * file-level retention; this module handles operationally expensive CLIs
 * that run on a slower cadence (rebase against main, prune merged
 * worktrees, etc.).
 *
 * Pattern mirrors cleanupPolicy.ts:
 *   - Declarative ScheduledTask entries (id, cmd, args, cadence_seconds)
 *   - Rate-limited via _scheduled-state.json last_run_at[task_id]
 *   - Dry-run by default; --apply persists state and runs the actual CLI
 *   - Audit each invocation via appendOverrideAudit kind='cleanup-action'
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFile } from './runState';
import { captureIdentity } from './sod';
import { appendOverrideAudit } from './overrideAudit';

export const ScheduledTask = z.object({
  id: z.string().min(1),
  description: z.string(),
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  /** cwd; defaults to PACKAGE_ROOT (resolved by caller). */
  cwd: z.string().optional(),
  cadence_seconds: z.number().int().positive(),
  /** Hard-cap timeout for the CLI invocation. */
  timeout_seconds: z.number().int().positive().default(10 * 60),
  /** Skip if dirty? Default true — destructive CLIs against dirty cwd are bad. */
  require_clean_cwd: z.boolean().default(false),
});
export type ScheduledTask = z.infer<typeof ScheduledTask>;

export const DEFAULT_SCHEDULED_TASKS: ScheduledTask[] = [
  {
    id: 'rebase-stale',
    description: 'rebase stale branches against origin/main (skip dirty)',
    cmd: 'pnpm',
    args: ['--silent', 'auto:rebase-stale', '--apply'],
    cadence_seconds: 24 * 3600,  // daily
    timeout_seconds: 5 * 60,
    require_clean_cwd: false,
  },
  {
    id: 'cleanup-worktree',
    description: 'prune merged/closed-PR worktrees + delete local branches',
    cmd: 'pnpm',
    args: ['--silent', 'auto:cleanup-worktree', '--apply'],
    cadence_seconds: 7 * 24 * 3600,  // weekly
    timeout_seconds: 5 * 60,
    require_clean_cwd: false,
  },
];

const STATE_REL = '.agent-runs/_scheduled-state.json';
interface State {
  schema_version: '1';
  last_run_at: Record<string, string>;
}

function statePath(harnessRoot: string): string {
  return path.join(harnessRoot, STATE_REL);
}

function readState(harnessRoot: string): State {
  const p = statePath(harnessRoot);
  if (!fs.existsSync(p)) return { schema_version: '1', last_run_at: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof raw === 'object' && raw && 'last_run_at' in raw) return raw as State;
  } catch { /* */ }
  return { schema_version: '1', last_run_at: {} };
}

function writeState(harnessRoot: string, state: State): void {
  const dir = path.dirname(statePath(harnessRoot));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(statePath(harnessRoot), JSON.stringify(state, null, 2));
}

export interface ScheduledRunResult {
  task_id: string;
  ran: boolean;
  applied: boolean;
  exit_code: number | null;
  duration_ms: number;
  output_truncated: string;
  error?: string;
  skipped_for_cadence?: boolean;
  cadence_remaining_sec?: number;
}

export interface RunOpts {
  apply?: boolean;
  force?: boolean;
  only?: string[];
  cwd: string;
  tasks?: ScheduledTask[];
}

/**
 * Run all scheduled tasks whose cadence has elapsed. Audits every actual
 * invocation. Idempotent + cadence-respecting.
 */
export function runScheduled(harnessRoot: string, opts: RunOpts): ScheduledRunResult[] {
  const apply = opts.apply ?? false;
  const force = opts.force ?? false;
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const tasks = opts.tasks ?? DEFAULT_SCHEDULED_TASKS;
  const state = readState(harnessRoot);
  const now = Date.now();
  const results: ScheduledRunResult[] = [];

  for (const t of tasks) {
    if (only && !only.has(t.id)) continue;
    const last = state.last_run_at[t.id];
    if (!force && last) {
      const sinceSec = (now - new Date(last).getTime()) / 1000;
      if (sinceSec < t.cadence_seconds) {
        results.push({
          task_id: t.id,
          ran: false,
          applied: false,
          exit_code: null,
          duration_ms: 0,
          output_truncated: '',
          skipped_for_cadence: true,
          cadence_remaining_sec: Math.ceil(t.cadence_seconds - sinceSec),
        });
        continue;
      }
    }
    if (!apply) {
      results.push({
        task_id: t.id,
        ran: false,
        applied: false,
        exit_code: null,
        duration_ms: 0,
        output_truncated: `(dry-run) would run: ${t.cmd} ${t.args.join(' ')}`,
      });
      continue;
    }
    // Actual run
    const start = Date.now();
    const r = spawnSync(t.cmd, t.args, {
      cwd: t.cwd ?? opts.cwd,
      encoding: 'utf8',
      timeout: t.timeout_seconds * 1000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const duration = Date.now() - start;
    const stdout = (r.stdout ?? '').slice(-2000);
    const stderr = (r.stderr ?? '').slice(-1000);
    const ok = r.status === 0;
    state.last_run_at[t.id] = new Date().toISOString();
    const result: ScheduledRunResult = {
      task_id: t.id,
      ran: true,
      applied: true,
      exit_code: r.status,
      duration_ms: duration,
      output_truncated: stdout + (stderr ? `\n[stderr]\n${stderr}` : ''),
      error: r.error ? r.error.message : undefined,
    };
    results.push(result);
    // Audit
    try {
      appendOverrideAudit(harnessRoot, {
        schema_version: '1',
        at: new Date().toISOString(),
        actor: captureIdentity(),
        kind: 'cleanup-action',
        reason: `scheduled task '${t.id}' invoked (cadence=${t.cadence_seconds}s); exit=${r.status} duration=${(duration / 1000).toFixed(1)}s`,
        context: {
          scheduled_task_id: t.id,
          description: t.description,
          cmd: t.cmd,
          args: t.args,
          exit_code: r.status,
          duration_ms: duration,
          ok,
          host: os.hostname(),
        },
        pid: process.pid,
        host: os.hostname(),
      });
    } catch (e) {
      console.error(`[scheduled] audit failed for ${t.id}: ${(e as Error).message}`);
    }
  }

  if (apply) writeState(harnessRoot, state);
  return results;
}
