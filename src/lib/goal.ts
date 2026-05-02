/**
 * Goal contract (LRA-5).
 *
 * Operator-defined goal: a JSON file at .agent-runs/_goal.json that declares
 * the completion criteria for the autonomous-delivery program. Without this,
 * the harness cannot know when it's "done" — operator must manually decide.
 *
 * Closes Codex end-to-end consensus mandate: "implement the goal contract so
 * the operator has a true finish line."
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';
import { TaskState } from './taskPack';
// Static imports for buildGoalSnapshot — ESM doesn't support require()
import { listTasks, readTaskPack } from './runState';
import { loadModuleScores, computeCiGreenStreakDays } from './scoreboard';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const GoalCriterion = z.object({
  /** Stable identifier for this criterion. */
  id: z.string(),
  /** Human description of what success looks like. */
  description: z.string(),
  /**
   * Predicate type — drives the evaluator. v0.1 supports:
   *   - "task_state_count" — count tasks in given state(s) >= target
   *   - "task_count_total" — total tasks in run >= target (for portfolio sizing)
   *   - "module_at_score" — modules at FRD-GO score >= target
   *   - "ci_green_streak_days" — days since last CI red >= target
   *   - "all_modules_merged" — count(modules where impl_status==merged) >= target
   *   - "manual" — operator must mark complete
   */
  predicate_type: z.enum([
    'task_state_count',
    'task_count_total',
    'module_at_score',
    'ci_green_streak_days',
    'all_modules_merged',
    'frd_go_count',
    'manual',
  ]),
  /** Predicate parameters (predicate_type-specific). */
  params: z.record(z.string(), z.unknown()).default({}),
  /** Target value to reach (e.g., 87 for "all modules merged"). */
  target: z.number().int().nonnegative(),
  /** Last computed value at tick time (informational). */
  current: z.number().int().nonnegative().default(0),
  /** Last evaluation timestamp. */
  last_evaluated_at: z.string().optional(),
});

export const GoalContract = z.object({
  schema_version: z.literal('1').default('1'),
  /** Stable goal identifier (one per program). */
  goal_id: z.string(),
  /** Human-readable goal name (for beacons/notifications). */
  name: z.string(),
  /** Created timestamp. */
  created_at: z.string(),
  /**
   * The completion criteria. Goal is COMPLETE when ALL criteria have
   * `current >= target`. Operator can disable a criterion by setting
   * `target: 0`.
   */
  completion_criteria: z.array(GoalCriterion).min(1),
  /**
   * Operator-set overrides — for emergencies (e.g., "ship anyway despite
   * one criterion failing"). Each override has a reason + timestamp; the
   * goal is treated as complete if ALL non-overridden criteria are met.
   */
  operator_overrides: z
    .array(
      z.object({
        criterion_id: z.string(),
        reason: z.string(),
        at: z.string(),
        by: z.string(),
      })
    )
    .default([]),
  /**
   * Where to broadcast completion. v0.1 just logs; future versions can
   * wire push notifications, GitHub issue creation, etc.
   */
  broadcast_on_completion: z.array(z.enum(['log', 'push-notification', 'git-tag', 'github-issue'])).default(['log']),
  /**
   * v0.5.0 Sprint 2 (Codex bdjec7m74): minimal extensions for goal-aware
   * gap analysis. Codex prescription: "Reuse and minimally extend the
   * existing goal contract."
   */
  /** Optional human-readable description for planners + dashboard. */
  description: z.string().optional(),
  /** Operational status (independent of completion). */
  status: z.enum(['draft', 'active', 'paused', 'achieved', 'abandoned']).default('active'),
  /**
   * Hints for `auto:gap`: which modules are "hot" (high priority for the
   * operator), which are "cold" (deprioritized), per-module priority
   * weights. Used by gap analysis to bias the candidate ranking. Defaults
   * empty = treat every module equally.
   */
  planning_hints: z.object({
    hot_modules: z.array(z.string()).default([]),
    cold_modules: z.array(z.string()).default([]),
    /** Module ID → priority weight (1.0 = default; higher = preferred). */
    module_weights: z.record(z.number()).default({}),
    /** Hard-cap candidates per gap-analysis run (Codex: "v1 output should be capped"). */
    max_candidates_per_run: z.number().int().positive().default(10),
  }).default({
    hot_modules: [],
    cold_modules: [],
    module_weights: {},
    max_candidates_per_run: 10,
  }),
});

export type GoalContract = z.infer<typeof GoalContract>;
export type GoalCriterion = z.infer<typeof GoalCriterion>;

// ─── Persistence ────────────────────────────────────────────────────────────

export function goalPath(harnessRoot: string): string {
  return path.join(harnessRoot, '.agent-runs', '_goal.json');
}

export function readGoal(harnessRoot: string): GoalContract | null {
  const p = goalPath(harnessRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return GoalContract.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    throw new Error(`goal.json is malformed: ${(e as Error).message}`);
  }
}

export function writeGoal(harnessRoot: string, goal: GoalContract): void {
  const p = goalPath(harnessRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic write via tempfile + rename
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(goal, null, 2));
  fs.renameSync(tmp, p);
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

export interface RunStateSnapshot {
  /** All task packs across all runs, with state + module info. */
  tasks: Array<{
    task_id: string;
    run_id: string;
    state: TaskState;
    module_or_sprint: string;
  }>;
  /** Optional: module → FRD-GO score (from Codex consensus). */
  module_scores?: Record<string, number>;
  /** Optional: days since last CI red on protected branch. */
  ci_green_streak_days?: number;
  /**
   * Operator-curated module progress sourced from FRD frontmatter at
   * $HERMES_DOCS_ROOT (operator-set). Counts shipped work that pre-dates the
   * harness's own TaskPack-driven dispatch (e.g., M01 sprint55m-closed
   * has shipped impl but no TaskPack history). Without this, the goal
   * counter shows 0/87 when the platform actually has 14+ active modules.
   */
  module_progress?: Array<{
    module_id: string;
    /** GO/READY (sprint-closed, signoff-ready, gold-polish, merged) */
    frd_go: boolean;
    /** code_home paths from FRD frontmatter exist on disk */
    has_impl: boolean;
  }>;
}

export interface CriterionResult {
  id: string;
  current: number;
  target: number;
  met: boolean;
  override_active: boolean;
  override_reason?: string;
}

export interface GoalEvaluation {
  goal_id: string;
  evaluated_at: string;
  complete: boolean;
  total_criteria: number;
  criteria_met: number;
  criteria_overridden: number;
  per_criterion: CriterionResult[];
}

/**
 * Evaluate a goal contract against the current run state.
 * Pure function — does NOT mutate the goal contract on disk; caller persists
 * via writeGoal() if they want the `current` field updated.
 */
export function evaluateGoal(goal: GoalContract, snapshot: RunStateSnapshot): GoalEvaluation {
  const overrideMap = new Map<string, { reason: string; at: string }>();
  for (const o of goal.operator_overrides) {
    overrideMap.set(o.criterion_id, { reason: o.reason, at: o.at });
  }

  const per_criterion: CriterionResult[] = goal.completion_criteria.map((c) => {
    const current = computeCriterionCurrent(c, snapshot);
    const override = overrideMap.get(c.id);
    const override_active = override !== undefined;
    return {
      id: c.id,
      current,
      target: c.target,
      met: current >= c.target,
      override_active,
      override_reason: override?.reason,
    };
  });

  const criteria_met = per_criterion.filter((c) => c.met || c.override_active).length;
  const complete = criteria_met === per_criterion.length;

  return {
    goal_id: goal.goal_id,
    evaluated_at: new Date().toISOString(),
    complete,
    total_criteria: per_criterion.length,
    criteria_met,
    criteria_overridden: per_criterion.filter((c) => c.override_active).length,
    per_criterion,
  };
}

function computeCriterionCurrent(c: GoalCriterion, s: RunStateSnapshot): number {
  switch (c.predicate_type) {
    case 'task_state_count': {
      const states = (c.params.states as string[] | undefined) ?? ['merged'];
      return s.tasks.filter((t) => states.includes(t.state)).length;
    }
    case 'task_count_total':
      return s.tasks.length;
    case 'module_at_score': {
      const minScore = (c.params.min_score as number | undefined) ?? 7.0;
      if (!s.module_scores) return 0;
      return Object.values(s.module_scores).filter((sc) => sc >= minScore).length;
    }
    case 'ci_green_streak_days':
      return s.ci_green_streak_days ?? 0;
    case 'all_modules_merged': {
      // Count distinct NORMALIZED modules where shipped impl exists. Two
      // sources combined (logical OR — first one to count wins per module):
      //   1. TaskPack-driven: at least one task in {merged, ready-for-merge}
      //   2. Operator-curated: module_progress[].has_impl (from FRD frontmatter
      //      code_home paths existing on disk — picks up modules that shipped
      //      BEFORE the harness's TaskPack-driven dispatch existed)
      // Codex R2 fix: normalize 'M02-impl-1' / 'M02-impl-2' / 'M02-v0.8' all
      // to 'M02' so multi-sprint tasks don't double-count.
      const normalize = (m: string): string => {
        const match = m.match(/^(M\d+)/i);
        return match ? match[1].toUpperCase() : m;
      };
      const merged = new Set<string>();
      for (const t of s.tasks) {
        if (t.state === 'merged' || t.state === 'ready-for-merge') {
          merged.add(normalize(t.module_or_sprint));
        }
      }
      // Fold in operator-curated module_progress (frontmatter-sourced).
      if (s.module_progress) {
        for (const m of s.module_progress) {
          if (m.has_impl) merged.add(m.module_id);
        }
      }
      return merged.size;
    }
    case 'frd_go_count': {
      // Count modules with FRD at GO (operator-curated frontmatter status).
      // Replaces the legacy 'all_modules_frd_go' which previously had no
      // implementation — it just always returned 0.
      if (!s.module_progress) return 0;
      return s.module_progress.filter((m) => m.frd_go).length;
    }
    case 'manual':
      // Manual criteria use the persisted `current` value directly; operator
      // bumps it via `auto:goal-complete --criterion <id>` (Phase 1 CLI).
      return c.current;
  }
}

/**
 * Persist updated `current` + `last_evaluated_at` into the goal contract on
 * disk, based on the latest evaluation. Atomic via writeGoal.
 */
export function persistGoalEvaluation(
  harnessRoot: string,
  goal: GoalContract,
  evaluation: GoalEvaluation
): void {
  const updated: GoalContract = {
    ...goal,
    completion_criteria: goal.completion_criteria.map((c) => {
      const r = evaluation.per_criterion.find((p) => p.id === c.id);
      if (!r) return c;
      return { ...c, current: r.current, last_evaluated_at: evaluation.evaluated_at };
    }),
  };
  writeGoal(harnessRoot, updated);
}

// ─── Builders + helpers ─────────────────────────────────────────────────────

/**
 * Codex R4 prereq #2: shared buildGoalSnapshot() helper.
 * Centralizes snapshot construction across goal/tick/flush/resume/resurrect
 * (was duplicated in 5 places — risk of drift). Pure-ish: scans all task
 * packs in all runs + loads scoreboard inputs.
 */
export function buildGoalSnapshot(
  harnessRoot: string,
  packageRoot: string,
  opts: {
    /** Inject pre-built tasks (for callers that already have them, like tick.ts). */
    tasks?: RunStateSnapshot['tasks'];
    /** Skip scoreboard loads (e.g., when caller doesn't want gh API call). */
    skipScoreboard?: boolean;
  } = {}
): RunStateSnapshot {
  let tasks = opts.tasks;
  if (!tasks) {
    tasks = [];
    const runsDir = path.join(harnessRoot, '.agent-runs');
    if (fs.existsSync(runsDir)) {
      for (const runId of fs.readdirSync(runsDir)) {
        if (runId.startsWith('_')) continue;
        try {
          if (!fs.statSync(path.join(runsDir, runId)).isDirectory()) continue;
        } catch { continue; }
        for (const tid of listTasks(runId)) {
          try {
            const pack = readTaskPack(runId, tid);
            tasks.push({
              task_id: tid,
              run_id: runId,
              state: pack.state,
              module_or_sprint: pack.module_or_sprint,
            });
          } catch { /* skip */ }
        }
      }
    }
  }

  // Operator-curated module progress from FRD frontmatter. Always included
  // (cheap; ~88 file reads, cached in-process for 30s).
  const module_progress = loadModuleProgressFromFrontmatter();

  if (opts.skipScoreboard) {
    return { tasks, module_progress };
  }

  try {
    const moduleScores = loadModuleScores(harnessRoot, packageRoot);
    const ciGreenStreakDays = computeCiGreenStreakDays(harnessRoot);
    return { tasks, module_scores: moduleScores, ci_green_streak_days: ciGreenStreakDays, module_progress };
  } catch {
    return { tasks, module_progress };
  }
}

let _modProgCache: { ts: number; data: NonNullable<RunStateSnapshot['module_progress']> } | null = null;

/**
 * Read FRD frontmatter from $HERMES_DOCS_ROOT (operator-set) and synthesize per-module
 * progress signals. Cached for 30s to avoid hammering the filesystem on every
 * tick. Returns [] if the FRD vault isn't present.
 *
 * GO bucket pattern: status matches /closed|signoff-ready|signed-off|merged|gold-polish/
 * has_impl: any code_home path exists under typical monorepo dirs.
 */
function loadModuleProgressFromFrontmatter(): NonNullable<RunStateSnapshot['module_progress']> {
  if (_modProgCache && Date.now() - _modProgCache.ts < 30_000) return _modProgCache.data;
  const out: NonNullable<RunStateSnapshot['module_progress']> = [];
  const frdsRoot = process.env.HERMES_DOCS_ROOT || '';
  if (!fs.existsSync(frdsRoot)) {
    _modProgCache = { ts: Date.now(), data: out };
    return out;
  }
  // Repo roots to probe for has_impl (caller is harness; check both vendored
  // worktree and the parent project if it exists).
  const repoRoots = [
    process.cwd(),
    path.resolve(process.cwd(), '..'),
    path.resolve(process.cwd(), '..', '..'),
  ];
  for (const dirent of fs.readdirSync(frdsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const m = dirent.name.match(/^FRD-(M\d+)/i);
    if (!m) continue;
    const moduleId = m[1].toUpperCase();
    let status = '', codeHome = '';
    try {
      for (const f of fs.readdirSync(path.join(frdsRoot, dirent.name))) {
        if (!f.endsWith('.md')) continue;
        try {
          const content = fs.readFileSync(path.join(frdsRoot, dirent.name, f), 'utf8');
          const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
          if (!fmMatch) continue;
          for (const line of fmMatch[1].split(/\n/)) {
            const kv = line.match(/^(\w+):\s*"?([^"\n]*?)"?\s*$/);
            if (!kv) continue;
            if (kv[1] === 'status' && !status) status = kv[2];
            if (kv[1] === 'code_home' && !codeHome) codeHome = kv[2];
          }
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    const sLow = status.toLowerCase();
    const frdGo = /closed|signoff-ready|signed-off|merged|gold-polish|^go$/.test(sLow);
    let hasImpl = false;
    if (codeHome && !codeHome.toLowerCase().includes('tbd') && !codeHome.toLowerCase().includes('greenfield')) {
      const tokens = codeHome.match(/(apps|domains|platform|packages|gateway|deploy|e2e)\/[a-zA-Z0-9_-]+/g) ?? [];
      for (const tok of tokens) {
        for (const root of repoRoots) {
          if (fs.existsSync(path.join(root, tok))) { hasImpl = true; break; }
        }
        if (hasImpl) break;
      }
    }
    out.push({ module_id: moduleId, frd_go: frdGo, has_impl: hasImpl });
  }
  _modProgCache = { ts: Date.now(), data: out };
  return out;
}

/**
 * Build a default goal contract — placeholder for greenfield projects.
 * Operator should call `auto:goal init` then edit the resulting YAML to
 * declare their own completion criteria.
 */
export function defaultGoal(): GoalContract {
  return GoalContract.parse({
    goal_id: 'project-v1',
    name: 'Project v1 — replace with your project goal',
    created_at: new Date().toISOString(),
    completion_criteria: [
      {
        id: 'all-modules-at-score',
        description: 'All modules at consensus score >= 7.0 sustained',
        predicate_type: 'module_at_score',
        params: { min_score: 7.0 },
        target: 1,
      },
      {
        id: 'all-modules-merged',
        description: 'Every planned module has impl PR merged to main',
        predicate_type: 'all_modules_merged',
        params: {},
        target: 1,
      },
      {
        id: 'ci-green-7d',
        description: 'main has been CI-green for 7 consecutive days',
        predicate_type: 'ci_green_streak_days',
        params: {},
        target: 7,
      },
    ],
    operator_overrides: [],
    broadcast_on_completion: ['log', 'github-issue'],
  });
}
