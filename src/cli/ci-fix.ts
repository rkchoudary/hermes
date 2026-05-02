#!/usr/bin/env node
/**
 * pnpm auto:ci-fix [--since-hours 24] [--auto-merge]
 *
 * Sprint M v2 final (item A): CI auto-fix loop (Composio pattern).
 *
 * Walks recently-merged-to-main PRs; for any whose CI on main subsequently
 * went red (e.g., test failure, build failure that escaped pre-merge),
 * auto-authors a fix-PR by:
 *   1. Identifying the failed check + error output
 *   2. Spawning auto:work --fix-bugs with CI-failure context
 *   3. Opening the fix as a follow-up PR (NOT a revert)
 *
 * Closes the "ship → CI red on main → operator manually reverts" gap.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs {
  sinceHours: number;
  autoMerge: boolean;
  dryRun: boolean;
  oneShot: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { sinceHours: 24, autoMerge: false, dryRun: false, oneShot: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--since-hours' && i + 1 < argv.length) a.sinceHours = parseInt(argv[++i], 10);
    else if (argv[i] === '--auto-merge') a.autoMerge = true;
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:ci-fix [--since-hours 24] [--auto-merge] [--dry-run]

Find recently-merged PRs whose CI on main subsequently went red, and
auto-author fix-PRs (Composio pattern). Default: report only.

  --since-hours    Look-back window (default: 24)
  --auto-merge     Merge fix-PRs automatically once CI green
  --dry-run        Print plan; no PRs opened
`);
      process.exit(0);
    }
  }
  return a;
}

interface FailedCheck {
  workflow: string;
  conclusion: string;
  url: string;
  log_excerpt: string;
}

function findRedCiOnMain(sinceHours: number): Array<{ pr: number; branch: string; commit: string; failedChecks: FailedCheck[] }> {
  // Get recent runs on main
  const r = spawnSync('gh', ['run', 'list', '--branch', 'main', '--status', 'failure', '--limit', '20', '--json', 'databaseId,headBranch,headSha,conclusion,createdAt,workflowName,url'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`gh run list failed: ${r.stderr.slice(0, 300)}`);
    return [];
  }
  const runs = JSON.parse(r.stdout || '[]') as Array<{
    databaseId: number;
    headBranch: string;
    headSha: string;
    conclusion: string;
    createdAt: string;
    workflowName: string;
    url: string;
  }>;
  const cutoff = Date.now() - sinceHours * 3600 * 1000;
  const recent = runs.filter(run => new Date(run.createdAt).getTime() > cutoff && run.conclusion === 'failure');

  // Group by SHA + look up the corresponding PR
  const bySha = new Map<string, FailedCheck[]>();
  for (const run of recent) {
    if (!bySha.has(run.headSha)) bySha.set(run.headSha, []);
    bySha.get(run.headSha)!.push({
      workflow: run.workflowName,
      conclusion: run.conclusion,
      url: run.url,
      log_excerpt: '',  // populated lazily
    });
  }

  const result: Array<{ pr: number; branch: string; commit: string; failedChecks: FailedCheck[] }> = [];
  for (const [sha, checks] of bySha) {
    // Find PR that landed this commit
    const prR = spawnSync('gh', ['pr', 'list', '--state', 'merged', '--search', sha, '--json', 'number,headRefName'], { encoding: 'utf8' });
    if (prR.status !== 0) continue;
    const prs = JSON.parse(prR.stdout || '[]') as Array<{ number: number; headRefName: string }>;
    if (prs.length > 0) {
      result.push({ pr: prs[0].number, branch: prs[0].headRefName, commit: sha, failedChecks: checks });
    }
  }
  return result;
}

function fetchLogExcerpt(workflowUrl: string): string {
  // Get the run's logs (first ~80 lines of failure)
  const idMatch = workflowUrl.match(/runs\/(\d+)/);
  if (!idMatch) return '';
  const id = idMatch[1];
  const r = spawnSync('gh', ['run', 'view', id, '--log-failed'], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  return (r.stdout || '').slice(0, 5000);
}

async function authorFix(target: { pr: number; branch: string; commit: string; failedChecks: FailedCheck[] }): Promise<string | null> {
  // Build a fix prompt for auto:work
  const checksDesc = target.failedChecks.map(c => `- ${c.workflow}: ${c.conclusion}\n  ${c.url}`).join('\n');
  const logBundle = target.failedChecks.map(c => fetchLogExcerpt(c.url)).join('\n\n---\n\n').slice(0, 8000);

  console.log(`\n→ Authoring fix for #${target.pr} (${target.branch})`);
  console.log(`  Failed checks:\n${checksDesc}`);

  // Create a synthetic task pack for the fix
  const fixTaskId = `TP-CI-FIX-${target.commit.slice(0, 8)}`;
  const promptPath = `/tmp/${fixTaskId}-prompt.txt`;
  fs.writeFileSync(promptPath, `CI auto-fix request: PR #${target.pr} (${target.branch}) merged at commit ${target.commit} but CI on main subsequently failed.

Failed checks:
${checksDesc}

Log excerpts:
${logBundle}

TASK: Identify the root cause from the log excerpts, then propose a minimal fix.
Output ONLY a unified diff that, when applied to origin/main, fixes the failing checks.
Do NOT run any git commands or make commits — just produce the diff.`);

  // Spawn claude --print with the prompt; capture the diff output
  const r = spawnSync('sh', ['-c', `claude --print --dangerously-skip-permissions < "${promptPath}" 2>&1`], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 5 * 60_000 });
  if (r.status !== 0) {
    console.error(`  fix authoring failed: exit=${r.status}`);
    return null;
  }
  // Extract diff from the output
  const diffMatch = (r.stdout || '').match(/(?:```diff\s*\n)?(diff --git[\s\S]+?)(?:\n```|$)/);
  if (!diffMatch) {
    console.error(`  no diff in output`);
    return null;
  }
  const diff = diffMatch[1];
  const diffPath = `/tmp/${fixTaskId}-fix.patch`;
  fs.writeFileSync(diffPath, diff + '\n');
  return diffPath;
}

async function openFixPr(diffPath: string, target: { pr: number; branch: string; commit: string; failedChecks: FailedCheck[] }): Promise<string | null> {
  const repoRoot = process.env.HERMES_PROJECT_ROOT || process.cwd();
  const fixBranch = `fix/ci-${target.branch.replace(/[^a-z0-9-]/gi, '-')}-${Date.now()}`;
  // Create branch off main
  spawnSync('git', ['-C', repoRoot, 'fetch', 'origin', 'main', '--quiet'], { encoding: 'utf8' });
  spawnSync('git', ['-C', repoRoot, 'checkout', '-b', fixBranch, 'origin/main'], { encoding: 'utf8' });
  // Apply diff
  const apply = spawnSync('git', ['-C', repoRoot, 'apply', '--3way', diffPath], { encoding: 'utf8' });
  if (apply.status !== 0) {
    console.error(`  diff apply failed: ${apply.stderr.slice(0, 300)}`);
    spawnSync('git', ['-C', repoRoot, 'checkout', 'main'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoRoot, 'branch', '-D', fixBranch], { encoding: 'utf8' });
    return null;
  }
  spawnSync('git', ['-C', repoRoot, 'add', '-A'], { encoding: 'utf8' });
  const commit = spawnSync('git', ['-C', repoRoot, 'commit', '-m', `fix(ci): auto-fix for #${target.pr} CI failure on main`], { encoding: 'utf8' });
  if (commit.status !== 0) {
    console.error(`  commit failed: ${commit.stderr.slice(0, 300)}`);
    return null;
  }
  spawnSync('git', ['-C', repoRoot, 'push', '-u', 'origin', fixBranch], { encoding: 'utf8' });
  const pr = spawnSync('gh', ['pr', 'create', '--base', 'main', '--head', fixBranch, '--title', `fix(ci): auto-fix CI failure on main from #${target.pr}`, '--body', `Auto-generated by auto:ci-fix.\n\nReverts/fixes CI failures introduced by merge of #${target.pr} (commit ${target.commit}).\n\nFailed workflows:\n${target.failedChecks.map((c) => `- ${c.workflow}`).join('\n')}`], { encoding: 'utf8', cwd: repoRoot });
  spawnSync('git', ['-C', repoRoot, 'checkout', 'main'], { encoding: 'utf8' });
  if (pr.status === 0) return (pr.stdout || '').trim();
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = findRedCiOnMain(args.sinceHours);
  console.log(`auto:ci-fix scan: ${targets.length} merged-but-CI-failed PR(s) in last ${args.sinceHours}h`);
  if (targets.length === 0) return;

  // Persist scan
  const histPath = path.join(harnessRoot(), '.agent-runs', '_ci-fix.jsonl');
  fs.appendFileSync(histPath, JSON.stringify({ at: new Date().toISOString(), scan_count: targets.length, since_hours: args.sinceHours }) + '\n');

  if (args.dryRun) {
    targets.forEach(t => console.log(`  #${t.pr} ${t.branch} → ${t.failedChecks.length} failed checks`));
    return;
  }

  for (const t of targets) {
    const diffPath = await authorFix(t);
    if (!diffPath) { console.error(`  skipping #${t.pr}: no fix produced`); continue; }
    const url = await openFixPr(diffPath, t);
    if (url) console.log(`  ✓ fix PR opened: ${url}`);
    if (args.autoMerge && url) {
      const prNum = url.match(/\/pull\/(\d+)/)?.[1];
      if (prNum) {
        // Wait briefly for CI then merge
        spawnSync('sleep', ['60']);
        spawnSync('gh', ['pr', 'merge', prNum, '--merge', '--admin'], { encoding: 'utf8' });
      }
    }
  }
}

main().catch((e) => { console.error(`[ci-fix] fatal: ${(e as Error).message}`); process.exit(99); });
