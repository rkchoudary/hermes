/**
 * v0.5.0 Sprint 4 — GapCandidate → TaskPack synthesizer.
 *
 * Codex final review (bvw1dczxm) prescribed THIS as "the one thing that
 * makes the harness world-class":
 *
 *   "Without it, the harness remains an excellent advisory system; with it,
 *    it becomes an operating system for delivery."
 *
 * Codex's hidden trap to avoid: PLANNING THEATER. "Beautiful task objects
 * with vague predicates, oversized scope, missing file ownership, or no
 * verifiable completion condition." The synthesizer must produce SMALL,
 * BORING, RUNNABLE work units.
 *
 * Mandates encoded in this synthesizer:
 *   1. Explicit non_goals (default + per-task-type) so worker doesn't drift
 *   2. Verifiable acceptance criteria with concrete predicates (commands)
 *   3. NEVER widens allowed_paths beyond candidate's proposed_allowed_paths
 *   4. Required evidence contract per task type
 *   5. Replay metadata (candidate_source) for `auto:replay` to render
 *      "this came from gap-analysis approved by <operator> at <ts>"
 *   6. Critical-path position recorded so scheduler can re-validate post-write
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import type { GapCandidate } from './gapAnalysis';
import type { TaskPack } from './taskPack';

/**
 * Operator-curated FRD spec excerpt sourced from
 * `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-MNN-<slug>/FRD-MNN.md`. The synthesizer reads
 * this when materializing a TaskPack so the worker prompt carries
 * REAL acceptance criteria + cited code paths instead of placeholders.
 */
interface FrdSpecExcerpt {
  frd_path: string;
  code_paths: string[];
  acceptance_criteria: string[];
}

function loadFrdSpec(moduleOrSprint: string): FrdSpecExcerpt | null {
  // Extract canonical module ID (M02 from "M02-impl-1a", "M03-v0.6", etc.)
  const m = String(moduleOrSprint).match(/M\d+/);
  if (!m) return null;
  const moduleId = m[0].toUpperCase();
  const frdsRoot = path.join(os.homedir(), process.env.HERMES_DOCS_ROOT || './docs/specs');
  if (!fs.existsSync(frdsRoot)) return null;
  // Find FRD dir for this module
  let frdDir: string | null = null;
  try {
    for (const dirent of fs.readdirSync(frdsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      if (dirent.name.match(new RegExp(`^FRD-${moduleId}\\b`, 'i'))) {
        frdDir = path.join(frdsRoot, dirent.name);
        break;
      }
    }
  } catch { return null; }
  if (!frdDir) return null;
  // Locate canonical FRD-MNN.md
  const frdFile = path.join(frdDir, `FRD-${moduleId}.md`);
  if (!fs.existsSync(frdFile)) return null;
  const content = fs.readFileSync(frdFile, 'utf8');
  // Parse code_home from frontmatter
  const codePaths: string[] = [];
  const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const codeHomeMatch = fmMatch[1].match(/^code_home:\s*"?([^"\n]+)"?/m);
    if (codeHomeMatch) {
      const tokens = codeHomeMatch[1].match(/(apps|domains|platform|packages|gateway|deploy|e2e)\/[a-zA-Z0-9_/-]+/g) ?? [];
      codePaths.push(...tokens);
    }
  }
  // Parse §17 Acceptance criteria — supports numbered + bulleted lists.
  const acceptance: string[] = [];
  const acSection = content.match(/##\s*17\..*?Acceptance criteria[^\n]*\n([\s\S]*?)(?:\n##\s|\nDocument completion|$)/i);
  if (acSection) {
    const body = acSection[1];
    // Match list items — include either bullets or numbered. Strip leading
    // markers and stop at next blank line within an item.
    const items = body.match(/(?:^|\n)\s*(?:[-*]\s+|\d+\.\s+)([^\n]+(?:\n(?!\s*(?:[-*]\s+|\d+\.\s+|##\s+|\n))[^\n]+)*)/g) ?? [];
    for (const raw of items) {
      const cleaned = raw
        .replace(/^\s*(?:[-*]\s+|\d+\.\s+)/, '')
        .replace(/\n\s+/g, ' ')
        .replace(/\*\*/g, '')
        .trim()
        .slice(0, 280);
      if (cleaned.length > 0) acceptance.push(cleaned);
    }
  }
  return {
    frd_path: frdFile,
    code_paths: codePaths,
    acceptance_criteria: acceptance,
  };
}

export interface SynthesisOptions {
  run_id: string;
  /** Sequential task number within the run for unique task_id. */
  task_seq: number;
  /** Operator identity recorded in the TaskPack's actors.creator. */
  approver_name: string;
  approved_at?: string;
  /** Set when synthesizing in batches; recorded for replay clarity. */
  approval_batch_id?: string;
  /**
   * Per Codex: TaskPacks must have explicit non-goals to prevent scope creep.
   * Defaults are sane for each task type; operator can override per-task.
   */
  extra_non_goals?: string[];
  /** Override evidence_dir; default is `evidence/<task_id>`. */
  evidence_dir_override?: string;
}

/** Default non_goals by task type. Codex's "small, boring, runnable" mandate. */
const DEFAULT_NON_GOALS: Record<string, string[]> = {
  'frd-polish': [
    'NOT a content rewrite — polish only existing FRD sections',
    'NOT touching ROADMAP.md or NEXT-SESSION.md',
    'NOT introducing new module dependencies',
    'NOT adding new acceptance criteria beyond the candidate scope',
  ],
  'frd-author': [
    'NOT modifying any existing FRD',
    'NOT touching ROADMAP.md or NEXT-SESSION.md',
    'NOT introducing cross-module changes',
  ],
  'frd-reconcile': [
    'NOT changing shipped code; this task only updates FRD to match impl',
    'NOT touching ROADMAP.md',
  ],
  'code-sprint': [
    'NOT modifying files outside allowed_paths',
    'NOT introducing new external dependencies without operator review',
    'NOT touching audit log / cleanup state / model inventory',
    'NOT broadening allowed_paths from the synthesizer-set values',
  ],
  'test-coverage': [
    'NOT modifying production code; tests-only',
    'NOT removing existing tests',
    'NOT lowering existing coverage thresholds',
  ],
  'audit-log-route': [
    'NOT touching the audit log file itself',
    'NOT modifying SoD enforcement code',
    'NOT changing override-audit JSONL schema',
  ],
  'platform-doc': [
    'NOT modifying source code; documentation-only',
    'NOT touching ROADMAP.md or NEXT-SESSION.md',
  ],
  'next-session-refresh': [
    'NOT modifying any code',
    'NOT modifying any FRD',
  ],
  'ui-component': [
    'NOT modifying parent app pages or routes',
    'NOT introducing new design tokens without ux-decisions.md rationale',
    'NOT bypassing wcag-compliant-responsive skill',
  ],
  'dashboard-page': [
    'NOT modifying design-system primitives (single-writer rule)',
    'NOT bypassing UX validation',
  ],
};

/** Default required-evidence per task type beyond the worker bundle. */
const REQUIRED_EVIDENCE_BY_TYPE: Record<string, string[]> = {
  'frd-polish': ['evidence/<TP>/frd-diff.md (before/after section diffs)'],
  'frd-author': ['evidence/<TP>/frd-skeleton-coverage.md (which template sections filled)'],
  'frd-reconcile': ['evidence/<TP>/reconcile-table.md (FR-id → code-path mapping)'],
  'code-sprint': ['evidence/<TP>/diff.patch (must `git apply` cleanly)', 'evidence/<TP>/test-summary.md'],
  'test-coverage': ['evidence/<TP>/coverage-before.json', 'evidence/<TP>/coverage-after.json'],
  'audit-log-route': ['evidence/<TP>/route-audit-coverage.md (every route → appendAuditLog call)'],
  'platform-doc': ['evidence/<TP>/doc-sections-touched.md'],
  'next-session-refresh': ['evidence/<TP>/handoff-diff.md'],
  'ui-component': ['evidence/<TP>/ux/screenshots/', 'evidence/<TP>/ux/axe-results.json'],
  'dashboard-page': ['evidence/<TP>/ux/screenshots/', 'evidence/<TP>/ux/axe-results.json'],
};

/**
 * Pure function: given a GapCandidate + options, return a fully-formed TaskPack
 * ready to be written to disk by the daemon.
 *
 * Caller is responsible for persistence (the daemon writes via runState helpers).
 */
export function candidateToTaskPack(candidate: GapCandidate, opts: SynthesisOptions): TaskPack {
  const taskId = formatTaskId(opts.run_id, opts.task_seq);
  const taskType = candidate.type as TaskPack['type'];
  const evidenceDir = opts.evidence_dir_override ?? `evidence/${taskId}`;

  // Non-goals: type defaults + extras
  const nonGoals = [
    ...(DEFAULT_NON_GOALS[taskType] ?? []),
    ...(opts.extra_non_goals ?? []),
  ];

  // FRD enrichment — read the actual operator-curated spec from
  // ${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-MNN-*/FRD-MNN.md so the TaskPack carries
  // real requirements (not placeholder rationale). Worker's prompt then
  // includes the actual acceptance criteria the FRD documents.
  const frdEnrichment = loadFrdSpec(candidate.module_or_sprint);

  // Acceptance criteria: prefer FRD §17 acceptance criteria when available,
  // fall back to rationale-derived + non-goal predicates.
  const acceptanceCriteria: string[] = [];
  if (frdEnrichment && frdEnrichment.acceptance_criteria.length > 0) {
    // Take first 5 FRD acceptance criteria to leave room for non-goals + predicates
    for (const ac of frdEnrichment.acceptance_criteria.slice(0, 5)) {
      acceptanceCriteria.push(`FRD-AC: ${ac}`);
    }
  } else {
    acceptanceCriteria.push(candidate.rationale);
  }
  for (const ng of nonGoals.slice(0, 2)) {
    acceptanceCriteria.push(`NON-GOAL respected: ${ng}`);
  }
  // Type-specific verifiable predicate
  if (taskType === 'code-sprint' || taskType === 'audit-log-route') {
    acceptanceCriteria.push('All tests in pack.commands.test pass (exit 0; non-zero count visible in test-summary.md)');
    acceptanceCriteria.push('Workspace typecheck passes for affected packages');
  } else if (taskType === 'frd-polish' || taskType === 'frd-author' || taskType === 'frd-reconcile') {
    acceptanceCriteria.push('FRD passes Codex consensus review at score ≥ 7.0');
    acceptanceCriteria.push('No edits outside allowed_paths');
  } else if (taskType === 'test-coverage') {
    acceptanceCriteria.push('Coverage delta is positive on modified module(s)');
    acceptanceCriteria.push('No production code modified');
  }

  // commands: derive concrete predicates per task type
  const commands: TaskPack['commands'] = {
    duplicate_scan: undefined,
    implement: [],
    test: [],
    typecheck: undefined,
    lint: undefined,
  };
  if (taskType === 'code-sprint' || taskType === 'audit-log-route' || taskType === 'test-coverage') {
    commands.test = ['pnpm -w test'];
    commands.typecheck = 'pnpm -w typecheck';
    commands.lint = 'pnpm -w lint --fix';
    commands.duplicate_scan = `grep -rn '${candidate.module_or_sprint}' apps/ packages/ platform/ --include='*.ts' --include='*.tsx' || true`;
  } else if (taskType === 'frd-polish' || taskType === 'frd-author' || taskType === 'frd-reconcile') {
    commands.test = [];  // FRDs aren't run; codex consensus is the test
  }

  // Cap acceptance_criteria at 10 (zod schema cap). Truncate keeping the
  // first (rationale) + the verifiable predicates, drop excess non-goal
  // restatements.
  while (acceptanceCriteria.length > 10) {
    // Drop NON-GOAL entries (they're echoed in pack.notes anyway)
    const idx = acceptanceCriteria.findIndex((ac) => ac.startsWith('NON-GOAL'));
    if (idx >= 0) acceptanceCriteria.splice(idx, 1);
    else acceptanceCriteria.pop();
  }

  const requiredEvidenceLines = REQUIRED_EVIDENCE_BY_TYPE[taskType] ?? [];

  // Build the TaskPack. zod will validate at write time.
  const pack: TaskPack = {
    schema_version: '1',
    task_id: taskId,
    run_id: opts.run_id,
    type: taskType,
    module_or_sprint: candidate.module_or_sprint,
    version_target: 'v1.0',  // Codex: "small, boring" — keep generic; operator can rev
    mode: 'brownfield',
    risk_class: 'medium',
    role: 'generic',
    objective: `${candidate.rationale.slice(0, 480)}${candidate.rationale.length > 480 ? '…' : ''}`,
    acceptance_criteria: acceptanceCriteria,
    allowed_paths: [...candidate.proposed_allowed_paths],
    forbidden_paths: ['NEXT-SESSION.md', 'ROADMAP.md', './ROADMAP.md'],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: {
      // Prefer FRD-frontmatter code_home over candidate proposed paths when
      // the operator has curated it (more accurate for worker context).
      code_paths: (frdEnrichment?.code_paths ?? candidate.proposed_allowed_paths).slice(0, 5),
      obsidian_paths: frdEnrichment?.frd_path ? [frdEnrichment.frd_path] : [],
      frd_path: frdEnrichment?.frd_path,
      prior_codex_output: undefined,
    },
    commands,
    consensus: {
      reviewer: 'codex-5.5-xhigh',
      prompt_template: 'templates/codex-completion-review.txt',
      gate_threshold: 7.0,
      max_rounds: 5,
      specialized_reviewers: [],
    },
    auto_land_policy: {
      enabled: false,
      allowed_task_types: ['platform-doc'],
      min_score: 8.0,
      min_consecutive_go: 2,
      protected_branches_excluded: ['main', 'master', 'release/*', 'production', 'prod'],
      real_merge_enabled: false,
    },
    auto_promote_policy: {
      enabled: false,
      allowed_task_types: ['frd-polish', 'platform-doc'],
      min_score: 7.5,
      min_consecutive_go: 2,
    },
    required_skills: candidate.type.startsWith('ui-') || candidate.type === 'dashboard-page'
      ? ['design-system-aware', 'wcag-compliant-responsive']
      : [],
    ux_validation: {
      enabled: false,
      pages_to_capture: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      browsers: ['chromium'],
      console_gate: { fail_on: ['error'], ignore_patterns: [] },
      network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] },
      visual_regression: { enabled: false, max_diff_ratio: 0.01 },
      vision_review: { enabled: false, advisory_only: true },
    },
    state: 'planned',
    state_history: [],
    evidence_dir: evidenceDir,
    depends_on: [...candidate.depends_on],
    base_sha: undefined,
    lock: null,
    cost_telemetry: [],
    actors: {
      creator: { name: opts.approver_name, source: 'manual', captured_at: opts.approved_at ?? new Date().toISOString() },
      reviewers: [],
      approvers: [],
    },
    notes: [
      {
        at: opts.approved_at ?? new Date().toISOString(),
        by: opts.approver_name,
        text: `synthesized from gap-candidate ${candidate.candidate_id}; approver=${opts.approver_name}${opts.approval_batch_id ? `; batch=${opts.approval_batch_id}` : ''}; required_evidence=${JSON.stringify(requiredEvidenceLines)}; non_goals=${JSON.stringify(nonGoals)}`,
      },
    ],
  };
  return pack;
}

function formatTaskId(runId: string, seq: number): string {
  // run_id is typically "2026-04-29-batch-1" — extract the date.
  const dateMatch = runId.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    return `TP-${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}-${String(seq).padStart(3, '0')}`;
  }
  // Fallback: today's date
  const d = new Date().toISOString().slice(0, 10);
  return `TP-${d}-${String(seq).padStart(3, '0')}`;
}

// ─── Approval-queue persistence ─────────────────────────────────────────────

export const ApprovedCandidate = z.object({
  schema_version: z.literal('1').default('1'),
  candidate_id: z.string(),
  approver: z.string(),
  approved_at: z.string(),
  /** The full GapCandidate body, captured at approval time so the daemon
   *  doesn't need to re-run gap analysis (which can produce different
   *  rankings as state evolves). */
  candidate: z.unknown(),
  /** Operator-set: optional override of synthesis options. */
  extra_non_goals: z.array(z.string()).default([]),
  evidence_dir_override: z.string().optional(),
  /** Set after the daemon materializes this approval into a real TaskPack. */
  materialized_as: z.object({
    task_id: z.string(),
    run_id: z.string(),
    materialized_at: z.string(),
  }).optional(),
});
export type ApprovedCandidate = z.infer<typeof ApprovedCandidate>;
