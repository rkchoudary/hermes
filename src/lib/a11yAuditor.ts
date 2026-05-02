/**
 * v0.5.0 Pillar 5 — a11y-auditor reviewer agent (the only reviewer Codex
 * authorized for this sprint).
 *
 * Codex prescription: "ship one reviewer: a11y-auditor, tool-backed via axe/
 * Playwright where available." This module:
 *
 *   1. Reads `evidence/<TP>/ux/axe-results.json` (produced by the worker via
 *      the `wcag-compliant-responsive` skill) — one entry per page × viewport.
 *   2. Classifies each violation by axe `impact`:
 *        critical / serious  → blocking (severity 'critical')
 *        moderate            → severity 'error', non-blocking by default
 *        minor               → severity 'warning'
 *   3. Cross-references with `design-system-artifacts.json` to flag drift.
 *   4. Emits a `ReviewerOutput` matching the v0.5.0 evidence contract.
 *
 * Codex final-arbiter rule: this reviewer's blocking findings DO block
 * promotion, but Codex consensus reviews the bundle and can override (with
 * audited reason) per existing `--human-override` semantics.
 *
 * Pure-ish: the evaluator is purely functional given parsed inputs. The
 * harness wraps it in I/O at dispatch time.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TaskPack } from './taskPack';
import type {
  AxeRunResult,
  AxeViolation,
  DesignSystemArtifact,
  ReviewerFinding,
  ReviewerOutput,
  UxEvidence,
} from './uxEvidence';
import { sha256OfFile } from './uxEvidence';
import { getLogger } from './logger';

const log = getLogger('a11y-auditor');

const REVIEWER_NAME = 'a11y-auditor' as const;
const REVIEWER_VERSION = '1.0.0';

/** Map axe impact to harness severity per Codex finding-classification rule. */
function impactToSeverity(impact: AxeViolation['impact']): { severity: ReviewerFinding['severity']; blocking: boolean } {
  switch (impact) {
    case 'critical':
      return { severity: 'critical', blocking: true };
    case 'serious':
      return { severity: 'critical', blocking: true };
    case 'moderate':
      return { severity: 'error', blocking: false };
    case 'minor':
      return { severity: 'warning', blocking: false };
    default:
      return { severity: 'info', blocking: false };
  }
}

export interface A11yAuditorInput {
  axe_runs: AxeRunResult[];
  /** Optional — when present, the auditor cross-references for drift. */
  design_system_artifacts?: DesignSystemArtifact[];
  /** Repo root, so we can re-hash design-system artifacts to detect drift. */
  repo_root?: string;
}

/**
 * Pure evaluator: given parsed axe results + (optionally) design-system
 * artifacts, return findings list. No filesystem/network/subprocess.
 */
export function evaluateA11y(input: A11yAuditorInput): ReviewerFinding[] {
  const findings: ReviewerFinding[] = [];

  // 1. axe violations — one finding per (rule × page) tuple to keep the
  //    evidence dir browseable. Deduplication by rule keeps reviewer output
  //    sane when the same rule fires on every page.
  const ruleSeen = new Map<string, { count: number; pages: Set<string>; viewports: Set<string>; severity: ReviewerFinding['severity']; blocking: boolean; sample: AxeViolation }>();
  for (const run of input.axe_runs) {
    for (const v of run.violations) {
      if (!v.id) continue;
      const sev = impactToSeverity(v.impact);
      const key = v.id;
      let entry = ruleSeen.get(key);
      if (!entry) {
        entry = { count: 0, pages: new Set(), viewports: new Set(), severity: sev.severity, blocking: sev.blocking, sample: v };
        ruleSeen.set(key, entry);
      }
      entry.count += v.nodes_count;
      entry.pages.add(run.page_url);
      entry.viewports.add(run.viewport_name);
      // Promote severity if a higher-impact instance is found.
      const a = ['info', 'warning', 'error', 'critical'].indexOf(sev.severity);
      const b = ['info', 'warning', 'error', 'critical'].indexOf(entry.severity);
      if (a > b) {
        entry.severity = sev.severity;
        entry.blocking = sev.blocking;
      }
    }
  }
  for (const [ruleId, entry] of ruleSeen) {
    findings.push({
      id: `axe-${ruleId}`,
      severity: entry.severity,
      blocking: entry.blocking,
      title: `axe: ${ruleId} (${entry.count} node${entry.count === 1 ? '' : 's'} across ${entry.pages.size} page${entry.pages.size === 1 ? '' : 's'})`,
      description: [
        entry.sample.help ?? entry.sample.description ?? `axe-core rule '${ruleId}' violated`,
        '',
        `Pages affected: ${Array.from(entry.pages).join(', ')}`,
        `Viewports: ${Array.from(entry.viewports).join(', ')}`,
        `Impact: ${entry.sample.impact ?? 'unknown'}`,
        entry.sample.helpUrl ? `Reference: ${entry.sample.helpUrl}` : '',
      ].filter((s) => s !== '').join('\n'),
      evidence_refs: Array.from(entry.pages).map((p) => `axe_results[page=${p}]`),
    });
  }

  // 2. Design-system drift — re-hash recorded artifacts and compare.
  if (input.design_system_artifacts && input.repo_root) {
    for (const artifact of input.design_system_artifacts) {
      const fullPath = path.resolve(input.repo_root, artifact.path);
      if (!fs.existsSync(fullPath)) {
        findings.push({
          id: `ds-drift-removed-${artifact.path}`,
          severity: 'error',
          blocking: false,
          title: `Design-system artifact removed: ${artifact.path}`,
          description: `Artifact recorded at task-start (sha ${artifact.sha256.slice(0, 16)}…, ${artifact.size_bytes} bytes) is now missing. May indicate concurrent design-system change or accidental deletion.`,
          file_path: artifact.path,
          evidence_refs: [],
        });
        continue;
      }
      const currentSha = sha256OfFile(fullPath);
      if (currentSha !== artifact.sha256) {
        findings.push({
          id: `ds-drift-modified-${artifact.path}`,
          severity: 'warning',
          blocking: false,
          title: `Design-system artifact changed during task: ${artifact.path}`,
          description: [
            `Recorded at task-start: ${artifact.sha256}`,
            `Current:                ${currentSha}`,
            `If your task intentionally modifies the design system, file a separate dependent TaskPack so the change is reviewed in isolation per single-writer rule.`,
          ].join('\n'),
          file_path: artifact.path,
          evidence_refs: [],
        });
      }
    }
  }

  return findings;
}

/**
 * Orchestrator: read evidence files for a task, run the pure evaluator, write
 * back a ReviewerOutput entry into UxEvidence. Returns the entry written.
 *
 * Caller (auto:specialized-review CLI) is responsible for invoking this for
 * each `pack.consensus.specialized_reviewers` entry.
 */
export function runA11yAuditor(opts: {
  taskId: string;
  runId: string;
  pack: TaskPack;
  evidenceDir: string;
  repoRoot: string;
}): ReviewerOutput {
  const startedAt = Date.now();
  const axeResultsPath = path.join(opts.evidenceDir, 'ux', 'axe-results.json');
  const dsArtifactsPath = path.join(opts.evidenceDir, 'ux', 'design-system-artifacts.json');

  let axeRuns: AxeRunResult[] = [];
  if (fs.existsSync(axeResultsPath)) {
    try {
      axeRuns = JSON.parse(fs.readFileSync(axeResultsPath, 'utf8'));
    } catch (e) {
      log.warn('axe-results.json failed to parse', { error: (e as Error).message });
    }
  } else {
    log.warn('axe-results.json missing — auditor will run with zero input', {
      task_id: opts.taskId,
      expected: axeResultsPath,
    });
  }

  let dsArtifacts: DesignSystemArtifact[] | undefined;
  if (fs.existsSync(dsArtifactsPath)) {
    try {
      dsArtifacts = JSON.parse(fs.readFileSync(dsArtifactsPath, 'utf8'));
    } catch { /* best-effort */ }
  }

  const findings = evaluateA11y({
    axe_runs: axeRuns,
    design_system_artifacts: dsArtifacts,
    repo_root: opts.repoRoot,
  });
  const blocking = findings.some((f) => f.blocking);

  const output: ReviewerOutput = {
    reviewer_name: REVIEWER_NAME,
    reviewer_version: REVIEWER_VERSION,
    invoked_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    findings,
    summary:
      findings.length === 0
        ? 'a11y-auditor: 0 findings'
        : `a11y-auditor: ${findings.length} finding(s) — ${findings.filter((f) => f.blocking).length} blocking`,
    reviewer_blocks: blocking,
  };

  // Write output file (reviewer JSON per Codex evidence contract)
  const outPath = path.join(opts.evidenceDir, 'ux', `reviewer-${REVIEWER_NAME}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  log.info('a11y-auditor complete', {
    task_id: opts.taskId,
    findings: findings.length,
    blocking,
    out: outPath,
  });

  return output;
}

export const A11Y_AUDITOR_NAME = REVIEWER_NAME;
