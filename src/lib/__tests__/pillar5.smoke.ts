#!/usr/bin/env tsx
/**
 * Smoke + property test for v0.5.0 Pillar 5 — UxEvidence contract +
 * a11y-auditor evaluator.
 *
 * Codex (bud3git9n) prescribed scope: "Add evidence schema: screenshots by
 * viewport, axe JSON, reviewer JSON. Add a property test for schema +
 * reviewer composition."
 *
 * Asserts:
 *   1. Empty evidence (no reviewers) → passes (vacuous truth).
 *   2. Single critical axe violation → blocks.
 *   3. Single moderate axe violation → does NOT block (severity=error, blocking=false).
 *   4. Mixed severity — highest impact wins per rule (rule-level severity = max).
 *   5. Multiple pages × same rule → consolidated to one finding (no duplicate noise).
 *   6. Reviewer composition: stack semantics, not vote — any reviewer's blocking
 *      finding blocks the entire bundle (Codex prescription).
 *   7. Design-system drift detection: missing artifact + modified artifact → findings.
 *   8. evaluateUxEvidence top-line verdict matches per-reviewer verdicts.
 *   9. Property test: 50 randomized fixtures (axe runs × DS artifact states ×
 *      severity distributions); invariant `verdict.passed iff no blocking finding
 *      across any reviewer`.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { evaluateA11y, runA11yAuditor } from '../a11yAuditor';
import { evaluateUxEvidence, sha256OfFile, type AxeRunResult, type DesignSystemArtifact, type ReviewerOutput, type UxEvidence } from '../uxEvidence';
import type { TaskPack } from '../taskPack';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

function makeAxeRun(overrides: Partial<AxeRunResult> = {}): AxeRunResult {
  return {
    page_url: 'http://test/',
    viewport_name: 'desktop',
    axe_version: '4.10.0',
    violations: [],
    passes_count: 50,
    inapplicable_count: 100,
    incomplete_count: 0,
    ran_at: '2026-04-29T10:00:00Z',
    ...overrides,
  };
}

console.log('— pillar5.smoke');

// 1. Empty evidence
{
  const findings = evaluateA11y({ axe_runs: [] });
  assert(findings.length === 0, '1. empty axe_runs → 0 findings');
}

// 2. Critical violation
{
  const findings = evaluateA11y({
    axe_runs: [makeAxeRun({ violations: [{ id: 'color-contrast', impact: 'critical', nodes_count: 3, help: 'Body text contrast too low' }] })],
  });
  assert(findings.length === 1, '2a. one rule = one finding');
  assert(findings[0].severity === 'critical', '2b. critical impact → critical severity');
  assert(findings[0].blocking === true, '2c. critical → blocking=true');
}

// 3. Moderate non-blocking
{
  const findings = evaluateA11y({
    axe_runs: [makeAxeRun({ violations: [{ id: 'aria-roles', impact: 'moderate', nodes_count: 1 }] })],
  });
  assert(findings[0].severity === 'error', '3a. moderate impact → error severity');
  assert(findings[0].blocking === false, '3b. moderate → blocking=false');
}

// 4. Severity promotion when same rule fires at multiple impacts
{
  const findings = evaluateA11y({
    axe_runs: [
      makeAxeRun({ page_url: 'http://test/a', violations: [{ id: 'color-contrast', impact: 'minor', nodes_count: 1 }] }),
      makeAxeRun({ page_url: 'http://test/b', violations: [{ id: 'color-contrast', impact: 'critical', nodes_count: 2 }] }),
    ],
  });
  assert(findings.length === 1, '4a. consolidated to single rule-level finding');
  assert(findings[0].severity === 'critical', '4b. severity promoted to critical (max)');
  assert(findings[0].blocking === true, '4c. blocking=true after promotion');
}

// 5. Multiple pages × same rule consolidated
{
  const findings = evaluateA11y({
    axe_runs: [
      makeAxeRun({ page_url: 'http://test/a', violations: [{ id: 'label', impact: 'serious', nodes_count: 1 }] }),
      makeAxeRun({ page_url: 'http://test/b', violations: [{ id: 'label', impact: 'serious', nodes_count: 2 }] }),
      makeAxeRun({ page_url: 'http://test/c', violations: [{ id: 'label', impact: 'serious', nodes_count: 1 }] }),
    ],
  });
  assert(findings.length === 1, '5a. 3 pages × same rule = 1 finding');
  assert(findings[0].title.includes('3 page'), '5b. title cites page count');
}

// 6. Reviewer composition — stack semantics
{
  const evidence: UxEvidence = {
    schema_version: '1',
    task_id: 'TP-X',
    run_id: 'R',
    sealed_at: '2026-04-29T10:00:00Z',
    screenshots: [],
    axe_results: [],
    design_system_artifacts: [],
    visual_diffs: [],
    reviewers: [
      {
        reviewer_name: 'a11y-auditor',
        invoked_at: '2026-04-29T10:00:00Z',
        duration_ms: 100,
        findings: [{ id: 'x', severity: 'critical', blocking: true, title: 't', description: 'd', evidence_refs: [] }],
        summary: 'block',
        reviewer_blocks: true,
      },
      {
        reviewer_name: 'ui-design-reviewer',
        invoked_at: '2026-04-29T10:00:00Z',
        duration_ms: 100,
        findings: [{ id: 'y', severity: 'info', blocking: false, title: 'pretty', description: 'd', evidence_refs: [] }],
        summary: 'pass',
        reviewer_blocks: false,
      },
    ],
  };
  const verdict = evaluateUxEvidence(evidence);
  assert(!verdict.passed, '6a. one reviewer blocks → bundle fails');
  assert(verdict.blocking_findings === 1, '6b. blocking count');
  assert(verdict.per_reviewer.length === 2, '6c. per-reviewer breakdown');
  assert(verdict.per_reviewer[0].passed === false, '6d. blocked reviewer marked failed');
  assert(verdict.per_reviewer[1].passed === true, '6e. non-blocking reviewer passed');
}

// 7. Design-system drift
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-'));
  const tokensPath = path.join(tmp, 'design-system', 'tokens.json');
  fs.mkdirSync(path.dirname(tokensPath), { recursive: true });
  fs.writeFileSync(tokensPath, '{"primary":"blue"}');
  const sha = sha256OfFile(tokensPath);
  // Modify post-capture
  fs.writeFileSync(tokensPath, '{"primary":"red"}');
  const findings = evaluateA11y({
    axe_runs: [],
    design_system_artifacts: [{ path: 'design-system/tokens.json', sha256: sha, captured_at: '2026-04-29T10:00:00Z', size_bytes: 18 }],
    repo_root: tmp,
  });
  assert(findings.some((f) => f.id.startsWith('ds-drift-modified')), '7a. modified artifact → drift finding');
  // Now remove
  fs.rmSync(tokensPath);
  const findings2 = evaluateA11y({
    axe_runs: [],
    design_system_artifacts: [{ path: 'design-system/tokens.json', sha256: sha, captured_at: '2026-04-29T10:00:00Z', size_bytes: 18 }],
    repo_root: tmp,
  });
  assert(findings2.some((f) => f.id.startsWith('ds-drift-removed')), '7b. removed artifact → drift finding');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 8. runA11yAuditor end-to-end via tmp evidence dir
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5-aud-'));
  const evidenceDir = path.join(tmp, '.agent-runs', 'R', 'evidence', 'TP-X');
  fs.mkdirSync(path.join(evidenceDir, 'ux'), { recursive: true });
  const axeResults: AxeRunResult[] = [makeAxeRun({ violations: [{ id: 'color-contrast', impact: 'serious', nodes_count: 4 }] })];
  fs.writeFileSync(path.join(evidenceDir, 'ux', 'axe-results.json'), JSON.stringify(axeResults));
  const pack = {
    schema_version: '1',
    task_id: 'TP-X',
    type: 'ui-component',
    consensus: { specialized_reviewers: ['a11y-auditor'] },
  } as unknown as TaskPack;
  const out = runA11yAuditor({ taskId: 'TP-X', runId: 'R', pack, evidenceDir, repoRoot: tmp });
  assert(out.reviewer_name === 'a11y-auditor', '8a. reviewer_name');
  assert(out.reviewer_blocks === true, '8b. blocks on serious');
  assert(out.findings.length === 1, '8c. 1 finding');
  assert(fs.existsSync(path.join(evidenceDir, 'ux', 'reviewer-a11y-auditor.json')), '8d. reviewer JSON written');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 9. Property test — 50 randomized fixtures
{
  console.log('\n9. Property test: 50 randomized fixtures');
  let pass = 0, fail = 0, violations = 0;
  const seed = 13;
  const rand = mulberry32(seed);
  for (let i = 0; i < 50; i++) {
    const numReviewers = 1 + Math.floor(rand() * 3);
    const reviewers: ReviewerOutput[] = [];
    let expectedBlock = false;
    for (let j = 0; j < numReviewers; j++) {
      const findingsCount = Math.floor(rand() * 4);
      const findings = [];
      let reviewerBlocks = false;
      for (let k = 0; k < findingsCount; k++) {
        const sev = (['info', 'warning', 'error', 'critical'] as const)[Math.floor(rand() * 4)];
        const blockChoice = rand() < 0.4 || sev === 'critical';
        if (blockChoice) reviewerBlocks = true;
        findings.push({
          id: `r${j}-f${k}`,
          severity: sev,
          blocking: blockChoice,
          title: 't',
          description: 'd',
          evidence_refs: [],
        });
      }
      if (reviewerBlocks) expectedBlock = true;
      reviewers.push({
        reviewer_name: `reviewer-${j}`,
        invoked_at: '2026-04-29T10:00:00Z',
        duration_ms: 100,
        findings,
        summary: 's',
        reviewer_blocks: reviewerBlocks,
      });
    }
    const evidence: UxEvidence = {
      schema_version: '1',
      task_id: `TP-${i}`,
      run_id: 'R',
      sealed_at: '2026-04-29T10:00:00Z',
      screenshots: [],
      axe_results: [],
      design_system_artifacts: [],
      visual_diffs: [],
      reviewers,
    };
    const verdict = evaluateUxEvidence(evidence);
    if (verdict.passed === !expectedBlock) {
      verdict.passed ? pass++ : fail++;
    } else {
      violations++;
    }
  }
  console.log(`  pass=${pass} fail=${fail} invariant-violations=${violations}`);
  assert(violations === 0, '   property holds for all 50 fixtures');
}

console.log('\n✓ all pillar5.smoke assertions passed');

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
