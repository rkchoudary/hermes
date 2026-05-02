#!/usr/bin/env node
/**
 * pnpm auto:resume-session — read durable session state + output handoff brief.
 *
 * Companion to auto:flush-progress. Reads:
 *  - ${process.env.HERMES_PROGRESS_PATH ?? "./PROGRESS.md"} (operator-facing snapshot)
 *  - Most recent tools/autonomous-delivery/session-history/<UTC>.json (forensic)
 *  - .agent-runs/ current run state
 *  - Recent /tmp/codex-*.md outputs (last 24h)
 *  - Open PRs via gh CLI
 *  - Recent commits across all worktrees
 *  - git fetch + report any remote changes since last session
 *
 * Outputs a compact (≤4 KB) "session-handoff brief" to stdout suitable for
 * inclusion as the first turn of a fresh Claude Code session.
 *
 * Usage:
 *   pnpm auto:resume-session                    # default — print brief
 *   pnpm auto:resume-session --json             # machine-readable
 *   pnpm auto:resume-session --quiet            # only output if state stale
 *   pnpm auto:resume-session --max-age-hours 24 # only resume if flush within N hours
 *
 * Designed for SessionStart hook in .claude/settings.json:
 *   { "hooks": { "SessionStart": [ { "type": "command", "command":
 *     "pnpm --dir tools/autonomous-delivery auto:resume-session --quiet" } ] } }
 *
 * Exit codes:
 *   0 — output produced (or quiet-mode skipped)
 *   1 — no flushed state found (treat as cold start)
 *   2 — error reading state
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readGoal, evaluateGoal, buildGoalSnapshot } from '../lib/goal';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = harnessRoot();
const RUNS_DIR = path.join(REPO_ROOT, '.agent-runs');
const SESSION_HISTORY_DIR = path.resolve(__dirname, '..', '..', 'session-history');
const DEFAULT_PROGRESS_PATH = path.join(os.homedir(), process.env.HERMES_PROGRESS_PATH || './PROGRESS.md');

interface ResumeArgs {
  json: boolean;
  quiet: boolean;
  maxAgeHours: number;
}

function parseArgs(argv: string[]): ResumeArgs {
  let json = false;
  let quiet = false;
  let maxAgeHours = 24;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--quiet') quiet = true;
    else if (a === '--max-age-hours' && i + 1 < argv.length) {
      maxAgeHours = parseFloat(argv[++i]);
    }
  }
  return { json, quiet, maxAgeHours };
}

function readMostRecentHistory(): { path: string; data: any; ageHours: number } | null {
  if (!fs.existsSync(SESSION_HISTORY_DIR)) return null;
  const files = fs
    .readdirSync(SESSION_HISTORY_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();
  if (files.length === 0) return null;
  const recent = path.join(SESSION_HISTORY_DIR, files[0]);
  try {
    const data = JSON.parse(fs.readFileSync(recent, 'utf8'));
    const ageMs = Date.now() - new Date(data.captured_at).getTime();
    return { path: recent, data, ageHours: ageMs / (1000 * 60 * 60) };
  } catch {
    return null;
  }
}

function gitFetchAll(): { ok: boolean; output: string } {
  const result = spawnSync('git', ['-C', REPO_ROOT, 'fetch', '--all', '--quiet'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { ok: result.status === 0, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

function discoverUnintegratedCodexOutputs(): Array<{ name: string; size_kb: number; mtime: string }> {
  const tmpDir = '/tmp';
  if (!fs.existsSync(tmpDir)) return [];
  const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours
  return fs
    .readdirSync(tmpDir)
    .filter((f) => /^codex-(arch|frd-).*\.md$/.test(f))
    .map((f) => {
      const full = path.join(tmpDir, f);
      const stat = fs.statSync(full);
      return { name: f, full, size_kb: stat.size / 1024, mtime: stat.mtime, mtimeStr: stat.mtime.toISOString() };
    })
    .filter((c) => c.mtime.getTime() > cutoff && c.size_kb > 0)
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    .slice(0, 10)
    .map(({ name, size_kb, mtimeStr }) => ({ name, size_kb, mtime: mtimeStr }));
}

function discoverInProgressTasks(): Array<{ run_id: string; task_id: string; state: string; module_or_sprint: string }> {
  const tasks: Array<{ run_id: string; task_id: string; state: string; module_or_sprint: string }> = [];
  if (!fs.existsSync(RUNS_DIR)) return tasks;
  for (const runId of fs.readdirSync(RUNS_DIR)) {
    const tasksDir = path.join(RUNS_DIR, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const taskFile of fs.readdirSync(tasksDir)) {
      if (!taskFile.endsWith('.json')) continue;
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(tasksDir, taskFile), 'utf8'));
        if (['planned', 'claimed', 'in-progress', 'awaiting-review', 'codex-reviewing', 'needs-revision', 'promotable'].includes(pack.state)) {
          tasks.push({
            run_id: runId,
            task_id: pack.task_id,
            state: pack.state,
            module_or_sprint: pack.module_or_sprint,
          });
        }
      } catch {
        // skip malformed
      }
    }
  }
  return tasks;
}

function buildHandoffBrief(args: ResumeArgs, history: ReturnType<typeof readMostRecentHistory>, fetchOk: boolean, codex: ReturnType<typeof discoverUnintegratedCodexOutputs>, tasks: ReturnType<typeof discoverInProgressTasks>): string {
  const lines: string[] = [];
  lines.push('# NBF Autonomous Delivery — Session Resume Brief');
  lines.push('');

  if (!history) {
    lines.push('**Status:** No prior session state found. Cold start.');
    lines.push('');
    lines.push('Recommended:');
    lines.push('- Read [`tools/autonomous-delivery/docs/INDUSTRIAL-ARCHITECTURE-V0.4.md`](tools/autonomous-delivery/docs/INDUSTRIAL-ARCHITECTURE-V0.4.md) for system design');
    lines.push('- Read [`tools/autonomous-delivery/docs/INDUSTRIAL-ARCHITECTURE-V0.4.1-FIX-LIST.md`](tools/autonomous-delivery/docs/INDUSTRIAL-ARCHITECTURE-V0.4.1-FIX-LIST.md) for current fix list');
    lines.push('- Read [`tools/autonomous-delivery/docs/LONG-RUNNING-OPERATIONS.md`](tools/autonomous-delivery/docs/LONG-RUNNING-OPERATIONS.md) for days-to-weeks operational model');
    lines.push('- Run `/resume` for the project skill (if interactive Claude Code session)');
    return lines.join('\n');
  }

  const { data, ageHours } = history;
  const stale = ageHours > args.maxAgeHours;

  lines.push(`**Last flush:** ${data.captured_at} (${ageHours.toFixed(1)} hours ago${stale ? ' — STALE' : ''})`);
  lines.push(`**Reason:** ${data.reason}`);
  lines.push(`**Operator-facing summary:** \`${DEFAULT_PROGRESS_PATH}\``);
  lines.push('');

  if (stale && args.quiet) {
    lines.push('_State is stale (> max-age-hours); manually inspect via `pnpm auto:status` and `pnpm auto:flush-progress` to refresh._');
    return lines.join('\n');
  }

  // Run state
  if (data.runs_state && data.runs_state.runs > 0) {
    lines.push('## In-flight task state');
    lines.push('');
    lines.push(`Latest run: \`${data.runs_state.latest_run ?? '(none)'}\``);
    lines.push('');
    lines.push('Tasks by state at last flush:');
    for (const [state, count] of Object.entries(data.runs_state.tasks_by_state ?? {}).sort()) {
      lines.push(`- ${state}: ${count}`);
    }
    if (Object.keys(data.runs_state.tasks_by_state ?? {}).length === 0) lines.push('- (no tasks)');
    lines.push('');
  }

  // Live tasks (re-discovered now, not from snapshot)
  if (tasks.length > 0) {
    lines.push('## Live tasks RIGHT NOW (fresh discovery)');
    lines.push('');
    lines.push('| Task | Module | State | Run |');
    lines.push('|---|---|---|---|');
    for (const t of tasks.slice(0, 15)) {
      lines.push(`| \`${t.task_id}\` | ${t.module_or_sprint} | ${t.state} | ${t.run_id} |`);
    }
    if (tasks.length > 15) lines.push(`| _… ${tasks.length - 15} more_ |`);
    lines.push('');
  }

  // Open PRs from snapshot
  if (data.prs && data.prs.length > 0) {
    lines.push('## Open PRs (from last flush)');
    lines.push('');
    for (const pr of data.prs.slice(0, 10)) {
      lines.push(`- [#${pr.number}](${process.env.HERMES_PROJECT_GITHUB_URL ?? ''}/pull/${pr.number}) ${pr.title} — \`${pr.head}\``);
    }
    if (data.prs.length > 10) lines.push(`- _… ${data.prs.length - 10} more_`);
    lines.push('');
  }

  // Branches with work ahead of main
  if (data.branches && data.branches.branches) {
    const ahead = data.branches.branches.filter((b: any) => b.ahead_of_main > 0);
    if (ahead.length > 0) {
      lines.push('## Branches with unmerged work (from last flush)');
      lines.push('');
      lines.push('| Branch | HEAD | Ahead of main | Subject |');
      lines.push('|---|---|---|---|');
      for (const b of ahead.slice(0, 10)) {
        const subj = b.subject.length > 50 ? b.subject.slice(0, 47) + '...' : b.subject;
        lines.push(`| \`${b.branch}\` | \`${b.head}\` | ${b.ahead_of_main} | ${subj} |`);
      }
      lines.push('');
    }
  }

  // Recent unintegrated Codex outputs (live discovery)
  if (codex.length > 0) {
    lines.push('## Recent Codex outputs (last 48h, possibly unintegrated)');
    lines.push('');
    for (const c of codex.slice(0, 8)) {
      lines.push(`- \`/tmp/${c.name}\` (${c.size_kb.toFixed(1)} KB, ${c.mtime})`);
    }
    if (codex.length > 8) lines.push(`- _… ${codex.length - 8} more_`);
    lines.push('');
  }

  // Git fetch result
  lines.push('## Sync status');
  lines.push('');
  lines.push(`- \`git fetch --all\`: ${fetchOk ? '✓ OK' : '✗ failed (check network)'}`);
  lines.push('');

  // Codex R2 mandate: surface goal progress in auto:resume-session brief.
  try {
    const harnessRootResolved = harnessRoot();
    const packageRoot = path.resolve(__dirname, '..', '..');
    const goal = readGoal(harnessRootResolved);
    if (goal) {
      // Codex R4 fix: centralized buildGoalSnapshot helper (was 17 LOC duplicated).
      const snapshot = buildGoalSnapshot(harnessRootResolved, packageRoot);
      const e = evaluateGoal(goal, snapshot);
      lines.push('## Goal progress');
      lines.push('');
      lines.push(`**${goal.name}**: ${e.complete ? '🎉 MISSION COMPLETE' : 'in progress'} — ${e.criteria_met}/${e.total_criteria} criteria met${e.criteria_overridden > 0 ? ` (${e.criteria_overridden} overridden)` : ''}`);
      for (const c of e.per_criterion) {
        const m = c.met ? '✓' : c.override_active ? '⚠' : ' ';
        lines.push(`- ${m} ${c.id}: ${c.current}/${c.target}${c.override_reason ? ` *override: ${c.override_reason}*` : ''}`);
      }
      lines.push('');
    }
  } catch { /* goal eval is optional */ }

  lines.push('## Recommended next actions');
  lines.push('');
  lines.push('1. Read the operator-facing AUTONOMOUS-PROGRESS.md for richer context');
  lines.push('2. If continuing a known task: `pnpm auto:status TP-XXX` for that task\'s detail');
  lines.push('3. If starting fresh work: `pnpm auto:plan --module MXX --version vY.Z --type frd-polish`');
  lines.push('4. If running daemon: `pnpm auto:daemon` (after operator review of in-flight state)');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('*Generated by `pnpm auto:resume-session`. Pair with `pnpm auto:flush-progress` for full session-cycle durability.*');

  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  const history = readMostRecentHistory();
  const fetchOk = gitFetchAll().ok;
  const codex = discoverUnintegratedCodexOutputs();
  const tasks = discoverInProgressTasks();

  if (args.json) {
    process.stdout.write(
      JSON.stringify(
        {
          history: history ? { path: history.path, captured_at: history.data.captured_at, age_hours: history.ageHours, reason: history.data.reason } : null,
          fetch_ok: fetchOk,
          codex_outputs_recent: codex,
          tasks_in_flight: tasks,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  if (args.quiet) {
    if (!history) {
      process.exit(1);
    }
    if (history.ageHours > args.maxAgeHours) {
      // No output — quiet mode + stale state
      process.exit(0);
    }
  }

  const brief = buildHandoffBrief(args, history, fetchOk, codex, tasks);
  process.stdout.write(brief + '\n');

  if (!history) process.exit(1);
}

main();
