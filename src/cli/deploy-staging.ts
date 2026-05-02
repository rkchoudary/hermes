#!/usr/bin/env node
/**
 * pnpm auto:deploy-staging <module>
 *
 * Sprint M (#19): Stage 29 staging deploy verification.
 * Runs deploy/staging.sh OR pnpm deploy:staging if present; smoke-tests
 * /health endpoint. No-op when no staging configured (graceful skip).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';
import { readTaskPack } from '../lib/runState';

interface CliArgs { module: string; taskId?: string; dryRun?: boolean; }

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(`pnpm auto:deploy-staging <module> [--task-id TP-...] [--dry-run]`);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const a: CliArgs = { module: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--task-id' && i + 1 < argv.length) a.taskId = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
  }
  return a;
}

function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: harnessRoot(), encoding: 'utf8' });
  return r.stdout?.trim() || process.env.HERMES_PROJECT_ROOT || process.cwd();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const start = Date.now();
  const repo = repoRoot();
  const stagingScript = path.join(repo, 'deploy', 'staging.sh');
  const rootPkg = path.join(repo, 'package.json');

  let plan: 'script' | 'pnpm' | 'noop' = 'noop';
  let cmd: string[] = [];
  if (fs.existsSync(stagingScript)) {
    const stat = fs.statSync(stagingScript);
    if (stat.mode & 0o100) { plan = 'script'; cmd = [stagingScript, args.module]; }
  }
  if (plan === 'noop' && fs.existsSync(rootPkg)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(rootPkg, 'utf8'));
      if (pkg?.scripts?.['deploy:staging']) {
        plan = 'pnpm'; cmd = ['pnpm', 'deploy:staging', '--', args.module];
      }
    } catch { /* skip */ }
  }

  console.log(`[deploy-staging] module=${args.module} plan=${plan}`);
  if (args.dryRun) { console.log(`[dry-run] would invoke: ${cmd.join(' ')}`); return; }

  const result = {
    status: 'unknown' as 'ok' | 'failed' | 'no-staging-configured' | 'unknown',
    plan, cmd: cmd.join(' '),
    deploy_url: null as string | null,
    smoke_test: null as { ok: boolean; status_code?: number; ms?: number } | null,
    duration_ms: 0, at: new Date().toISOString(),
  };

  if (plan === 'noop') {
    result.status = 'no-staging-configured';
    console.log(`status=no-staging-configured (no deploy/staging.sh, no pnpm deploy:staging)`);
  } else {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd: repo, encoding: 'utf8', timeout: 30 * 60_000 });
    if (r.status === 0) {
      result.status = 'ok';
      const urlMatch = (r.stdout || '').match(/https?:\/\/[^\s]+/);
      if (urlMatch) result.deploy_url = urlMatch[0];
      if (result.deploy_url) {
        const smokeStart = Date.now();
        const sm = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', `${result.deploy_url}/health`, '--max-time', '60'], { encoding: 'utf8' });
        const code = parseInt(sm.stdout?.trim() || '0', 10);
        result.smoke_test = { ok: code === 200, status_code: code, ms: Date.now() - smokeStart };
        if (code !== 200) { result.status = 'failed'; console.error(`/health returned ${code}`); }
      }
    } else { result.status = 'failed'; console.error(`deploy exit ${r.status}: ${(r.stderr || '').slice(0, 500)}`); }
  }

  result.duration_ms = Date.now() - start;
  if (args.taskId) {
    try {
      const runsDir = path.join(harnessRoot(), '.agent-runs');
      for (const dirent of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const taskFile = path.join(runsDir, dirent.name, 'tasks', `${args.taskId}.json`);
        if (fs.existsSync(taskFile)) {
          const pack = readTaskPack(dirent.name, args.taskId);
          if (pack.evidence_dir && fs.existsSync(pack.evidence_dir)) {
            fs.writeFileSync(path.join(pack.evidence_dir, 'deploy-staging.json'), JSON.stringify(result, null, 2));
          }
          break;
        }
      }
    } catch { /* skip */ }
  }
  console.log(`[deploy-staging] status=${result.status} duration=${result.duration_ms}ms`);
  if (result.status === 'failed') process.exit(1);
}

main().catch((e) => { console.error(`[deploy-staging] fatal: ${(e as Error).message}`); process.exit(99); });
