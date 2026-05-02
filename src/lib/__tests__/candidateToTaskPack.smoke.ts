#!/usr/bin/env tsx
/**
 * Smoke + property test for v0.5.0 Sprint 4 — candidateToTaskPack synthesizer.
 *
 * Codex final review (bvw1dczxm) hidden trap: "Planning theater — beautiful
 * task objects with vague predicates, oversized scope, missing file ownership,
 * or no verifiable completion condition. The daemon must produce small,
 * boring, runnable work units."
 *
 * Codex acceptance criteria for this commit:
 *   1. Synthesized TaskPack passes zod TaskPack schema (round-trip valid)
 *   2. Allowed_paths NEVER widened beyond candidate.proposed_allowed_paths
 *   3. Non-goals injected per task type (default + extras)
 *   4. Acceptance criteria capped at 10 (zod limit)
 *   5. Notes contain replay metadata (candidate_id + approver + batch + non_goals)
 *   6. evidence_dir set
 *   7. UI/UX-typed candidates auto-load required_skills
 *   8. Property test: 50 randomized candidates, every synthesized pack
 *      passes TaskPack.parse() and respects all invariants
 */

import { TaskPack } from '../taskPack';
import { candidateToTaskPack } from '../candidateToTaskPack';
import type { GapCandidate } from '../gapAnalysis';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makeCandidate(overrides: Partial<GapCandidate> = {}): GapCandidate {
  return {
    candidate_id: 'gap-M01-frd-polish',
    module_or_sprint: 'M01',
    type: 'frd-polish',
    rationale: 'FRD status PARTIAL; needs polish to reach GO',
    contributes_to_criterion: 'c1',
    evidence: ['module: M01', 'frd_status: PARTIAL'],
    proposed_allowed_paths: ['docs/frd-m01-auth/**'],
    unblocks: [],
    depends_on: [],
    estimated_effort_hours: 1,
    ranking: {
      dependency_readiness: true,
      operator_priority: 1.0,
      criterion_impact: 1.0,
      estimated_cost_usd: 1.5,
      freshness_days: 5,
    },
    uncertainty: [],
    ...overrides,
  };
}

console.log('— candidateToTaskPack.smoke');

// 1. Round-trip valid via zod
{
  const pack = candidateToTaskPack(makeCandidate(), {
    run_id: '2026-04-29-batch-1',
    task_seq: 1,
    approver_name: 'alice',
  });
  const parsed = TaskPack.parse(pack);
  assert(parsed.task_id === 'TP-2026-04-29-001', '1a. task_id derived from run_id date + seq');
  assert(parsed.state === 'planned', '1b. starts in planned state');
}

// 2. Allowed_paths never widened
{
  const candidate = makeCandidate({ proposed_allowed_paths: ['docs/frd-m02/**', 'docs/frd-m02/sub/*.md'] });
  const pack = candidateToTaskPack(candidate, { run_id: '2026-04-29-batch-1', task_seq: 1, approver_name: 'a' });
  assert(pack.allowed_paths.length === 2, '2a. allowed_paths preserved exactly');
  assert(pack.allowed_paths.every((p) => candidate.proposed_allowed_paths.includes(p)), '2b. no synthetic widening');
}

// 3. Non-goals injected per task type
{
  const pack = candidateToTaskPack(makeCandidate({ type: 'frd-polish' }), {
    run_id: '2026-04-29-batch-1', task_seq: 1, approver_name: 'a',
  });
  // Notes include the non_goals JSON
  const noteText = pack.notes[0].text;
  assert(noteText.includes('non_goals'), '3a. notes include non_goals reference');
  assert(noteText.includes('NOT a content rewrite'), '3b. frd-polish default non-goal injected');
  // Acceptance criteria includes NON-GOAL restatements
  assert(pack.acceptance_criteria.some((ac) => (typeof ac === 'string' ? ac : ac.text).startsWith('NON-GOAL')), '3c. acceptance criteria includes non-goal restatement');
}

// 4. Acceptance criteria capped at 10
{
  const pack = candidateToTaskPack(makeCandidate({ type: 'code-sprint' }), {
    run_id: '2026-04-29-batch-1', task_seq: 1, approver_name: 'a',
    extra_non_goals: ['extra1', 'extra2', 'extra3', 'extra4', 'extra5', 'extra6', 'extra7', 'extra8', 'extra9', 'extra10', 'extra11', 'extra12'],
  });
  assert(pack.acceptance_criteria.length <= 10, `4. acceptance_criteria ≤ 10 (got ${pack.acceptance_criteria.length})`);
}

// 5. Replay metadata in notes
{
  const pack = candidateToTaskPack(makeCandidate({ candidate_id: 'gap-M99-x' }), {
    run_id: '2026-04-29-batch-1', task_seq: 5, approver_name: 'bob',
    approval_batch_id: 'batch-2026-04-29-foo',
    approved_at: '2026-04-29T14:00:00Z',
  });
  const noteText = pack.notes[0].text;
  assert(noteText.includes('gap-M99-x'), '5a. note cites candidate_id');
  assert(noteText.includes('approver=bob'), '5b. note cites approver');
  assert(noteText.includes('batch-2026-04-29-foo'), '5c. note cites batch');
  assert(pack.actors.creator?.name === 'bob', '5d. actors.creator.name set to approver');
}

// 6. evidence_dir set
{
  const pack = candidateToTaskPack(makeCandidate(), { run_id: '2026-04-29-batch-1', task_seq: 7, approver_name: 'a' });
  assert(pack.evidence_dir === 'evidence/TP-2026-04-29-007', '6. evidence_dir defaults to evidence/<task_id>');
}

// 7. UI-typed candidate auto-loads required_skills
{
  const pack = candidateToTaskPack(makeCandidate({ type: 'ui-component', module_or_sprint: 'PriceBadge' }), {
    run_id: '2026-04-29-batch-1', task_seq: 8, approver_name: 'a',
  });
  assert(pack.required_skills.includes('design-system-aware'), '7a. ui-component auto-loads design-system-aware');
  assert(pack.required_skills.includes('wcag-compliant-responsive'), '7b. ui-component auto-loads wcag-compliant-responsive');
}

// 8. code-sprint type produces concrete commands
{
  const pack = candidateToTaskPack(makeCandidate({ type: 'code-sprint' }), {
    run_id: '2026-04-29-batch-1', task_seq: 1, approver_name: 'a',
  });
  assert(pack.commands.test.length > 0, '8a. test command set');
  assert(pack.commands.typecheck !== undefined, '8b. typecheck command set');
  assert(pack.commands.lint !== undefined, '8c. lint command set');
  assert(pack.commands.duplicate_scan !== undefined, '8d. duplicate_scan command set');
}

// 9. Property test — 50 randomized candidates all round-trip
{
  console.log('\n9. Property test: 50 randomized candidates round-trip via TaskPack.parse');
  const seed = 23;
  const rand = mulberry32(seed);
  const types = ['frd-author', 'frd-polish', 'frd-reconcile', 'code-sprint', 'test-coverage', 'audit-log-route', 'platform-doc', 'next-session-refresh', 'ui-component', 'dashboard-page'] as const;
  let passed = 0;
  let widenViolations = 0;
  for (let i = 0; i < 50; i++) {
    const t = types[Math.floor(rand() * types.length)];
    const numPaths = 1 + Math.floor(rand() * 4);
    const paths = Array.from({ length: numPaths }, (_, k) => `src/M${String(i).padStart(2, '0')}/${k}.ts`);
    const candidate = makeCandidate({
      candidate_id: `gap-M${String(i).padStart(2, '0')}-${t}`,
      module_or_sprint: `M${String(i).padStart(2, '0')}`,
      type: t,
      proposed_allowed_paths: paths,
      depends_on: rand() < 0.3 ? [`gap-M${String(i - 1).padStart(2, '0')}-frd-polish`] : [],
      estimated_effort_hours: 0.5 + rand() * 6,
    });
    try {
      const pack = candidateToTaskPack(candidate, {
        run_id: '2026-04-29-batch-prop',
        task_seq: i + 1,
        approver_name: 'prop-test',
      });
      // Invariant: zod parses
      TaskPack.parse(pack);
      // Invariant: allowed_paths never widened
      if (pack.allowed_paths.some((p) => !candidate.proposed_allowed_paths.includes(p))) widenViolations++;
      // Invariant: state always planned
      if (pack.state !== 'planned') widenViolations++;
      // Invariant: depends_on preserved exactly
      if (pack.depends_on.length !== candidate.depends_on.length) widenViolations++;
      passed++;
    } catch (e) {
      console.error(`  fixture ${i} (${t}) failed: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  assert(passed === 50, `   50/50 candidates round-tripped (got ${passed})`);
  assert(widenViolations === 0, `   zero invariant violations across 50 fixtures`);
}

console.log('\n✓ all candidateToTaskPack.smoke assertions passed');

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
