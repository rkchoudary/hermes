#!/usr/bin/env node
/**
 * pnpm auto:rebase-stale (M3) — auto-rebase open PRs whose branches are
 * stale vs origin/main.
 *
 * Closes the recurring "stale-base Vercel error" pattern observed throughout
 * this session: sub-agents/workers fetch a SHA, then origin/main moves
 * forward, and the resulting PR is N commits behind. CI sometimes catches
 * it, sometimes doesn't (depends on what changed); the safest default is to
 * rebase before any landing operation.
 *
 * Usage:
 *   pnpm auto:rebase-stale                  # diagnose only (no mutations)
 *   pnpm auto:rebase-stale --apply          # actually rebase + force-push-with-lease
 *   pnpm auto:rebase-stale --threshold 5    # only rebase if >=5 commits behind (default 3)
 *   pnpm auto:rebase-stale --branch <name>  # restrict to a single branch
 *   pnpm auto:rebase-stale --json           # machine-readable output
 *
 * Safety:
 *   - Refuses to operate on branches with uncommitted changes
 *   - Always uses --force-with-lease (never plain --force)
 *   - Bails on conflict; reports for operator (does NOT attempt --resolve-using-merges)
 *   - Skips main/master and any branch named in EXCLUDED_BRANCHES
 *   - Honors kill switch (refuses to operate if engaged)
 *
 * Phase 1 (M3 from M-agent series). Phase 2 will integrate with auto:land
 * + auto:merge for full pre-promotion freshness checks.
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

const EXCLUDED_BRANCHES = new Set(['main', 'master', 'gh-pages', 'production', 'release']);
const DEFAULT_THRESHOLD = 3;

interface Args {
  apply: boolean;
  threshold: number;
  branch?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, threshold: DEFAULT_THRESHOLD, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--json') args.json = true;
    else if (a === '--threshold' && i + 1 < argv.length) args.threshold = parseInt(argv[++i], 10);
    else if (a === '--branch' && i + 1 < argv.length) args.branch = argv[++i];
  }
  return args;
}

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit: number | null;
}

function run(cmd: string, cmdArgs: string[], cwd: string, timeoutMs = 60_000): RunResult {
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', exit: r.status };
}

interface BranchReport {
  name: string;
  head_sha: string;
  base_sha: string;
  commits_ahead: number;
  commits_behind: number;
  has_uncommitted: boolean;
  pr_number?: number;
  status: 'fresh' | 'stale-skipped' | 'rebased' | 'conflict' | 'dirty' | 'excluded' | 'error';
  detail?: string;
}

interface RebaseStaleReport {
  timestamp: string;
  apply: boolean;
  threshold: number;
  current_main_sha: string;
  branches: BranchReport[];
  rebased_count: number;
  conflict_count: number;
  skipped_count: number;
}

function getCurrentMainSha(repoRoot: string): string {
  // Always fetch first to make sure we're against a fresh origin/main
  const fetch = run('git', ['fetch', 'origin', 'main', '--quiet'], repoRoot, 30_000);
  if (!fetch.ok) {
    throw new Error(`git fetch origin main failed: ${fetch.stderr.slice(0, 200)}`);
  }
  const r = run('git', ['rev-parse', 'origin/main'], repoRoot, 5_000);
  if (!r.ok) throw new Error(`git rev-parse origin/main failed`);
  return r.stdout.trim();
}

function listOpenPrs(repoRoot: string): Map<string, number> {
  const r = run(
    'gh',
    ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,headRefName'],
    repoRoot,
    30_000
  );
  const map = new Map<string, number>();
  if (!r.ok) return map;
  try {
    const list = JSON.parse(r.stdout) as Array<{ number: number; headRefName: string }>;
    for (const p of list) map.set(p.headRefName, p.number);
  } catch { /* ignore */ }
  return map;
}

function listLocalBranches(repoRoot: string): Array<{ name: string; sha: string }> {
  const r = run(
    'git',
    ['for-each-ref', '--format=%(refname:short)\t%(objectname:short)', 'refs/heads/'],
    repoRoot,
    10_000
  );
  if (!r.ok) return [];
  return r.stdout
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [name, sha] = l.split('\t');
      return { name, sha };
    });
}

function rebaseBranch(branch: string, repoRoot: string): { ok: boolean; detail: string } {
  // Use a worktree to perform the rebase WITHOUT switching the current
  // checkout. Avoids contaminating the operator's working state.
  const worktreeRoot = path.join(repoRoot, '.claude', 'worktrees', `_rebase-${branch.replace(/\//g, '-')}`);
  // Clean any prior worktree for idempotency
  if (fs.existsSync(worktreeRoot)) {
    run('git', ['worktree', 'remove', '--force', worktreeRoot], repoRoot, 30_000);
  }
  const wt = run('git', ['worktree', 'add', worktreeRoot, branch], repoRoot, 30_000);
  if (!wt.ok) return { ok: false, detail: `worktree add failed: ${wt.stderr.slice(0, 200)}` };

  try {
    const rebase = run('git', ['rebase', 'origin/main'], worktreeRoot, 60_000);
    if (!rebase.ok) {
      // Conflict; abort + clean
      run('git', ['rebase', '--abort'], worktreeRoot, 10_000);
      return { ok: false, detail: `rebase conflict — operator must resolve manually: ${rebase.stderr.slice(0, 300)}` };
    }
    const push = run(
      'git',
      ['push', '--force-with-lease', 'origin', branch],
      worktreeRoot,
      60_000
    );
    if (!push.ok) {
      return { ok: false, detail: `push --force-with-lease failed: ${push.stderr.slice(0, 300)}` };
    }
    return { ok: true, detail: `rebased + pushed (force-with-lease)` };
  } finally {
    run('git', ['worktree', 'remove', '--force', worktreeRoot], repoRoot, 30_000);
  }
}

function main(): void {
  refuseIfKillSwitchActive(HARNESS_ROOT);

  const args = parseArgs(process.argv.slice(2));
  const repoRoot = (() => {
    const r = run('git', ['rev-parse', '--show-toplevel'], HARNESS_ROOT, 5_000);
    if (r.ok) return r.stdout.trim();
    // Fall back to the main repo root via git common dir
    const g = run('git', ['rev-parse', '--git-common-dir'], HARNESS_ROOT, 5_000);
    if (g.ok) return path.dirname(path.isAbsolute(g.stdout.trim()) ? g.stdout.trim() : path.resolve(HARNESS_ROOT, g.stdout.trim()));
    return HARNESS_ROOT;
  })();

  const mainSha = getCurrentMainSha(repoRoot);
  const openPrs = listOpenPrs(repoRoot);
  const localBranches = listLocalBranches(repoRoot);

  const report: RebaseStaleReport = {
    timestamp: new Date().toISOString(),
    apply: args.apply,
    threshold: args.threshold,
    current_main_sha: mainSha.slice(0, 8),
    branches: [],
    rebased_count: 0,
    conflict_count: 0,
    skipped_count: 0,
  };

  for (const { name, sha } of localBranches) {
    if (args.branch && name !== args.branch) continue;
    if (EXCLUDED_BRANCHES.has(name)) {
      report.branches.push({
        name, head_sha: sha, base_sha: '', commits_ahead: 0, commits_behind: 0,
        has_uncommitted: false, status: 'excluded',
      });
      report.skipped_count++;
      continue;
    }

    // Compute ahead/behind vs origin/main
    const ahead = run('git', ['rev-list', '--count', `origin/main..${name}`], repoRoot, 10_000);
    const behind = run('git', ['rev-list', '--count', `${name}..origin/main`], repoRoot, 10_000);
    const aheadN = parseInt((ahead.stdout || '0').trim(), 10);
    const behindN = parseInt((behind.stdout || '0').trim(), 10);

    // Check for uncommitted changes (only matters if branch is checked out)
    const checkedOutAt = run('git', ['worktree', 'list', '--porcelain'], repoRoot, 5_000);
    let hasUncommitted = false;
    if (checkedOutAt.ok) {
      const checkedOut = checkedOutAt.stdout.match(new RegExp(`branch refs/heads/${name.replace(/\//g, '\\/')}`));
      if (checkedOut) {
        const diff = run('git', ['diff', '--quiet', name], repoRoot, 5_000);
        hasUncommitted = diff.exit !== 0;
      }
    }

    const branchReport: BranchReport = {
      name,
      head_sha: sha,
      base_sha: mainSha.slice(0, 8),
      commits_ahead: aheadN,
      commits_behind: behindN,
      has_uncommitted: hasUncommitted,
      pr_number: openPrs.get(name),
      status: 'fresh',
    };

    if (behindN < args.threshold) {
      branchReport.status = 'fresh';
      report.skipped_count++;
    } else if (hasUncommitted) {
      branchReport.status = 'dirty';
      branchReport.detail = `branch is checked out somewhere with uncommitted changes; refusing to rebase`;
      report.skipped_count++;
    } else if (!args.apply) {
      branchReport.status = 'stale-skipped';
      branchReport.detail = `would rebase (${behindN} commits behind); pass --apply to actually do it`;
      report.skipped_count++;
    } else {
      // Actually rebase
      const result = rebaseBranch(name, repoRoot);
      if (result.ok) {
        branchReport.status = 'rebased';
        branchReport.detail = result.detail;
        report.rebased_count++;
      } else {
        branchReport.status = 'conflict';
        branchReport.detail = result.detail;
        report.conflict_count++;
      }
    }

    report.branches.push(branchReport);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`pnpm auto:rebase-stale ${args.apply ? '[APPLY MODE]' : '[DIAGNOSE]'}`);
  console.log(`  origin/main = ${report.current_main_sha} (just fetched)`);
  console.log(`  threshold = ${args.threshold} commits behind`);
  console.log(``);
  for (const b of report.branches) {
    if (b.status === 'excluded') continue; // don't clutter with main/master
    const tag = (() => {
      switch (b.status) {
        case 'fresh': return ' ✓ ';
        case 'stale-skipped': return '⚠ ';
        case 'rebased': return '✓ ';
        case 'conflict': return '✗ ';
        case 'dirty': return '⚠ ';
        default: return '? ';
      }
    })();
    const prTag = b.pr_number ? ` [PR #${b.pr_number}]` : '';
    console.log(`${tag}${b.name}${prTag}: ahead=${b.commits_ahead}, behind=${b.commits_behind}, status=${b.status}`);
    if (b.detail) console.log(`     ${b.detail}`);
  }
  console.log(``);
  console.log(`Summary: ${report.rebased_count} rebased, ${report.conflict_count} conflicts, ${report.skipped_count} skipped`);
  if (!args.apply && report.branches.some((b) => b.status === 'stale-skipped')) {
    console.log(`Re-run with --apply to actually rebase the stale branches.`);
  }
}

main();
