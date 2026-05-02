#!/usr/bin/env node
/**
 * pnpm auto:rollback <module>
 *
 * Sprint L (2026-05-02): rollback automation. Finds the most recent merged
 * TRD/Sprint-Plan/Code-Sprint PRs for a module and opens revert PRs for each.
 *
 * Use cases:
 *   - Post-merge issue discovered (regression in production smoke test)
 *   - Council retroactive failure (sidecar updated to "failed" after merge)
 *   - Operator policy change (e.g., new gate retroactively rejects this work)
 *
 * Output: list of revert PR URLs. Operator must merge revert PRs (not auto-
 * merged here — rollback is high-impact and requires conscious choice).
 */
import { spawnSync } from 'node:child_process';

interface CliArgs {
  module: string;
  phases?: ('trd' | 'sprint-plan' | 'code-sprint')[];
  dryRun?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(`pnpm auto:rollback <module> [--phases trd,sprint-plan,code-sprint] [--dry-run]

Open revert PRs for the most recent merged PRs of <module>.

  --phases    Comma-separated phases to revert (default: all merged ones)
  --dry-run   Print what would be reverted; don't open PRs

Example:
  pnpm auto:rollback M21               # revert all M21 phase PRs
  pnpm auto:rollback M21 --phases trd  # revert only M21 TRD PR
  pnpm auto:rollback M21 --dry-run     # preview
`);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const a: CliArgs = { module: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--phases' && i + 1 < argv.length) {
      a.phases = argv[++i].split(',').map(s => s.trim()) as CliArgs['phases'];
    } else if (argv[i] === '--dry-run') {
      a.dryRun = true;
    }
  }
  return a;
}

function findMergedPrs(module: string, phases: string[]): Array<{ number: number; branch: string; phase: string; mergedAt: string }> {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'number,headRefName,mergedAt'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`gh pr list failed: ${r.stderr}`);
    return [];
  }
  const all = JSON.parse(r.stdout || '[]') as Array<{ number: number; headRefName: string; mergedAt: string }>;
  const modLower = module.toLowerCase();
  const prefixMap: Record<string, string> = {
    'trd': `docs/trd-${modLower}-`,
    'sprint-plan': `docs/sprint-plan-${modLower}-`,
    'code-sprint': `feat/${modLower}-impl-`,
  };
  const out: Array<{ number: number; branch: string; phase: string; mergedAt: string }> = [];
  for (const phase of phases) {
    const prefix = prefixMap[phase];
    if (!prefix) continue;
    const matched = all
      .filter(p => p.headRefName.startsWith(prefix))
      .sort((a, b) => (b.mergedAt || '').localeCompare(a.mergedAt || ''))[0];
    if (matched) {
      out.push({ number: matched.number, branch: matched.headRefName, phase, mergedAt: matched.mergedAt });
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const phases = args.phases ?? ['trd', 'sprint-plan', 'code-sprint'];
  const targets = findMergedPrs(args.module, phases);
  if (targets.length === 0) {
    console.error(`No merged PRs found for ${args.module} (phases: ${phases.join(',')})`);
    process.exit(1);
  }
  console.log(`Found ${targets.length} merged PR(s) for ${args.module}:`);
  for (const t of targets) {
    console.log(`  #${t.number} ${t.branch} (${t.phase}) merged=${t.mergedAt}`);
  }
  if (args.dryRun) {
    console.log('--dry-run: no revert PRs opened');
    return;
  }
  const opened: string[] = [];
  for (const t of targets) {
    console.log(`\nReverting #${t.number} (${t.branch})…`);
    // Use gh to revert the merge commit
    const sha = spawnSync('gh', ['pr', 'view', String(t.number), '--json', 'mergeCommit', '--jq', '.mergeCommit.oid'], { encoding: 'utf8' });
    const mergeCommit = (sha.stdout || '').trim();
    if (!mergeCommit) {
      console.error(`  could not resolve merge commit for #${t.number}; skipping`);
      continue;
    }
    const branchName = `revert/${t.branch.replace(/[^a-z0-9-]/gi, '-')}-${Date.now()}`;
    const repoRoot = process.env.HERMES_PROJECT_ROOT || process.cwd();
    spawnSync('git', ['-C', repoRoot, 'fetch', 'origin', 'main', '--quiet'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoRoot, 'checkout', '-b', branchName, 'origin/main'], { encoding: 'utf8' });
    const revertResult = spawnSync('git', ['-C', repoRoot, 'revert', '--no-edit', '-m', '1', mergeCommit], { encoding: 'utf8' });
    if (revertResult.status !== 0) {
      console.error(`  git revert failed: ${revertResult.stderr.slice(0, 300)}`);
      spawnSync('git', ['-C', repoRoot, 'revert', '--abort'], { encoding: 'utf8' });
      spawnSync('git', ['-C', repoRoot, 'checkout', 'main'], { encoding: 'utf8' });
      spawnSync('git', ['-C', repoRoot, 'branch', '-D', branchName], { encoding: 'utf8' });
      continue;
    }
    spawnSync('git', ['-C', repoRoot, 'push', '-u', 'origin', branchName], { encoding: 'utf8' });
    const prResult = spawnSync('gh', ['pr', 'create', '--base', 'main', '--head', branchName,
      '--title', `revert: rollback #${t.number} (${t.phase} of ${args.module})`,
      '--body', `Auto-generated rollback by auto:rollback CLI.\n\nReverts merge commit ${mergeCommit} which closed #${t.number}.\n\nReason: operator-initiated rollback for ${args.module} ${t.phase}.\nReview + merge to complete rollback.`,
    ], { encoding: 'utf8', cwd: repoRoot });
    if (prResult.status === 0) {
      const url = (prResult.stdout || '').trim();
      console.log(`  ✓ revert PR opened: ${url}`);
      opened.push(url);
    } else {
      console.error(`  gh pr create failed: ${prResult.stderr.slice(0, 300)}`);
    }
    spawnSync('git', ['-C', repoRoot, 'checkout', 'main'], { encoding: 'utf8' });
  }
  console.log(`\nOpened ${opened.length} revert PR(s):`);
  opened.forEach(u => console.log(`  ${u}`));
}

main();
