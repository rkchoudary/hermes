#!/usr/bin/env node
/**
 * Hermes CLI dispatcher.
 *
 * Routes the first positional arg to the matching tsx CLI in src/cli/. So:
 *   npx hermes init           → tsx src/cli/init.ts
 *   npx hermes plan --module M01 → tsx src/cli/plan.ts --module M01
 *   npx hermes engine-list    → tsx -e 'import...'
 *
 * The full set of commands is defined in package.json scripts ("auto:*").
 * This dispatcher is the user-facing surface; the auto:* scripts remain
 * available for in-repo / pnpm invocations.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_ROOT = path.resolve(__dirname, '..');

// Map: short subcommand → CLI module file (in src/cli/) OR composite command
const ROUTES = {
  init: 'init.ts',
  plan: 'plan.ts',
  work: 'work.ts',
  land: 'land.ts',
  promote: 'promote.ts',
  consensus: 'consensus.ts',
  postflight: 'work.ts',  // postflight is a flag of work
  tick: 'tick.ts',
  doctor: 'doctor.ts',
  dashboard: 'dashboard-live.ts',
  metrics: 'metrics-daemon.ts',
  mcp: 'mcp-server.ts',
  rollback: 'rollback.ts',
  council: 'council-sweep.ts',
  watchdog: 'council-watchdog.ts',
  deploy: 'deploy-staging.ts',
  yaml: 'yaml-runner.ts',
  reflect: 'skill-reflect.ts',
  archive: 's3-archive.ts',
  fix: 'ci-fix.ts',
  resume: 'resume.ts',
  flush: 'flush.ts',
  intake: 'intake.ts',
  replay: 'replay.ts',
  approve: 'approve.ts',
  status: 'doctor.ts',  // alias
  help: null,
};

function printHelp() {
  console.log(`Hermes — autonomous delivery harness

USAGE
  npx hermes <command> [options]

GETTING STARTED
  init                       Bootstrap .hermes/ in current directory
  plan --module M01 ...      Generate a task pack
  work                       Dispatch a worker
  land                       Run blocking gates and open PR

LIVE OBSERVABILITY
  dashboard                  Live HTML dashboard at :7777
  metrics                    Prometheus metrics at :9090
  mcp                        MCP server (JSON-RPC over stdio)

OPERATIONS
  tick                       Cleanup + audit-pack archive
  doctor                     Integrity check on .agent-runs/
  rollback <module>          Open revert PRs for merged module work
  council [--auto-rollback]  Sweep council sidecars
  fix                        Auto-fix red CI on merged PRs
  archive --bucket BUCKET    Upload audit artifacts to S3
  reflect --phase PHASE      LLM reflection on skill memory

ENGINE / WORKFLOW
  yaml <workflow.yaml>       Run an Archon-style YAML workflow
  resume                     Print session-resume brief
  flush                      Append progress snapshot

For per-command help: npx hermes <command> --help
Documentation: https://github.com/rkchoudary/hermes
`);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  printHelp();
  process.exit(0);
}

const subcmd = argv[0];
const rest = argv.slice(1);

if (!(subcmd in ROUTES)) {
  console.error(`Unknown command: ${subcmd}`);
  console.error(`Run \`npx hermes help\` for the command list.`);
  process.exit(2);
}

const routeFile = ROUTES[subcmd];
if (!routeFile) {
  printHelp();
  process.exit(0);
}

const cliPath = path.join(PKG_ROOT, 'src', 'cli', routeFile);
if (!fs.existsSync(cliPath)) {
  console.error(`CLI module not found: ${cliPath}`);
  console.error(`This may be a packaging issue — please file an issue at https://github.com/rkchoudary/hermes/issues`);
  process.exit(3);
}

// Use tsx to run the TypeScript CLI directly. Operators pinning a specific
// tsx version can do so via package.json; this runner finds it through the
// local node_modules first.
const tsxBin = (() => {
  const local = path.join(PKG_ROOT, 'node_modules', '.bin', 'tsx');
  if (fs.existsSync(local)) return local;
  return 'tsx';  // fall back to PATH
})();

const r = spawnSync(tsxBin, [cliPath, ...rest], {
  stdio: 'inherit',
  cwd: process.cwd(),  // run against operator's cwd, not Hermes package dir
  env: { ...process.env, HERMES_PACKAGE_ROOT: PKG_ROOT },
});

process.exit(r.status ?? 1);
