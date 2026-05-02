/**
 * v0.5.0 Pillar 4 — UX validation gate evaluator + Playwright orchestrator.
 *
 * Codex GO-with-modifications scope: deterministic gates only. Catches the
 * "blank production page" failure without taking on model-gated visual judgment,
 * Lighthouse flake, or visual baseline management.
 *
 * Three gates (all deterministic, no model judgment):
 *   1. blank-page    — body must contain > MIN_BODY_CHARS visible chars OR
 *                       a known-root selector. Catches the "build succeeded
 *                       but page is empty" failure mode.
 *   2. console_gate  — any console message matching policy.console_gate.fail_on
 *                       (error|warning) after policy.console_gate.ignore_patterns
 *                       filter triggers a fail.
 *   3. network       — any failed request (status ≥ 400 OR transport error)
 *                       triggers a fail when policy.network.fail_on_failed_requests
 *                       is true. policy.network.ignore_patterns can suppress
 *                       known-noisy domains (analytics 404s).
 *
 * Vision review (advisory_only=true) and visual_regression are stubbed; they do
 * NOT block consensus in v1. a11y + Lighthouse not yet wired (Codex deferred).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import type { TaskPack } from './taskPack';
import { getLogger } from './logger';

const log = getLogger('ux-validate');

const MIN_BODY_CHARS = 50;

export interface PlaywrightRunResult {
  /** Per-page results captured by the harness Playwright harness. */
  pages: Array<{
    url: string;
    viewport: { name: string; width: number; height: number };
    browser: 'chromium' | 'firefox' | 'webkit';
    /** Total chars of visible body text. < MIN_BODY_CHARS = blank. */
    body_text_chars: number;
    /** Console messages captured during the visit. */
    console_messages: Array<{ type: 'log' | 'info' | 'warning' | 'error' | string; text: string }>;
    /** Failed network requests (status ≥ 400 OR transport error). */
    failed_requests: Array<{ url: string; status: number | null; failure: string | null }>;
    screenshot_path?: string;
    trace_path?: string;
  }>;
  /** Optional interaction-script results (raw Playwright test results JSON). */
  interaction_results?: {
    passed: number;
    failed: number;
    skipped: number;
    failures: Array<{ test: string; error: string }>;
  };
}

export interface UxGateVerdict {
  passed: boolean;
  /** One-line summary suitable for state-log + Slack. */
  summary: string;
  /** Per-gate breakdown. */
  gates: {
    blank_page: { passed: boolean; failures: Array<{ url: string; chars: number }> };
    console: { passed: boolean; failures: Array<{ url: string; type: string; text: string }> };
    network: { passed: boolean; failures: Array<{ url: string; req_url: string; status: number | null; failure: string | null }> };
    interaction: { passed: boolean; failures: Array<{ test: string; error: string }> };
  };
  /** Total failure count across all deterministic gates. */
  total_failures: number;
}

/**
 * Pure evaluator: given a parsed PlaywrightRunResult + a TaskPack, return the
 * gate verdict. No filesystem/network/subprocess. Trivially property-testable.
 */
export function evaluateUxResults(
  results: PlaywrightRunResult,
  pack: TaskPack
): UxGateVerdict {
  const policy = pack.ux_validation;
  const verdict: UxGateVerdict = {
    passed: false,
    summary: '',
    gates: {
      blank_page: { passed: true, failures: [] },
      console: { passed: true, failures: [] },
      network: { passed: true, failures: [] },
      interaction: { passed: true, failures: [] },
    },
    total_failures: 0,
  };

  // 1. Blank-page gate
  for (const page of results.pages) {
    if (page.body_text_chars < MIN_BODY_CHARS) {
      verdict.gates.blank_page.failures.push({ url: page.url, chars: page.body_text_chars });
    }
  }
  verdict.gates.blank_page.passed = verdict.gates.blank_page.failures.length === 0;

  // 2. Console gate
  const consoleFailOn = new Set(policy.console_gate.fail_on);
  const consoleIgnore = policy.console_gate.ignore_patterns.map((p) => new RegExp(p));
  for (const page of results.pages) {
    for (const msg of page.console_messages) {
      if (!consoleFailOn.has(msg.type as 'error' | 'warning')) continue;
      if (consoleIgnore.some((re) => re.test(msg.text))) continue;
      verdict.gates.console.failures.push({ url: page.url, type: msg.type, text: msg.text });
    }
  }
  verdict.gates.console.passed = verdict.gates.console.failures.length === 0;

  // 3. Network gate
  if (policy.network.fail_on_failed_requests) {
    const networkIgnore = policy.network.ignore_patterns.map((p) => new RegExp(p));
    for (const page of results.pages) {
      for (const req of page.failed_requests) {
        if (networkIgnore.some((re) => re.test(req.url))) continue;
        verdict.gates.network.failures.push({
          url: page.url,
          req_url: req.url,
          status: req.status,
          failure: req.failure,
        });
      }
    }
  }
  verdict.gates.network.passed = verdict.gates.network.failures.length === 0;

  // 4. Interaction script results (if any)
  if (results.interaction_results) {
    for (const f of results.interaction_results.failures) {
      verdict.gates.interaction.failures.push({ test: f.test, error: f.error });
    }
    verdict.gates.interaction.passed = results.interaction_results.failures.length === 0;
  }

  verdict.total_failures =
    verdict.gates.blank_page.failures.length +
    verdict.gates.console.failures.length +
    verdict.gates.network.failures.length +
    verdict.gates.interaction.failures.length;
  verdict.passed = verdict.total_failures === 0;

  if (verdict.passed) {
    verdict.summary = `UX gates PASS: ${results.pages.length} page(s) × ${results.pages[0]?.viewport.name ?? '?'}…; 0 failures`;
  } else {
    const parts: string[] = [];
    if (!verdict.gates.blank_page.passed) parts.push(`${verdict.gates.blank_page.failures.length} blank`);
    if (!verdict.gates.console.passed) parts.push(`${verdict.gates.console.failures.length} console`);
    if (!verdict.gates.network.passed) parts.push(`${verdict.gates.network.failures.length} network`);
    if (!verdict.gates.interaction.passed) parts.push(`${verdict.gates.interaction.failures.length} interaction`);
    verdict.summary = `UX gates FAIL: ${parts.join(', ')}`;
  }
  return verdict;
}

/**
 * Wait for `server_ready_check.url` to return < 500 within `timeout_ms`.
 * Returns true on ready, throws on timeout. No external deps; uses node:http.
 */
export async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const httpMod = url.startsWith('https:') ? await import('node:https') : await import('node:http');
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const req = httpMod.request(url, { method: 'GET', timeout: 5000 }, (res) => {
          if ((res.statusCode ?? 599) < 500) {
            res.destroy();
            resolve();
          } else {
            res.destroy();
            reject(new Error(`status ${res.statusCode}`));
          }
        });
        req.on('error', (e) => reject(e));
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`waitForReady(${url}) timed out after ${timeoutMs}ms (started ${new Date(started).toISOString()})`);
}

/**
 * Probe whether Playwright is callable. Returns the version string on success
 * (e.g. "1.45.0") or null if the user hasn't installed it. Used to short-circuit
 * with a clear MissingDependencyError before the user burns time waiting.
 */
export function probePlaywright(cwd: string): { installed: boolean; version?: string } {
  try {
    const r = spawnSync('pnpm', ['exec', 'playwright', '--version'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) {
      return { installed: true, version: r.stdout.trim().split('\n')[0] };
    }
  } catch { /* fall through */ }
  // Try direct binary as fallback
  try {
    const r = spawnSync('npx', ['--no', 'playwright', '--version'], {
      cwd,
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) {
      return { installed: true, version: r.stdout.trim().split('\n')[0] };
    }
  } catch { /* fall through */ }
  return { installed: false };
}

/**
 * Path to the bundled default test template. Operators who haven't authored
 * their own interaction_script use this; it visits each pages_to_capture URL
 * for each viewport, captures screenshot + console + network, asserts blank.
 */
export function defaultTestTemplatePath(): string {
  return path.resolve(__dirname, '..', '..', 'templates', 'ux-validate-default.spec.ts');
}

/**
 * Write evidence files into the task's evidence dir. `bundle` should mirror
 * the Codex review bundle convention so consensus prompts can read it.
 */
export function writeEvidence(
  evidenceDir: string,
  results: PlaywrightRunResult,
  verdict: UxGateVerdict
): { paths: string[] } {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const paths: string[] = [];
  const writeJson = (name: string, obj: unknown) => {
    const p = path.join(evidenceDir, name);
    fs.writeFileSync(p, JSON.stringify(obj, null, 2));
    paths.push(p);
  };
  writeJson('ux-results.json', results);
  writeJson('ux-verdict.json', verdict);
  // Human-readable summary for the codex bundle
  const md = [
    `# UX Validation — ${verdict.passed ? 'PASS' : 'FAIL'}`,
    '',
    `**Summary:** ${verdict.summary}`,
    `**Pages tested:** ${results.pages.length}`,
    `**Total failures:** ${verdict.total_failures}`,
    '',
    '## Per-gate breakdown',
    '',
    `| Gate | Passed | Failures |`,
    `|---|---|---|`,
    `| blank-page | ${verdict.gates.blank_page.passed ? '✓' : '✗'} | ${verdict.gates.blank_page.failures.length} |`,
    `| console | ${verdict.gates.console.passed ? '✓' : '✗'} | ${verdict.gates.console.failures.length} |`,
    `| network | ${verdict.gates.network.passed ? '✓' : '✗'} | ${verdict.gates.network.failures.length} |`,
    `| interaction | ${verdict.gates.interaction.passed ? '✓' : '✗'} | ${verdict.gates.interaction.failures.length} |`,
  ];
  if (!verdict.passed) {
    md.push('', '## Failure detail');
    if (verdict.gates.blank_page.failures.length > 0) {
      md.push('', '### Blank pages');
      for (const f of verdict.gates.blank_page.failures) md.push(`- ${f.url} (only ${f.chars} chars of body text; threshold ${MIN_BODY_CHARS})`);
    }
    if (verdict.gates.console.failures.length > 0) {
      md.push('', '### Console errors');
      for (const f of verdict.gates.console.failures.slice(0, 20)) md.push(`- ${f.url}: [${f.type}] ${f.text.slice(0, 200)}`);
      if (verdict.gates.console.failures.length > 20) md.push(`- … and ${verdict.gates.console.failures.length - 20} more`);
    }
    if (verdict.gates.network.failures.length > 0) {
      md.push('', '### Failed network requests');
      for (const f of verdict.gates.network.failures.slice(0, 20)) md.push(`- ${f.url} → ${f.req_url} (${f.status ?? 'no-status'}, ${f.failure ?? 'transport-failure'})`);
      if (verdict.gates.network.failures.length > 20) md.push(`- … and ${verdict.gates.network.failures.length - 20} more`);
    }
    if (verdict.gates.interaction.failures.length > 0) {
      md.push('', '### Interaction script failures');
      for (const f of verdict.gates.interaction.failures.slice(0, 20)) md.push(`- ${f.test}: ${f.error.slice(0, 200)}`);
    }
  }
  const summaryPath = path.join(evidenceDir, 'ux-summary.md');
  fs.writeFileSync(summaryPath, md.join('\n') + '\n');
  paths.push(summaryPath);
  log.info(`UX evidence written`, { evidence_dir: evidenceDir, paths_count: paths.length, passed: verdict.passed });
  return { paths };
}
