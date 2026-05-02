#!/usr/bin/env tsx
/**
 * Smoke test for v0.5.0 T4 — auto-land eligibility evaluator (Codex bnl3rpgha).
 *
 * Codex prescription: "ship as eligibility report; real merge requires both
 * policy.real_merge_enabled=true AND env AUTO_AUTO_LAND_APPLY=1." Triple
 * opt-in (per-task policy + global env + CLI flag).
 *
 * Asserts:
 *   1. Default-disabled policy denies regardless of state
 *   2. Wrong state denies (auto-land requires state=ready-for-merge)
 *   3. Type not in allowlist denies (default = ['platform-doc'] only)
 *   4. Score below 8.0 denies
 *   5. Insufficient consecutive GO denies
 *   6. Protected branch denies (main/master/release/*)
 *   7. Open escalations deny
 *   8. SoD violation: same actor as creator + approver denies
 *   9. real_merge_authorized requires triple opt-in
 *  10. Eligibility report includes suggested merge + revert commands
 *  11. Property test: 50 randomized fixtures
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TaskPack } from '../taskPack';
import { evaluateAutoLand } from '../autoLand';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makePack(overrides: Partial<TaskPack> = {}): TaskPack {
  const base = {
    schema_version: '1',
    task_id: 'TP-2026-04-29-001',
    run_id: '2026-04-29-test',
    type: 'platform-doc',
    module_or_sprint: 'M99-test',
    version_target: 'v1.0',
    objective: 'test',
    acceptance_criteria: ['x'],
    allowed_paths: ['*'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7.0, max_rounds: 5, specialized_reviewers: [] },
    auto_land_policy: {
      enabled: true,
      allowed_task_types: ['platform-doc'],
      min_score: 8.0,
      min_consecutive_go: 2,
      protected_branches_excluded: ['main', 'master', 'release/*', 'production', 'prod'],
      real_merge_enabled: false,
    },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: {
      enabled: false,
      pages_to_capture: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      browsers: ['chromium'],
      console_gate: { fail_on: ['error' as const], ignore_patterns: [] },
      network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] },
      visual_regression: { enabled: false, max_diff_ratio: 0.01 },
      vision_review: { enabled: false, advisory_only: true },
    },
    state: 'ready-for-merge' as const,
    state_history: [],
    evidence_dir: 'evidence/TP-2026-04-29-001',
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    actors: {
      creator: { name: 'alice', source: 'git-config' as const, captured_at: '2026-04-29T10:00:00Z' },
      reviewers: [],
      approvers: [{ name: 'bob', source: 'git-config' as const, captured_at: '2026-04-29T11:00:00Z' }],
    },
    notes: [],
    codex: {
      score: 8.5,
      verdict: 'GO' as const,
      rounds_executed: 2,
      score_history: [
        { round: 1, score: 8.2, verdict: 'GO' as const, at: '2026-04-29T10:00:00Z' },
        { round: 2, score: 8.5, verdict: 'GO' as const, at: '2026-04-29T10:30:00Z' },
      ],
    },
    ...overrides,
  };
  return base as TaskPack;
}

console.log('— autoLand.smoke');

// 1. Default-disabled denies
{
  const pack = makePack({ auto_land_policy: { ...makePack().auto_land_policy, enabled: false } });
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(!r.eligible, '1. policy.enabled=false denies');
  assert(r.predicates.find((p) => p.name === 'policy-enabled')?.passed === false, '   policy-enabled predicate fails');
}

// 2. Wrong state denies
{
  const pack = makePack({ state: 'promotable' });
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(!r.eligible, '2. state=promotable denies (auto-land needs ready-for-merge)');
}

// 3. Type not in allowlist denies
{
  const pack = makePack({ type: 'code-sprint' as const });
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(!r.eligible, '3. code-sprint not in default allowlist denies');
}

// 4. Score below 8.0 denies
{
  const pack = makePack({
    codex: {
      score: 7.5, verdict: 'GO' as const, rounds_executed: 2,
      score_history: [
        { round: 1, score: 7.5, verdict: 'GO' as const, at: '2026-04-29T10:00:00Z' },
        { round: 2, score: 7.5, verdict: 'GO' as const, at: '2026-04-29T10:30:00Z' },
      ],
    },
  });
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(!r.eligible, '4. score=7.5 < 8.0 denies');
}

// 5. Insufficient consecutive GO denies
{
  const pack = makePack({
    codex: {
      score: 8.5, verdict: 'GO' as const, rounds_executed: 3,
      score_history: [
        { round: 1, score: 8.2, verdict: 'GO' as const, at: '2026-04-29T10:00:00Z' },
        { round: 2, score: 6.5, verdict: 'NO-GO' as const, at: '2026-04-29T10:30:00Z' },
        { round: 3, score: 8.5, verdict: 'GO' as const, at: '2026-04-29T11:00:00Z' },
      ],
    },
  });
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(!r.eligible, '5. NO-GO breaks streak → only 1 consecutive GO; denies');
}

// 6. Protected branch denies
{
  const pack = makePack();
  for (const branch of ['main', 'master', 'release/v1', 'production', 'prod']) {
    const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: branch });
    assert(!r.eligible, `6. branch ${branch} matches protected pattern; denies`);
  }
}

// 7. Open escalations deny — write a fake escalation log
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
  fs.mkdirSync(path.join(tmp, '.agent-runs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, '.agent-runs', '_escalation-log.jsonl'),
    JSON.stringify({ task_id: 'TP-2026-04-29-001', reason: 'budget breach' }) + '\n'
  );
  const pack = makePack();
  const r = evaluateAutoLand(pack, {
    globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x',
    runId: pack.run_id, harnessRootOverride: tmp,
  });
  assert(!r.eligible, '7. open escalation denies');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 8. SoD violation: same actor creator + approver denies
{
  const pack = makePack({
    actors: {
      creator: { name: 'alice', source: 'git-config' as const, captured_at: '2026-04-29T10:00:00Z' },
      reviewers: [],
      approvers: [{ name: 'alice', source: 'git-config' as const, captured_at: '2026-04-29T11:00:00Z' }],
    },
  });
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(!r.eligible, '8. SoD violation (alice = creator AND approver) denies');
}

// 9. real_merge_authorized requires triple opt-in
{
  const pack = makePack();
  const r1 = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(r1.eligible, '9a. eligible when all predicates pass');
  assert(r1.real_merge_authorized === false, '9b. real_merge_authorized=false when policy.real_merge_enabled=false');

  const pack2 = makePack({ auto_land_policy: { ...makePack().auto_land_policy, real_merge_enabled: true } });
  const r2 = evaluateAutoLand(pack2, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x' });
  assert(r2.real_merge_authorized === true, '9c. real_merge_authorized=true with all 3 opt-ins');

  const r3 = evaluateAutoLand(pack2, { globalOptIn: true, applyAuthorization: false, targetBranch: 'feature/x' });
  assert(r3.real_merge_authorized === false, '9d. apply=false denies real merge even with policy enabled');
}

// 10. Suggested merge + revert commands generated when eligible + PR known
{
  const pack = makePack();
  const r = evaluateAutoLand(pack, { globalOptIn: true, applyAuthorization: true, targetBranch: 'feature/x', prNumber: 42 });
  assert(r.suggested_merge_command?.includes('gh pr merge 42') === true, '10a. suggested merge command generated');
  assert(r.generated_revert_command?.includes('git revert') === true, '10b. revert command generated');
}

// 11. Property test
{
  console.log('\n11. Property test: 50 randomized fixtures');
  let pass = 0, fail = 0, violations = 0;
  const seed = 19;
  const rand = mulberry32(seed);
  for (let i = 0; i < 50; i++) {
    const enabled = rand() > 0.3;
    const goodType = rand() > 0.3;
    const goodState = rand() > 0.3;
    const score = 6 + rand() * 4;
    const minScore = 7 + rand() * 2;
    const consecutive = Math.floor(rand() * 4);
    const minConsec = 1 + Math.floor(rand() * 3);
    const goodBranch = rand() > 0.3;
    const distinctActors = rand() > 0.3;

    const pack = makePack({
      type: goodType ? 'platform-doc' as const : 'code-sprint' as const,
      state: goodState ? 'ready-for-merge' as const : 'promotable' as const,
      auto_land_policy: {
        enabled, allowed_task_types: ['platform-doc'], min_score: minScore, min_consecutive_go: minConsec,
        protected_branches_excluded: ['main', 'master', 'release/*', 'production', 'prod'],
        real_merge_enabled: false,
      },
      codex: {
        score, verdict: 'GO' as const, rounds_executed: consecutive,
        score_history: Array.from({ length: consecutive }, (_, k) => ({
          round: k + 1, score, verdict: 'GO' as const, at: '2026-04-29T10:00:00Z',
        })),
      },
      actors: {
        creator: { name: 'alice', source: 'git-config' as const, captured_at: '2026-04-29T10:00:00Z' },
        reviewers: [],
        approvers: [{ name: distinctActors ? 'bob' : 'alice', source: 'git-config' as const, captured_at: '2026-04-29T11:00:00Z' }],
      },
    });
    const r = evaluateAutoLand(pack, {
      globalOptIn: true, applyAuthorization: true,
      targetBranch: goodBranch ? 'feature/x' : 'main',
    });
    const expected = enabled && goodType && goodState && score >= minScore && consecutive >= minConsec && goodBranch && distinctActors;
    if (r.eligible !== expected) violations++;
    if (r.eligible) pass++; else fail++;
  }
  console.log(`  pass=${pass} fail=${fail} invariant-violations=${violations}`);
  assert(violations === 0, '   property holds for all 50 fixtures');
}

console.log('\n✓ all autoLand.smoke assertions passed');

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
