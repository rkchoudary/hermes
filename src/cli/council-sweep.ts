#!/usr/bin/env node
/**
 * pnpm auto:council-sweep
 *
 * Sprint L (2026-05-02): retroactive council scan. Walks all council
 * sidecars; for any that flipped to status='failed' AFTER the module's PRs
 * already merged to main, opens revert PRs (via auto:rollback).
 *
 * Closes the "ship first, fail later" risk created by the async-council
 * pattern. Council remains non-blocking on the forward path; this is the
 * cleanup sweep for the rare case where council disagreement only surfaces
 * after merge.
 *
 * Designed to run periodically (e.g., GitHub Actions cron) or after a full
 * portfolio run completes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs {
  dryRun?: boolean;
  autoRollback?: boolean;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (const x of argv) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x === '--auto-rollback') a.autoRollback = true;
    else if (x === '--json') a.json = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:council-sweep [--dry-run] [--auto-rollback] [--json]

Walks .agent-runs/_audit/council/<mod>/<phase>/<ver>.json sidecars; reports
any with status='failed' whose module PRs are merged to origin/main.

  --dry-run        Report only; don't take action
  --auto-rollback  For each failed-but-merged sidecar, invoke auto:rollback
  --json           Machine-readable output

Default: report only.
`);
      process.exit(0);
    }
  }
  return a;
}

function listSidecars(): Array<{ path: string; data: Record<string, unknown> }> {
  const root = path.join(harnessRoot(), '.agent-runs', '_audit', 'council');
  if (!fs.existsSync(root)) return [];
  const out: Array<{ path: string; data: Record<string, unknown> }> = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json')) {
        try { out.push({ path: p, data: JSON.parse(fs.readFileSync(p, 'utf8')) }); } catch { /* skip */ }
      }
    }
  };
  walk(root);
  return out;
}

function moduleMergedToMain(module: string): boolean {
  // Check if any PR with branch matching docs/(trd|sprint-plan)-<mod>-* is merged
  const r = spawnSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '50', '--json', 'headRefName'], { encoding: 'utf8' });
  if (r.status !== 0) return false;
  try {
    const prs = JSON.parse(r.stdout || '[]') as Array<{ headRefName: string }>;
    const mLower = module.toLowerCase();
    return prs.some(p => p.headRefName.startsWith(`docs/trd-${mLower}-`) || p.headRefName.startsWith(`docs/sprint-plan-${mLower}-`) || p.headRefName.startsWith(`feat/${mLower}-impl-`));
  } catch { return false; }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sidecars = listSidecars();
  const failed = sidecars.filter(s => (s.data.status === 'failed' || s.data.status === 'eval-error'));

  const flagged: Array<{ sidecar: string; module: string; phase: string; status: string; merged: boolean; memo: string }> = [];
  for (const s of failed) {
    const module = String(s.data.module || '');
    const phase = String(s.data.phase || '');
    const status = String(s.data.status || '');
    const memo = String(s.data.memo_summary || '');
    const merged = moduleMergedToMain(module);
    flagged.push({ sidecar: s.path, module, phase, status, merged, memo });
  }

  if (args.json) {
    console.log(JSON.stringify({ total_sidecars: sidecars.length, failed_count: failed.length, flagged }, null, 2));
    return;
  }

  console.log(`Council sweep: ${sidecars.length} total sidecars, ${failed.length} with status=failed/eval-error`);
  if (flagged.length === 0) {
    console.log('  no flagged modules');
    return;
  }
  console.log('\nFlagged modules:');
  for (const f of flagged) {
    const tag = f.merged ? '⚠ MERGED' : '  not-merged';
    console.log(`  ${tag} ${f.module}/${f.phase} status=${f.status}`);
    if (f.memo) console.log(`           ${f.memo.slice(0, 100)}`);
  }
  const mergedFailed = flagged.filter(f => f.merged);
  if (args.autoRollback && mergedFailed.length > 0) {
    console.log(`\nAuto-rolling back ${mergedFailed.length} merged-but-failed module(s)…`);
    for (const f of mergedFailed) {
      console.log(`\n→ auto:rollback ${f.module} --phases ${f.phase.replace('-author', '')}`);
      const r = spawnSync('pnpm', ['auto:rollback', f.module, '--phases', f.phase.replace('-author', '')], { stdio: 'inherit' });
      if (r.status !== 0) console.error(`  rollback failed for ${f.module}`);
    }
  }
}

main();
