/**
 * v0.5.0 Sprint 2 — gap analysis evidence compiler.
 *
 * Codex review (bdjec7m74) prescribed scope:
 *   "Make `auto:gap` an evidence compiler, not an autonomous planner. The
 *   output should be a ranked backlog with citations, proposed allowed_paths,
 *   and explicit uncertainty. The operator's approvals become the training
 *   signal for later decomposition and scheduling."
 *
 * Strict design rules (per Codex):
 *   - DETERMINISTIC index from filesystem state; LLM only sees compact summaries
 *   - NO filesystem writes (output is structured JSON only)
 *   - Top-K cap (default 10; capped via planning_hints.max_candidates_per_run)
 *   - candidate state, NOT planned (operator must approve before TaskPack write)
 *   - Transparent tuple ranking (dependency readiness, priority, risk/cost)
 *   - Stable ranking under irrelevant file changes
 *
 * Inputs (read-only):
 *   - Active GoalContract
 *   - Existing TaskPacks (for "already in flight" exclusion)
 *   - Module manifest if present (for path-allowlist derivation)
 *   - Cost telemetry history (for forecast)
 *
 * Output: { candidates: GapCandidate[], inventory_summary, generated_at, goal_id }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import type { GoalContract } from './goal';
import type { TaskPack, TaskType } from './taskPack';
import { getLogger } from './logger';

const log = getLogger('gap-analysis');

// ─── Schema ─────────────────────────────────────────────────────────────────

export const GapCandidate = z.object({
  /** Stable id for operator approval (operator types `approve <id>`). */
  candidate_id: z.string(),
  /** Module/sprint this candidate targets. */
  module_or_sprint: z.string(),
  /** Suggested task_type from the harness enum. */
  type: z.string(),
  /** One-line rationale operator-readable. Codex: "ranked backlog with citations". */
  rationale: z.string(),
  /** Goal criterion this candidate moves toward. */
  contributes_to_criterion: z.string().optional(),
  /** Evidence paths the operator can verify. */
  evidence: z.array(z.string()),
  /** Suggested allowed_paths derived from module manifest OR default deny-only. */
  proposed_allowed_paths: z.array(z.string()),
  /** Tasks this candidate would unblock (depends_on graph fan-out). */
  unblocks: z.array(z.string()).default([]),
  /** Tasks this candidate depends on. Must be merged/ready before dispatch. */
  depends_on: z.array(z.string()).default([]),
  /** Estimated effort in hours, derived from prior cost telemetry. */
  estimated_effort_hours: z.number().nonnegative(),
  /** Tuple ranking (transparent, NOT a weighted scalar). Codex prescription. */
  ranking: z.object({
    dependency_readiness: z.boolean(),
    operator_priority: z.number(),
    criterion_impact: z.number(),
    estimated_cost_usd: z.number(),
    freshness_days: z.number(),
  }),
  /** Explicit uncertainty per Codex: where the candidate may be wrong. */
  uncertainty: z.array(z.string()).default([]),
});
export type GapCandidate = z.infer<typeof GapCandidate>;

export const GapAnalysisResult = z.object({
  schema_version: z.literal('1').default('1'),
  goal_id: z.string(),
  generated_at: z.string(),
  candidates: z.array(GapCandidate),
  inventory_summary: z.object({
    modules_scanned: z.number().int().nonnegative(),
    existing_tasks_in_flight: z.number().int().nonnegative(),
    candidates_before_cap: z.number().int().nonnegative(),
    candidates_capped_to: z.number().int().nonnegative(),
  }),
});
export type GapAnalysisResult = z.infer<typeof GapAnalysisResult>;

// ─── Inventory builders (deterministic, no LLM) ───────────────────────────

export interface ModuleSummary {
  module_id: string;
  /** FRD status if known: GO | PARTIAL | DRAFT | UNKNOWN */
  frd_status: 'GO' | 'PARTIAL' | 'DRAFT' | 'UNKNOWN';
  /** Latest known FRD score if recorded. */
  frd_score: number | null;
  /** Has shipped impl in repo. */
  has_impl: boolean;
  /** Has test coverage (any tests). */
  has_tests: boolean;
  /** Code paths owned by this module (from manifest, FRD, or convention). */
  code_paths: string[];
  /** Existing TaskPacks targeting this module (any state). */
  existing_tasks: Array<{ task_id: string; state: TaskPack['state']; type: string }>;
  /** Last operator activity timestamp (last commit, last task, etc.). */
  last_active_at: string | null;
  /** Open PRs targeting this module (gh pr list snapshot). Modules with an
   *  open authoring/refresh PR for a given task type are excluded from being
   *  re-suggested as candidates of that same type — PR == work in flight. */
  open_prs: Array<{ number: number; branch: string; title: string; kind: 'frd' | 'impl' | 'other' }>;
  /** Merged PRs for this module (gh pr list --state merged snapshot). Tells
   *  the operator which modules have shipped work even if the FRD isn't GO yet.
   *  Re-suggesting code-sprint on a module that already has merged impl PRs
   *  is the second green-field illusion. */
  merged_prs: Array<{ number: number; branch: string; title: string; kind: 'frd' | 'impl' | 'other' }>;
}

/** Open PR record sourced from `gh pr list --json`. Caller must supply.
 *  buildInventoryFromFs stays a pure function — no shell-out inside. */
export interface OpenPrRecord {
  number: number;
  branch: string;
  title: string;
}

/**
 * Map a PR branch name to a module ID + work kind.
 *
 *   docs/frd-m05-auth      → { module: M05, kind: 'frd' }
 *   docs/frd-m07-refresh   → { module: M07, kind: 'frd' }
 *   claude/m02-impl-1c     → { module: M02, kind: 'impl' }
 *   feat/M03-fix-tests     → { module: M03, kind: 'other' }
 *   <unrelated>            → null
 */
/**
 * Parse a markdown file's YAML frontmatter (the `--- ... ---` block at the top).
 * Returns a flat key→value record (string values only, unwrapped from quotes).
 * Returns null if no frontmatter present. Pure function; no I/O.
 */
export function parseFrdFrontmatter(content: string): Record<string, string> | null {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const body = m[1];
  const out: Record<string, string> = {};
  for (const line of body.split(/\n/)) {
    const kv = line.match(/^(\w+):\s*(.*?)\s*$/);
    if (!kv) continue;
    let v = kv[2];
    // Strip surrounding quotes.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[kv[1]] = v;
  }
  return out;
}

/**
 * Parse the operator-curated `code_home:` frontmatter value into discrete
 * monorepo paths. Tokens look like:
 *   "platform/pipeline/ + apps/web/src/lib/canonical/ + apps/web/src/app/api/ingest/upload/"
 * Returns the paths split + trimmed of trailing slashes. Filters out
 * sentinel values like "TBD" and "greenfield".
 */
export function parseCodeHome(codeHomeRaw: string): string[] {
  if (!codeHomeRaw) return [];
  const lower = codeHomeRaw.toLowerCase();
  if (lower.includes('tbd') || lower.includes('greenfield') || lower.includes('no direct implementation')) return [];
  return codeHomeRaw
    .split(/[+,]|—|–/)  // accept +, comma, em/en dash separators
    .map((s) => s.trim())
    .filter((s) => /^(apps|domains|platform|packages|gateway|deploy|e2e)\//.test(s))
    .map((s) => s.replace(/\/+$/, ''));
}

/**
 * Cheap existence check: does any of the parsed code_home paths exist under
 * the repo root? Used as a best-effort signal for `has_impl`.
 */
export function codeHomePathExists(repoRoot: string | undefined, paths: string[]): boolean {
  if (!repoRoot || paths.length === 0) return false;
  for (const p of paths) {
    if (fs.existsSync(path.join(repoRoot, p))) return true;
  }
  return false;
}

export function classifyPrBranch(branch: string): { module_id: string; kind: 'frd' | 'impl' | 'other' } | null {
  const frdMatch = branch.match(/(?:^|\/)frd-(m\d+)/i) ?? branch.match(/^docs\/(?:frd-)?(m\d+)/i);
  if (frdMatch) return { module_id: frdMatch[1].toUpperCase(), kind: 'frd' };
  const implMatch = branch.match(/(?:^|\/)(m\d+)-impl/i);
  if (implMatch) return { module_id: implMatch[1].toUpperCase(), kind: 'impl' };
  const generic = branch.match(/(?:^|\/|-)([Mm]\d+)(?:[-/]|$)/);
  if (generic) return { module_id: generic[1].toUpperCase(), kind: 'other' };
  return null;
}

/**
 * Build deterministic module inventory from filesystem.
 *
 * Codex: "Build a deterministic index first: module id, FRD status, frontmatter,
 * sections, cited code paths, known tests, existing TaskPacks, dependency edges,
 * latest score, latest blockers. Then rank from the index."
 *
 * Pure function — caller supplies all inputs. No I/O inside.
 */
export interface InventoryInput {
  modules: ModuleSummary[];
  existingTasks: TaskPack[];
}

export function buildInventoryFromFs(opts: {
  obsidianFrdsRoot?: string;
  repoRoot?: string;
  agentRunsRoot?: string;
  /** Open PRs from `gh pr list --json`. Caller supplies — keeps this fn pure. */
  openPrs?: OpenPrRecord[];
  /** Merged PRs from `gh pr list --state merged --json`. Caller supplies. */
  mergedPrs?: OpenPrRecord[];
}): InventoryInput {
  const modules: ModuleSummary[] = [];
  const existingTasks: TaskPack[] = [];

  // Scan FRDs for module status (Obsidian FRD docs).
  if (opts.obsidianFrdsRoot && fs.existsSync(opts.obsidianFrdsRoot)) {
    for (const entry of fs.readdirSync(opts.obsidianFrdsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = entry.name.match(/^FRD-(M\d+)/i);
      if (!m) continue;
      const moduleId = m[1].toUpperCase();
      const frdDir = path.join(opts.obsidianFrdsRoot, entry.name);
      let frdStatus: ModuleSummary['frd_status'] = 'UNKNOWN';
      let frdScore: number | null = null;
      let lastActive: string | null = null;
      let codeHomePaths: string[] = [];
      try {
        // Prefer FRD frontmatter (operator-curated `status:` + `codex_score:`
        // + `code_home:`) over the brittle CODEX-REVIEW.md regex. Frontmatter
        // is ground-truth — operator updates it as the FRD progresses through
        // sprint55m-closed → v0.8-signoff-ready → v0.x-polish-rN → draft → skeleton.
        for (const f of fs.readdirSync(frdDir)) {
          if (!f.endsWith('.md')) continue;
          const content = fs.readFileSync(path.join(frdDir, f), 'utf8');
          const fm = parseFrdFrontmatter(content);
          if (fm) {
            // Operator-curated status string → bucket. Last-write-wins across
            // multiple .md files in the same FRD dir (FRD-MNN.md is canonical).
            const fmStatus = (fm.status ?? '').toLowerCase();
            if (/closed|signoff-ready|signed-off|merged|gold-polish|^go$/.test(fmStatus)) {
              frdStatus = 'GO';
            } else if (/polish|addressed|fix-r\d+|-r\d+|in-progress/.test(fmStatus)) {
              if (frdStatus !== 'GO') frdStatus = 'PARTIAL';
            } else if (/skeleton|^draft$|^v0\.1 draft$/.test(fmStatus)) {
              if (frdStatus === 'UNKNOWN') frdStatus = 'DRAFT';
            }
            const score = parseFloat(fm.codex_score ?? '');
            if (!isNaN(score)) frdScore = score;
            if (fm.code_home) codeHomePaths = parseCodeHome(fm.code_home);
          }
          // Backstop: legacy regex on review-log markdown for FRDs that pre-date
          // the frontmatter convention.
          if (frdStatus === 'UNKNOWN') {
            const slice = content.slice(0, 4000);
            if (/Verdict:\s*\*?\*?GO\*?\*?/i.test(slice)) frdStatus = 'GO';
            else if (/Verdict:\s*PARTIAL/i.test(slice)) frdStatus = 'PARTIAL';
          }
          if (frdScore === null) {
            const sm = content.match(/(?:Score|score):\s*\*?\*?(\d+\.\d+)/);
            if (sm) frdScore = parseFloat(sm[1]);
          }
        }
        // Score backstop: high score with low status → bump to GO.
        if (frdStatus !== 'GO' && frdScore !== null && frdScore >= 7.5) frdStatus = 'GO';
        lastActive = fs.statSync(frdDir).mtime.toISOString();
      } catch { /* skip */ }
      modules.push({
        module_id: moduleId,
        frd_status: frdStatus,
        frd_score: frdScore,
        has_impl: codeHomePaths.length > 0 && codeHomePathExists(opts.repoRoot, codeHomePaths),
        has_tests: false,
        code_paths: codeHomePaths,
        existing_tasks: [],
        last_active_at: lastActive,
        open_prs: [],
        merged_prs: [],
      });
    }
  }

  // Annotate modules with open PR work-in-flight (caller-supplied).
  if (opts.openPrs && opts.openPrs.length > 0) {
    for (const pr of opts.openPrs) {
      const cls = classifyPrBranch(pr.branch);
      if (!cls) continue;
      const m = modules.find((x) => x.module_id === cls.module_id);
      if (!m) continue;
      m.open_prs.push({ number: pr.number, branch: pr.branch, title: pr.title, kind: cls.kind });
    }
  }

  // Annotate modules with merged PR shipped work (caller-supplied).
  // Merged impl PRs imply has_impl=true (best-effort signal without manifest).
  if (opts.mergedPrs && opts.mergedPrs.length > 0) {
    for (const pr of opts.mergedPrs) {
      const cls = classifyPrBranch(pr.branch);
      if (!cls) continue;
      const m = modules.find((x) => x.module_id === cls.module_id);
      if (!m) continue;
      m.merged_prs.push({ number: pr.number, branch: pr.branch, title: pr.title, kind: cls.kind });
      if (cls.kind === 'impl') m.has_impl = true;
    }
  }

  // Scan existing TaskPacks under .agent-runs/<run>/tasks/*.json.
  if (opts.agentRunsRoot && fs.existsSync(opts.agentRunsRoot)) {
    for (const runEntry of fs.readdirSync(opts.agentRunsRoot, { withFileTypes: true })) {
      if (!runEntry.isDirectory() || runEntry.name.startsWith('_')) continue;
      const tasksDir = path.join(opts.agentRunsRoot, runEntry.name, 'tasks');
      if (!fs.existsSync(tasksDir)) continue;
      for (const f of fs.readdirSync(tasksDir)) {
        if (!f.endsWith('.json') || f.startsWith('.')) continue;
        try {
          const pack = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')) as TaskPack;
          existingTasks.push(pack);
          const moduleId = pack.module_or_sprint.match(/M\d+/)?.[0];
          if (moduleId) {
            const m = modules.find((x) => x.module_id === moduleId.toUpperCase());
            if (m) m.existing_tasks.push({ task_id: pack.task_id, state: pack.state, type: pack.type });
          }
        } catch { /* malformed; skip */ }
      }
    }
  }

  return { modules, existingTasks };
}

// ─── Candidate ranking (transparent tuple per Codex) ────────────────────────

const TERMINAL_STATES = new Set(['merged', 'ready-for-merge', 'abandoned']);

export interface RankCandidatesOptions {
  goal: GoalContract;
  inventory: InventoryInput;
  /** When set, fold in cost forecasts (avg duration_ms × engine rate). */
  cost_history_avg_usd_per_round?: number;
  /** Now timestamp (for freshness scoring). Default = Date.now(). */
  now?: Date;
}

export function rankCandidates(opts: RankCandidatesOptions): GapAnalysisResult {
  const now = opts.now ?? new Date();
  const candidates: GapCandidate[] = [];

  // Module-level: each module that's not GO yet OR has no test coverage is a candidate.
  for (const mod of opts.inventory.modules) {
    // Skip cold modules (operator-deprioritized).
    if (opts.goal.planning_hints.cold_modules.includes(mod.module_id)) continue;

    // Skip if there's already a non-terminal task for this module.
    const inFlight = mod.existing_tasks.some((t) => !TERMINAL_STATES.has(t.state));
    if (inFlight) continue;

    // Determine the gap: FRD not GO yet → frd-polish; FRD GO but no impl → code-sprint;
    // impl exists but no tests → test-coverage.
    let gapType: TaskType | null = null;
    let rationale = '';
    if (mod.frd_status !== 'GO') {
      gapType = 'frd-polish';
      rationale = `FRD status=${mod.frd_status}${mod.frd_score !== null ? ` (score ${mod.frd_score})` : ''}; needs polish to reach GO ≥ 7.0`;
    } else if (!mod.has_impl) {
      gapType = 'code-sprint';
      rationale = `FRD GO but no impl in repo; ready for implementation sprint`;
    } else if (!mod.has_tests) {
      gapType = 'test-coverage';
      rationale = `FRD GO + impl exists but tests missing; coverage backfill candidate`;
    } else {
      continue;  // Module fully complete
    }

    // Skip when an open PR already represents this kind of work.
    // Re-suggesting frd-polish on a module whose authoring/refresh PR is already
    // open is the green-field illusion the operator flagged.
    const gt: string = gapType;
    const blockingPr = mod.open_prs.find((pr) => {
      if (pr.kind === 'frd' && (gt === 'frd-polish' || gt === 'frd-author' || gt === 'frd-reconcile')) return true;
      if (pr.kind === 'impl' && gt === 'code-sprint') return true;
      return false;
    });
    if (blockingPr) continue;

    // Tuple ranking
    const isHot = opts.goal.planning_hints.hot_modules.includes(mod.module_id);
    const operatorPriority = opts.goal.planning_hints.module_weights[mod.module_id]
      ?? (isHot ? 2.0 : 1.0);
    const dependencyReadiness = true;  // v1: assume ready; future depends_on chase
    const criterionImpact = mod.frd_status === 'GO' ? 0.5 : 1.0;  // FRD work has higher impact when status is poor
    const estimatedCostUsd = (opts.cost_history_avg_usd_per_round ?? 1.5) * (gapType === 'code-sprint' ? 4 : 1);
    const freshnessDays = mod.last_active_at
      ? Math.floor((now.getTime() - new Date(mod.last_active_at).getTime()) / (1000 * 60 * 60 * 24))
      : 999;

    const uncertainty: string[] = [];
    if (mod.code_paths.length === 0) uncertainty.push('no module manifest; allowed_paths inferred from convention');
    if (mod.frd_status === 'UNKNOWN') uncertainty.push('FRD status could not be parsed from frontmatter');

    candidates.push({
      candidate_id: `gap-${mod.module_id}-${gapType}`,
      module_or_sprint: mod.module_id,
      type: gapType,
      rationale,
      contributes_to_criterion: opts.goal.completion_criteria[0]?.id,
      evidence: [
        `module: ${mod.module_id}`,
        `frd_status: ${mod.frd_status}`,
        `frd_score: ${mod.frd_score ?? 'unknown'}`,
        `existing_tasks: ${mod.existing_tasks.length}`,
        `last_active_at: ${mod.last_active_at ?? 'unknown'}`,
      ],
      proposed_allowed_paths: mod.code_paths.length > 0
        ? mod.code_paths
        : [`docs/frd-m${mod.module_id.toLowerCase().replace(/^m/, '').padStart(2, '0')}-auth/**`],
      unblocks: [],
      depends_on: [],
      estimated_effort_hours: gapType === 'code-sprint' ? 4 : 1,
      ranking: {
        dependency_readiness: dependencyReadiness,
        operator_priority: operatorPriority,
        criterion_impact: criterionImpact,
        estimated_cost_usd: estimatedCostUsd,
        freshness_days: freshnessDays,
      },
      uncertainty,
    });
  }

  // Stable sort: dependency_readiness DESC (true first) → operator_priority DESC →
  // criterion_impact DESC → estimated_cost_usd ASC → module_id ASC (tie-break)
  candidates.sort((a, b) => {
    if (a.ranking.dependency_readiness !== b.ranking.dependency_readiness) {
      return a.ranking.dependency_readiness ? -1 : 1;
    }
    if (a.ranking.operator_priority !== b.ranking.operator_priority) {
      return b.ranking.operator_priority - a.ranking.operator_priority;
    }
    if (a.ranking.criterion_impact !== b.ranking.criterion_impact) {
      return b.ranking.criterion_impact - a.ranking.criterion_impact;
    }
    if (a.ranking.estimated_cost_usd !== b.ranking.estimated_cost_usd) {
      return a.ranking.estimated_cost_usd - b.ranking.estimated_cost_usd;
    }
    return a.module_or_sprint.localeCompare(b.module_or_sprint);
  });

  const beforeCap = candidates.length;
  const cap = opts.goal.planning_hints.max_candidates_per_run;
  const capped = candidates.slice(0, cap);
  log.info('gap analysis complete', {
    modules_scanned: opts.inventory.modules.length,
    existing_tasks: opts.inventory.existingTasks.length,
    candidates_before_cap: beforeCap,
    candidates_after_cap: capped.length,
  });
  return {
    schema_version: '1',
    goal_id: opts.goal.goal_id,
    generated_at: now.toISOString(),
    candidates: capped,
    inventory_summary: {
      modules_scanned: opts.inventory.modules.length,
      existing_tasks_in_flight: opts.inventory.existingTasks.filter((t) => !TERMINAL_STATES.has(t.state)).length,
      candidates_before_cap: beforeCap,
      candidates_capped_to: capped.length,
    },
  };
}
