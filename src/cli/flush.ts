#!/usr/bin/env node
/**
 * pnpm auto:flush-progress — flush durable session/daemon state to disk for resume.
 *
 * Captures, in <2 seconds:
 *  - Current run manifest + tail of state-log.jsonl
 *  - Open task packs by state
 *  - Recent Codex outputs at /tmp/codex-*.md (unintegrated into CODEX-REVIEW.md)
 *  - In-flight background-task IDs (best-effort)
 *  - Recent commits on each open PR (last 5 each)
 *  - Architecture iteration state (which doc is current)
 *  - Writes to ${process.env.HERMES_PROGRESS_PATH ?? "./PROGRESS.md"} (operator-facing)
 *  - Appends to tools/autonomous-delivery/session-history/<UTC-timestamp>.json
 *
 * Usage:
 *   pnpm auto:flush-progress                                        # default
 *   pnpm auto:flush-progress --reason "session-end"                 # tag the flush
 *   pnpm auto:flush-progress --output ~/custom-progress.md          # custom output
 *   pnpm auto:flush-progress --json                                 # machine-readable to stdout
 *
 * Idempotent: same input → same output (modulo timestamp).
 * Atomic: writes via tempfile-then-rename per INV-CW-2.
 * Bounded: ≤32 KB output (truncates oldest evidence summaries).
 *
 * Designed for SessionEnd hook in .claude/settings.json:
 *   { "hooks": { "SessionEnd": [ { "type": "command", "command":
 *     "pnpm --dir tools/autonomous-delivery auto:flush-progress --reason session-end" } ] } }
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
const DEFAULT_OUTPUT = path.join(os.homedir(), process.env.HERMES_PROGRESS_PATH || './PROGRESS.md');
const MAX_OUTPUT_KB = 32;

interface FlushArgs {
  reason: string;
  output: string;
  json: boolean;
}

function parseArgs(argv: string[]): FlushArgs {
  let reason = 'manual';
  let output = DEFAULT_OUTPUT;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--reason' && i + 1 < argv.length) reason = argv[++i];
    else if (a === '--output' && i + 1 < argv.length) output = path.resolve(argv[++i]);
    else if (a === '--json') json = true;
  }
  return { reason, output, json };
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function discoverRunsState(): { runs: number; tasks_by_state: Record<string, number>; latest_run: string | null } {
  const tasks_by_state: Record<string, number> = {};
  if (!fs.existsSync(RUNS_DIR)) return { runs: 0, tasks_by_state, latest_run: null };
  const runs = fs.readdirSync(RUNS_DIR).filter((d) => fs.statSync(path.join(RUNS_DIR, d)).isDirectory());
  let latest_run: string | null = null;
  let latest_mtime = 0;
  for (const runId of runs) {
    const tasksDir = path.join(RUNS_DIR, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    const mtime = fs.statSync(tasksDir).mtimeMs;
    if (mtime > latest_mtime) {
      latest_mtime = mtime;
      latest_run = runId;
    }
    for (const taskFile of fs.readdirSync(tasksDir)) {
      if (!taskFile.endsWith('.json')) continue;
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(tasksDir, taskFile), 'utf8'));
        tasks_by_state[pack.state] = (tasks_by_state[pack.state] ?? 0) + 1;
      } catch {
        // skip
      }
    }
  }
  return { runs: runs.length, tasks_by_state, latest_run };
}

function discoverCodexOutputs(): { recent: Array<{ name: string; size_kb: number; mtime: string }> } {
  const tmpDir = '/tmp';
  if (!fs.existsSync(tmpDir)) return { recent: [] };
  const recent = fs
    .readdirSync(tmpDir)
    .filter((f) => /^codex-(arch|frd-).*\.md$/.test(f))
    .map((f) => {
      const full = path.join(tmpDir, f);
      const stat = fs.statSync(full);
      return { name: f, size_kb: stat.size / 1024, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime))
    .slice(0, 10);
  return { recent };
}

function discoverRecentCommits(): { branches: Array<{ branch: string; head: string; subject: string; ahead_of_main: number }> } {
  const branches: Array<{ branch: string; head: string; subject: string; ahead_of_main: number }> = [];
  // Look at all git worktrees under REPO_ROOT/.claude/worktrees and the main repo
  const worktreesRoot = path.join(REPO_ROOT, '..', '..', '..');
  // Use parent-repo's worktree list
  const result = spawnSync('git', ['-C', REPO_ROOT, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (result.status !== 0) return { branches };
  const lines = (result.stdout ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('worktree ')) {
      const wtPath = line.slice(9).trim();
      // Find branch line
      const branchLine = lines[i + 2] || '';
      const branch = branchLine.startsWith('branch ')
        ? branchLine.slice(7).trim().replace(/^refs\/heads\//, '')
        : 'detached';
      // Get HEAD subject
      const headResult = spawnSync('git', ['-C', wtPath, 'log', '-1', '--format=%H|%s'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (headResult.status !== 0) continue;
      const [head, ...subjectParts] = (headResult.stdout ?? '').trim().split('|');
      const subject = subjectParts.join('|');
      // Count commits ahead of main
      const aheadResult = spawnSync('git', ['-C', wtPath, 'rev-list', '--count', 'main..HEAD'], {
        encoding: 'utf8',
        timeout: 5_000,
      });
      const ahead = parseInt((aheadResult.stdout ?? '0').trim(), 10) || 0;
      branches.push({ branch, head: head.slice(0, 7), subject, ahead_of_main: ahead });
    }
  }
  return { branches };
}

function discoverOpenPRs(): Array<{ number: number; title: string; state: string; head: string }> {
  const result = spawnSync(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'number,title,state,headRefName', '--limit', '20'],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.status !== 0) return [];
  try {
    const arr = JSON.parse(result.stdout ?? '[]') as Array<{
      number: number;
      title: string;
      state: string;
      headRefName: string;
    }>;
    return arr.map((p) => ({ number: p.number, title: p.title, state: p.state, head: p.headRefName }));
  } catch {
    return [];
  }
}

function atomicWrite(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function buildOperatorMarkdown(args: FlushArgs, snapshot: ReturnType<typeof captureSnapshot>): string {
  const { reason } = args;
  const { runs_state, codex_outputs, branches, prs, captured_at } = snapshot;

  const sections: string[] = [];
  sections.push('# NBF Autonomous Delivery — Live Progress');
  sections.push('');
  sections.push(`**Last flushed:** ${captured_at} (reason: \`${reason}\`)`);
  sections.push(`**Mechanism:** auto:flush-progress (FR-IH-NEW v0.4.1; durable + atomic + bounded ≤${MAX_OUTPUT_KB} KB)`);
  sections.push(`**Resume from any session:** read this file + run \`pnpm auto:resume-session\` (or \`/resume\` slash command)`);
  sections.push('');

  sections.push('## Run state');
  sections.push('');
  sections.push(`Runs in \`.agent-runs/\`: ${runs_state.runs}`);
  if (runs_state.latest_run) sections.push(`Latest run: \`${runs_state.latest_run}\``);
  sections.push('');
  sections.push('Tasks by state:');
  for (const [state, count] of Object.entries(runs_state.tasks_by_state).sort()) {
    sections.push(`- ${state}: ${count}`);
  }
  if (Object.keys(runs_state.tasks_by_state).length === 0) sections.push('- (no tasks yet)');
  sections.push('');

  sections.push('## Recent Codex outputs in /tmp/');
  sections.push('');
  if (codex_outputs.recent.length === 0) {
    sections.push('(no recent codex outputs)');
  } else {
    sections.push('| File | Size (KB) | Modified |');
    sections.push('|---|---|---|');
    for (const c of codex_outputs.recent) {
      sections.push(`| \`${c.name}\` | ${c.size_kb.toFixed(1)} | ${c.mtime} |`);
    }
  }
  sections.push('');

  sections.push('## Active branches (worktrees)');
  sections.push('');
  if (branches.branches.length === 0) {
    sections.push('(no worktrees discovered)');
  } else {
    sections.push('| Branch | HEAD | Subject | Ahead of main |');
    sections.push('|---|---|---|---|');
    for (const b of branches.branches) {
      const subj = b.subject.length > 60 ? b.subject.slice(0, 57) + '...' : b.subject;
      sections.push(`| \`${b.branch}\` | \`${b.head}\` | ${subj} | ${b.ahead_of_main} |`);
    }
  }
  sections.push('');

  sections.push('## Open PRs');
  sections.push('');
  if (prs.length === 0) {
    sections.push('(none open)');
  } else {
    sections.push('| # | Title | Branch | State |');
    sections.push('|---|---|---|---|');
    for (const p of prs) {
      const t = p.title.length > 60 ? p.title.slice(0, 57) + '...' : p.title;
      sections.push(`| #${p.number} | ${t} | \`${p.head}\` | ${p.state} |`);
    }
  }
  sections.push('');

  // Codex R2 mandate: surface goal progress in auto:flush-progress so the
  // operator-facing AUTONOMOUS-PROGRESS.md shows finish-line status.
  try {
    const harnessRootResolved = harnessRoot();
    const packageRoot = path.resolve(__dirname, '..', '..');
    const goal = readGoal(harnessRootResolved);
    if (goal) {
      // Codex R4 fix: use centralized buildGoalSnapshot helper (was 20 LOC of
      // inline duplication of tick.ts logic).
      const snapshot = buildGoalSnapshot(harnessRootResolved, packageRoot);
      const e = evaluateGoal(goal, snapshot);
      sections.push(`## Goal contract`);
      sections.push('');
      sections.push(`**${goal.name}** (${goal.goal_id})`);
      sections.push('');
      sections.push(`Status: ${e.complete ? '🎉 MISSION COMPLETE' : 'in progress'} — ${e.criteria_met}/${e.total_criteria} criteria met${e.criteria_overridden > 0 ? ` (${e.criteria_overridden} via operator override)` : ''}`);
      sections.push('');
      for (const c of e.per_criterion) {
        const mark = c.met ? '✓' : c.override_active ? '⚠' : ' ';
        const tag = c.override_active ? ` *override: ${c.override_reason}*` : '';
        sections.push(`- ${mark} **${c.id}**: ${c.current}/${c.target}${tag}`);
      }
      sections.push('');
    }
  } catch { /* goal evaluation is optional */ }

  sections.push('## How to resume');
  sections.push('');
  sections.push('From a fresh Claude Code session OR from CLI:');
  sections.push('```');
  sections.push('cd <repo or worktree>');
  sections.push('cat ${process.env.HERMES_PROGRESS_PATH ?? "./PROGRESS.md"}       # this file');
  sections.push('pnpm --dir tools/autonomous-delivery auto:status   # current state');
  sections.push('# OR (interactive)');
  sections.push('/resume                                              # CLAUDE.md skill');
  sections.push('```');
  sections.push('');
  sections.push('---');
  sections.push('');
  sections.push('*Auto-generated by `pnpm auto:flush-progress`. Atomic write per INV-CW-2. Idempotent.*');

  let content = sections.join('\n');
  // Bound size
  if (Buffer.byteLength(content, 'utf8') > MAX_OUTPUT_KB * 1024) {
    const note = `\n\n_… truncated to ${MAX_OUTPUT_KB} KB per FR-IH-NEW v0.4.1 bounding rule …_\n`;
    content = content.slice(0, MAX_OUTPUT_KB * 1024 - note.length) + note;
  }
  return content;
}

function captureSnapshot(reason: string) {
  return {
    captured_at: new Date().toISOString(),
    reason,
    runs_state: discoverRunsState(),
    codex_outputs: discoverCodexOutputs(),
    branches: discoverRecentCommits(),
    prs: discoverOpenPRs(),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = captureSnapshot(args.reason);

  if (args.json) {
    process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
    return;
  }

  const md = buildOperatorMarkdown(args, snapshot);
  atomicWrite(args.output, md);

  // Append to session-history (forensic replay)
  if (!fs.existsSync(SESSION_HISTORY_DIR)) {
    fs.mkdirSync(SESSION_HISTORY_DIR, { recursive: true });
  }
  const histPath = path.join(SESSION_HISTORY_DIR, `${snapshot.captured_at.replace(/[:.]/g, '-')}.json`);
  atomicWrite(histPath, JSON.stringify(snapshot, null, 2));

  console.log(`✓ flushed at ${snapshot.captured_at} (reason=${args.reason})`);
  console.log(`  operator-facing: ${args.output} (${Buffer.byteLength(md, 'utf8') / 1024 | 0} KB)`);
  console.log(`  forensic:        ${histPath}`);
}

main();
