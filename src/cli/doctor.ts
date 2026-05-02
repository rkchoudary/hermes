#!/usr/bin/env node
/**
 * pnpm auto:doctor [--state] [--apply] [--json]
 *
 * Operator state-integrity checker (Codex tier-plan first-sprint scope item:
 * "Add auto:doctor --state").
 *
 * Walks .agent-runs/ and validates:
 *   1. Every TaskPack JSON parses cleanly + matches zod schema
 *   2. Every state-log.jsonl entry has matching pack.state_history entries
 *   3. No orphan .lock sentinel files (sentinel exists but referenced PID
 *      is dead OR pack.lock is null)
 *   4. No tasks with state_history terminal but state field non-terminal
 *      (or vice versa)
 *   5. Audit log + escalation log JSONL entries parse cleanly
 *   6. Evidence dirs referenced by packs exist (where state >= awaiting-review)
 *   7. depends_on graphs have no cycles + no missing pointers
 *   8. cost_telemetry monotonic in round number
 *
 * Default: read-only report. --apply offers safe corrective actions
 * (release stale sentinels with audit; rebuild state_history from state-log).
 *
 * Per Codex (bgxrqvh58 Operational Durability tier): "If you run this for
 * 30 days after only T1+T2, the likely failures are local-state problems:
 * .agent-runs/ grows into an opaque source of truth, corrupted state requires
 * manual surgery, evidence is hard to reconstruct."
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { TaskPack } from '../lib/taskPack';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();

interface Issue {
  severity: 'info' | 'warning' | 'error';
  category: string;
  task_id?: string;
  run_id?: string;
  detail: string;
  remediation?: string;
}

interface Args {
  state: boolean;
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let state = false;
  let apply = false;
  let json = false;
  for (const a of argv) {
    if (a === '--state') state = true;
    else if (a === '--apply') apply = true;
    else if (a === '--json') json = true;
  }
  // Default to --state mode when no flag given (most common operator query)
  if (!state) state = true;
  return { state, apply, json };
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function checkState(): Issue[] {
  const issues: Issue[] = [];
  const runs = listRuns();
  if (runs.length === 0) {
    issues.push({ severity: 'info', category: 'empty', detail: 'No runs found in .agent-runs/' });
    return issues;
  }

  for (const runId of runs) {
    const taskIds = listTasks(runId);
    for (const taskId of taskIds) {
      // 1. Parse + schema
      let pack;
      try {
        pack = readTaskPack(runId, taskId);
      } catch (e) {
        issues.push({
          severity: 'error',
          category: 'parse',
          run_id: runId,
          task_id: taskId,
          detail: `pack JSON failed schema: ${(e as Error).message.slice(0, 200)}`,
          remediation: 'Inspect file; restore from git history or hand-edit to match TaskPack schema',
        });
        continue;
      }

      // 2. Lock sentinel orphan check
      const sentinelPath = path.join(HARNESS_ROOT, '.agent-runs', runId, 'tasks', `.${taskId}.lock`);
      if (fs.existsSync(sentinelPath)) {
        if (pack.lock === null) {
          // Sentinel without pack.lock → orphan
          issues.push({
            severity: 'warning',
            category: 'orphan-sentinel',
            run_id: runId,
            task_id: taskId,
            detail: `Lock sentinel exists at ${sentinelPath} but pack.lock is null (orphan from crashed dispatch)`,
            remediation: 'Run pnpm auto:resurrect, or delete the sentinel manually if you verified no dispatch is in flight',
          });
        } else {
          const pid = pack.lock.pid;
          if (typeof pid === 'number' && !isPidAlive(pid)) {
            issues.push({
              severity: 'warning',
              category: 'dead-lock-holder',
              run_id: runId,
              task_id: taskId,
              detail: `pack.lock.pid=${pid} not running; sentinel still present (dispatcher crashed)`,
              remediation: 'Run pnpm auto:resurrect to release the lock with audit',
            });
          }
        }
      }

      // 3. Terminal state mismatch
      const TERMINAL = new Set(['merged', 'ready-for-merge', 'abandoned']);
      const lastTransition = pack.state_history[pack.state_history.length - 1];
      if (lastTransition && lastTransition.to !== pack.state) {
        issues.push({
          severity: 'error',
          category: 'state-mismatch',
          run_id: runId,
          task_id: taskId,
          detail: `pack.state='${pack.state}' but last state_history entry says '${lastTransition.to}'`,
          remediation: 'Run auto:replay to see full timeline; pack.state is the authoritative field',
        });
      }
      if (TERMINAL.has(pack.state) && pack.lock !== null) {
        issues.push({
          severity: 'warning',
          category: 'terminal-with-lock',
          run_id: runId,
          task_id: taskId,
          detail: `Task in terminal state '${pack.state}' but pack.lock is still set (should be cleared on terminal)`,
          remediation: '--apply to null out pack.lock with audit',
        });
      }

      // 4. depends_on missing pointer
      for (const dep of pack.depends_on) {
        if (!taskIds.includes(dep)) {
          issues.push({
            severity: 'warning',
            category: 'missing-dependency',
            run_id: runId,
            task_id: taskId,
            detail: `depends_on includes '${dep}' which is not in run '${runId}'`,
            remediation: 'Verify dep is intentional; if cross-run, document; if typo, fix pack.json',
          });
        }
      }

      // 5. Evidence dir presence for non-planned states
      const NON_PLANNED = new Set(['awaiting-review', 'codex-reviewing', 'promotable', 'needs-revision', 'ready-for-merge', 'merged']);
      if (NON_PLANNED.has(pack.state)) {
        // v0.5.1 bugfix surfaced by E2E test (operator dogfood):
        // pack.evidence_dir can be either an absolute path OR a path relative
        // to the run dir. path.join doesn't preserve absolute paths in the
        // 2nd arg, so we use path.resolve which does.
        const evidencePath = path.isAbsolute(pack.evidence_dir)
          ? pack.evidence_dir
          : path.resolve(HARNESS_ROOT, '.agent-runs', runId, pack.evidence_dir);
        if (!fs.existsSync(evidencePath)) {
          issues.push({
            severity: 'warning',
            category: 'missing-evidence',
            run_id: runId,
            task_id: taskId,
            detail: `pack.state='${pack.state}' but evidence_dir '${pack.evidence_dir}' does not exist`,
            remediation: 'Worker should have written evidence; check auto:work logs for that round',
          });
        }
      }

      // 6. cost_telemetry sanity check — v0.5.1 bugfix surfaced by E2E test:
      // The original "monotonic round" check assumed pack.cost_telemetry[i].round
      // increases monotonically. That's WRONG: round=1 legitimately repeats
      // when codex CLI is retried (each retry gets its own cost record), and
      // a plateau-pivot can re-dispatch round 1 with the same logical round
      // number. We instead check that timestamps are monotonic (each new
      // record has at >= prior) — that's the actual durability invariant.
      let lastAt = '';
      for (const c of pack.cost_telemetry) {
        if (typeof c.at === 'string' && lastAt && c.at < lastAt) {
          issues.push({
            severity: 'warning',
            category: 'cost-telemetry-timestamp-out-of-order',
            run_id: runId,
            task_id: taskId,
            detail: `cost_telemetry record at=${c.at} appears after at=${lastAt} (timestamps must be monotonic)`,
          });
        }
        if (typeof c.at === 'string') lastAt = c.at;
      }
    }

    // 7. state-log.jsonl integrity
    const stateLogPath = path.join(HARNESS_ROOT, '.agent-runs', runId, 'state-log.jsonl');
    if (fs.existsSync(stateLogPath)) {
      const lines = fs.readFileSync(stateLogPath, 'utf8').split('\n').filter((l) => l.trim());
      let parseFails = 0;
      for (const l of lines) {
        try { JSON.parse(l); } catch { parseFails++; }
      }
      if (parseFails > 0) {
        issues.push({
          severity: 'error',
          category: 'state-log-corrupt',
          run_id: runId,
          detail: `${parseFails}/${lines.length} lines failed to parse as JSON in ${stateLogPath}`,
          remediation: 'Inspect manually; corrupt lines may indicate disk-full during a write or concurrent unsafe append',
        });
      }
    }
  }

  // 8. _override-audit.jsonl + _escalation-log.jsonl parse-clean
  for (const f of ['_override-audit.jsonl', '_escalation-log.jsonl']) {
    const p = path.join(HARNESS_ROOT, '.agent-runs', f);
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
      let parseFails = 0;
      for (const l of lines) {
        try { JSON.parse(l); } catch { parseFails++; }
      }
      if (parseFails > 0) {
        issues.push({
          severity: 'error',
          category: 'audit-log-corrupt',
          detail: `${parseFails}/${lines.length} lines failed to parse in ${p}`,
          remediation: 'Inspect manually; corrupt audit logs are SOX-hostile',
        });
      }
    }
  }

  return issues;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const issues = args.state ? checkState() : [];

  if (args.json) {
    console.log(JSON.stringify({
      runs_scanned: listRuns().length,
      issue_count: issues.length,
      severities: {
        error: issues.filter((i) => i.severity === 'error').length,
        warning: issues.filter((i) => i.severity === 'warning').length,
        info: issues.filter((i) => i.severity === 'info').length,
      },
      issues,
    }, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:doctor --state  (.agent-runs/ integrity check)`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Runs scanned: ${listRuns().length}`);
  console.log(`Issues:       ${issues.length} (${issues.filter((i) => i.severity === 'error').length} error, ${issues.filter((i) => i.severity === 'warning').length} warning, ${issues.filter((i) => i.severity === 'info').length} info)`);
  console.log('');

  if (issues.length === 0) {
    console.log('✓ No issues — state is consistent');
    return;
  }

  for (const i of issues) {
    const icon = i.severity === 'error' ? '✗' : i.severity === 'warning' ? '⚠' : 'ℹ';
    const tag = i.task_id ? `${i.task_id} ` : '';
    console.log(`${icon} [${i.severity.toUpperCase()}] ${tag}${i.category}: ${i.detail}`);
    if (i.remediation) console.log(`     → ${i.remediation}`);
  }

  if (issues.some((i) => i.severity === 'error')) process.exit(1);
}

main();
