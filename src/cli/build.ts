#!/usr/bin/env node
/**
 * pnpm auto:build — run the build pipeline (typecheck + smoke + …) with
 * watchdog tracking and structured per-step results.
 *
 * Usage:
 *   pnpm auto:build                             # default pipeline (typecheck + smoke)
 *   pnpm auto:build --only typecheck            # subset
 *   pnpm auto:build --skip test                 # exclude
 *   pnpm auto:build --no-fail-fast              # run all even on failure
 *   pnpm auto:build --json                      # machine-readable
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, formatPipelineHuman, DEFAULT_PIPELINE } from '../lib/buildPipeline';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_build = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_build);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = harnessRoot();

interface Args {
  only: string[];
  skip: string[];
  fail_fast: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { only: [], skip: [], fail_fast: true, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--no-fail-fast') a.fail_fast = false;
    else if (x === '--json') a.json = true;
    else if (x === '--only' && i + 1 < argv.length) a.only = argv[++i].split(',').map((s) => s.trim()).filter((s) => s);
    else if (x === '--skip' && i + 1 < argv.length) a.skip = argv[++i].split(',').map((s) => s.trim()).filter((s) => s);
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const r = runPipeline({
    cwd: PACKAGE_ROOT,
    harness_root: HARNESS_ROOT,
    fail_fast: args.fail_fast,
    only: args.only.length > 0 ? args.only : undefined,
    skip: args.skip.length > 0 ? args.skip : undefined,
  });
  if (args.json) {
    console.log(JSON.stringify({
      ok: r.ok,
      duration_ms: r.duration_ms,
      ran: r.ran,
      skipped: r.skipped,
      required_failures: r.required_failures,
      optional_failures: r.optional_failures,
      steps: r.steps.map((s) => ({
        id: s.step.id,
        ok: s.ok,
        exit_code: s.exit_code,
        duration_ms: s.duration_ms,
        killed_by_watchdog: s.killed_by_watchdog,
        error: s.error,
      })),
    }, null, 2));
  } else {
    console.log(formatPipelineHuman(r));
  }
  process.exit(r.ok ? 0 : 1);
}

try { main(); }
catch (e) {
  console.error(`[build] error: ${(e as Error).message}`);
  process.exit(2);
}

void DEFAULT_PIPELINE;  // keep import for IDE jump
