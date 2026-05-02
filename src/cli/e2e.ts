#!/usr/bin/env node
/**
 * pnpm auto:e2e --url <base_url> --user <email> --pass <password>
 *                [--routes route1,route2] [--config <json_file>] [--headed] [--json]
 *
 * Real-browser smoke test for the deployed app. Uses Playwright (Chromium).
 * Bridges the Pillar 5b operator gap: Pillar 4 was deterministic gates only;
 * this validates SPAs with logged-in flows across data → calc → cubes →
 * reporting → AI → MCP layers.
 *
 * Default routes (operator can override with --routes or --config):
 *   /dashboard, /opex, /pipeline, /data-integration, /hierarchy,
 *   /analytics, /regulatory, /governance, /ai, /learn, /admin
 *
 * Artifacts (screenshots, console logs, network summary, findings) land at
 *   <agentRunsRoot>/_e2e/<run_uuid>/
 * for replay + consensus inspection.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { runSmokeSuite, type SmokeSuiteOptions } from '../lib/browserAuto';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();

interface Args {
  url: string;
  user: string | null;
  pass: string | null;
  routes: string[] | null;
  configFile: string | null;
  headed: boolean;
  json: boolean;
  emailSelector: string;
  passwordSelector: string;
  submitSelector: string;
  successUrlPattern: string;
}

function parseArgs(argv: string[]): Args {
  let url = '';
  let user: string | null = null;
  let pass: string | null = null;
  let routes: string[] | null = null;
  let configFile: string | null = null;
  let headed = false;
  let json = false;
  let emailSelector = 'input[type="email"], input[name="email"], input[id="email"]';
  let passwordSelector = 'input[type="password"], input[name="password"], input[id="password"]';
  let submitSelector = 'button[type="submit"], button:has-text("Sign in"), button:has-text("Login")';
  let successUrlPattern = '(/dashboard|/home|/$)';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url' && i + 1 < argv.length) url = argv[++i];
    else if (a === '--user' && i + 1 < argv.length) user = argv[++i];
    else if (a === '--pass' && i + 1 < argv.length) pass = argv[++i];
    else if (a === '--routes' && i + 1 < argv.length) routes = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--config' && i + 1 < argv.length) configFile = argv[++i];
    else if (a === '--headed') headed = true;
    else if (a === '--json') json = true;
    else if (a === '--email-selector' && i + 1 < argv.length) emailSelector = argv[++i];
    else if (a === '--password-selector' && i + 1 < argv.length) passwordSelector = argv[++i];
    else if (a === '--submit-selector' && i + 1 < argv.length) submitSelector = argv[++i];
    else if (a === '--success-url' && i + 1 < argv.length) successUrlPattern = argv[++i];
  }
  return { url, user, pass, routes, configFile, headed, json, emailSelector, passwordSelector, submitSelector, successUrlPattern };
}

const DEFAULT_ROUTES = [
  '/dashboard', '/opex', '/pipeline', '/data-integration', '/hierarchy',
  '/analytics', '/regulatory', '/governance', '/ai', '/learn', '/admin',
];

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url && !args.configFile) {
    console.error('Usage: pnpm auto:e2e --url <base_url> [--user <email> --pass <password>] [--routes a,b,c] [--config <file.json>] [--headed]');
    process.exit(2);
  }

  const cfg: SmokeSuiteOptions = args.configFile && fs.existsSync(args.configFile)
    ? JSON.parse(fs.readFileSync(args.configFile, 'utf8'))
    : {
        base_url: args.url,
        login: {
          email: args.user ?? '',
          password: args.pass ?? '',
          email_selector: args.emailSelector,
          password_selector: args.passwordSelector,
          submit_selector: args.submitSelector,
          success_url_pattern: args.successUrlPattern,
        },
        routes: (args.routes ?? DEFAULT_ROUTES).map((p) => ({
          path: p,
          // Permissive: any visible nav link OR header. Playwright's `:visible`
          // pseudo skips elements hidden via CSS / [hidden] attribute / 0-size.
          // (Most Next.js apps don't expose semantic <main>; the navigation
          // bar is the most reliable post-login signal.) Operator can override
          // per-route via --config <file.json>.
          expect_selector: 'nav a:visible, header:visible, h1:visible',
        })),
        artifacts_root: path.join(HARNESS_ROOT, '.agent-runs', '_e2e'),
      };

  if (!cfg.login.email || !cfg.login.password) {
    console.error('--user + --pass required (or supply via --config <file>)');
    process.exit(2);
  }

  fs.mkdirSync(cfg.artifacts_root, { recursive: true });

  console.log(`auto:e2e starting against ${cfg.base_url} (${cfg.routes.length} routes, headless=${!args.headed})`);
  const result = await runSmokeSuite({ ...cfg, artifacts_root: cfg.artifacts_root });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.exit_status === 'pass' ? 0 : 1);
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:e2e  ${result.exit_status.toUpperCase()}  (${result.duration_ms} ms)`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Steps:        ${result.steps_passed}/${result.steps_total} passed (${result.steps_failed} failed)`);
  console.log(`Network:      ${result.network_summary.total_requests} reqs · ${result.network_summary.failed_requests} failed · ${result.network_summary.slow_requests_5s} slow(>5s)`);
  console.log(`By status:    ${Object.entries(result.network_summary.by_status).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (result.network_summary.bad_status_urls.length > 0) {
    console.log(`Bad-status URLs (4xx/5xx — first ${result.network_summary.bad_status_urls.length}):`);
    for (const u of result.network_summary.bad_status_urls) {
      console.log(`  ${u.status} ${u.url}`);
    }
  }
  console.log(`Screenshots:  ${result.screenshots.length} (under ${result.artifacts_dir})`);
  console.log(`Console:      ${result.console_log.length} entries`);
  console.log('');

  if (result.findings.length > 0) {
    console.log(`Findings (${result.findings.length}):`);
    for (const f of result.findings.slice(0, 20)) {
      const icon = f.severity === 'error' ? '✗' : f.severity === 'warning' ? '⚠' : 'ℹ';
      console.log(`  ${icon} [step ${f.step_index} · ${f.step_kind}] ${f.message}`);
    }
    if (result.findings.length > 20) console.log(`  … +${result.findings.length - 20} more`);
  } else {
    console.log('No findings (clean run).');
  }
  console.log('');
  console.log(`Full artifacts: ${result.artifacts_dir}/artifacts.json`);

  process.exit(result.exit_status === 'pass' ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e run failed:', e);
  process.exit(1);
});
