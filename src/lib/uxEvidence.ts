/**
 * v0.5.0 Pillar 5 — UI/UX evidence contract.
 *
 * Codex's biggest critique on the original Pillar 5 design (bud3git9n):
 *   "The biggest missing surface is an evidence model. Pillar 5 names skills
 *    and agents but does not define what artifacts prove UX quality. Without
 *    those, Pillar 5 becomes prompt theater with higher cost. Make Pillar 5
 *    evidence-first. Define the UI evidence contract, then attach skills and
 *    reviewers to produce and consume that evidence. The harness should gate
 *    on artifacts and severity, not on the existence of named agents."
 *
 * This file defines the canonical UxEvidence shape. Workers PRODUCE it
 * (Pillar 4 default Playwright template emits screenshots + ux-results.json;
 * Pillar 5 skills emit design_system_artifacts hashes + axe_results); reviewer
 * agents CONSUME it (a11y-auditor reads axe_results, classifies severity,
 * emits reviewer findings). The harness gates on the structured findings, not
 * on the names of the agents that produced them.
 *
 * Versioned. Forward-compatible additions allowed; removals require migration.
 */

import { z } from 'zod';

// ─── Severity model (per Codex: stack by orthogonal severity, not vote) ────

export const FindingSeverity = z.enum([
  'info',      // observation; never blocks
  'warning',   // worth showing; doesn't block by default
  'error',     // blocks promotion unless explicitly waived
  'critical',  // blocks promotion AND triggers escalation
]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const ReviewerFinding = z.object({
  /** Stable id within the reviewer's output (e.g. 'axe-color-contrast'). */
  id: z.string(),
  /** Per Codex: blocking severity stacks; codex remains final arbiter. */
  severity: FindingSeverity,
  /** Whether this finding alone should block promotion. Codex can override. */
  blocking: z.boolean().default(false),
  title: z.string(),
  description: z.string(),
  /** Optional refs into other evidence (e.g. ['screenshots[0]', 'axe_results[1].violations[2]']). */
  evidence_refs: z.array(z.string()).default([]),
  /** Optional file:line for code-grounded findings. */
  file_path: z.string().optional(),
  line: z.number().int().positive().optional(),
});
export type ReviewerFinding = z.infer<typeof ReviewerFinding>;

// ─── Visual evidence (screenshots from Playwright per viewport × page) ─────

export const Screenshot = z.object({
  page_url: z.string(),
  viewport: z.object({
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  browser: z.enum(['chromium', 'firefox', 'webkit']),
  /** Path RELATIVE to evidence_dir. Operators can rsync evidence dirs. */
  path: z.string(),
  /** SHA-256 for tamper detection + change detection across rounds. */
  sha256: z.string(),
  captured_at: z.string(),  // ISO 8601
});
export type Screenshot = z.infer<typeof Screenshot>;

// ─── Accessibility evidence (axe-core output) ──────────────────────────────

export const AxeViolation = z.object({
  id: z.string(),
  impact: z.enum(['minor', 'moderate', 'serious', 'critical']).optional(),
  description: z.string().optional(),
  help: z.string().optional(),
  helpUrl: z.string().optional(),
  /** Number of DOM nodes failing this rule on this page. */
  nodes_count: z.number().int().nonnegative(),
});
export type AxeViolation = z.infer<typeof AxeViolation>;

export const AxeRunResult = z.object({
  page_url: z.string(),
  viewport_name: z.string(),
  axe_version: z.string().optional(),
  violations: z.array(AxeViolation),
  passes_count: z.number().int().nonnegative(),
  inapplicable_count: z.number().int().nonnegative(),
  incomplete_count: z.number().int().nonnegative(),
  ran_at: z.string(),
});
export type AxeRunResult = z.infer<typeof AxeRunResult>;

// ─── Design-system artifact hashes (per Codex: capture for drift detection) ─

export const DesignSystemArtifact = z.object({
  /** Path relative to repo root (e.g. 'design-system/tokens.json'). */
  path: z.string(),
  /** SHA-256 of the file at task-start. Drift between this and current = warning. */
  sha256: z.string(),
  /** When the worker hashed it. */
  captured_at: z.string(),
  /** Size in bytes (sanity check; large files = mis-hashed). */
  size_bytes: z.number().int().nonnegative(),
});
export type DesignSystemArtifact = z.infer<typeof DesignSystemArtifact>;

// ─── Reviewer agent output (one entry per specialized_reviewer invoked) ─────

export const ReviewerOutput = z.object({
  /** Matches one of pack.consensus.specialized_reviewers. */
  reviewer_name: z.string(),
  /** Reviewer-internal version. Lets us track quality drift over time. */
  reviewer_version: z.string().optional(),
  invoked_at: z.string(),
  duration_ms: z.number().int().nonnegative(),
  findings: z.array(ReviewerFinding),
  /** One-line operator-readable summary. */
  summary: z.string(),
  /** Whether THIS reviewer would block (any blocking finding). Codex can override. */
  reviewer_blocks: z.boolean().default(false),
});
export type ReviewerOutput = z.infer<typeof ReviewerOutput>;

// ─── Visual regression diff (schema slot reserved; deferred to v2) ──────────

export const VisualDiff = z.object({
  page_url: z.string(),
  viewport_name: z.string(),
  baseline_path: z.string(),
  actual_path: z.string(),
  diff_path: z.string().optional(),
  diff_ratio: z.number().min(0).max(1),
  threshold: z.number().min(0).max(1),
  passed: z.boolean(),
});
export type VisualDiff = z.infer<typeof VisualDiff>;

// ─── Top-level evidence bundle ─────────────────────────────────────────────

export const UxEvidence = z.object({
  schema_version: z.literal('1').default('1'),
  task_id: z.string(),
  run_id: z.string(),
  /** When the harness sealed this evidence bundle for review. */
  sealed_at: z.string(),
  screenshots: z.array(Screenshot).default([]),
  axe_results: z.array(AxeRunResult).default([]),
  design_system_artifacts: z.array(DesignSystemArtifact).default([]),
  reviewers: z.array(ReviewerOutput).default([]),
  visual_diffs: z.array(VisualDiff).default([]),  // v2 will populate
});
export type UxEvidence = z.infer<typeof UxEvidence>;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute a top-line gate verdict from a UxEvidence bundle.
 *
 * Per Codex: stack by orthogonal severity. Any reviewer's blocking finding
 * blocks promotion. Codex consensus remains final arbiter.
 */
export interface UxEvidenceVerdict {
  passed: boolean;
  blocking_findings: number;
  total_findings: number;
  per_severity: Record<FindingSeverity, number>;
  /** Per-reviewer summary. */
  per_reviewer: Array<{ reviewer_name: string; passed: boolean; finding_count: number }>;
  summary: string;
}

export function evaluateUxEvidence(evidence: UxEvidence): UxEvidenceVerdict {
  const verdict: UxEvidenceVerdict = {
    passed: true,
    blocking_findings: 0,
    total_findings: 0,
    per_severity: { info: 0, warning: 0, error: 0, critical: 0 },
    per_reviewer: [],
    summary: '',
  };
  for (const reviewer of evidence.reviewers) {
    let reviewerBlocks = false;
    for (const f of reviewer.findings) {
      verdict.total_findings += 1;
      verdict.per_severity[f.severity] = (verdict.per_severity[f.severity] ?? 0) + 1;
      if (f.blocking || f.severity === 'critical') {
        verdict.blocking_findings += 1;
        reviewerBlocks = true;
      }
    }
    verdict.per_reviewer.push({
      reviewer_name: reviewer.reviewer_name,
      passed: !reviewerBlocks,
      finding_count: reviewer.findings.length,
    });
  }
  verdict.passed = verdict.blocking_findings === 0;
  if (verdict.passed) {
    verdict.summary = `UX evidence PASS: ${evidence.reviewers.length} reviewer(s), ${verdict.total_findings} non-blocking finding(s)`;
  } else {
    verdict.summary = `UX evidence FAIL: ${verdict.blocking_findings} blocking finding(s) across ${verdict.per_reviewer.filter((r) => !r.passed).length} reviewer(s)`;
  }
  return verdict;
}

// Imports placed at the top of the helper section to avoid `require` in ESM.
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

/**
 * SHA-256 hash a file. Used by skills + workers when capturing design-system
 * artifacts and screenshots.
 */
export function sha256OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}
