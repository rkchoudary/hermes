/**
 * Sprint J — self-healing harness diagnostics library.
 *
 * Pattern (per operator directive 2026-05-01):
 *   1. Phase failure detected → assemble failure context
 *   2. Council reviews failure + emits structured fix suggestions
 *      (council = pattern recognition, what it's good at)
 *   3. Opus 4.7 worker reads suggestions + applies fixes
 *      (worker = code edits, what it's good at)
 *   4. Tests / post-flight gate the move-on
 *   5. Hard cap: 2 diagnose-fix cycles per phase, then park
 *      (no-hang invariant preserved)
 *
 * This module:
 *   - classifies failure types (transport / worker-logic / postflight / test)
 *   - assembles the diagnostic context that the council reviews
 *   - defines the BugReview output schema the worker consumes
 *
 * Persisted at: pack.evidence_dir/_bug-review.json
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { TaskPack } from './taskPack';

// ─── Failure classification ─────────────────────────────────────────────────

export type FailureClass =
  | 'transport-error'        // API timeout, rate limit, network — retry without diagnose
  | 'worker-incomplete'      // Worker exited but didn't produce expected evidence
  | 'worker-blocked'         // Worker emitted STATUS:blocked (logical impasse)
  | 'postflight-rejected'    // Deterministic gate caught structural defect
  | 'test-failure'           // Tests/typecheck/lint failed
  | 'council-hard-gate'      // Council triage classified as factual/fabrication/eval-failure
  | 'unknown';

export interface FailureContext {
  failure_class: FailureClass;
  /** Concise human-readable summary (one sentence). */
  summary: string;
  /** Operator-facing detail (multi-line ok; capped at 2KB). */
  detail: string;
  /** Specific paths to evidence the council should read. */
  evidence_pointers: string[];
  /** Prior bug-review attempts on this task (to avoid infinite loops). */
  prior_attempts: number;
}

/**
 * Classify a worker-completion result as a failure type. Pure: looks at
 * exit code + stdout + evidence-dir state, doesn't make LLM calls.
 */
export function classifyFailure(opts: {
  workerStdout?: string;
  workerExitCode?: number | null;
  evidenceDir?: string;
  postflightFailed?: boolean;
  testFailed?: boolean;
  councilTriage?: 'fabrication' | 'factual' | 'traceability' | 'low-fidelity' | 'eval-failure' | 'none';
}): FailureClass {
  // Council hard gates take precedence
  if (opts.councilTriage === 'fabrication' || opts.councilTriage === 'factual' || opts.councilTriage === 'eval-failure') {
    return 'council-hard-gate';
  }
  // Transport errors (Anthropic API hiccups)
  const stdout = opts.workerStdout ?? '';
  if (
    /API Error: Stream idle timeout/i.test(stdout) ||
    /rate.?limit/i.test(stdout) ||
    /ECONNRESET|ETIMEDOUT|ENETUNREACH/i.test(stdout) ||
    /upstream connect error/i.test(stdout)
  ) {
    return 'transport-error';
  }
  // Test failures
  if (opts.testFailed) return 'test-failure';
  // Post-flight rejection (handled separately, but classify here for completeness)
  if (opts.postflightFailed) return 'postflight-rejected';
  // Worker-emitted blocked status
  if (/STATUS:blocked/.test(stdout) || /STATUS:abandoned/.test(stdout)) {
    return 'worker-blocked';
  }
  // Worker exited but evidence missing
  if (opts.workerExitCode === 0 && opts.evidenceDir && fs.existsSync(opts.evidenceDir)) {
    const required = ['diff.patch', 'worker-handoff.json'];
    const missing = required.filter((f) => !fs.existsSync(path.join(opts.evidenceDir!, f)));
    if (missing.length > 0) return 'worker-incomplete';
  }
  // Non-zero exit without recognizable transport pattern
  if (opts.workerExitCode !== 0 && opts.workerExitCode !== null) {
    return 'worker-incomplete';
  }
  return 'unknown';
}

/**
 * Assemble the failure context the council will review. Reads from the
 * evidence dir + task pack notes. Caps total size to keep the council
 * prompt bounded.
 */
export function assembleFailureContext(
  pack: TaskPack,
  opts: {
    workerStdout?: string;
    workerExitCode?: number | null;
    workerStderr?: string;
    failure_class?: FailureClass;
  } = {},
): FailureContext {
  const failure_class = opts.failure_class ?? classifyFailure({
    workerStdout: opts.workerStdout,
    workerExitCode: opts.workerExitCode,
    evidenceDir: pack.evidence_dir,
  });

  const lines: string[] = [];
  const evidencePointers: string[] = [];

  lines.push(`Task: ${pack.task_id} (${pack.module_or_sprint})`);
  lines.push(`Type: ${pack.type}`);
  lines.push(`State: ${pack.state}`);
  lines.push(`Failure class: ${failure_class}`);
  lines.push('');

  if (opts.workerExitCode !== undefined && opts.workerExitCode !== null) {
    lines.push(`Worker exit code: ${opts.workerExitCode}`);
  }
  if (opts.workerStdout) {
    const stdoutTail = opts.workerStdout.split('\n').slice(-30).join('\n');
    lines.push('');
    lines.push('Worker stdout (last 30 lines):');
    lines.push('```');
    lines.push(stdoutTail.slice(0, 4000));
    lines.push('```');
  }
  if (opts.workerStderr) {
    lines.push('');
    lines.push('Worker stderr:');
    lines.push('```');
    lines.push(opts.workerStderr.slice(0, 1000));
    lines.push('```');
  }

  // Evidence dir contents
  if (fs.existsSync(pack.evidence_dir)) {
    const files = fs.readdirSync(pack.evidence_dir);
    lines.push('');
    lines.push(`Evidence dir contents (${files.length} files):`);
    for (const f of files.slice(0, 20)) {
      const p = path.join(pack.evidence_dir, f);
      const stat = fs.statSync(p);
      lines.push(`  ${f} (${stat.size} bytes)`);
      evidencePointers.push(p);
    }
  } else {
    lines.push('');
    lines.push('Evidence dir DOES NOT EXIST — worker never wrote to it.');
  }

  // Post-flight summary if present
  if (pack.artifact_acceptance) {
    lines.push('');
    lines.push(`Post-flight: accepted=${pack.artifact_acceptance.accepted_by_postflight}, patches=${pack.artifact_acceptance.postflight_summary.patches_applied}`);
    if (!pack.artifact_acceptance.accepted_by_postflight) {
      lines.push('Post-flight failures:');
      for (const f of pack.artifact_acceptance.postflight_summary.failures.slice(0, 10)) {
        lines.push(`  - ${f.check}: ${f.detail}`);
      }
    }
  }

  // Council feedback if present
  if (pack.council_feedback) {
    lines.push('');
    lines.push(`Council (advisory): score=${pack.council_feedback.score}, decision=${pack.council_feedback.decision}, hard_gates=${pack.council_feedback.hard_gates.join(',') || 'none'}`);
  }

  // Prior bug-review attempts (read from notes)
  const priorAttempts = pack.notes.filter((n) => n.text.includes('bug-review-applied')).length;

  // Build the summary
  const summary = (() => {
    switch (failure_class) {
      case 'transport-error': return 'Anthropic API stream error — provider issue, retry expected to recover';
      case 'worker-incomplete': return `Worker exited with code ${opts.workerExitCode}; required evidence files missing`;
      case 'worker-blocked': return 'Worker emitted STATUS:blocked — logical impasse needs review';
      case 'postflight-rejected': return 'Deterministic post-flight gate caught structural defects';
      case 'test-failure': return 'Tests / typecheck / lint failed';
      case 'council-hard-gate': return `Council triage flagged a hard-gate finding (${pack.council_feedback?.hard_gates.join(',')})`;
      case 'unknown': return 'Failure type could not be auto-classified';
    }
  })();

  return {
    failure_class,
    summary,
    detail: lines.join('\n').slice(0, 2048),
    evidence_pointers: evidencePointers,
    prior_attempts: priorAttempts,
  };
}

// ─── Bug review schema (what the council emits) ─────────────────────────────

export const BugFix = z.object({
  /** Stable id (FIX-1, FIX-2, etc) for cross-reference. */
  id: z.string(),
  /** Specific concrete fix the worker should apply. */
  action: z.string().min(10),
  /** Where the fix applies: file path + line range or section. */
  pointer: z.string(),
  /** Severity (informs ordering — critical fixes first). */
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  /** Plain-English why this fix is needed. */
  rationale: z.string().min(10),
});
export type BugFix = z.infer<typeof BugFix>;

export const BugReview = z.object({
  schema_version: z.literal('1').default('1'),
  task_id: z.string(),
  reviewed_at: z.string(),
  reviewer: z.string().default('codex-5.5-xhigh'),
  /** Council's classification of why the failure happened. */
  failure_classification: z.enum([
    'transport-error',
    'worker-incomplete',
    'worker-blocked',
    'postflight-rejected',
    'test-failure',
    'council-hard-gate',
    'unknown',
  ]),
  /** Plain-English diagnosis. */
  diagnosis: z.string().min(20),
  /** Ordered list of fixes (highest severity first). Empty when retry-only. */
  fixes: z.array(BugFix).default([]),
  /** Should the next worker dispatch retry the SAME task (no fixes) or
   *  apply the fixes? Transport errors → retry; logic errors → apply fixes. */
  next_action: z.enum(['retry-same', 'apply-fixes', 'park-needs-operator']),
  /** Estimated probability the next attempt will succeed (0-1). Used by
   *  the driver to decide whether to spend the LLM budget on retry vs park. */
  confidence: z.number().min(0).max(1),
  /** Operator-facing summary for the validation memo. */
  summary_for_memo: z.string().min(20),
});
export type BugReview = z.infer<typeof BugReview>;

/**
 * Build the diagnostic prompt the council reviews. Includes the failure
 * context + asks for structured BugReview output.
 */
export function buildDiagnosticPrompt(ctx: FailureContext, pack: TaskPack): string {
  return `# Self-healing harness — bug-review diagnosis

You are reviewing a phase failure in the autonomous-delivery harness. Emit a
structured BugReview JSON the next worker dispatch will read.

## Failure context

${ctx.detail}

## Pack metadata

- task_id: ${pack.task_id}
- module_or_sprint: ${pack.module_or_sprint}
- type: ${pack.type}
- objective: ${pack.objective.slice(0, 200)}
- prior bug-review attempts on this task: ${ctx.prior_attempts}

## Your job

1. Classify the failure: ${ctx.failure_class} (auto-classified; correct if needed)
2. Diagnose root cause in plain English (1-3 sentences)
3. Decide next_action:
   - retry-same: transport error or transient infrastructure failure; same prompt + fresh worker should recover
   - apply-fixes: worker logic / output failure; emit ordered fixes for the next worker
   - park-needs-operator: ${ctx.prior_attempts >= 1 ? 'STRONGLY PREFER (this is the SECOND attempt; harness is at hard cap)' : 'use only when failure is unrecoverable without operator judgment'}
4. If apply-fixes: emit ordered list of BugFix objects (highest severity first):
   - id (FIX-1, FIX-2, ...)
   - action (concrete: "rewrite §7.2 to remove the unsupported claim about X" — NOT "fix the section")
   - pointer (file path + line range or "§N")
   - severity (critical | high | medium | low)
   - rationale (1-2 sentences)
5. confidence: 0.0-1.0 estimate that next attempt succeeds
6. summary_for_memo: 2-3 sentences for the validation memo audit trail

## Output schema (Zod BugReview)

\`\`\`json
{
  "schema_version": "1",
  "task_id": "${pack.task_id}",
  "reviewed_at": "<ISO timestamp>",
  "reviewer": "codex-5.5-xhigh",
  "failure_classification": "transport-error | worker-incomplete | worker-blocked | postflight-rejected | test-failure | council-hard-gate | unknown",
  "diagnosis": "≥20 char plain-English root cause",
  "fixes": [{ "id": "FIX-1", "action": "...", "pointer": "...", "severity": "critical|high|medium|low", "rationale": "..." }],
  "next_action": "retry-same | apply-fixes | park-needs-operator",
  "confidence": 0.0-1.0,
  "summary_for_memo": "≥20 char operator-facing summary"
}
\`\`\`

Emit ONLY the JSON object, no preamble.`;
}

// ─── Persistence ────────────────────────────────────────────────────────────

export const BUG_REVIEW_FILENAME = '_bug-review.json';

export function bugReviewPath(evidenceDir: string): string {
  return path.join(evidenceDir, BUG_REVIEW_FILENAME);
}

export function readBugReview(evidenceDir: string): BugReview | null {
  const p = bugReviewPath(evidenceDir);
  if (!fs.existsSync(p)) return null;
  try {
    return BugReview.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch {
    return null;
  }
}

export function writeBugReview(evidenceDir: string, review: BugReview): void {
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(bugReviewPath(evidenceDir), JSON.stringify(review, null, 2));
}
