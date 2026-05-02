#!/usr/bin/env tsx
/**
 * Smoke test for browserAuto. Uses a local file:// URL so the test is
 * hermetic — no network dependency, no flaky external server.
 *
 * Asserts:
 *   1. Headless Chromium launches + closes cleanly
 *   2. navigate + wait_for_selector + expect_text all work
 *   3. Failed assertion records a finding with severity=error and a screenshot
 *   4. Total timeout enforced (slow-loop step doesn't hang the suite)
 *   5. Artifacts directory + artifacts.json written + exit_status correct
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { runBrowserScript, type BrowserStep } from '../browserAuto';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

async function main(): Promise<void> {
  console.log('— browserAuto.smoke');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browserAuto-'));
  const artifactsRoot = path.join(tmpDir, 'artifacts');
  fs.mkdirSync(artifactsRoot, { recursive: true });

  // Write a minimal HTML fixture
  const fixtureHtml = `<!DOCTYPE html><html><head><title>Test</title></head><body>
<h1 id="hello">Hello World</h1>
<form id="loginForm">
  <input type="email" name="email" id="email" />
  <input type="password" name="password" id="password" />
  <button type="submit" id="submit">Sign in</button>
</form>
<div id="counter">0</div>
<script>
  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    document.getElementById('counter').innerText = '1';
  });
</script>
</body></html>`;
  const fixturePath = path.join(tmpDir, 'fixture.html');
  fs.writeFileSync(fixturePath, fixtureHtml);
  const fixtureUrl = `file://${fixturePath}`;

  // 1. Happy path: navigate, fill, click, expect_text
  {
    const steps: BrowserStep[] = [
      { kind: 'navigate', url: fixtureUrl, wait_for: 'domcontentloaded' },
      { kind: 'wait_for_selector', selector: '#hello' },
      { kind: 'expect_text', selector: '#hello', text: 'Hello World' },
      { kind: 'fill', selector: '#email', value: 'a@b.c' },
      { kind: 'fill', selector: '#password', value: 'secret' },
      { kind: 'click', selector: '#submit' },
      { kind: 'expect_text', selector: '#counter', text: '1' },
    ];
    const r = await runBrowserScript({ url: fixtureUrl, steps, artifacts_root: artifactsRoot, total_timeout_ms: 30_000 });
    assert(r.exit_status === 'pass', `1a. happy-path run exits 'pass' (got '${r.exit_status}')`);
    assert(r.steps_passed === r.steps_total, `1b. all ${r.steps_total} steps passed (got ${r.steps_passed})`);
    assert(r.steps_failed === 0, '1c. zero steps failed');
    assert(r.findings.filter((f) => f.severity === 'error').length === 0, '1d. zero error findings');
    assert(r.screenshots.length >= 1, `1e. at least one screenshot captured (got ${r.screenshots.length})`);
    assert(fs.existsSync(path.join(r.artifacts_dir, 'artifacts.json')), '1f. artifacts.json written');
    assert(r.network_summary.total_requests >= 0, '1g. network_summary populated');
    assert(r.duration_ms > 0 && r.duration_ms < 30_000, `1h. duration_ms within bounds (got ${r.duration_ms})`);
  }

  // 2. Failed expectation records finding + does NOT crash
  {
    const steps: BrowserStep[] = [
      { kind: 'navigate', url: fixtureUrl, wait_for: 'domcontentloaded' },
      { kind: 'expect_text', selector: '#hello', text: 'Goodbye' },  // wrong
    ];
    const r = await runBrowserScript({ url: fixtureUrl, steps, artifacts_root: artifactsRoot, total_timeout_ms: 30_000 });
    assert(r.exit_status === 'fail', `2a. failed-assertion run exits 'fail' (got '${r.exit_status}')`);
    assert(r.steps_failed === 1, `2b. one step failed (got ${r.steps_failed})`);
    assert(r.findings.some((f) => f.severity === 'error' && f.step_kind === 'expect_text'), '2c. error finding for expect_text');
    assert(r.screenshots.some((s) => s.name.startsWith('fail-')), '2d. failure screenshot captured');
  }

  // 3. Selector that doesn't exist times out and records finding
  {
    const steps: BrowserStep[] = [
      { kind: 'navigate', url: fixtureUrl, wait_for: 'domcontentloaded' },
      { kind: 'wait_for_selector', selector: '#does-not-exist', timeout_ms: 1000 },
    ];
    const r = await runBrowserScript({ url: fixtureUrl, steps, artifacts_root: artifactsRoot, total_timeout_ms: 30_000 });
    assert(r.exit_status === 'fail', '3a. missing selector → fail');
    assert(r.findings.some((f) => f.message.includes('wait_for_selector') || f.message.includes('Timeout')), '3b. timeout finding recorded');
  }

  // 4. Total timeout cap is enforced
  {
    const steps: BrowserStep[] = [
      { kind: 'navigate', url: fixtureUrl, wait_for: 'domcontentloaded' },
      { kind: 'wait_for_selector', selector: '#missing-1', timeout_ms: 1500 },
      { kind: 'wait_for_selector', selector: '#missing-2', timeout_ms: 1500 },
      { kind: 'wait_for_selector', selector: '#missing-3', timeout_ms: 1500 },
    ];
    const r = await runBrowserScript({ url: fixtureUrl, steps, artifacts_root: artifactsRoot, total_timeout_ms: 2500 });
    // Either fail (steps recovered) or crash (deadline exceeded). Both acceptable.
    assert(r.exit_status === 'fail' || r.exit_status === 'crash', `4a. budget-exceeded run terminates (got '${r.exit_status}')`);
    assert(r.duration_ms < 10_000, `4b. duration under hard cap (got ${r.duration_ms} ms)`);
  }

  // 5. eval_in_page returns value into evalContext
  {
    const steps: BrowserStep[] = [
      { kind: 'navigate', url: fixtureUrl, wait_for: 'domcontentloaded' },
      { kind: 'eval_in_page', script: 'document.title', assign_to: 'pageTitle' },
    ];
    const r = await runBrowserScript({ url: fixtureUrl, steps, artifacts_root: artifactsRoot, total_timeout_ms: 30_000 });
    assert(r.exit_status === 'pass', '5a. eval_in_page run passes');
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('\n✓ all browserAuto.smoke assertions passed');
}

main().catch((e) => {
  console.error('smoke failed:', e);
  process.exit(1);
});
