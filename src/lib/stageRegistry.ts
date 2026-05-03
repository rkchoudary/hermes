/**
 * Layer 0.A — Central stage registry.
 *
 * Doctrine: "Driver refuses to call any stage not in the registry. New
 * stage = registry entry + fixtures + tests, in one PR." This is the
 * mechanism that turns the gate-self-test contract into something that
 * stays non-trivial — the registry forces every stage to declare its
 * inputs, outputs, evidence contract, fixtures, and expected outcomes
 * before it can be invoked.
 *
 * The registry is the source of truth for:
 *   - L0   What stages exist + what their contracts are
 *   - L1   Cost estimates for budget reservation
 *   - L2   Self-test fixtures + negative controls
 *   - L3   Stage names in the fleet view
 *   - L4   Plateau detector knows what counts as "progress" per stage type
 *   - L7   DAG scheduler knows stage dependencies
 *
 * This file is the seed. Layer 0.B/C extends with replay fixtures.
 */

export type StagePermission =
  | 'read:intake' | 'write:intake-create' | 'write:intake-amend' | 'write:intake-approve'
  | 'priv:tier-1-intake-approve'
  | 'read:task-pack' | 'write:task-pack' | 'write:sdlc-transition'
  | 'read:validation-record' | 'write:validation-create' | 'write:validation-sign'
  | 'read:approval-request' | 'write:approval-request' | 'write:approval-sign'
  | 'read:evidence-graph' | 'read:audit-pack'
  | 'priv:override-control-bypass' | 'priv:kill-switch' | 'priv:production-toggle';

export type ExpectedOutcomeKind =
  | 'success' | 'gate-pass' | 'gate-fail'
  | 'precondition-fail' | 'policy-refusal' | 'budget-exceeded'
  | 'worker-error' | 'infrastructure-error' | 'harness-bug';

export interface StageRegistryEntry {
  /** Canonical CLI name (matches `pnpm` script). */
  stage: string;
  /** Path relative to package root. */
  cli_path: string;
  /** One-sentence purpose. */
  purpose: string;
  /** Inputs that must exist before this stage runs (TaskPack fields, files, env). */
  required_inputs: string[];
  /** Outputs the stage produces on success. */
  required_outputs: string[];
  /** Evidence files this stage MUST produce or consume. Used by L2 self-tests. */
  evidence_contract: string[];
  /** Permissions required from the operator's identity. */
  permissions: StagePermission[];
  /** Cost estimate per invocation. Used by L1 budget reservation. */
  cost_estimate: {
    /** 'gate' = no LLM; 'llm-light' = single short LLM call; 'llm-heavy' = multi-round LLM author. */
    profile: 'gate' | 'llm-light' | 'llm-medium' | 'llm-heavy' | 'subscription';
    /** P50/P95 token estimates (when applicable). */
    tokens_p50?: number;
    tokens_p95?: number;
    /** Wall-clock budget in seconds (driver should kill past this). */
    wall_clock_p95_sec: number;
  };
  /** Outcome kinds this stage is expected to emit. Anything else = harness-bug. */
  expected_outcomes: ExpectedOutcomeKind[];
  /** Driver actions this stage's `driver_action` field is allowed to suggest. */
  allowed_driver_actions: string[];
  /** Replay fixtures (path relative to __tests__/replay/). Layer 0.B fills in. */
  fixtures: string[];
  /** Negative-control fixtures (broken inputs → expect specific failure kind). */
  negative_controls: { fixture: string; expect_kind: ExpectedOutcomeKind }[];
  /** Stages that must complete before this one runs (DAG edges). */
  depends_on: string[];
  /** Whether this stage is task-bound (called per task) or run-bound (called per fanout). */
  scope: 'per-task' | 'per-module' | 'per-run' | 'per-fanout';
}

/**
 * The 12 driver-callable stages of the 28-stage SDLC pipeline. Stages NOT
 * in this list (e.g., diagnostic CLIs like `auto:status`, observability
 * CLIs like `auto:metrics`) are not driver-orchestrated — they are
 * operator-facing only and bypass the contract.
 *
 * Order roughly matches forward-pass execution. Cost wall_clock budgets
 * derived from observed p95 in serial-by-module.sh runs 2026-04-27 onward.
 */
export const STAGE_REGISTRY: ReadonlyArray<StageRegistryEntry> = [
  {
    stage: 'auto:intake',
    cli_path: 'src/cli/intake.ts',
    purpose: 'Stage 0 — register module + capture risk tier + collect role approvals',
    required_inputs: ['module_id', 'identity'],
    required_outputs: ['.agent-runs/intake/<module>.json'],
    evidence_contract: [],
    permissions: ['write:intake-create', 'write:intake-approve', 'priv:tier-1-intake-approve'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 5 },
    expected_outcomes: ['success', 'precondition-fail', 'policy-refusal'],
    allowed_driver_actions: ['advance', 'mark-gate-broken', 'pause-fanout'],
    fixtures: [],
    negative_controls: [],
    depends_on: [],
    scope: 'per-module',
  },
  {
    stage: 'auto:plan',
    cli_path: 'src/cli/plan.ts',
    purpose: 'Phase 1–4 — generate task pack from FRD + module config',
    required_inputs: ['module_id', 'version', 'type', 'intake.status=approved', 'frd_path'],
    required_outputs: ['.agent-runs/<run>/tasks/<task_id>.json'],
    evidence_contract: [],
    permissions: ['read:intake', 'write:task-pack'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 10 },
    expected_outcomes: ['success', 'precondition-fail', 'policy-refusal'],
    allowed_driver_actions: ['advance', 'mark-gate-broken', 'pause-fanout'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:intake'],
    scope: 'per-task',
  },
  {
    stage: 'auto:work',
    cli_path: 'src/cli/work.ts',
    purpose: 'Phase 4 — dispatch worker engine to author the artifact',
    required_inputs: ['task_pack', 'worktree', 'engine_on_path', 'base_sha'],
    required_outputs: ['evidence/<task>/diff.patch', 'evidence/<task>/test-summary.md', 'evidence/<task>/worker-handoff.json'],
    evidence_contract: ['diff.patch', 'test-summary.md', 'worker-handoff.json', 'risk-register.md', 'duplicate-scan.json'],
    permissions: ['read:task-pack', 'write:task-pack', 'write:sdlc-transition'],
    cost_estimate: { profile: 'llm-heavy', tokens_p50: 80_000, tokens_p95: 250_000, wall_clock_p95_sec: 1200 },
    expected_outcomes: ['success', 'worker-error', 'budget-exceeded', 'infrastructure-error', 'precondition-fail'],
    allowed_driver_actions: ['advance', 'patch-round', 'park', 'requeue', 'pause-fanout'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:plan'],
    scope: 'per-task',
  },
  {
    stage: 'auto:postflight',
    cli_path: 'src/cli/postflight.ts',
    purpose: 'Deterministic acceptance gate — run after worker',
    required_inputs: ['task_pack', 'evidence_dir'],
    required_outputs: ['pack.artifact_acceptance.postflight_summary'],
    evidence_contract: ['worker-handoff.json', 'diff.patch', 'test-summary.md'],
    permissions: ['read:task-pack', 'write:task-pack'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 30 },
    expected_outcomes: ['gate-pass', 'gate-fail', 'precondition-fail'],
    allowed_driver_actions: ['advance', 'patch-round', 'park', 'mark-gate-broken'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:work'],
    scope: 'per-task',
  },
  {
    stage: 'auto:diagnose',
    cli_path: 'src/cli/diagnose.ts',
    purpose: 'Cognitive recovery — produce _bug-review.json after repeated postflight fails',
    required_inputs: ['task_pack', 'evidence_dir', 'failed_rounds>=3'],
    required_outputs: ['evidence/<task>/_bug-review.json'],
    evidence_contract: ['_bug-review.json'],
    permissions: ['read:task-pack', 'write:task-pack'],
    cost_estimate: { profile: 'llm-medium', tokens_p50: 30_000, tokens_p95: 80_000, wall_clock_p95_sec: 300 },
    expected_outcomes: ['success', 'worker-error', 'budget-exceeded'],
    allowed_driver_actions: ['advance', 'park', 'requeue', 'pause-fanout'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:postflight'],
    scope: 'per-task',
  },
  {
    stage: 'auto:consensus',
    cli_path: 'src/cli/consensus.ts',
    purpose: 'Codex review for plan/duplicate-scan/completion gates',
    required_inputs: ['task_pack', 'evidence_dir', 'codex_bin_on_path'],
    required_outputs: ['pack.codex.{verdict,score,verdict_path}'],
    evidence_contract: ['codex-verdict.txt'],
    permissions: ['read:task-pack', 'write:task-pack'],
    cost_estimate: { profile: 'llm-medium', tokens_p50: 40_000, tokens_p95: 120_000, wall_clock_p95_sec: 600 },
    expected_outcomes: ['gate-pass', 'gate-fail', 'precondition-fail', 'infrastructure-error'],
    allowed_driver_actions: ['advance', 'patch-round', 'park', 'mark-gate-broken', 'requeue'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:postflight'],
    scope: 'per-task',
  },
  {
    stage: 'auto:promote',
    cli_path: 'src/cli/promote.ts',
    purpose: 'Transition pack from awaiting-review/promotable → ready-for-merge',
    required_inputs: ['task_pack.state=promotable', 'pack.codex.verdict=GO'],
    required_outputs: ['pack.state=ready-for-merge'],
    evidence_contract: [],
    permissions: ['read:task-pack', 'write:task-pack', 'write:sdlc-transition'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 5 },
    expected_outcomes: ['success', 'precondition-fail', 'policy-refusal'],
    allowed_driver_actions: ['advance', 'mark-gate-broken'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:postflight', 'auto:consensus'],
    scope: 'per-task',
  },
  {
    stage: 'auto:land',
    cli_path: 'src/cli/land.ts',
    purpose: 'Open PR with diff + evidence; transition pack → merged on success',
    required_inputs: ['task_pack.state=ready-for-merge', 'gh_authenticated', 'worktree_clean'],
    required_outputs: ['pack.pr_url', 'pack.state=merged'],
    evidence_contract: [],
    permissions: ['read:task-pack', 'write:task-pack', 'write:sdlc-transition'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 120 },
    expected_outcomes: ['success', 'precondition-fail', 'infrastructure-error'],
    allowed_driver_actions: ['advance', 'requeue', 'mark-gate-broken'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:promote'],
    scope: 'per-task',
  },
  {
    stage: 'auto:validation',
    cli_path: 'src/cli/validation.ts',
    purpose: 'Stage 25 — validation memo, signed by validator role',
    required_inputs: ['module_id', 'all_tasks_merged', 'validator_identity'],
    required_outputs: ['.agent-runs/validation/<module>-<version>.json'],
    evidence_contract: [],
    permissions: ['write:validation-create', 'write:validation-sign'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 10 },
    expected_outcomes: ['success', 'precondition-fail', 'policy-refusal'],
    allowed_driver_actions: ['advance', 'mark-gate-broken', 'pause-fanout'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:land'],
    scope: 'per-module',
  },
  {
    stage: 'auto:approval',
    cli_path: 'src/cli/approval.ts',
    purpose: 'Stage 26 — production-model-use-expansion approval',
    required_inputs: ['module_id', 'validation_signed', 'approver_identity'],
    required_outputs: ['.agent-runs/approvals/<module>-<op>.json'],
    evidence_contract: [],
    permissions: ['write:approval-request', 'write:approval-sign'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 10 },
    expected_outcomes: ['success', 'precondition-fail', 'policy-refusal'],
    allowed_driver_actions: ['advance', 'mark-gate-broken', 'pause-fanout'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:validation'],
    scope: 'per-module',
  },
  {
    stage: 'auto:tick',
    cli_path: 'src/cli/tick.ts',
    purpose: 'Stage 27 — sweep state transitions + audit pack archive',
    required_inputs: [],
    required_outputs: ['.agent-runs/<run>/state-log.jsonl', '_override-audit.jsonl'],
    evidence_contract: [],
    permissions: ['read:task-pack', 'write:task-pack', 'read:audit-pack'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 30 },
    expected_outcomes: ['success', 'infrastructure-error'],
    allowed_driver_actions: ['advance', 'requeue'],
    fixtures: [],
    negative_controls: [],
    depends_on: [],
    scope: 'per-run',
  },
  {
    stage: 'auto:deploy-staging',
    cli_path: 'src/cli/deploy-staging.ts',
    purpose: 'Stage 29 — deploy approved+merged module to staging',
    required_inputs: ['module_id', 'approval_signed'],
    required_outputs: ['.agent-runs/deployments/<module>-staging.json'],
    evidence_contract: [],
    permissions: ['priv:production-toggle', 'priv:override-control-bypass'],
    cost_estimate: { profile: 'gate', wall_clock_p95_sec: 300 },
    expected_outcomes: ['success', 'precondition-fail', 'infrastructure-error'],
    allowed_driver_actions: ['advance', 'requeue', 'mark-gate-broken'],
    fixtures: [],
    negative_controls: [],
    depends_on: ['auto:approval'],
    scope: 'per-module',
  },
];

// Index by stage name for O(1) lookup.
const REGISTRY_INDEX = new Map<string, StageRegistryEntry>(
  STAGE_REGISTRY.map((e) => [e.stage, e]),
);

export function getStageEntry(stage: string): StageRegistryEntry | null {
  return REGISTRY_INDEX.get(stage) ?? null;
}

export function isStageRegistered(stage: string): boolean {
  return REGISTRY_INDEX.has(stage);
}

/**
 * Validate a stage's outcome against its registry entry. Used by the
 * driver to detect contract violations (= harness-bug). Returns null on
 * pass; returns a diagnostic string on violation.
 */
export function validateOutcomeAgainstRegistry(
  stage: string,
  outcomeKind: string,
  driverAction: string,
): string | null {
  const entry = REGISTRY_INDEX.get(stage);
  if (!entry) {
    return `stage "${stage}" is not in the registry — driver should refuse to call it`;
  }
  if (!entry.expected_outcomes.includes(outcomeKind as ExpectedOutcomeKind)) {
    return `stage "${stage}" emitted unexpected outcome kind "${outcomeKind}"; registry allows: ${entry.expected_outcomes.join(', ')}`;
  }
  if (!entry.allowed_driver_actions.includes(driverAction)) {
    return `stage "${stage}" suggested driver_action "${driverAction}" which is not in registry's allowed list: ${entry.allowed_driver_actions.join(', ')}`;
  }
  return null;
}

/**
 * Topological sort of stages by `depends_on` edges. Returns stage names in
 * an order where every stage's dependencies appear earlier. Used by L7
 * DAG scheduler.
 */
export function topologicalStages(): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const visit = (stage: string): void => {
    if (visited.has(stage)) return;
    visited.add(stage);
    const entry = REGISTRY_INDEX.get(stage);
    if (!entry) return;
    for (const dep of entry.depends_on) visit(dep);
    result.push(stage);
  };
  for (const entry of STAGE_REGISTRY) visit(entry.stage);
  return result;
}
