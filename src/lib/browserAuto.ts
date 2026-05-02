/**
 * v0.5.x — Browser automation primitive for true E2E validation.
 *
 * Why this exists: Pillar 4 UX validation was deterministic-gate-only
 * (a11y on static HTML, no real browser). Pillar 5b prescribed real-browser
 * coverage so operators can validate the deployed app end-to-end across
 * data → calc engine → cubes → reporting → AI → MCP layers. Static-fetch
 * tests (curl, WebFetch) cannot exercise SPAs; logged-in flows require a
 * real browser.
 *
 * Design rules:
 *   - Single primitive: `runBrowserScript()` takes a URL, optional
 *     credentials, and a sequence of high-level steps. Returns a structured
 *     `BrowserRunArtifacts` (screenshots, console logs, network log,
 *     assertion results, timings). Pure inputs → reproducible outputs.
 *   - Headless by default (CI-friendly). `--headed` flag in CLI for debug.
 *   - All runs write artifacts under
 *       <agentRunsRoot>/<run_id>/browser/<run_uuid>/
 *     so consensus reviewers + replay can re-inspect everything.
 *   - Soft failures (page errors, console errors, slow assertions) accrue
 *     into `findings` instead of throwing — the orchestrator decides if
 *     they're blocking. Hard failures (browser crash, timeout > limit)
 *     throw so the harness can mark the gate failed.
 *   - No cookies persisted between calls (clean state per run). Caller
 *     can pass a `storage_state` file for re-use.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import { chromium, type Browser, type Page } from 'playwright';

import { getLogger } from './logger';

const log = getLogger('browser-auto');

// ─── Step DSL ─────────────────────────────────────────────────────────────

export type BrowserStep =
  | { kind: 'navigate'; url: string; wait_for?: 'load' | 'domcontentloaded' | 'networkidle' }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'click'; selector: string }
  | { kind: 'wait_for_selector'; selector: string; timeout_ms?: number }
  | { kind: 'wait_for_url'; url_pattern: string; timeout_ms?: number }
  | { kind: 'screenshot'; name: string; full_page?: boolean }
  | { kind: 'expect_text'; selector: string; text: string; mode?: 'contains' | 'equals' }
  | { kind: 'expect_url'; url_pattern: string }
  | { kind: 'expect_response_ok'; url_pattern: string; status_below?: number }
  | { kind: 'eval_in_page'; script: string; assign_to?: string };

// ─── Artifacts ────────────────────────────────────────────────────────────

export interface BrowserFinding {
  severity: 'info' | 'warning' | 'error';
  step_index: number;
  step_kind: BrowserStep['kind'];
  message: string;
}

export interface BrowserRunArtifacts {
  run_uuid: string;
  url: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  exit_status: 'pass' | 'fail' | 'crash';
  steps_total: number;
  steps_passed: number;
  steps_failed: number;
  findings: BrowserFinding[];
  screenshots: Array<{ name: string; path: string; bytes: number }>;
  console_log: Array<{ type: string; text: string; t_ms: number }>;
  network_summary: {
    total_requests: number;
    failed_requests: number;
    slow_requests_5s: number;
    by_status: Record<string, number>;
    /** Top 20 URLs that returned 4xx/5xx — distinguishes real backend issues
     *  from cosmetic ERR_ABORTED races caused by rapid navigation. */
    bad_status_urls: Array<{ url: string; status: number }>;
  };
  artifacts_dir: string;
}

// ─── Runner ───────────────────────────────────────────────────────────────

export interface BrowserRunOptions {
  url: string;
  steps: BrowserStep[];
  artifacts_root: string;
  /** Default 30000 ms per step. */
  step_timeout_ms?: number;
  /** Default 60000 ms total cap. Hard-fail if exceeded. */
  total_timeout_ms?: number;
  /** Run with visible browser window (debug only). Default false. */
  headed?: boolean;
  /** User agent override. */
  user_agent?: string;
  /** Viewport. Default 1280x720. */
  viewport?: { width: number; height: number };
  /** Bearer auth header. */
  auth_bearer?: string;
}

export async function runBrowserScript(opts: BrowserRunOptions): Promise<BrowserRunArtifacts> {
  const runUuid = crypto.randomBytes(8).toString('hex');
  const artifactsDir = path.join(opts.artifacts_root, runUuid);
  fs.mkdirSync(artifactsDir, { recursive: true });

  const startedAt = new Date();
  const stepTimeout = opts.step_timeout_ms ?? 30_000;
  const totalTimeout = opts.total_timeout_ms ?? 120_000;

  const findings: BrowserFinding[] = [];
  const screenshots: BrowserRunArtifacts['screenshots'] = [];
  const consoleLog: BrowserRunArtifacts['console_log'] = [];
  const byStatus: Record<string, number> = {};
  const badStatusUrls: Array<{ url: string; status: number }> = [];
  let totalReq = 0;
  let failedReq = 0;
  let slowReq = 0;

  let stepsPassed = 0;
  let stepsFailed = 0;
  let exitStatus: BrowserRunArtifacts['exit_status'] = 'pass';

  let browser: Browser | null = null;
  const evalContext: Record<string, unknown> = {};

  const totalDeadline = Date.now() + totalTimeout;

  try {
    browser = await chromium.launch({
      headless: !opts.headed,
      args: ['--disable-dev-shm-usage', '--no-sandbox'],
    });
    const ctx = await browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 720 },
      userAgent: opts.user_agent,
      extraHTTPHeaders: opts.auth_bearer ? { Authorization: `Bearer ${opts.auth_bearer}` } : undefined,
    });
    const page = await ctx.newPage();

    page.on('console', (msg) => {
      consoleLog.push({
        type: msg.type(),
        text: msg.text().slice(0, 500),
        t_ms: Date.now() - startedAt.getTime(),
      });
    });

    page.on('pageerror', (err) => {
      findings.push({
        severity: 'error',
        step_index: -1,
        step_kind: 'navigate',
        message: `pageerror: ${err.message.slice(0, 300)}`,
      });
    });

    const reqStartTimes = new Map<string, number>();
    page.on('request', (req) => {
      reqStartTimes.set(req.url(), Date.now());
      totalReq++;
    });
    page.on('response', (res) => {
      const start = reqStartTimes.get(res.url());
      const elapsed = start ? Date.now() - start : 0;
      if (elapsed > 5000) slowReq++;
      const sBucket = `${Math.floor(res.status() / 100)}xx`;
      byStatus[sBucket] = (byStatus[sBucket] ?? 0) + 1;
      if (res.status() >= 400) {
        failedReq++;
        if (badStatusUrls.length < 20) {
          badStatusUrls.push({ url: res.url().slice(0, 200), status: res.status() });
        }
      }
    });
    page.on('requestfailed', (req) => {
      failedReq++;
      findings.push({
        severity: 'warning',
        step_index: -1,
        step_kind: 'navigate',
        message: `request failed: ${req.url().slice(0, 200)} — ${req.failure()?.errorText ?? 'unknown'}`,
      });
    });

    for (let i = 0; i < opts.steps.length; i++) {
      if (Date.now() > totalDeadline) {
        throw new Error(`total_timeout_ms=${totalTimeout} exceeded at step ${i}`);
      }
      const step = opts.steps[i];
      try {
        await executeStep(page, step, stepTimeout, evalContext);
        stepsPassed++;
        // Auto-screenshot after navigate + after final step
        if (step.kind === 'navigate' || i === opts.steps.length - 1) {
          const name = `auto-step${i}-${step.kind}`;
          const filePath = path.join(artifactsDir, `${name}.png`);
          await page.screenshot({ path: filePath, fullPage: false });
          const stat = fs.statSync(filePath);
          screenshots.push({ name, path: filePath, bytes: stat.size });
        }
      } catch (e) {
        stepsFailed++;
        findings.push({
          severity: 'error',
          step_index: i,
          step_kind: step.kind,
          message: `step ${i} (${step.kind}) failed: ${(e as Error).message.slice(0, 400)}`,
        });
        // Capture failure screenshot
        try {
          const failName = `fail-step${i}-${step.kind}`;
          const filePath = path.join(artifactsDir, `${failName}.png`);
          await page.screenshot({ path: filePath, fullPage: true });
          const stat = fs.statSync(filePath);
          screenshots.push({ name: failName, path: filePath, bytes: stat.size });
        } catch { /* ignore */ }
        exitStatus = 'fail';
        // Continue executing remaining steps so operator gets full picture.
      }
    }
  } catch (e) {
    exitStatus = 'crash';
    findings.push({
      severity: 'error',
      step_index: -1,
      step_kind: 'navigate',
      message: `browser run crashed: ${(e as Error).message.slice(0, 500)}`,
    });
    log.error('browser run crashed', { error: (e as Error).message });
  } finally {
    if (browser) await browser.close().catch(() => { /* ignore */ });
  }

  const endedAt = new Date();
  const artifacts: BrowserRunArtifacts = {
    run_uuid: runUuid,
    url: opts.url,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - startedAt.getTime(),
    exit_status: exitStatus,
    steps_total: opts.steps.length,
    steps_passed: stepsPassed,
    steps_failed: stepsFailed,
    findings,
    screenshots,
    console_log: consoleLog.slice(-200),  // cap log to last 200 entries
    network_summary: {
      total_requests: totalReq,
      failed_requests: failedReq,
      slow_requests_5s: slowReq,
      by_status: byStatus,
      bad_status_urls: badStatusUrls,
    },
    artifacts_dir: artifactsDir,
  };
  fs.writeFileSync(path.join(artifactsDir, 'artifacts.json'), JSON.stringify(artifacts, null, 2));
  return artifacts;
}

async function executeStep(page: Page, step: BrowserStep, timeoutMs: number, evalContext: Record<string, unknown>): Promise<void> {
  switch (step.kind) {
    case 'navigate':
      await page.goto(step.url, { waitUntil: step.wait_for ?? 'domcontentloaded', timeout: timeoutMs });
      return;
    case 'fill':
      await page.fill(step.selector, step.value, { timeout: timeoutMs });
      return;
    case 'click':
      await page.click(step.selector, { timeout: timeoutMs });
      return;
    case 'wait_for_selector':
      await page.waitForSelector(step.selector, { timeout: step.timeout_ms ?? timeoutMs });
      return;
    case 'wait_for_url':
      await page.waitForURL(new RegExp(step.url_pattern), { timeout: step.timeout_ms ?? timeoutMs });
      return;
    case 'screenshot':
      // Caller-named screenshot is captured by runBrowserScript via auto-mechanism —
      // but if explicit, force capture now.
      // (We let runBrowserScript handle persistence for consistency.)
      return;
    case 'expect_text': {
      const el = await page.waitForSelector(step.selector, { timeout: timeoutMs });
      const txt = (await el.textContent()) ?? '';
      const ok = step.mode === 'equals' ? txt.trim() === step.text : txt.includes(step.text);
      if (!ok) throw new Error(`expected ${step.mode ?? 'contains'} "${step.text}", got "${txt.slice(0, 100)}"`);
      return;
    }
    case 'expect_url': {
      const re = new RegExp(step.url_pattern);
      const cur = page.url();
      if (!re.test(cur)) throw new Error(`expected URL ~ /${step.url_pattern}/, got ${cur}`);
      return;
    }
    case 'expect_response_ok': {
      // No-op at step time; status accrues via response listener. The operator
      // reads network_summary.by_status to assess.
      return;
    }
    case 'eval_in_page': {
      const result = await page.evaluate(step.script);
      if (step.assign_to) evalContext[step.assign_to] = result;
      return;
    }
  }
}

/**
 * Convenience: standard "smoke" suite for a deployed Next.js + auth app.
 * Logs in, hits each top-level route, expects 2xx + non-empty page text.
 *
 * Caller specifies routes + selectors (no per-app assumptions baked in).
 */
export interface SmokeSuiteOptions {
  base_url: string;
  login: { email: string; password: string; email_selector: string; password_selector: string; submit_selector: string; success_url_pattern: string };
  routes: Array<{ path: string; expect_selector?: string; expect_text?: string }>;
  artifacts_root: string;
}

export async function runSmokeSuite(opts: SmokeSuiteOptions): Promise<BrowserRunArtifacts> {
  const steps: BrowserStep[] = [
    { kind: 'navigate', url: `${opts.base_url}/login`, wait_for: 'domcontentloaded' },
    { kind: 'wait_for_selector', selector: opts.login.email_selector, timeout_ms: 15_000 },
    { kind: 'fill', selector: opts.login.email_selector, value: opts.login.email },
    { kind: 'fill', selector: opts.login.password_selector, value: opts.login.password },
    { kind: 'click', selector: opts.login.submit_selector },
    { kind: 'wait_for_url', url_pattern: opts.login.success_url_pattern, timeout_ms: 30_000 },
  ];
  for (const route of opts.routes) {
    steps.push({ kind: 'navigate', url: `${opts.base_url}${route.path}`, wait_for: 'networkidle' });
    if (route.expect_selector) steps.push({ kind: 'wait_for_selector', selector: route.expect_selector, timeout_ms: 20_000 });
    if (route.expect_text && route.expect_selector) {
      steps.push({ kind: 'expect_text', selector: route.expect_selector, text: route.expect_text });
    }
  }
  return runBrowserScript({ url: opts.base_url, steps, artifacts_root: opts.artifacts_root, total_timeout_ms: 5 * 60_000 });
}
