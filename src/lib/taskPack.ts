/**
 * Task Pack — bounded unit of autonomous work.
 *
 * Every autonomous task is a TaskPack: claim file + scope + AC + evidence dir +
 * Codex consensus gate. See ../docs/ARCHITECTURE.md for full lifecycle.
 *
 * v0.1 schema. Future versions extend additively.
 */

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Actors } from './sod';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const TaskType = z.enum([
  'frd-author',           // create FRD v0.1-draft from skeleton
  'frd-polish',           // surgical fixes to advance FRD round (most common pilot type)
  'frd-reconcile',        // FRD vs shipped-impl reconciliation
  // v0.7.2 Sprint 0.5 (Authoring Trio): TRD + Sprint Plan are first-class
  // artifacts alongside FRD. Both greenfield (author from scratch) and
  // brownfield (read existing, polish or reconcile) flows mirror FRD.
  'trd-author',           // greenfield Technical Requirements Document
  'trd-polish',           // surgical fixes to advance TRD round
  'trd-reconcile',        // TRD vs shipped-impl drift reconciliation
  'sprint-plan-author',   // greenfield Sprint Plan (Sprint A..N with goals + done-when)
  'sprint-plan-polish',   // sprint plan revision as scope evolves
  'sprint-plan-reconcile',// Sprint Plan vs actual delivery progress drift
  'code-sprint',          // implementation work (TS/Rust/SQL)
  'test-coverage',        // add tests for untested module
  'audit-log-route',      // BCBS 239 mutation-route audit (Sprint AA-N pattern)
  'platform-doc',         // NBF-* platform doc authoring
  'next-session-refresh', // handoff doc maintenance
  // v0.5.0 Pillar 5 — UI/UX types. Per Codex: "for type=ui-*, UI/UX should be
  // opinionated default, not opt-in. Once the task declares UI type, minimum
  // UX gates should be forced unless explicitly waived with audit reason."
  'ui-component',         // single component in a design system
  'dashboard-page',       // data-driven page in an app
]);
export type TaskType = z.infer<typeof TaskType>;

export const TaskState = z.enum([
  'unplanned',
  'planned',
  'claimed',
  'in-progress',
  'awaiting-review',
  'claims-verified',          // NEW v0.4.1: pre-Codex grep-verify gate passed
  'codex-reviewing',
  'promotable',
  'needs-revision',
  'awaiting-human-approval',  // NEW v0.4.1: dual-control gate per Codex Part C C4
  'ready-for-merge',          // NEW v0.4.1: Codex GO + push + PR ready (was overloaded into 'merged')
  'merged',                   // NEW v0.4.1 narrow meaning: actual merge to main happened
  'abandoned',
]);
export type TaskState = z.infer<typeof TaskState>;

export const ConsensusVerdict = z.enum(['GO', 'NO-GO', 'SIGNOFF-READY', 'pending']);
export type ConsensusVerdict = z.infer<typeof ConsensusVerdict>;

/**
 * v0.5.1 (Codex review 2026-04-29 alignment): JobMode declares whether the
 * task is operating on an existing repo (brownfield, the default), scaffolding
 * a new project (greenfield), or extending a brownfield repo with a greenfield
 * sub-tree (hybrid). Default 'brownfield' preserves all existing TaskPack literals.
 */
export const JobMode = z.enum(['greenfield', 'brownfield', 'hybrid']);
export type JobMode = z.infer<typeof JobMode>;

/**
 * v0.5.1 (Codex MF-08): risk_class drives default merge policy and HITL gating.
 *   - low: docs/comments/dev-only tooling
 *   - medium: app code outside finance/auth (default)
 *   - high: schemas/infra/deps/secrets/public APIs (manual approval)
 *   - critical: balance-sheet/credit-loss/capital/liquidity/funding/profitability/regulatory
 */
export const RiskClass = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskClass = z.infer<typeof RiskClass>;

// ─── Sub-schemas ────────────────────────────────────────────────────────────

export const ContextBudget = z.object({
  /** Max size of the task pack JSON itself (KB). Default 8 KB. */
  max_task_pack_kb: z.number().int().positive().default(8),
  /** Max size of log summaries that go INTO prompts (KB). Default 4 KB. */
  max_log_summary_kb: z.number().int().positive().default(4),
  /** Max size of the Codex review bundle (KB). Default 32 KB. */
  max_codex_bundle_kb: z.number().int().positive().default(32),
  /**
   * v0.5.0 T4 (Codex bnl3rpgha): hard cost cap per task pack. When set,
   * `auto:forecast` refuses if p95 cost exceeds this. Default undefined =
   * no cap (operator opts in per pack).
   */
  max_cost_usd: z.number().nonnegative().optional(),
});

export const References = z.object({
  /** Path to the FRD body (for frd-* task types). */
  frd_path: z.string().optional(),
  /** Repo code paths the task touches (for code-sprint, audit-log-route, test-coverage). */
  code_paths: z.array(z.string()).default([]),
  /** Obsidian companion file paths (GAP, CODEX-REVIEW, SIGNOFFS) for FRD tasks. */
  obsidian_paths: z.array(z.string()).default([]),
  /** Prior Codex output path (for revision rounds). */
  prior_codex_output: z.string().optional(),
});

export const Commands = z.object({
  /** Shell command to scan for existing functionality. Required for code-sprint, frd-author. */
  duplicate_scan: z.string().optional(),
  /** Optional implementation hints; usually worker decides. */
  implement: z.array(z.string()).default([]),
  /** Test commands. Each runs separately; outputs go to evidence dir. */
  test: z.array(z.string()).default([]),
  /** Typecheck command (e.g., "pnpm -F @nbf/web typecheck"). */
  typecheck: z.string().optional(),
  /** Lint command. */
  lint: z.string().optional(),
});

export const Consensus = z.object({
  reviewer: z.literal('codex-5.5-xhigh').default('codex-5.5-xhigh'),
  /** Path to the Codex prompt template (.txt file). */
  prompt_template: z.string(),
  /** Score threshold for GO. Default 7.0. SIGNOFF-READY requires 7.5+. */
  gate_threshold: z.number().min(0).max(10).default(7.0),
  /** Max revision rounds before human escalate. Default 2. */
  // Operator directive 2026-04-28: "maximum 10 rounds for consensus" — give
  // the auto-revise loop more budget before escalating to manual review.
  max_rounds: z.number().int().positive().default(10),
  /**
   * v0.5.0 Pillar 5: specialized reviewer agents invoked BEFORE codex consensus.
   * Each agent emits a ReviewerOutput into the UxEvidence bundle; codex sees
   * the bundle and treats blocking findings as gating per Codex review:
   * "Reviewer composition should stack, not vote, for v1. UX quality has
   * orthogonal failure domains. Use blocking severity per reviewer, not N-of-M
   * consensus. Codex remains the final arbiter of whether findings are valid
   * and release-blocking."
   *
   * Default empty. Templates set this for ui-component / dashboard-page types.
   */
  specialized_reviewers: z.array(z.enum([
    'a11y-auditor',           // tool-backed via axe + Playwright; runs WCAG 2.1 AA scan + classifies severity
    // v2 reviewers (declared but not implemented yet — keep enum closed to
    // catch typos in TaskPacks):
    'ui-design-reviewer',
    'interaction-test-author',
    'visual-regressor',
  ])).default([]),
});

/**
 * v0.5.0 (Pillar 4, Codex GO-with-modifications): UX validation policy.
 *
 * After worker exit and BEFORE consensus, when `ux_validation.enabled`, the
 * harness invokes Playwright against `preview_url` (or starts `server_command`
 * locally and waits for `server_ready_check` to return 200). Captures
 * screenshots + traces + console errors + network failures into the evidence
 * bundle. Three DETERMINISTIC gates:
 *   - blank-page: body must contain > MIN_BODY_CHARS visible text or a known
 *     root selector
 *   - console: any console message matching `console_gate.fail_on` (after
 *     `ignore_patterns` filter) fails the gate
 *   - network: any failed request (status ≥ 400, OR transport error) fails
 *     the gate when `network.fail_on_failed_requests` is true
 *
 * Codex flagged: Vision review with multimodal Claude is intentionally NOT
 * a hard gate in v1. Visual regression baseline (pixel diff) is stubbed in
 * the schema but not yet implemented (deferred per
 * `visual_regression.enabled: false` default). a11y + Lighthouse stubs are
 * NOT yet wired — `console_gate` + `network` is the v1 deterministic floor
 * (catches "blank production page" failure).
 *
 * For ux-tagged tasks: passing this gate becomes a REQUIRED auto-promote
 * predicate (joins state=promotable, opt-in, allowlist, score, consecutive
 * GO from auto_promote_policy).
 */
export const UxValidation = z.object({
  enabled: z.boolean().default(false),
  /** Operator-supplied preview URL (e.g. Vercel preview). Mutually exclusive
   *  with server_command — only one should be set. If both unset and enabled
   *  is true, the harness emits a `MissingPreviewURLError`. */
  preview_url: z.string().optional(),
  /** Alternative: a local-server start command (e.g. "pnpm dev --port 3000")
   *  the harness will spawn + wait on `server_ready_check` to return 200. */
  server_command: z.string().optional(),
  server_ready_check: z.object({
    url: z.string(),
    timeout_ms: z.number().int().positive().default(60000),
  }).optional(),
  /** Glob pages or full URLs to visit. Default ["/"] catches the home page. */
  pages_to_capture: z.array(z.string()).default(['/']),
  /** Optional Playwright .spec.ts file the harness invokes via `playwright test`
   *  for richer interaction assertions. If unset, the harness uses
   *  templates/ux-validate-default.spec.ts (visit pages, screenshot, blank
   *  check). Codex: "interaction script should be the primary artifact;
   *  screenshots are evidence." */
  interaction_script: z.string().optional(),
  /** Codex flagged mobile cannot be afterthought. Default ships desktop +
   *  mobile so responsive failures surface. */
  viewports: z.array(z.object({
    name: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })).default([
    { name: 'desktop', width: 1280, height: 800 },
    { name: 'mobile', width: 390, height: 844 },
  ]),
  browsers: z.array(z.enum(['chromium', 'firefox', 'webkit'])).default(['chromium']),
  /** Authenticated flows. Either provide a saved Playwright storage-state JSON
   *  OR a setup-script to run before the test (login flow). */
  auth: z.object({
    storage_state: z.string().optional(),
    setup_script: z.string().optional(),
  }).optional(),
  /** Console-error gate. Codex default: fail on errors only (warnings noisy). */
  console_gate: z.object({
    fail_on: z.array(z.enum(['error', 'warning'])).default(['error']),
    ignore_patterns: z.array(z.string()).default([]),
  }).default({ fail_on: ['error'], ignore_patterns: [] }),
  /** Network-failure gate. Codex flagged: many real-world failures only show
   *  in network panel (preview env vars missing, branch backends not deployed). */
  network: z.object({
    fail_on_failed_requests: z.boolean().default(true),
    /** Optional list of domain/path patterns to block (CSP test, ad blocker test). */
    block_patterns: z.array(z.string()).default([]),
    /** Optional list of patterns to IGNORE failures from (e.g. analytics 404s). */
    ignore_patterns: z.array(z.string()).default([]),
  }).default({ fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] }),
  /** Visual regression — schema-only stub; Codex deferred to v2. enabled=false
   *  default; setting true currently is a no-op until baseline workflow ships. */
  visual_regression: z.object({
    enabled: z.boolean().default(false),
    baseline_dir: z.string().optional(),
    max_diff_ratio: z.number().min(0).max(1).default(0.01),
  }).default({ enabled: false, max_diff_ratio: 0.01 }),
  /** Vision review — Codex demoted from hard gate to ADVISORY only. Output
   *  is a markdown file in evidence/; does NOT block consensus. v2 may add
   *  threshold-gated behavior once labeled outcomes inform calibration. */
  vision_review: z.object({
    enabled: z.boolean().default(false),
    /** Always advisory in v1. Codex: "Use it to produce structured findings
     *  and operator-readable review. Deterministic checks should carry the
     *  hard gate." */
    advisory_only: z.boolean().default(true),
  }).default({ enabled: false, advisory_only: true }),
});

/**
 * v0.5.0 T4 (Codex bnl3rpgha) — opt-in auto-LAND policy. STARTS DRY-RUN ONLY:
 * the harness emits an eligibility report ("would land / would not land")
 * over immutable evidence. Real merge action requires AUTO_AUTO_LAND_APPLY=1
 * AND policy.real_merge_enabled=true (both must agree). Default = both off.
 *
 * Codex prescription: "Auto-land should start narrower than your proposed
 * allowed types. I would begin with `platform-doc` and docs-only changes,
 * then add `frd-polish` after observed clean runs. Require branch target
 * to be non-protected and require generated revert metadata."
 */
export const AutoLandPolicy = z.object({
  /** OFF by default. Even when true, ships as eligibility report only unless
   *  real_merge_enabled is also true AND env opt-in is set. */
  enabled: z.boolean().default(false),
  /** Narrowest possible default: only platform-doc. Operator widens to
   *  frd-polish after observed clean runs (per Codex). NEVER add
   *  code-sprint/audit-log-route without N-of-M consensus first. */
  allowed_task_types: z.array(z.enum([
    'platform-doc',
    'frd-polish',
    'frd-author',
    'frd-reconcile',
    'next-session-refresh',
  ])).default(['platform-doc']),
  /** Score floor. Codex: "keep 8.0, but treat it as one guard among many." */
  min_score: z.number().min(0).max(10).default(8.0),
  /** Min consecutive GO rounds. */
  min_consecutive_go: z.number().int().positive().default(2),
  /** Branch patterns NEVER auto-mergeable. */
  protected_branches_excluded: z.array(z.string()).default(['main', 'master', 'release/*', 'production', 'prod']),
  /** Whether ANY merge is actually performed. False = dry-run only (default). */
  real_merge_enabled: z.boolean().default(false),
});

/**
 * v0.5.0 (Codex roadmap-review GO-with-modifications): opt-in auto-promotion policy.
 * DEFAULT IS DISABLED. Even when enabled, this only transitions
 *   promotable → ready-for-merge
 * (i.e., opens / marks-ready a PR). It NEVER auto-merges to protected branches —
 * that remains a human gate per OPERATOR-RUNBOOK.md.
 *
 * Activation requires THREE signals:
 *   1. `auto_promote_policy.enabled === true` on the task pack itself
 *   2. The task's `type` is in `auto_promote_policy.allowed_task_types`
 *   3. `auto:tick --auto-promote` (or `AUTO_AUTO_PROMOTE=1` env) explicitly opts in
 *      for this tick — protects the global flush/notify behavior of `auto:tick`
 *      from accidentally becoming a mutator.
 *
 * Conservative defaults: only `frd-polish` + `platform-doc` types, min score 7.5
 * (SIGNOFF-quality), 2 consecutive GO rounds (debounces single-round flukes).
 */
export const AutoPromotePolicy = z.object({
  /** OFF by default. Codex's roadmap review: "no side effects without policy context". */
  enabled: z.boolean().default(false),
  /**
   * Whitelist of task types eligible for auto-promote. Anything not on this list
   * remains operator-gated even with `enabled: true`. Codex flagged that
   * `code-sprint` and `audit-log-route` are governance-critical and must NOT
   * be added without N-of-M consensus first (a v2 feature).
   */
  allowed_task_types: z.array(z.enum([
    'frd-author',
    'frd-polish',
    'frd-reconcile',
    'platform-doc',
    'next-session-refresh',
  ])).default(['frd-polish', 'platform-doc']),
  /** Minimum codex score required. Defaults to 7.5 (SIGNOFF quality, above the 7.0 GO bar). */
  min_score: z.number().min(0).max(10).default(7.5),
  /**
   * Minimum consecutive rounds with score ≥ min_score. Default 2 — debounces
   * single-round flukes (e.g., codex flips on cosmetic findings between rounds).
   */
  min_consecutive_go: z.number().int().positive().default(2),
});

export const StateTransition = z.object({
  from: TaskState,
  to: TaskState,
  at: z.string(), // ISO 8601
  by: z.string(), // user_id or "orchestrator"
  reason: z.string().optional(),
});

export const Worker = z.object({
  // v0.4.3 (Codex C5): expanded to represent every engine the harness dispatches.
  // Without this, all non-manual workers were recorded as 'claude-code', which
  // destroyed provenance (BP3) at the schema level.
  type: z.enum([
    'claude-code',         // legacy alias for claude-code-cli (kept for back-compat)
    'claude-code-cli',     // headless `claude --print`
    'claude-agent-sdk',    // @anthropic-ai/sdk tool-use loop
    'codex-cli',           // codex exec
    'subagent',            // sub-agent dispatched by main session
    'manual',              // human operator
  ]),
  worktree_path: z.string().optional(),
  branch_name: z.string().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  /** v0.4.3: PID of the dispatched worker process (for mid-run liveness checks). */
  pid: z.number().int().optional(),
});

/**
 * v0.4.3: Cost telemetry per dispatch round. Appended each time auto:work runs.
 * Persisted to enable budget guards + cross-task aggregation.
 *
 * Phase 1 (BP3 provenance + PUB-10 model inventory): added model_id,
 * model_version, temperature, system_prompt_hash, tool_versions for full
 * per-dispatch reproducibility. Codex SOTA-bar ranked provenance as the #1
 * publication-blocking gap. These fields constitute the SLSA-L1 baseline
 * (SLSA-L2/L3 require signed attestation; deferred to Phase 2).
 */
export const CostTelemetry = z.object({
  round: z.number().int().nonnegative(),
  engine: z.string(),
  duration_ms: z.number().int().nonnegative(),
  exit_code: z.number().int().nullable(),
  /** Bytes of stdout from the worker (proxy for token cost when actuals unavailable). */
  output_bytes: z.number().int().nonnegative(),
  /** Estimated USD cost if engine reports it (claude-agent-sdk only for v0.4.3). */
  est_usd: z.number().nonnegative().optional(),
  at: z.string(),
  /** Phase 1 (BP3): model identifier (e.g., 'claude-opus-4-7', 'gpt-5.5' xhigh). */
  model_id: z.string().optional(),
  /** Phase 1 (BP3): model version/release tag if known (e.g., '20251001'). */
  model_version: z.string().optional(),
  /** Phase 1 (BP3): temperature setting at dispatch time (NaN = engine default). */
  temperature: z.number().optional(),
  /** Phase 1 (BP3): SHA-256 hash of the system prompt + worker prompt for replay verification. */
  prompt_hash: z.string().optional(),
  /** Phase 1 (BP3): pinned tool versions visible to worker (Node, pnpm, git, codex bin). */
  tool_versions: z.record(z.string(), z.string()).optional(),
  /** Phase 1 (BP3): hostname + boot time for cross-runner provenance. */
  host: z.string().optional(),
});
export type CostTelemetry = z.infer<typeof CostTelemetry>;

/**
 * v0.4.3 (Codex C3): Single-writer lock for a task. Acquired at auto:work
 * start; renewed via heartbeat; released on completion. The TaskLock in-pack
 * record is the *advisory* layer (visible in dashboard); the *authoritative*
 * concurrency primitive is a sibling .lock file with OS flock (Codex C1)
 * acquired in runState.ts before any read-modify-write to the pack.
 *
 * `expires_at` replaces the old fixed-TTL semantics so long-running workers
 * can heartbeat-renew (Codex C3); a worker still alive at `expires_at` must
 * renew via `renewTaskLock()` or it is considered abandoned and the lock is
 * stealable.
 */
export const TaskLock = z.object({
  holder: z.string(),               // "auto-worker-claude-code-cli pid 12345"
  acquired_at: z.string(),          // ISO 8601
  expires_at: z.string(),           // ISO 8601 — past = stealable
  last_heartbeat_at: z.string(),    // ISO 8601 — renewed periodically
  pid: z.number().int(),
  /**
   * v0.4.3 (Codex end-to-end consensus + LRA Phase 1): host identity for
   * cross-runner liveness checks. `kill -0 <pid>` is meaningless across
   * machines — Phase 1 cron/multi-runner orchestrators MUST verify
   * host before treating a lock as steal-able.
   * Today (Phase 0 single-host): defaults to local hostname; consumers
   * can ignore. Phase 1 will enforce host == current_host before
   * pid-liveness checks and add boot_time to detect host reboot.
   */
  host: z.string().optional(),
  /** Boot time of the host that owns the lock; rebooted host invalidates lock. */
  host_boot_time: z.string().optional(),
});

/**
 * Per-round Codex score record — drives plateau detection in the decision
 * rubric. Operator directive 2026-04-28: "do not waste time on the blocker
 * vs you could have finished the task." TP-101 R1=6.4 → R2=6.6 → R3=6.2 →
 * R4=6.6 was a plateau the rubric should have caught instead of
 * mechanically dispatching R5..R10.
 */
export const CodexRoundScore = z.object({
  round: z.number().int().positive(),
  score: z.number().min(0).max(10).optional(),
  verdict: ConsensusVerdict,
  at: z.string(),
  /** Optional path to the review file for this round (verdict_path snapshot). */
  verdict_path: z.string().optional(),
});
export type CodexRoundScore = z.infer<typeof CodexRoundScore>;

export const CodexResult = z.object({
  bundle_path: z.string().optional(),
  verdict_path: z.string().optional(),
  score: z.number().min(0).max(10).optional(),
  verdict: ConsensusVerdict.default('pending'),
  rounds_executed: z.number().int().nonnegative().default(0),
  /**
   * v0.4.4: per-round score history for plateau detection. Backward-compat:
   * optional + defaults to []. Old packs without history fall back to
   * round-count-only escalation.
   */
  score_history: z.array(CodexRoundScore).default([]),
});

// ─── Top-level TaskPack ─────────────────────────────────────────────────────

export const TaskPack = z.object({
  /**
   * v0.4.3 (BP17 fix per Codex end-to-end consensus): explicit schema version
   * for forward-compatible migration. v1 = current additive-only schema.
   * Increment + write a migration when fields are removed or restructured.
   */
  schema_version: z.literal('1').default('1'),
  /** "TP-YYYY-MM-DD-NNN" — globally unique task ID. */
  task_id: z.string().regex(/^TP-\d{4}-\d{2}-\d{2}-\d{3,}$/),
  /** Parent run ID (e.g., "2026-04-26-frd-batch-1"). */
  run_id: z.string(),
  type: TaskType,
  /** "M02-v0.8" | "Sprint-AA-2" | "NBF-ARCH-DIM-001" | etc. */
  module_or_sprint: z.string(),
  /** Version label this task targets ("v0.8", "round-2-of-N", etc.). */
  version_target: z.string(),
  /** v0.5.1 — JobSpec.mode: greenfield/brownfield/hybrid. Default 'brownfield'. */
  mode: JobMode.default('brownfield'),
  /** v0.5.1 (Codex MF-08) — risk class drives default merge policy + HITL gating. */
  risk_class: RiskClass.default('medium'),
  /**
   * v0.2 — specialized worker role. Narrows the worker's prompt to a
   * specific intent. Pre-fab templates ship in templates/prompts/; planner
   * can load one via --template flag. Skill memory is partitioned by
   * (type, role) so reflection patterns are role-specific.
   */
  role: z.enum([
    'generic',
    'bug-fix',
    'feature-add',
    'refactor',
    'test-coverage',
    'dep-upgrade',
    'security-fix',
    'perf-fix',
    'doc-update',
    'migration',
    'e2e-test',
  ]).default('generic'),
  /** ≤ 500 chars; what success looks like, no fluff. */
  objective: z.string().max(500),
  /**
   * ≤ 10 items; each must be testable (not vague).
   *
   * Sprint J — accepts both legacy (string) and bucketed-object form:
   *   - 'deterministic'         → post-flight enforces (regex / fs / token presence)
   *   - 'semantic-objective'    → council judges; can hard-gate
   *   - 'semantic-subjective'   → council provides advice only; never gates
   * Default for back-compat (string-form): 'deterministic'.
   */
  acceptance_criteria: z.array(
    z.union([
      z.string(),
      z.object({
        text: z.string(),
        bucket: z.enum(['deterministic', 'semantic-objective', 'semantic-subjective']).default('deterministic'),
      }),
    ])
  ).max(10),
  /** Glob patterns; worker MUST NOT edit outside these paths. */
  allowed_paths: z.array(z.string()),
  /** Glob patterns; never touch (e.g., NEXT-SESSION.md, ROADMAP.md per single-writer rule). */
  forbidden_paths: z.array(z.string()).default([
    'NEXT-SESSION.md',
    'ROADMAP.md',
    './ROADMAP.md',
  ]),
  context_budget: ContextBudget,
  references: References,
  commands: Commands,
  consensus: Consensus,
  /**
   * v0.5.0 T4: opt-in auto-LAND policy. Default disabled + dry-run only.
   * Codex prescribed: ships as eligibility report; real merge requires both
   * policy.real_merge_enabled=true AND env AUTO_AUTO_LAND_APPLY=1.
   */
  auto_land_policy: AutoLandPolicy.default({
    enabled: false,
    allowed_task_types: ['platform-doc'],
    min_score: 8.0,
    min_consecutive_go: 2,
    protected_branches_excluded: ['main', 'master', 'release/*', 'production', 'prod'],
    real_merge_enabled: false,
  }),
  /**
   * v0.5.0: opt-in auto-promote policy. Defaults to disabled object so legacy
   * task packs continue to require operator-gated promote.
   */
  auto_promote_policy: AutoPromotePolicy.default({
    enabled: false,
    allowed_task_types: ['frd-polish', 'platform-doc'],
    min_score: 7.5,
    min_consecutive_go: 2,
  }),
  /**
   * v0.5.0 Pillar 5: required skills attached to this TaskPack.
   *
   * Per Codex: "required_skills belongs on the TaskPack, not on engine. Engine
   * should describe execution substrate. Skills describe task intent and
   * implementation constraints. TaskPack-level composition scales better."
   *
   * Worker dispatcher reads this list, loads each skill's SKILL.md, prepends
   * the skill body to the worker's system message, and records the skill set
   * + content hashes in evidence. Skills must be EXECUTABLE POLICY (read repo
   * artifacts at runtime + emit evidence), NOT inspirational prompt text.
   *
   * Default empty. Templates set this for ui-component / dashboard-page types.
   */
  required_skills: z.array(z.enum([
    'design-system-aware',         // reads design-system tokens.json + components index, emits hashes
    'wcag-compliant-responsive',   // injects WCAG 2.1 AA + responsive criteria + motion-reduced behavior
    // v2 skills declared but not yet implemented:
    'security-aware',
    'i18n-aware',
    'performance-aware',
  ])).default([]),
  /** v0.5.0 Pillar 4: UX validation policy. Default disabled — backend tasks
   *  pay zero cost. UX-tagged tasks set enabled=true + populate preview_url. */
  ux_validation: UxValidation.default({
    enabled: false,
    pages_to_capture: ['/'],
    viewports: [
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    browsers: ['chromium'],
    console_gate: { fail_on: ['error'], ignore_patterns: [] },
    network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] },
    visual_regression: { enabled: false, max_diff_ratio: 0.01 },
    vision_review: { enabled: false, advisory_only: true },
  }),
  state: TaskState.default('planned'),
  state_history: z.array(StateTransition).default([]),
  /** Path under .agent-runs/<run_id>/evidence/<task_id>/. */
  evidence_dir: z.string(),
  worker: Worker.optional(),
  codex: CodexResult.optional(),
  /**
   * Sprint J — forward-pass deterministic acceptance. Set by post-flight when
   * lint/tests/audit pass after at most one surgical patch round. If unset
   * after the patch budget is exhausted, the module is parked.
   */
  artifact_acceptance: z.object({
    accepted_by_postflight: z.boolean(),
    accepted_at: z.string(),
    postflight_summary: z.object({
      sections_ok: z.boolean(),
      citations_ok: z.boolean(),
      ac_coverage_ok: z.boolean(),
      frontmatter_ok: z.boolean(),
      reciprocity_ok: z.boolean(),
      patches_applied: z.number().int().min(0).max(1),
      failures: z.array(z.object({
        check: z.string(),
        detail: z.string(),
      })).default([]),
    }),
  }).optional(),
  /**
   * v0.4.3: Dependency edges. auto:work refuses to dispatch unless every
   * dep is in {merged, ready-for-merge}. plan() emits these from sprint
   * metadata (e.g., M02-impl-2 depends on M02-impl-1).
   */
  depends_on: z.array(z.string()).default([]),
  /**
   * v0.4.3: SHA of origin/main at dispatch time. Pinned by auto:work after
   * `git fetch origin main`. auto:land uses it to detect drift (if origin/main
   * has moved past base_sha, it must rebase the worker's diff before pushing).
   */
  base_sha: z.string().optional(),
  /** v0.4.3: Single-writer lock; null when no dispatch in flight. */
  lock: TaskLock.nullable().default(null),
  /** v0.4.3: Append-only cost telemetry, one entry per dispatch round. */
  cost_telemetry: z.array(CostTelemetry).default([]),
  /**
   * PUB-8 (Phase 1 governance): segregation-of-duties identity capture.
   * Records principal who created the task pack (auto:work claimant), each
   * principal who reviewed (auto:consensus dispatcher per round), and each
   * principal who approved (auto:land/auto:promote runner). Used by
   * enforceSoD() in src/lib/sod.ts to refuse same-principal review/approve
   * transitions per SOX/generic-model-governance. Default = empty (legacy task packs work
   * unchanged; SoD enforcement only kicks in once identities are captured).
   */
  actors: Actors.default({ creator: undefined, reviewers: [], approvers: [] }),
  /** Human-readable notes for handoff/escalation. Append-only. */
  notes: z.array(z.object({ at: z.string(), by: z.string(), text: z.string() })).default([]),
  /**
   * Sprint J — council output recorded as feedback for the operator memo,
   * NOT as an auto-promote gate. Stage 25 validation memo surfaces this to
   * the operator. Distinct from pack.codex (legacy reviewer-mode result) so
   * the audit trail records both shapes when transitioning between modes.
   */
  council_feedback: z.object({
    score: z.number().min(0).max(10),
    decision: z.enum(['accept', 'revise_and_rejudge', 'regenerate_and_rejudge', 'reject_fail_closed']),
    hard_gates: z.array(z.string()).default([]),
    rubric_version: z.string(),
    evidence_path: z.string(),
    advisory: z.literal(true),
    recorded_at: z.string(),
  }).optional(),
});
export type TaskPack = z.infer<typeof TaskPack>;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Compute the next task_id for a given run + date.
 * Format: TP-YYYY-MM-DD-NNN where NNN is zero-padded sequence within the day.
 */
export function nextTaskId(date: Date, sequenceWithinDay: number): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const nnn = String(sequenceWithinDay).padStart(3, '0');
  return `TP-${yyyy}-${mm}-${dd}-${nnn}`;
}

/**
 * Validate a TaskPack JSON object against the schema. Throws ZodError if invalid.
 */
export function parseTaskPack(json: unknown): TaskPack {
  return TaskPack.parse(json);
}

/**
 * Check that a TaskPack JSON serializes within the configured size budget.
 * Returns null if OK; returns an error message string if oversized.
 */
export function checkSizeBudget(pack: TaskPack): string | null {
  const json = JSON.stringify(pack);
  const sizeKb = Buffer.byteLength(json, 'utf8') / 1024;
  if (sizeKb > pack.context_budget.max_task_pack_kb) {
    return `Task pack exceeds size budget: ${sizeKb.toFixed(2)} KB > ${pack.context_budget.max_task_pack_kb} KB. Trim objective/AC/references.`;
  }
  return null;
}

/**
 * Append a state transition to the task pack history. Mutates the pack.
 * Caller must persist after.
 */
export function appendStateTransition(
  pack: TaskPack,
  to: TaskState,
  by: string,
  reason?: string
): TaskPack {
  const transition = {
    from: pack.state,
    to,
    at: new Date().toISOString(),
    by,
    reason,
  };
  pack.state_history.push(transition);
  pack.state = to;
  return pack;
}

// ─── v0.4.3: Industrial-scale guards ────────────────────────────────────────

/**
 * States that mean the task is shipped (or queued to ship). auto:work refuses
 * to re-dispatch on these unless --force is passed. This prevents the
 * accidental re-run that flipped TP-101 from awaiting-review to needs-revision
 * after PR #33 had already merged (Sprint H1 / G4).
 */
export const SHIPPED_STATES: ReadonlyArray<TaskState> = [
  'awaiting-review',
  'claims-verified',
  'codex-reviewing',
  'promotable',
  'awaiting-human-approval',
  'ready-for-merge',
  'merged',
];

/**
 * States that allow `auto:work` to start a fresh round.
 */
export const DISPATCHABLE_STATES: ReadonlyArray<TaskState> = [
  'planned',
  'claimed',
  'needs-revision',
];

export interface ReDispatchGuardOptions {
  force?: boolean;
}

export interface ReDispatchGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * G4 — refuse to dispatch on a task whose work is already shipped/queued.
 * Returns ok=true when state allows dispatch (or --force was passed).
 */
export function checkReDispatchAllowed(
  pack: TaskPack,
  options: ReDispatchGuardOptions = {}
): ReDispatchGuardResult {
  if (options.force) return { ok: true };
  if (DISPATCHABLE_STATES.includes(pack.state)) return { ok: true };
  if (SHIPPED_STATES.includes(pack.state)) {
    return {
      ok: false,
      reason:
        `Task ${pack.task_id} is in shipped/queued state '${pack.state}'. ` +
        `Re-running auto:work would corrupt the state machine. ` +
        `Pass --force only if you intentionally want to start a new round.`,
    };
  }
  if (pack.state === 'in-progress') {
    return {
      ok: false,
      reason:
        `Task ${pack.task_id} is already in-progress. Check pack.lock for active dispatch. ` +
        `Pass --force only if you've verified no other auto:work is running on this task.`,
    };
  }
  if (pack.state === 'abandoned') {
    return {
      ok: false,
      reason: `Task ${pack.task_id} was abandoned. Use auto:revise to revise scope before re-dispatching.`,
    };
  }
  return { ok: true };
}

/**
 * G1 — verify every dependency is in a "merged-or-equivalent" terminal state
 * before allowing dispatch of this task. Returns ok=true when all deps are
 * resolved.
 */
export interface DependencyCheckResult {
  ok: boolean;
  unresolved: Array<{ task_id: string; state?: TaskState; reason: string }>;
}

export function checkDependenciesResolved(
  pack: TaskPack,
  packLookup: (taskId: string) => TaskPack | null
): DependencyCheckResult {
  const unresolved: DependencyCheckResult['unresolved'] = [];
  for (const depId of pack.depends_on) {
    const dep = packLookup(depId);
    if (!dep) {
      unresolved.push({ task_id: depId, reason: `dependency task pack not found in run` });
      continue;
    }
    if (dep.state !== 'merged' && dep.state !== 'ready-for-merge') {
      unresolved.push({
        task_id: depId,
        state: dep.state,
        reason: `dependency state is '${dep.state}'; required: merged | ready-for-merge`,
      });
    }
  }
  return { ok: unresolved.length === 0, unresolved };
}

/**
 * G5 (revised per Codex C3) — acquire single-writer lock on a task pack.
 * Uses expires_at (not fixed TTL) so heartbeat-renewing workers don't get
 * stolen mid-run. Caller is responsible for OS-level flock (Codex C1) on
 * the sibling .lock file BEFORE this in-memory mutate; without flock, this
 * is purely advisory.
 *
 * Default lease: 90 minutes (covers the 60-min worker timeout in
 * dispatchClaudeCodeCli + 30-min buffer for pre/post-dispatch work). Workers
 * SHOULD renew via renewTaskLock() periodically; healthy long workers won't
 * be stolen. PID liveness is advisory-only (Codex C3); use the lease as the
 * source of truth.
 *
 * R2 fix: bumped from 10min → 90min so a 61-min healthy run isn't stolen
 * before it can complete. Heartbeat from inside the worker dispatch loop
 * is deferred to H2 (requires switching from spawnSync to spawn + Polling).
 */
export function acquireTaskLock(
  pack: TaskPack,
  holder: string,
  pid: number,
  leaseMinutes = 90
): { ok: boolean; reason?: string } {
  const now = new Date();
  if (pack.lock) {
    const expiresAt = new Date(pack.lock.expires_at);
    if (expiresAt > now) {
      const remainingMin = (expiresAt.getTime() - now.getTime()) / 60000;
      return {
        ok: false,
        reason:
          `Task ${pack.task_id} is locked by ${pack.lock.holder} (pid ${pack.lock.pid}, ` +
          `lease expires in ${remainingMin.toFixed(1)}min at ${pack.lock.expires_at}). ` +
          `Either wait, or pass --steal-lock if you've verified the holder is dead.`,
      };
    }
    // expired lock — stealable
  }
  const expiresAt = new Date(now.getTime() + leaseMinutes * 60_000);
  // Codex R2: actually populate host + host_boot_time fields (schema had them;
  // implementation didn't write them). Required for cross-runner liveness.
  let host: string | undefined;
  let host_boot_time: string | undefined;
  try {
    host = os.hostname();
    // host_boot_time = uptime expressed as boot epoch
    const uptimeSec = os.uptime();
    host_boot_time = new Date(now.getTime() - uptimeSec * 1000).toISOString();
  } catch {
    /* best-effort */
  }
  pack.lock = {
    holder,
    acquired_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    last_heartbeat_at: now.toISOString(),
    pid,
    host,
    host_boot_time,
  };
  return { ok: true };
}

/**
 * G5 — heartbeat-renew the lease. Call periodically (e.g., every 60s) from
 * a long-running worker. Resets expires_at to now + leaseMinutes. Default
 * matches acquireTaskLock (90min) so renewal extends by the same amount.
 */
export function renewTaskLock(pack: TaskPack, leaseMinutes = 90): { ok: boolean; reason?: string } {
  if (!pack.lock) return { ok: false, reason: 'no lock to renew' };
  const now = new Date();
  pack.lock.last_heartbeat_at = now.toISOString();
  pack.lock.expires_at = new Date(now.getTime() + leaseMinutes * 60_000).toISOString();
  return { ok: true };
}

/**
 * G5 — release lock when dispatch completes.
 */
export function releaseTaskLock(pack: TaskPack): void {
  pack.lock = null;
}

// ─── v0.4.3 (operator directive 2026-04-27): Path overlap detection ──────
// "modules do not overlap and agents working on the same files at the same time"
//
// In addition to depends_on (sequencing) and TaskLock (per-task single-writer),
// this catches the case where TWO different tasks declare allowed_paths that
// intersect. If both run concurrently, they will produce conflicting diffs.
// Detect at dispatch time and refuse unless --force-overlap.

/**
 * Returns true if globs `a` and `b` could both match at least one common path.
 * Conservative — uses prefix overlap because most allowed_paths today are
 * directory globs like "platform/pipeline/**". Two globs overlap iff one's
 * path-prefix is a prefix of the other's (treating `**` and `*` as wildcards
 * that match anything).
 */
function globsOverlap(a: string, b: string): boolean {
  // Normalize: strip trailing /** or /* to a directory prefix for prefix match.
  const norm = (g: string) => g.replace(/\/\*\*\*?$/, '').replace(/\/\*$/, '').replace(/\/$/, '');
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  // If one is a prefix of the other (with a path separator or end), they overlap.
  if (na.length === 0 || nb.length === 0) return true; // empty glob = match-all
  return (
    na === nb ||
    na.startsWith(nb + '/') ||
    nb.startsWith(na + '/')
  );
}

/**
 * Find tasks currently in-progress (or with active lock) whose allowed_paths
 * overlap with the candidate task's. Returns empty array if safe to dispatch.
 *
 * `inFlightLookup` returns a list of task packs that are NOT this pack and
 * are in a state that could be writing files. Caller iterates the run's
 * tasks and excludes the candidate.
 */
export interface PathOverlapResult {
  ok: boolean;
  overlaps: Array<{
    other_task_id: string;
    other_state: TaskState;
    overlapping_paths: Array<{ ours: string; theirs: string }>;
  }>;
}

export function checkPathOverlapAgainstInFlight(
  candidate: TaskPack,
  inFlight: TaskPack[]
): PathOverlapResult {
  const overlaps: PathOverlapResult['overlaps'] = [];
  for (const other of inFlight) {
    if (other.task_id === candidate.task_id) continue;
    // Only consider tasks that are actively writing or queued to land.
    const ACTIVE_STATES: ReadonlyArray<TaskState> = [
      'in-progress',
      'awaiting-review',
      'claims-verified',
      'codex-reviewing',
      'promotable',
      'ready-for-merge',
    ];
    if (!ACTIVE_STATES.includes(other.state)) continue;
    const matches: Array<{ ours: string; theirs: string }> = [];
    for (const ours of candidate.allowed_paths) {
      for (const theirs of other.allowed_paths) {
        if (globsOverlap(ours, theirs)) {
          matches.push({ ours, theirs });
        }
      }
    }
    if (matches.length > 0) {
      overlaps.push({
        other_task_id: other.task_id,
        other_state: other.state,
        overlapping_paths: matches,
      });
    }
  }
  return { ok: overlaps.length === 0, overlaps };
}

// ─── v0.4.3 (Codex C4): Cycle + self-dependency detection ─────────────────

/**
 * Detects cycles and self-dependencies in the task DAG before allowing
 * dispatch. Walks the dependency graph from the given pack, returning the
 * cycle path if found.
 */
export function detectDependencyCycle(
  pack: TaskPack,
  packLookup: (taskId: string) => TaskPack | null
): { hasCycle: boolean; path?: string[]; reason?: string } {
  // Self-dep check (a task depends on itself)
  if (pack.depends_on.includes(pack.task_id)) {
    return {
      hasCycle: true,
      path: [pack.task_id, pack.task_id],
      reason: `Self-dependency: ${pack.task_id} depends on itself`,
    };
  }

  // DFS from this pack, tracking visit state (white/gray/black)
  const VISITING = 'visiting';
  const VISITED = 'visited';
  const state = new Map<string, typeof VISITING | typeof VISITED>();
  const stack: string[] = [];

  function visit(taskId: string): { cycle: boolean; path?: string[] } {
    const s = state.get(taskId);
    if (s === VISITED) return { cycle: false };
    if (s === VISITING) {
      const cycleStart = stack.indexOf(taskId);
      return { cycle: true, path: stack.slice(cycleStart).concat(taskId) };
    }
    const p = taskId === pack.task_id ? pack : packLookup(taskId);
    if (!p) {
      // Unknown task — treated as a leaf (no further deps to walk).
      // The dependency-resolution check will catch the missing pack.
      state.set(taskId, VISITED);
      return { cycle: false };
    }
    state.set(taskId, VISITING);
    stack.push(taskId);
    for (const dep of p.depends_on) {
      const r = visit(dep);
      if (r.cycle) return r;
    }
    stack.pop();
    state.set(taskId, VISITED);
    return { cycle: false };
  }

  const r = visit(pack.task_id);
  if (r.cycle) {
    return {
      hasCycle: true,
      path: r.path,
      reason: `Dependency cycle detected: ${(r.path ?? []).join(' → ')}`,
    };
  }
  return { hasCycle: false };
}

// ─── v0.4.3: Kill switch ────────────────────────────────────────────────────

/**
 * Kill switch — operator-controlled global halt for ALL auto:work / auto:land /
 * auto:merge dispatches. Triggered by either:
 *   - Existence of `.agent-runs/_KILL_SWITCH` file (preferred — survives reboots)
 *   - AUTO_HARNESS_KILL=1 env var (preferred — quick local override)
 *
 * When active, every CLI that would dispatch a worker, push to a remote, or open
 * a PR REFUSES with exit code 99. Read-only commands (auto:tick, auto:status,
 * auto:dashboard, auto:resume-session, auto:awareness) continue to work for
 * observability. This satisfies operator directive: "kill switch enabled"
 * (Sprint H1, 2026-04-27).
 */

export interface KillSwitchResult {
  active: boolean;
  reason?: string;
}

export function checkKillSwitch(repoRoot: string): KillSwitchResult {
  if (process.env.AUTO_HARNESS_KILL === '1') {
    return { active: true, reason: 'AUTO_HARNESS_KILL=1 env var is set' };
  }
  const killFile = path.join(repoRoot, '.agent-runs', '_KILL_SWITCH');
  if (fs.existsSync(killFile)) {
    let body = '';
    try { body = fs.readFileSync(killFile, 'utf8').trim(); } catch { /* ignore */ }
    return {
      active: true,
      reason: `kill-switch file present: ${killFile}${body ? ` — ${body.slice(0, 200)}` : ''}`,
    };
  }
  return { active: false };
}

/**
 * Convenience: throw if kill switch is active. For use at top of any
 * dispatching CLI (auto:work, auto:land, auto:merge). Exit code 99 is reserved
 * for kill-switch refusals (so operators can grep logs for "exit 99").
 */
export function refuseIfKillSwitchActive(repoRoot: string): void {
  const k = checkKillSwitch(repoRoot);
  if (k.active) {
    console.error(`[kill-switch] HALTED: ${k.reason}`);
    console.error(`Remove the kill switch (delete .agent-runs/_KILL_SWITCH or unset AUTO_HARNESS_KILL) to resume.`);
    process.exit(99);
  }
}
