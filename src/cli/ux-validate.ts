#!/usr/bin/env node
/**
 * pnpm auto:ux-validate <TP-…> [--dry-run] [--apply]
 *
 * Pillar 4 — UX validation gate (Codex GO-with-modifications scope).
 *
 * Reads a task pack with `ux_validation.enabled === true`, invokes Playwright
 * against the configured `preview_url` (or starts `server_command` and waits
 * on `server_ready_check`), runs three deterministic gates (blank-page,
 * console, network) plus optional interaction-script, and writes evidence
 * files. Designed to run AFTER `auto:work` has shipped the diff and BEFORE
 * `auto:consensus` so the codex prompt can read ux-summary.md.
 *
 * Usage:
 *   pnpm auto:ux-validate TP-2026-04-29-002 --apply
 *
 * Without --apply: dry-run that probes Playwright availability + reports the
 * planned action without spawning anything.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { readTaskPack, listRuns, listTasks } from '../lib/runState';
import { evaluateUxResults, probePlaywright, defaultTestTemplatePath, writeEvidence, waitForReady, type PlaywrightRunResult } from '../lib/uxValidate';
import { getLogger } from '../lib/logger';

const __filename = fileURLToPath(import.meta.url);
void __filename;

const log = getLogger('cli:ux-validate');
const HARNESS_ROOT = harnessRoot();

interface Args {
  taskId: string;
  apply: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  let taskId = '';
  let apply = false;
  let verbose = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') apply = false;
    else if (a === '--verbose' || a === '-v') verbose = true;
    else if (!a.startsWith('--') && !taskId) taskId = a;
  }
  if (!taskId) {
    console.error('usage: pnpm auto:ux-validate <TP-…> [--apply]');
    process.exit(64);
  }
  return { taskId, apply, verbose };
}

function findRun(taskId: string): string | null {
  for (const runId of listRuns()) {
    if (listTasks(runId).includes(taskId)) return runId;
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRun(args.taskId);
  if (!runId) {
    console.error(`task ${args.taskId} not found in any run under ${HARNESS_ROOT}/.agent-runs/`);
    process.exit(2);
  }
  const pack = readTaskPack(runId, args.taskId);
  log.info('starting ux-validate', { task_id: args.taskId, run_id: runId, apply: args.apply });

  if (!pack.ux_validation.enabled) {
    console.log(`[ux-validate] task ${args.taskId} has ux_validation.enabled=false; skipping.`);
    console.log(`              Set pack.ux_validation.enabled = true to opt in.`);
    return;
  }

  // Probe Playwright. Codex graceful-degradation pattern.
  const probe = probePlaywright(HARNESS_ROOT);
  if (!probe.installed) {
    throw new Error(
      `[ux-validate] MissingDependencyError: Playwright not found.\n\n` +
      `  Tried:\n` +
      `    1. pnpm exec playwright --version\n` +
      `    2. npx --no playwright --version\n\n` +
      `  Install in your project root:\n` +
      `    pnpm add -D @playwright/test\n` +
      `    pnpm exec playwright install chromium\n\n` +
      `  Or set ux_validation.enabled = false on this task pack to skip.`
    );
  }
  if (args.verbose) console.log(`[ux-validate] playwright detected: ${probe.version}`);

  // Resolve target URL.
  const policy = pack.ux_validation;
  let targetUrl = policy.preview_url;
  let serverProc: ReturnType<typeof spawnSync> | null = null;
  if (!targetUrl && policy.server_command) {
    if (!args.apply) {
      console.log(`[ux-validate] dry-run: would spawn server_command="${policy.server_command}" + wait on ${policy.server_ready_check?.url ?? 'unset'}`);
    } else {
      // For v1 we don't actually fork the server inside this CLI — rely on the
      // operator (or auto:work post-step) to have it running. Document the
      // boundary clearly so users don't get confused. Future v2 will fork +
      // register with the watchdog so dangling servers get reaped.
      throw new Error(
        `[ux-validate] server_command + server_ready_check is not yet auto-spawned in v1.\n` +
        `  v2 will fork + watchdog-register the server. For now:\n` +
        `    1. Start your server in a separate terminal: ${policy.server_command}\n` +
        `    2. Re-run this command with preview_url=<the URL it serves>`
      );
    }
  }
  if (!targetUrl) {
    throw new Error(`[ux-validate] MissingPreviewURLError: ux_validation.preview_url is required (server_command auto-spawn deferred to v2)`);
  }

  // Wait for ready.
  if (policy.server_ready_check) {
    if (args.verbose) console.log(`[ux-validate] waiting for ${policy.server_ready_check.url} to be ready (timeout ${policy.server_ready_check.timeout_ms}ms)…`);
    if (args.apply) {
      try {
        await waitForReady(policy.server_ready_check.url, policy.server_ready_check.timeout_ms);
      } catch (e) {
        throw new Error(`[ux-validate] server_ready_check failed: ${(e as Error).message}`);
      }
    }
  }

  if (!args.apply) {
    console.log(`[ux-validate] DRY-RUN. Would run:`);
    console.log(`  pnpm exec playwright test --reporter=json …`);
    console.log(`  Pages: ${policy.pages_to_capture.join(', ')}`);
    console.log(`  Viewports: ${policy.viewports.map((v) => `${v.name} ${v.width}×${v.height}`).join(', ')}`);
    console.log(`  Browsers: ${policy.browsers.join(', ')}`);
    console.log(`  Console gate: fail on ${policy.console_gate.fail_on.join('+')}, ignore ${policy.console_gate.ignore_patterns.length} patterns`);
    console.log(`  Network gate: fail_on_failed_requests=${policy.network.fail_on_failed_requests}`);
    console.log(`  Interaction script: ${policy.interaction_script ?? defaultTestTemplatePath()}`);
    console.log(`\n  Re-run with --apply to actually invoke Playwright.`);
    return;
  }

  // Spawn Playwright with config injected via env.
  const evidenceDir = path.join(HARNESS_ROOT, '.agent-runs', runId, 'evidence', args.taskId, 'ux');
  fs.mkdirSync(evidenceDir, { recursive: true });
  const reportJson = path.join(evidenceDir, 'playwright-report.json');
  const testFile = policy.interaction_script ?? defaultTestTemplatePath();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HARNESS_UX_TARGET_URL: targetUrl,
    HARNESS_UX_PAGES: policy.pages_to_capture.join(','),
    HARNESS_UX_VIEWPORTS: JSON.stringify(policy.viewports),
    HARNESS_UX_BROWSERS: policy.browsers.join(','),
    HARNESS_UX_EVIDENCE_DIR: evidenceDir,
    HARNESS_UX_AUTH_STORAGE_STATE: policy.auth?.storage_state ?? '',
    PLAYWRIGHT_JSON_OUTPUT_NAME: reportJson,
  };

  console.log(`[ux-validate] running Playwright (${probe.version}) against ${targetUrl}`);
  const r = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', testFile, `--reporter=json`, `--output=${path.join(evidenceDir, 'pw-output')}`],
    { cwd: HARNESS_ROOT, env, encoding: 'utf8', timeout: 5 * 60 * 1000, stdio: ['inherit', 'pipe', 'pipe'] }
  );
  if (args.verbose && r.stderr) console.error(r.stderr);

  // Parse playwright JSON report (best-effort — schema can change between
  // major versions). The default-template emits a custom JSON sidecar at
  // ${HARNESS_UX_EVIDENCE_DIR}/ux-results.json which is our canonical input.
  const sidecarPath = path.join(evidenceDir, 'ux-results.json');
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(
      `[ux-validate] Playwright completed (exit ${r.status}) but did not produce ${sidecarPath}.\n` +
      `  Either the test template did not run, or the env vars (HARNESS_UX_*) were not honored.\n` +
      `  Stderr (last 500 chars): ${(r.stderr ?? '').slice(-500)}`
    );
  }
  const results: PlaywrightRunResult = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

  // Evaluate + write evidence.
  const verdict = evaluateUxResults(results, pack);
  writeEvidence(evidenceDir, results, verdict);

  // Print verdict.
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`UX VALIDATION VERDICT — ${args.taskId}`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Result:   ${verdict.passed ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Summary:  ${verdict.summary}`);
  console.log('');
  console.log(`  blank-page:  ${verdict.gates.blank_page.passed ? '✓' : '✗'} (${verdict.gates.blank_page.failures.length} failures)`);
  console.log(`  console:     ${verdict.gates.console.passed ? '✓' : '✗'} (${verdict.gates.console.failures.length} failures)`);
  console.log(`  network:     ${verdict.gates.network.passed ? '✓' : '✗'} (${verdict.gates.network.failures.length} failures)`);
  console.log(`  interaction: ${verdict.gates.interaction.passed ? '✓' : '✗'} (${verdict.gates.interaction.failures.length} failures)`);
  console.log('');
  console.log(`Evidence: ${evidenceDir}/ux-summary.md`);
  if (!verdict.passed) process.exit(1);
}

main().catch((e) => {
  console.error(`[ux-validate] error: ${(e as Error).message}`);
  process.exit(1);
});
