#!/usr/bin/env tsx
/**
 * Smoke + property test for v0.5.0 Pillar 4 — uxValidate gate evaluator.
 *
 * Codex GO-with-modifications scope is deterministic gates only. We test the
 * pure evaluator against curated PlaywrightRunResult fixtures + a randomized
 * property-test (50 packs × 50 result fixtures) to assert:
 *
 *   1. All-pass scenario passes.
 *   2. Blank page (chars < threshold) → blank-page gate fail.
 *   3. Console error → console gate fail (when policy.fail_on includes 'error').
 *   4. Console warning IGNORED when policy.fail_on excludes 'warning'.
 *   5. console_gate.ignore_patterns suppresses matching messages.
 *   6. Failed network request → network gate fail.
 *   7. network.ignore_patterns suppresses matching domains.
 *   8. Interaction-script failure → interaction gate fail.
 *   9. fail_on_failed_requests=false → network gate ALWAYS passes.
 *  10. Property test: 50 randomized fixtures; verdict.passed iff all 4 gates pass.
 */

import type { TaskPack } from '../taskPack';
import { evaluateUxResults, type PlaywrightRunResult } from '../uxValidate';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makePack(overrides: Partial<TaskPack['ux_validation']> = {}): TaskPack {
  return {
    schema_version: '1',
    task_id: 'TP-2026-04-29-001',
    run_id: '2026-04-29-test',
    type: 'code-sprint',
    mode: 'brownfield',
    risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'ux-test',
    version_target: 'v1.0',
    objective: 'test',
    acceptance_criteria: ['x'],
    allowed_paths: ['*'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7.0, max_rounds: 5 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: {
      enabled: true,
      pages_to_capture: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      browsers: ['chromium'],
      console_gate: { fail_on: ['error'], ignore_patterns: [] },
      network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] },
      visual_regression: { enabled: false, max_diff_ratio: 0.01 },
      vision_review: { enabled: false, advisory_only: true },
      ...overrides,
    },
    state: 'awaiting-review',
    state_history: [],
    evidence_dir: 'evidence/TP-2026-04-29-001',
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    actors: { reviewers: [], approvers: [] },
    notes: [],
  };
}

function makeRunResult(overrides: Partial<PlaywrightRunResult['pages'][0]> = {}): PlaywrightRunResult {
  return {
    pages: [{
      url: 'http://test/',
      viewport: { name: 'desktop', width: 1280, height: 800 },
      browser: 'chromium',
      body_text_chars: 500,
      console_messages: [],
      failed_requests: [],
      ...overrides,
    }],
  };
}

console.log('— uxValidate.smoke');

// 1. All-pass
{
  const r = evaluateUxResults(makeRunResult(), makePack());
  assert(r.passed, '1. all-pass scenario');
  assert(r.total_failures === 0, '   total_failures=0');
  assert(r.summary.startsWith('UX gates PASS'), '   summary cites PASS');
}

// 2. Blank page
{
  const r = evaluateUxResults(makeRunResult({ body_text_chars: 10 }), makePack());
  assert(!r.passed, '2. blank page (10 chars < 50 threshold) fails');
  assert(!r.gates.blank_page.passed, '   blank_page gate fails');
  assert(r.gates.blank_page.failures[0].chars === 10, '   failure cites char count');
}

// 3. Console error
{
  const r = evaluateUxResults(
    makeRunResult({ console_messages: [{ type: 'error', text: 'TypeError: foo' }] }),
    makePack()
  );
  assert(!r.passed, '3. console error fails');
  assert(!r.gates.console.passed, '   console gate fails');
  assert(r.gates.console.failures[0].text.includes('TypeError'), '   failure cites text');
}

// 4. Console warning ignored when fail_on excludes 'warning'
{
  const r = evaluateUxResults(
    makeRunResult({ console_messages: [{ type: 'warning', text: 'minor' }] }),
    makePack({ console_gate: { fail_on: ['error'], ignore_patterns: [] } })
  );
  assert(r.passed, '4. console warning ignored when fail_on=[error] only');
}

// 5. ignore_patterns suppresses console messages
{
  const r = evaluateUxResults(
    makeRunResult({ console_messages: [
      { type: 'error', text: 'analytics tracking failed' },
      { type: 'error', text: 'real bug' },
    ]}),
    makePack({ console_gate: { fail_on: ['error'], ignore_patterns: ['^analytics'] } })
  );
  assert(!r.passed, '5a. real bug fails');
  assert(r.gates.console.failures.length === 1, '5b. analytics filtered, only real bug remains');
}

// 6. Failed network request
{
  const r = evaluateUxResults(
    makeRunResult({ failed_requests: [{ url: 'https://api.example/x', status: 500, failure: null }] }),
    makePack()
  );
  assert(!r.passed, '6. failed network request fails');
  assert(!r.gates.network.passed, '   network gate fails');
}

// 7. network.ignore_patterns suppresses
{
  const r = evaluateUxResults(
    makeRunResult({ failed_requests: [
      { url: 'https://analytics.example/track', status: 404, failure: null },
      { url: 'https://api.example/critical', status: 500, failure: null },
    ]}),
    makePack({ network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: ['analytics\\.example'] } })
  );
  assert(!r.passed, '7a. critical 500 fails');
  assert(r.gates.network.failures.length === 1, '7b. analytics 404 filtered');
}

// 8. Interaction-script failure
{
  const result: PlaywrightRunResult = {
    ...makeRunResult(),
    interaction_results: {
      passed: 1,
      failed: 1,
      skipped: 0,
      failures: [{ test: 'login flow', error: 'Selector .submit not found' }],
    },
  };
  const r = evaluateUxResults(result, makePack());
  assert(!r.passed, '8. interaction failure fails');
  assert(!r.gates.interaction.passed, '   interaction gate fails');
}

// 9. fail_on_failed_requests=false makes network always pass
{
  const r = evaluateUxResults(
    makeRunResult({ failed_requests: [{ url: 'https://x/y', status: 500, failure: null }] }),
    makePack({ network: { fail_on_failed_requests: false, block_patterns: [], ignore_patterns: [] } })
  );
  assert(r.passed, '9. network gate disabled → 500 ignored');
}

// 10. Property test — 50 randomized fixtures
{
  console.log('\n10. Property test: 50 randomized fixtures');
  let pass = 0;
  let fail = 0;
  let invariantViolations = 0;
  const seed = 7;
  const rand = mulberry32(seed);
  for (let i = 0; i < 50; i++) {
    const isBlank = rand() < 0.3;
    const hasConsoleError = rand() < 0.3;
    const hasNetworkFail = rand() < 0.3;
    const hasInteractionFail = rand() < 0.2;
    const failOnWarn = rand() < 0.3;

    const result: PlaywrightRunResult = {
      pages: [{
        url: 'http://test/',
        viewport: { name: 'desktop', width: 1280, height: 800 },
        browser: 'chromium',
        body_text_chars: isBlank ? Math.floor(rand() * 49) : 100 + Math.floor(rand() * 1000),
        console_messages: hasConsoleError ? [{ type: 'error', text: 'random' }] : [],
        failed_requests: hasNetworkFail ? [{ url: 'http://x', status: 500, failure: null }] : [],
      }],
      interaction_results: hasInteractionFail
        ? { passed: 0, failed: 1, skipped: 0, failures: [{ test: 'x', error: 'y' }] }
        : undefined,
    };
    const pack = makePack({
      console_gate: { fail_on: failOnWarn ? ['error', 'warning'] : ['error'], ignore_patterns: [] },
    });
    const r = evaluateUxResults(result, pack);

    // Invariant: passed ↔ (not blank AND no error AND no network fail AND no interaction fail)
    const expected = !isBlank && !hasConsoleError && !hasNetworkFail && !hasInteractionFail;
    if (r.passed !== expected) invariantViolations++;
    if (r.passed) pass++; else fail++;
  }
  console.log(`  pass=${pass} fail=${fail} invariant-violations=${invariantViolations}`);
  assert(invariantViolations === 0, '   property holds for all 50 fixtures');
}

console.log('\n✓ all uxValidate.smoke assertions passed');

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
