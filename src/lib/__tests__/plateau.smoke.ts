/**
 * Smoke tests for plateau detection in decisionRubric.
 *
 * Run via:
 *   pnpm auto:test:plateau
 */
import { detectPlateau, applyRubric } from '../decisionRubric';
import type { CodexRoundScore, TaskPack } from '../taskPack';

let passed = 0, failed = 0;
function assert(c: unknown, l: string): void {
  if (c) { passed++; console.log(`  ✓ ${l}`); }
  else { failed++; console.error(`  ✗ ${l}`); }
}
function assertEq<T>(a: T, b: T, l: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log(`  ✓ ${l}`); }
  else { failed++; console.error(`  ✗ ${l}\n      actual: ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`); }
}

function score(round: number, sc: number, verdict: 'GO' | 'NO-GO' = 'NO-GO'): CodexRoundScore {
  return { round, score: sc, verdict, at: new Date().toISOString() };
}

console.log('\n[plateau smoke] starting…\n');

// ─── 1. <3 rounds → not a plateau ────────────────────────────────────────────
{
  console.log('1. <3 rounds insufficient signal');
  const r1 = detectPlateau([], 7);
  assertEq(r1.isPlateau, false, 'empty history not plateau');
  const r2 = detectPlateau([score(1, 5)], 7);
  assertEq(r2.isPlateau, false, '1 round not plateau');
  const r3 = detectPlateau([score(1, 5), score(2, 6)], 7);
  assertEq(r3.isPlateau, false, '2 rounds not plateau');
}

// ─── 2. Score above threshold → never plateau ────────────────────────────────
{
  console.log('\n2. Latest above threshold');
  const r = detectPlateau([score(1, 6, 'NO-GO'), score(2, 6.5, 'NO-GO'), score(3, 7.5, 'GO')], 7);
  assertEq(r.isPlateau, false, 'latest GO ≥ threshold not plateau');
}

// ─── 3. The TP-101 plateau case ──────────────────────────────────────────────
{
  console.log('\n3. TP-101 R1=6.4 R2=6.6 R3=6.2 R4=6.6 plateau');
  const tp101 = [
    score(1, 6.4),
    score(2, 6.6),
    score(3, 6.2),
    score(4, 6.6),
  ];
  const r = detectPlateau(tp101, 7);
  assert(r.isPlateau, 'TP-101 trajectory detected as plateau');
  console.log(`      reason: ${r.reason}`);
}

// ─── 4. Monotonically improving — not a plateau ─────────────────────────────
{
  console.log('\n4. Monotonic improvement');
  const r = detectPlateau([score(1, 5.0), score(2, 5.5), score(3, 6.0), score(4, 6.5)], 7);
  assertEq(r.isPlateau, false, 'monotonic improvement not plateau');
}

// ─── 5. Improvement just past last-3 window ─────────────────────────────────
{
  console.log('\n5. Last-3 max > prior max → not plateau');
  const r = detectPlateau([
    score(1, 5.0),
    score(2, 5.0),
    score(3, 5.0),  // prior max = 5.0
    score(4, 6.0),
    score(5, 6.5),
    score(6, 6.3),  // last-3 max = 6.5 > 5.0
  ], 7);
  assertEq(r.isPlateau, false, 'still improving (last-3 max > prior max)');
}

// ─── 6. Three rounds latest-is-lowest → plateau ──────────────────────────────
{
  console.log('\n6. Exactly 3 rounds, latest is lowest');
  const r = detectPlateau([score(1, 6.5), score(2, 6.4), score(3, 6.0)], 7);
  assert(r.isPlateau, '3 rounds with latest the lowest is plateau');
}

// ─── 7. Three rounds latest-is-tied-lowest → plateau ────────────────────────
{
  console.log('\n7. 3 rounds, latest tied lowest');
  const r = detectPlateau([score(1, 6.5), score(2, 6.0), score(3, 6.0)], 7);
  assert(r.isPlateau, '3 rounds with latest tied-lowest is plateau');
}

// ─── 8. applyRubric returns escalate for plateau ─────────────────────────────
{
  console.log('\n8. applyRubric: plateau → escalate (precedence 95)');
  const pack: TaskPack = {
    schema_version: '1',
    task_id: 'TP-2026-04-28-001',
    run_id: 'test',
    type: 'code-sprint',
    mode: 'brownfield',
    risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'X',
    version_target: 'v1',
    objective: 'x',
    acceptance_criteria: ['x'],
    allowed_paths: ['x'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'needs-revision',
    state_history: [],
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    notes: [],
    evidence_dir: '/tmp/test-evidence',
    actors: { reviewers: [], approvers: [] },
    codex: {
      score: 6.6,
      verdict: 'NO-GO',
      rounds_executed: 4,
      score_history: [
        score(1, 6.4),
        score(2, 6.6),
        score(3, 6.2),
        score(4, 6.6),
      ],
    },
  };
  const decision = applyRubric(pack);
  // v0.4.17: plateau no longer escalates immediately — it routes through
  // staged pivots (apply-foldin-plan → try-different-reviewer → tighten-scope
  // → human-escalate). First detection without prior pivots → strategy=apply-foldin-plan.
  assertEq(decision.action.kind, 'plateau-pivot', 'plateau → plateau-pivot (not raw escalate)');
  assertEq(decision.precedence, 92, 'precedence 92 (1st pivot)');
  if (decision.action.kind === 'plateau-pivot') {
    assertEq(decision.action.strategy, 'apply-foldin-plan', '1st pivot strategy = apply-foldin-plan');
    assertEq(decision.action.pivot_round, 1, 'pivot_round=1');
    assert(decision.action.reason.includes('plateau'), 'reason mentions plateau');
    console.log(`      reason: ${decision.action.reason}`);
  }
}

// ─── 9. applyRubric: still-improving → dispatch-worker-revise ────────────────
{
  console.log('\n9. applyRubric: improving → dispatch-worker-revise');
  const pack: TaskPack = {
    schema_version: '1',
    task_id: 'TP-2026-04-28-002',
    run_id: 'test',
    type: 'code-sprint',
    mode: 'brownfield',
    risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'X',
    version_target: 'v1',
    objective: 'x',
    acceptance_criteria: ['x'],
    allowed_paths: ['x'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'needs-revision',
    state_history: [],
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    notes: [],
    evidence_dir: '/tmp/test-evidence',
    actors: { reviewers: [], approvers: [] },
    codex: {
      score: 6.5,
      verdict: 'NO-GO',
      rounds_executed: 3,
      score_history: [
        score(1, 5.0),
        score(2, 5.5),
        score(3, 6.5),
      ],
    },
  };
  const decision = applyRubric(pack);
  assertEq(decision.action.kind, 'dispatch-worker-revise', 'improving → dispatch-revise');
  assertEq(decision.precedence, 80, 'precedence 80 (normal dispatch-revise)');
}

// ─── 10. applyRubric: no history → falls through to normal dispatch ──────────
{
  console.log('\n10. applyRubric: no history → normal dispatch (rounds < max)');
  const pack: TaskPack = {
    schema_version: '1',
    task_id: 'TP-2026-04-28-003',
    run_id: 'test',
    type: 'code-sprint',
    mode: 'brownfield',
    risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'X',
    version_target: 'v1',
    objective: 'x',
    acceptance_criteria: ['x'],
    allowed_paths: ['x'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'needs-revision',
    state_history: [],
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    notes: [],
    evidence_dir: '/tmp/test-evidence',
    actors: { reviewers: [], approvers: [] },
    codex: {
      score: 6.5,
      verdict: 'NO-GO',
      rounds_executed: 1,
      score_history: [],  // backward-compat: old packs without history
    },
  };
  const decision = applyRubric(pack);
  assertEq(decision.action.kind, 'dispatch-worker-revise', 'no history → dispatch-revise');
}

// ─── 11. plateau pivot 2: try-different-reviewer ─────────────────────────────
{
  console.log('\n11. applyRubric: 2nd plateau pivot → try-different-reviewer');
  const pack: TaskPack = {
    schema_version: '1', task_id: 'TP-2026-04-28-004', run_id: 'test', type: 'code-sprint', mode: 'brownfield', risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'X', version_target: 'v1', objective: 'x', acceptance_criteria: ['x'],
    allowed_paths: ['x'], forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'needs-revision', state_history: [], depends_on: [], lock: null, cost_telemetry: [],
    notes: [
      // Existing pivot-round 1 note (apply-foldin-plan was tried)
      { at: '2026-04-28T15:00:00Z', by: 'plateau-pivot', text: 'pivot_round: 1 strategy=apply-foldin-plan' },
    ],
    evidence_dir: '/tmp/test-evidence',
    actors: { reviewers: [], approvers: [] },
    codex: {
      score: 6.6, verdict: 'NO-GO', rounds_executed: 5,
      score_history: [
        score(1, 6.4), score(2, 6.6), score(3, 6.2), score(4, 6.6), score(5, 6.5),
      ],
    },
  };
  const decision = applyRubric(pack);
  assertEq(decision.action.kind, 'plateau-pivot', '2nd plateau → plateau-pivot');
  if (decision.action.kind === 'plateau-pivot') {
    assertEq(decision.action.strategy, 'try-different-reviewer', 'strategy=try-different-reviewer');
    assertEq(decision.action.pivot_round, 2, 'pivot_round=2');
    assertEq(decision.precedence, 93, 'precedence 93');
    assert(typeof decision.action.details.suggested_alt === 'string', 'suggested_alt is set');
  }
}

// ─── 12. plateau pivot 3: tighten-scope ──────────────────────────────────────
{
  console.log('\n12. applyRubric: 3rd plateau pivot → tighten-scope');
  const pack: TaskPack = {
    schema_version: '1', task_id: 'TP-2026-04-28-005', run_id: 'test', type: 'code-sprint', mode: 'brownfield', risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'X', version_target: 'v1', objective: 'x', acceptance_criteria: ['x'],
    allowed_paths: ['x'], forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'needs-revision', state_history: [], depends_on: [], lock: null, cost_telemetry: [],
    notes: [
      { at: '2026-04-28T15:00:00Z', by: 'plateau-pivot', text: 'pivot_round: 1' },
      { at: '2026-04-28T15:30:00Z', by: 'plateau-pivot', text: 'pivot_round: 2' },
    ],
    evidence_dir: '/tmp/test-evidence',
    actors: { reviewers: [], approvers: [] },
    codex: {
      score: 6.5, verdict: 'NO-GO', rounds_executed: 6,
      score_history: [
        score(1, 6.4), score(2, 6.6), score(3, 6.2), score(4, 6.6), score(5, 6.5), score(6, 6.5),
      ],
    },
  };
  const decision = applyRubric(pack);
  assertEq(decision.action.kind, 'plateau-pivot', '3rd plateau → plateau-pivot');
  if (decision.action.kind === 'plateau-pivot') {
    assertEq(decision.action.strategy, 'tighten-scope', 'strategy=tighten-scope');
    assertEq(decision.action.pivot_round, 3, 'pivot_round=3');
    assertEq(decision.precedence, 94, 'precedence 94');
  }
}

// ─── 13. plateau pivot 4+: human-escalate ────────────────────────────────────
{
  console.log('\n13. applyRubric: 4th plateau pivot → human-escalate');
  const pack: TaskPack = {
    schema_version: '1', task_id: 'TP-2026-04-28-006', run_id: 'test', type: 'code-sprint', mode: 'brownfield', risk_class: 'medium',
    role: 'generic',
    module_or_sprint: 'X', version_target: 'v1', objective: 'x', acceptance_criteria: ['x'],
    allowed_paths: ['x'], forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['echo'], typecheck: 'echo' },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7, max_rounds: 10 , specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: { enabled: false, pages_to_capture: ['/'], viewports: [{name:'desktop',width:1280,height:800},{name:'mobile',width:390,height:844}], browsers: ['chromium'], console_gate: { fail_on:['error'], ignore_patterns:[] }, network: { fail_on_failed_requests: true, block_patterns:[], ignore_patterns:[] }, visual_regression: { enabled: false, max_diff_ratio: 0.01 }, vision_review: { enabled: false, advisory_only: true } },
    state: 'needs-revision', state_history: [], depends_on: [], lock: null, cost_telemetry: [],
    notes: [
      { at: '2026-04-28T15:00:00Z', by: 'plateau-pivot', text: 'pivot_round: 1' },
      { at: '2026-04-28T15:30:00Z', by: 'plateau-pivot', text: 'pivot_round: 2' },
      { at: '2026-04-28T16:00:00Z', by: 'plateau-pivot', text: 'pivot_round: 3' },
    ],
    evidence_dir: '/tmp/test-evidence',
    actors: { reviewers: [], approvers: [] },
    codex: {
      score: 6.5, verdict: 'NO-GO', rounds_executed: 7,
      score_history: [
        score(1, 6.4), score(2, 6.6), score(3, 6.2), score(4, 6.6),
        score(5, 6.5), score(6, 6.5), score(7, 6.5),
      ],
    },
  };
  const decision = applyRubric(pack);
  assertEq(decision.action.kind, 'plateau-pivot', '4th plateau → plateau-pivot');
  if (decision.action.kind === 'plateau-pivot') {
    assertEq(decision.action.strategy, 'human-escalate', 'strategy=human-escalate');
    assertEq(decision.action.pivot_round, 4, 'pivot_round=4');
    assertEq(decision.precedence, 95, 'precedence 95 (terminal escalate)');
  }
}

console.log(`\n[plateau smoke] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
