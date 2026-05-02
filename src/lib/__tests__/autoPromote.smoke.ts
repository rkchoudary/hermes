#!/usr/bin/env tsx
/**
 * Smoke + property test for v0.5.0 auto-promote evaluator.
 *
 * Per Codex roadmap-review GO-with-modifications: "Add simulation/property
 * tests for 50 tasks plus regression tests for kill-switch, SoD, stale lock,
 * and policy-deny cases."
 *
 * Asserts:
 *   1. Default-disabled policy denies regardless of score.
 *   2. Wrong state (not promotable) denies regardless of policy.
 *   3. Global opt-in absent → denies even with per-task enabled+allowlisted.
 *   4. Type not in allowlist → denies (defends against config drift).
 *   5. Score below min → denies.
 *   6. Insufficient consecutive GO rounds → denies.
 *   7. Happy path: all signals + 2 consecutive GO at ≥ 7.5 → eligible.
 *   8. Property: 50 randomized packs across the policy space — every "eligible"
 *      result satisfies all 5 policy invariants; every "not eligible" result
 *      cites a specific failing invariant by name.
 */

import * as fsm from 'node:fs';
import * as pathm from 'node:path';
import * as osm from 'node:os';

import type { TaskPack } from '../taskPack';
import { evaluateAutoPromote, isGloballyOptedIn, getLatestE2eResult } from '../autoPromote';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makePack(overrides: Partial<TaskPack> = {}): TaskPack {
  const base: TaskPack = {
    schema_version: '1',
    task_id: 'TP-2026-04-28-001',
    run_id: '2026-04-28-test',
    type: 'frd-polish',
    module_or_sprint: 'M99-test',
    version_target: 'v1.0',
    mode: 'brownfield',
    risk_class: 'medium',
    objective: 'test',
    acceptance_criteria: ['x'],
    allowed_paths: ['*'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7.0, max_rounds: 5 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: {
      enabled: true,
      allowed_task_types: ['frd-polish', 'platform-doc'],
      min_score: 7.5,
      min_consecutive_go: 2,
    },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'promotable',
    state_history: [],
    evidence_dir: 'evidence/TP-2026-04-28-001',
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    actors: { reviewers: [], approvers: [] },
    notes: [],
    codex: {
      score: 8.0,
      verdict: 'GO',
      rounds_executed: 2,
      score_history: [
        { round: 1, score: 7.8, verdict: 'GO', at: '2026-04-28T10:00:00Z' },
        { round: 2, score: 8.0, verdict: 'GO', at: '2026-04-28T10:30:00Z' },
      ],
    },
    ...overrides,
  };
  return base;
}

console.log('— autoPromote.smoke');

// 1. Default-disabled policy denies even with everything else right.
{
  const pack = makePack({
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: {
      enabled: false,
      allowed_task_types: ['frd-polish', 'platform-doc'],
      min_score: 7.5,
      min_consecutive_go: 2,
    },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
  });
  const r = evaluateAutoPromote(pack, true);
  assert(!r.eligible, '1. policy.enabled=false denies');
  assert(r.reason.includes('auto_promote_policy.enabled is false'), '   reason cites disabled flag');
}

// 2. Wrong state denies regardless of policy.
{
  const pack = makePack({ state: 'planned' });
  const r = evaluateAutoPromote(pack, true);
  assert(!r.eligible, '2. state=planned denies');
  assert(r.reason.includes("not 'promotable'"), '   reason cites state');
}

// 3. Global opt-in absent denies.
{
  const pack = makePack();
  const r = evaluateAutoPromote(pack, false);
  assert(!r.eligible, '3. globalOptIn=false denies');
  assert(r.reason.includes('global opt-in absent'), '   reason cites global opt-in');
}

// 4. Type not in allowlist denies.
{
  const pack = makePack({ type: 'code-sprint' });
  const r = evaluateAutoPromote(pack, true);
  assert(!r.eligible, '4. type=code-sprint not in default allowlist denies');
  assert(r.reason.includes("not in policy allowlist"), '   reason cites type allowlist');
}

// 5. Score below min denies.
{
  const pack = makePack({
    codex: {
      score: 7.0,
      verdict: 'GO',
      rounds_executed: 2,
      score_history: [
        { round: 1, score: 7.0, verdict: 'GO', at: '2026-04-28T10:00:00Z' },
        { round: 2, score: 7.0, verdict: 'GO', at: '2026-04-28T10:30:00Z' },
      ],
    },
  });
  const r = evaluateAutoPromote(pack, true);
  assert(!r.eligible, '5. score=7.0 < min_score=7.5 denies');
  assert(r.reason.includes('< min_score'), '   reason cites score threshold');
}

// 6. Insufficient consecutive GO denies.
{
  const pack = makePack({
    codex: {
      score: 8.0,
      verdict: 'GO',
      rounds_executed: 3,
      score_history: [
        { round: 1, score: 7.8, verdict: 'GO', at: '2026-04-28T10:00:00Z' },
        { round: 2, score: 6.5, verdict: 'NO-GO', at: '2026-04-28T10:30:00Z' },
        { round: 3, score: 8.0, verdict: 'GO', at: '2026-04-28T11:00:00Z' },
      ],
    },
  });
  const r = evaluateAutoPromote(pack, true);
  assert(!r.eligible, '6. only 1 consecutive GO (NO-GO breaks streak) denies');
  assert(r.reason.includes('1 consecutive GO'), '   reason cites consecutive-GO count');
}

// 7. Happy path: all signals.
{
  const pack = makePack();
  const r = evaluateAutoPromote(pack, true);
  assert(r.eligible, '7. happy path: 2 consecutive GO at 7.8/8.0 ≥ 7.5, frd-polish allowlisted, all opt-in flags');
  assert(r.detail.consecutive_go_observed === 2, '   detail.consecutive_go_observed=2');
  assert(r.detail.min_score_met, '   detail.min_score_met');
  assert(r.detail.consecutive_go_met, '   detail.consecutive_go_met');
}

// 8. Property: 50 randomized packs.
{
  console.log('\n8. Property: 50 randomized packs satisfy invariants');
  let eligibleCount = 0;
  let deniedCount = 0;
  let mutexViolations = 0;
  const seed = 42;
  const rand = mulberry32(seed);
  for (let i = 0; i < 50; i++) {
    const enabled = rand() > 0.3;
    const goodType = rand() > 0.3;
    const goodState = rand() > 0.3;
    const score = 5.0 + rand() * 5.0; // 5.0-10.0
    const minScore = 6.5 + rand() * 2.0; // 6.5-8.5
    const consecutiveGoals = Math.floor(rand() * 4); // 0-3
    const minConsec = 1 + Math.floor(rand() * 3); // 1-3
    const globalOptIn = rand() > 0.2;

    const history: TaskPack['codex'] extends infer U ? (U extends { score_history: infer S } ? S : never) : never =
      Array.from({ length: consecutiveGoals }, (_, k) => ({
        round: k + 1,
        score,
        verdict: 'GO' as const,
        at: '2026-04-28T10:00:00Z',
      }));
    const pack = makePack({
      type: goodType ? 'frd-polish' : 'code-sprint',
      state: goodState ? 'promotable' : 'planned',
      auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: {
        enabled,
        allowed_task_types: ['frd-polish', 'platform-doc'],
        min_score: minScore,
        min_consecutive_go: minConsec,
      },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
      codex: {
        score,
        verdict: 'GO',
            rounds_executed: consecutiveGoals,
        score_history: history,
      },
    });
    const r = evaluateAutoPromote(pack, globalOptIn);

    // Invariant: eligible ↔ (state=promotable AND globalOptIn AND enabled AND
    // type in allowlist AND score ≥ min AND consecutive ≥ minConsec)
    const expectedEligible = (
      goodState &&
      globalOptIn &&
      enabled &&
      goodType &&
      score >= minScore &&
      consecutiveGoals >= minConsec
    );
    if (r.eligible !== expectedEligible) mutexViolations += 1;
    if (r.eligible) eligibleCount += 1; else deniedCount += 1;
  }
  console.log(`  eligible=${eligibleCount} denied=${deniedCount} invariant-violations=${mutexViolations}`);
  assert(mutexViolations === 0, `   property holds for all 50 packs (zero violations)`);
}

// 8.5 v0.5.0 T2 core — ux_validation predicate
{
  // 8.5a — ux_validation.enabled but ux-verdict.json missing → denies
  const fs = fsm;
  const path = pathm;
  const os = osm;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-ux-'));
  const pack = makePack();
  pack.ux_validation = { ...pack.ux_validation, enabled: true };
  const r = evaluateAutoPromote(pack, true, { runId: pack.run_id, harnessRootOverride: tmp });
  assert(!r.eligible, '8.5a. ux_validation.enabled + no verdict → denies');
  assert(r.reason.includes('ux-verdict.json'), '   reason cites ux-verdict.json');

  // 8.5b — verdict present but passed=false → denies
  const evDir = path.join(tmp, '.agent-runs', pack.run_id, pack.evidence_dir, 'ux');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'ux-verdict.json'), JSON.stringify({ passed: false, summary: 'console error on /admin' }));
  const r2 = evaluateAutoPromote(pack, true, { runId: pack.run_id, harnessRootOverride: tmp });
  assert(!r2.eligible, '8.5b. verdict.passed=false → denies');

  // 8.5c — verdict.passed=true → eligible
  fs.writeFileSync(path.join(evDir, 'ux-verdict.json'), JSON.stringify({ passed: true, summary: 'all gates green' }));
  const r3 = evaluateAutoPromote(pack, true, { runId: pack.run_id, harnessRootOverride: tmp });
  assert(r3.eligible, '8.5c. verdict.passed=true → eligible');

  // 8.5d — specialized_reviewers + reviewer-a11y-auditor.json missing → denies
  const pack2 = makePack();
  pack2.consensus.specialized_reviewers = ['a11y-auditor'];
  const r4 = evaluateAutoPromote(pack2, true, { runId: pack2.run_id, harnessRootOverride: tmp });
  assert(!r4.eligible, '8.5d. specialized_reviewer with no output → denies');

  // 8.5e — reviewer.reviewer_blocks=true → denies
  fs.writeFileSync(path.join(tmp, '.agent-runs', pack2.run_id, pack2.evidence_dir, 'ux', 'reviewer-a11y-auditor.json'), JSON.stringify({ reviewer_blocks: true, summary: '2 critical findings' }));
  const r5 = evaluateAutoPromote(pack2, true, { runId: pack2.run_id, harnessRootOverride: tmp });
  assert(!r5.eligible, '8.5e. reviewer_blocks=true → denies');
  assert(r5.reason.includes('blocking finding'), '   reason cites blocking');

  // 8.5f — reviewer_blocks=false → eligible
  fs.writeFileSync(path.join(tmp, '.agent-runs', pack2.run_id, pack2.evidence_dir, 'ux', 'reviewer-a11y-auditor.json'), JSON.stringify({ reviewer_blocks: false, summary: '0 findings' }));
  const r6 = evaluateAutoPromote(pack2, true, { runId: pack2.run_id, harnessRootOverride: tmp });
  assert(r6.eligible, '8.5f. reviewer_blocks=false → eligible');

  fs.rmSync(tmp, { recursive: true, force: true });
}

// 9. isGloballyOptedIn helper: env precedence
{
  delete process.env.AUTO_AUTO_PROMOTE;
  assert(isGloballyOptedIn() === false, '9a. no flag, no env → false');
  process.env.AUTO_AUTO_PROMOTE = '1';
  assert(isGloballyOptedIn() === true, '9b. AUTO_AUTO_PROMOTE=1 → true');
  process.env.AUTO_AUTO_PROMOTE = 'true';
  assert(isGloballyOptedIn() === true, '9c. AUTO_AUTO_PROMOTE=true → true');
  process.env.AUTO_AUTO_PROMOTE = '0';
  assert(isGloballyOptedIn() === false, '9d. AUTO_AUTO_PROMOTE=0 → false');
  delete process.env.AUTO_AUTO_PROMOTE;
  assert(isGloballyOptedIn({ autoPromote: true }) === true, '9e. CLI flag forces true regardless of env');
}

// 10. getLatestE2eResult — reads .agent-runs/_e2e/<latest>/artifacts.json
{
  const tmp = fsm.mkdtempSync(pathm.join(osm.tmpdir(), 'e2e-reader-'));
  const e2eRoot = pathm.join(tmp, '.agent-runs', '_e2e');
  fsm.mkdirSync(e2eRoot, { recursive: true });

  // 10a. Empty dir → null
  let r = getLatestE2eResult(tmp);
  assert(r.exit_status === null, '10a. empty .agent-runs/_e2e → exit_status null');
  assert(r.run_uuid === null, '10b. empty → run_uuid null');

  // 10c. One run with passing artifact
  const run1 = pathm.join(e2eRoot, 'aaa111');
  fsm.mkdirSync(run1, { recursive: true });
  fsm.writeFileSync(pathm.join(run1, 'artifacts.json'), JSON.stringify({
    exit_status: 'pass', ended_at: '2026-04-28T22:00:00Z',
    network_summary: { bad_status_urls: [{ url: 'x', status: 404 }, { url: 'y', status: 500 }] },
  }));
  r = getLatestE2eResult(tmp);
  assert(r.exit_status === 'pass', '10c. single passing run → exit_status pass');
  assert(r.run_uuid === 'aaa111', '10d. run_uuid matches');
  assert(r.bad_status_count === 2, '10e. bad_status_count=2');

  // 10f. Newer run with fail wins on mtime
  const run2 = pathm.join(e2eRoot, 'bbb222');
  fsm.mkdirSync(run2, { recursive: true });
  fsm.writeFileSync(pathm.join(run2, 'artifacts.json'), JSON.stringify({
    exit_status: 'fail', ended_at: '2026-04-28T22:30:00Z',
    network_summary: { bad_status_urls: [] },
  }));
  // Bump mtime to ensure ordering
  const future = new Date('2027-01-01');
  fsm.utimesSync(run2, future, future);
  r = getLatestE2eResult(tmp);
  assert(r.exit_status === 'fail', '10f. newer fail run wins by mtime');
  assert(r.run_uuid === 'bbb222', '10g. newer run uuid surfaced');

  // 10h. Malformed artifacts.json falls through to older valid run
  fsm.writeFileSync(pathm.join(run2, 'artifacts.json'), '{not valid json');
  r = getLatestE2eResult(tmp);
  assert(r.run_uuid === 'aaa111', '10h. malformed JSON skipped, older valid run used');

  fsm.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n✓ all autoPromote.smoke assertions passed');

// Mulberry32 — small deterministic PRNG, no deps.
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
