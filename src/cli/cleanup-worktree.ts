#!/usr/bin/env node
/**
 * pnpm auto:cleanup-worktree (M4) — remove worktrees whose branches are merged.
 *
 * After a PR lands, the corresponding `.claude/worktrees/<task>/` lingers
 * indefinitely (saw 28+ accumulating during this session). This CLI:
 *   1. Scans `.claude/worktrees/`
 *   2. For each worktree, finds the branch and checks if it's merged to
 *      origin/main (via `git merge-base --is-ancestor` and/or PR state)
 *   3. If merged: removes the worktree + deletes the local branch
 *   4. Skips worktrees with uncommitted changes (operator might be working there)
 *
 * Modes:
 *   pnpm auto:cleanup-worktree                    # diagnose only (default; safe)
 *   pnpm auto:cleanup-worktree --apply            # actually remove
 *   pnpm auto:cleanup-worktree --keep-branch      # remove worktree but keep local branch
 *   pnpm auto:cleanup-worktree --max-age-days 7   # only remove worktrees older than this
 *   pnpm auto:cleanup-worktree --json             # machine-readable output
 *
 * Safety:
 *   - Honors kill switch
 *   - Refuses on uncommitted changes
 *   - Verifies branch is ancestor of origin/main (definitive merge proof)
 *     OR has a closed/merged PR (gh pr view)
 *   - Skips the harness package's own active worktree (where this CLI runs)
 *   - Does NOT push (only local cleanup)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { refuseIfKillSwitchActive } from '../lib/taskPack';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

interface Args {
  apply: boolean;
  keepBranch: boolean;
  maxAgeDays: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, keepBranch: false, maxAgeDays: 0, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--keep-branch') args.keepBranch = true;
    else if (a === '--json') args.json = true;
    else if (a === '--max-age-days' && i + 1 < argv.length) args.maxAgeDays = parseInt(argv[++i], 10);
  }
  return args;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit: number | null;
}

function run(cmd: string, cmdArgs: string[], cwd: string, timeoutMs = 30_000): RunResult {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', exit: r.status };
}

function getRepoRoot(): string {
  const r = run('git', ['rev-parse', '--show-toplevel'], HARNESS_ROOT, 5_000);
  if (r.ok) return r.stdout.trim();
  const g = run('git', ['rev-parse', '--git-common-dir'], HARNESS_ROOT, 5_000);
  if (g.ok) {
    const gd = g.stdout.trim();
    return path.dirname(path.isAbsolute(gd) ? gd : path.resolve(HARNESS_ROOT, gd));
  }
  return HARNESS_ROOT;
}

interface WorktreeReport {
  path: string;
  branch: string | null;
  age_days: number;
  has_uncommitted: boolean;
  is_ancestor_of_main: boolean;
  pr_status?: 'merged' | 'closed' | 'open' | 'none';
  status: 'clean-removed' | 'would-remove' | 'kept-active' | 'kept-dirty' | 'kept-unmerged' | 'kept-too-young' | 'skipped' | 'error';
  detail?: string;
}

function listWorktrees(repoRoot: string): Array<{ path: string; branch: string | null; sha: string }> {
  const r = run('git', ['worktree', 'list', '--porcelain'], repoRoot, 10_000);
  if (!r.ok) return [];
  const result: Array<{ path: string; branch: string | null; sha: string }> = [];
  let cur: { path?: string; branch?: string; sha?: string } = {};
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur.path) result.push({ path: cur.path, branch: cur.branch ?? null, sha: cur.sha ?? '' });
      cur = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      cur.sha = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  if (cur.path) result.push({ path: cur.path, branch: cur.branch ?? null, sha: cur.sha ?? '' });
  return result;
}

function isAncestorOfMain(branch: string, repoRoot: string): boolean {
  const r = run('git', ['merge-base', '--is-ancestor', branch, 'origin/main'], repoRoot, 5_000);
  return r.exit === 0;
}

function getPrStatus(branch: string, repoRoot: string): WorktreeReport['pr_status'] {
  const r = run('gh', ['pr', 'view', branch, '--json', 'state,mergedAt'], repoRoot, 30_000);
  if (!r.ok) return 'none';
  try {
    const j = JSON.parse(r.stdout) as { state: string; mergedAt: string | null };
    if (j.mergedAt || j.state === 'MERGED') return 'merged';
    if (j.state === 'CLOSED') return 'closed';
    if (j.state === 'OPEN') return 'open';
    return 'none';
  } catch {
    return 'none';
  }
}

function getWorktreeAgeDays(wpath: string): number {
  try {
    const stat = fs.statSync(wpath);
    return (Date.now() - stat.mtimeMs) / (24 * 3600 * 1000);
  } catch {
    return 0;
  }
}

function hasUncommittedChanges(wpath: string): boolean {
  try {
    if (!fs.existsSync(wpath)) return false;
    const r = run('git', ['status', '--porcelain'], wpath, 10_000);
    return r.ok && r.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

function main(): void {
  refuseIfKillSwitchActive(HARNESS_ROOT);
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = getRepoRoot();

  // Refresh origin/main so ancestry checks are against fresh state
  run('git', ['fetch', 'origin', 'main', '--quiet'], repoRoot, 30_000);

  const worktrees = listWorktrees(repoRoot);
  const reports: WorktreeReport[] = [];
  const myOwnPath = HARNESS_ROOT; // never delete the harness's own worktree

  for (const wt of worktrees) {
    // Skip non-.claude/worktrees/ paths (main repo + any other tooling worktrees)
    if (!wt.path.includes(`/.claude/worktrees/`)) continue;
    // Skip self
    if (wt.path === myOwnPath || HARNESS_ROOT.startsWith(wt.path + path.sep) || wt.path.startsWith(HARNESS_ROOT + path.sep)) {
      reports.push({
        path: wt.path, branch: wt.branch, age_days: 0, has_uncommitted: false,
        is_ancestor_of_main: false, status: 'kept-active', detail: 'this is the harness own worktree',
      });
      continue;
    }

    const ageDays = getWorktreeAgeDays(wt.path);
    const dirty = hasUncommittedChanges(wt.path);
    const ancestor = wt.branch ? isAncestorOfMain(wt.branch, repoRoot) : false;
    const prStatus = wt.branch ? getPrStatus(wt.branch, repoRoot) : undefined;

    const r: WorktreeReport = {
      path: wt.path,
      branch: wt.branch,
      age_days: ageDays,
      has_uncommitted: dirty,
      is_ancestor_of_main: ancestor,
      pr_status: prStatus,
      status: 'skipped',
    };

    if (dirty) {
      r.status = 'kept-dirty';
      r.detail = 'worktree has uncommitted changes; refusing to clean';
    } else if (args.maxAgeDays > 0 && ageDays < args.maxAgeDays) {
      r.status = 'kept-too-young';
      r.detail = `age ${ageDays.toFixed(1)}d < threshold ${args.maxAgeDays}d`;
    } else if (!ancestor && prStatus !== 'merged' && prStatus !== 'closed') {
      r.status = 'kept-unmerged';
      r.detail = `branch '${wt.branch}' is NOT an ancestor of origin/main and PR (if any) is not merged/closed`;
    } else if (!args.apply) {
      r.status = 'would-remove';
      r.detail = `branch is merged (ancestor=${ancestor}, pr=${prStatus}); pass --apply to actually remove`;
    } else {
      // Actually remove
      const removeWt = run('git', ['worktree', 'remove', '--force', wt.path], repoRoot, 30_000);
      if (!removeWt.ok) {
        r.status = 'error';
        r.detail = `git worktree remove failed: ${removeWt.stderr.slice(0, 200)}`;
      } else {
        // Delete local branch unless --keep-branch
        if (!args.keepBranch && wt.branch) {
          const deleteBranch = run('git', ['branch', '-D', wt.branch], repoRoot, 10_000);
          if (deleteBranch.ok) {
            r.status = 'clean-removed';
            r.detail = `worktree removed + branch deleted`;
          } else {
            r.status = 'clean-removed';
            r.detail = `worktree removed; branch deletion: ${deleteBranch.stderr.slice(0, 100)}`;
          }
        } else {
          r.status = 'clean-removed';
          r.detail = `worktree removed (--keep-branch passed; local branch preserved)`;
        }
      }
    }
    reports.push(r);
  }

  if (args.json) {
    console.log(JSON.stringify({ apply: args.apply, threshold_days: args.maxAgeDays, reports }, null, 2));
    return;
  }

  console.log(`pnpm auto:cleanup-worktree ${args.apply ? '[APPLY]' : '[DIAGNOSE]'}`);
  console.log(`  threshold: ${args.maxAgeDays > 0 ? `${args.maxAgeDays}d` : 'no min age'}`);
  console.log(``);
  let removed = 0, would = 0, kept = 0;
  for (const r of reports) {
    const rel = path.relative(path.dirname(HARNESS_ROOT) + '/..', r.path);
    const tag = (() => {
      switch (r.status) {
        case 'clean-removed': return '✓ ';
        case 'would-remove': return '⚠ ';
        case 'kept-dirty': return '⚠ ';
        case 'kept-unmerged': return ' ✓';
        case 'kept-too-young': return ' ⏳';
        case 'kept-active': return ' ⏷';
        case 'error': return '✗ ';
        default: return '? ';
      }
    })();
    console.log(`${tag}${rel} (branch=${r.branch ?? 'detached'}, age=${r.age_days.toFixed(1)}d, ancestor=${r.is_ancestor_of_main}, pr=${r.pr_status ?? '?'}): ${r.status}`);
    if (r.detail) console.log(`     ${r.detail}`);
    if (r.status === 'clean-removed') removed++;
    else if (r.status === 'would-remove') would++;
    else kept++;
  }
  console.log(``);
  console.log(`Summary: ${removed} removed, ${would} would-remove (--apply to actually do it), ${kept} kept`);
}

main();
