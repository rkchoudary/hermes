/**
 * 15-stage SDLC state machine — Deliverable 9 per Codex Path 1.
 *
 * Implements FRD-HARNESS v0.9 §4.2 / TRD-HARNESS v0.9 §4.2: a per-MODULE
 * (not per-task) state machine over 15 lifecycle stages. Tasks (TaskPacks)
 * are the unit of execution WITHIN a stage; a stage may host many tasks.
 *
 * The 14 transitions chain the 15 stages. Each transition must satisfy:
 *   - required_gate_ids: hardGates that must be passed=true + status='enforced'
 *   - required_evidence: URIs/paths that must exist
 *   - required_approver_roles: distinct human approver signatures
 *   - tier_1_only_gates: extra gates that fire only for risk_tier='tier-1'
 *   - irreversible_op (optional): if transition implies an IrreversibleOp
 *     per twoKeyApproval, an approved request_id must be presented
 *
 * Every executed transition is appended to the module's SDLC history with
 * a sha256 audit chain hash so the trail is tamper-evident.
 *
 * Codex 2026-04-30 invariant: this state machine is the SPINE for module
 * delivery. Workers (auto:work, auto:plan, auto:promote) read the current
 * stage to decide what kind of task to dispatch; transitions are the
 * gates downstream of code-sprint completion.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { harnessRoot } from './harnessRoot';
import { HardGateId, GateResult, GateStatus } from './hardGates';
import { IrreversibleOp } from './twoKeyApproval';
import { computeChainHash } from './runState';
import { readIntake } from './intake';

// ─── Stage enumeration (FRD-HARNESS §4.2) ──────────────────────────────────
export const SDLCStage = z.enum([
  'intake-approved',          // [1] Intake & risk-tier approved (Stage 0 hard gate)
  'spec',                     // [2] FRD authored to v1.0-candidate; signoff-ready
  'architecture',             // [3] ADRs + threat model + control mapping ratified
  'build',                    // [4] Code-sprint TaskPacks executing (>=1)
  'verify',                   // [5] Tests pass: unit + integration + CDC + golden
  'quality',                  // [6] Pre-merge gates ENFORCED (perf, sbom, license, etc.)
  'validation-approved',      // [7] Independent validator (NOT builder) signed
  'release-readiness',        // [8] Operability gates (DR, observability, runbook)
  'change-approval',          // [9] Change-mgmt board approved + window + rollback
  'deploy',                   // [10] Canary deploy + smoke + promotion
  'production-use-approval',  // [11] Live in approved-uses; CRO/Controller signed
  'observe',                  // [12] Steady-state operation; SLO budget tracked
  'incident-remediation',     // [13] Triggered by SLO burn / incident; remediation cycle
  'decommission',             // [14] Retire from production; data retention plan
  'post-implementation-review', // [15] PIR; lessons learned; close model file
]);
export type SDLCStage = z.infer<typeof SDLCStage>;

/** Ordered stage list for index/predecessor lookup. */
export const STAGE_ORDER: readonly SDLCStage[] = [
  'intake-approved',
  'spec',
  'architecture',
  'build',
  'verify',
  'quality',
  'validation-approved',
  'release-readiness',
  'change-approval',
  'deploy',
  'production-use-approval',
  'observe',
  'incident-remediation',
  'decommission',
  'post-implementation-review',
] as const;

export function stageIndex(s: SDLCStage): number {
  return STAGE_ORDER.indexOf(s);
}

// ─── Transition policy ─────────────────────────────────────────────────────
export interface ApproverRoleRequirement {
  role: string;
  count: number;
}

export interface StageTransitionPolicy {
  from: SDLCStage;
  to: SDLCStage;
  required_gate_ids: HardGateId[];
  required_evidence: string[]; // glob-like patterns under module evidence dir
  required_approver_roles: ApproverRoleRequirement[];
  tier_1_only_gates?: HardGateId[];
  irreversible_op?: IrreversibleOp;
  /** Human-readable description for CLI output. */
  description: string;
}

/**
 * The 14 transitions of the SDLC. Each transition specifies what's required
 * to advance. Transitions are STRICT (no skipping) except for explicit
 * incident-remediation cycles (12 → 13 → 12) and decommission paths.
 */
export const TRANSITIONS: readonly StageTransitionPolicy[] = [
  {
    from: 'intake-approved',
    to: 'spec',
    description: 'Begin FRD authoring after intake approval',
    required_gate_ids: ['INTAKE-APPROVED', 'RISK-TIER', 'CONTROL-MAP'],
    required_evidence: ['intake/<MODULE>.json'],
    required_approver_roles: [],
    tier_1_only_gates: ['THREAT-MODEL'],
  },
  {
    from: 'spec',
    to: 'architecture',
    description: 'FRD signed-off; ratify ADRs + threat model + control mapping',
    required_gate_ids: ['REQ-TRACE', 'CONTROL-MAP', 'DATA-LINEAGE'],
    required_evidence: ['frd/v1.0-candidate.md', 'adr/'],
    required_approver_roles: [{ role: 'Domain-PM', count: 1 }, { role: 'model-governance-Lead', count: 1 }],
    tier_1_only_gates: ['THREAT-MODEL'],
  },
  {
    from: 'architecture',
    to: 'build',
    description: 'Architecture approved; begin code-sprint TaskPack execution',
    required_gate_ids: ['INTAKE-APPROVED'],
    required_evidence: ['architecture/'],
    required_approver_roles: [{ role: 'Eng-Lead', count: 1 }],
  },
  {
    from: 'build',
    to: 'verify',
    description: 'Code complete; advance to test verification',
    required_gate_ids: ['TYPECHECK', 'LINT', 'UNIT-TESTS'],
    required_evidence: ['evidence/'],
    required_approver_roles: [],
  },
  {
    from: 'verify',
    to: 'quality',
    description: 'Tests pass; advance to pre-merge quality gates',
    required_gate_ids: ['INTEGRATION-TESTS', 'CDC-CONTRACTS', 'COVERAGE-90'],
    required_evidence: ['evidence/'],
    required_approver_roles: [],
  },
  {
    from: 'quality',
    to: 'validation-approved',
    description: 'Pre-merge gates pass; submit for independent validation (Tier-1 only)',
    required_gate_ids: ['SAST', 'SECRETS-SCAN', 'SBOM', 'LICENSE-COMPLIANCE', 'IAC-SCAN', 'SCHEMA-COMPAT', 'EVIDENCE-COMPLETE'],
    required_evidence: ['evidence/sbom.json', 'evidence/sast-report.sarif'],
    required_approver_roles: [],
    tier_1_only_gates: ['model-governance-VALIDATION', 'APPROVED-USE'],
  },
  {
    from: 'validation-approved',
    to: 'release-readiness',
    description: 'Independent validator signed; advance to operability gates',
    required_gate_ids: ['model-governance-VALIDATION'],
    required_evidence: ['validation/independent-report.md'],
    required_approver_roles: [{ role: 'model-governance-Independent-Validator', count: 1 }],
  },
  {
    from: 'release-readiness',
    to: 'change-approval',
    description: 'Operability gates pass; submit to change-management board',
    required_gate_ids: ['DR-DRILL', 'OBSERVABILITY-LIVE', 'INCIDENT-RUNBOOK'],
    required_evidence: ['runbook/', 'dr-drill-evidence/'],
    required_approver_roles: [],
  },
  {
    from: 'change-approval',
    to: 'deploy',
    description: 'Change-mgmt board approved; begin canary deploy',
    required_gate_ids: ['SUPPLY-CHAIN'],
    required_evidence: ['change-ticket.json'],
    required_approver_roles: [{ role: 'Change-Approver', count: 1 }, { role: 'Eng-Lead', count: 1 }],
    irreversible_op: 'feature-flag-prod-toggle',
  },
  {
    from: 'deploy',
    to: 'production-use-approval',
    description: 'Canary green; promote to full production. CRO/Controller signoff required for tier-1.',
    required_gate_ids: ['CANARY-SMOKE', 'PERF-SLO'],
    required_evidence: ['canary-metrics.json'],
    required_approver_roles: [{ role: 'Eng-Lead', count: 1 }],
    tier_1_only_gates: ['model-governance-VALIDATION'],
    irreversible_op: 'production-model-use-expansion',
  },
  {
    from: 'production-use-approval',
    to: 'observe',
    description: 'Production-use approval signed; enter steady-state observation',
    required_gate_ids: ['APPROVED-USE', 'AUDIT-TRAIL'],
    required_evidence: ['use-approval-evidence/'],
    required_approver_roles: [{ role: 'CRO', count: 1 }, { role: 'Controller', count: 1 }],
  },
  {
    from: 'observe',
    to: 'incident-remediation',
    description: 'SLO burn / incident triggered; enter remediation cycle',
    required_gate_ids: [],
    required_evidence: ['incident/'],
    required_approver_roles: [{ role: 'Eng-Lead', count: 1 }],
  },
  {
    from: 'incident-remediation',
    to: 'observe',
    description: 'Incident remediation complete; return to steady-state',
    required_gate_ids: ['SLO-IN-BUDGET', 'INCIDENT-RUNBOOK'],
    required_evidence: ['incident/post-mortem.md'],
    required_approver_roles: [{ role: 'Eng-Lead', count: 1 }, { role: 'model-governance-Lead', count: 1 }],
  },
  {
    from: 'observe',
    to: 'decommission',
    description: 'Module retired from production; data retention plan in effect',
    required_gate_ids: ['AUDIT-TRAIL'],
    required_evidence: ['retirement-plan.md'],
    required_approver_roles: [
      { role: 'CRO', count: 1 },
      { role: 'Controller', count: 1 },
      { role: 'model-governance-Lead', count: 1 },
    ],
    irreversible_op: 'production-model-retirement',
  },
  {
    from: 'decommission',
    to: 'post-implementation-review',
    description: 'PIR; lessons learned; close model file',
    required_gate_ids: ['AUDIT-TRAIL'],
    required_evidence: ['pir/lessons-learned.md'],
    required_approver_roles: [{ role: 'model-governance-Lead', count: 1 }],
  },
];

export function findTransition(from: SDLCStage, to: SDLCStage): StageTransitionPolicy | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function nextValidStages(from: SDLCStage): SDLCStage[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.to);
}

/**
 * Stage → permitted task types map. Workers (auto:work) consult this to
 * refuse dispatching a task type that doesn't match the module's current
 * SDLC stage. Modules without SDLC state are exempt (legacy mode); modules
 * with SDLC state must match.
 *
 * Empty array means "no dispatchable task types at this stage" — operator
 * must transition the module forward via auto:sdlc before work can proceed.
 *
 * Mapping rationale:
 *   - intake-approved: nothing dispatchable yet; transition to spec first
 *   - spec: FRD authoring/polish/reconciliation, platform-doc
 *   - architecture: FRD polish (final tweaks), platform-doc (ADRs)
 *   - build: code-sprint, ui-component, dashboard-page
 *   - verify: test-coverage, audit-log-route (BCBS 239 audit trail tests)
 *   - quality: small fixes via code-sprint, additional test-coverage
 *   - validation-approved..post-implementation-review: human-driven; no
 *     dispatchable task types (operator must drive via auto:validation,
 *     auto:approval, etc.)
 */
export const STAGE_PERMITTED_TASK_TYPES: Record<SDLCStage, readonly string[]> = {
  'intake-approved': [],
  // v0.7.2 (Sprint 0.5 Authoring Trio): FRD + TRD + Sprint Plan are all
  // first-class spec-stage artifacts. Greenfield flow creates FRD first
  // (frd-author), then TRD from FRD (trd-author), then Sprint Plan from TRD
  // (sprint-plan-author). Brownfield flow reads existing artifacts via
  // discoverArtifacts() and dispatches polish or reconcile tasks instead.
  'spec': [
    'frd-author', 'frd-polish', 'frd-reconcile',
    'trd-author', 'trd-polish', 'trd-reconcile',
    'sprint-plan-author', 'sprint-plan-polish', 'sprint-plan-reconcile',
    'platform-doc', 'next-session-refresh',
  ],
  // Architecture stage permits the technical artifacts to iterate as ADRs
  // ratify; FRD is locked at this point but TRD + Sprint Plan are still mutable.
  'architecture': ['frd-polish', 'trd-polish', 'sprint-plan-polish', 'platform-doc'],
  'build': ['code-sprint', 'ui-component', 'dashboard-page'],
  'verify': ['test-coverage', 'audit-log-route'],
  'quality': ['code-sprint', 'test-coverage'],
  'validation-approved': [],
  'release-readiness': [],
  'change-approval': [],
  'deploy': [],
  'production-use-approval': [],
  'observe': ['code-sprint', 'test-coverage'], // hotfixes / monitoring tweaks
  'incident-remediation': ['code-sprint', 'test-coverage', 'audit-log-route'],
  'decommission': [],
  'post-implementation-review': ['platform-doc', 'sprint-plan-reconcile'], // PIR + final sprint-plan close-out
};

export interface DispatchPermissionResult {
  permitted: boolean;
  reason: string;
  current_stage?: SDLCStage;
  required_stage?: SDLCStage;
  allowed_task_types?: readonly string[];
}

/**
 * Check whether a task of the given type can be dispatched against the
 * module's current SDLC stage. If no SDLC state exists, returns permitted
 * (legacy mode: workers function without the state machine for backwards
 * compatibility). If state exists, checks pack.type against
 * STAGE_PERMITTED_TASK_TYPES[current_stage].
 */
export function checkDispatchPermission(moduleId: string, taskType: string): DispatchPermissionResult {
  const state = readSDLCState(moduleId);
  if (!state) {
    return {
      permitted: true,
      reason: `No SDLC state for module ${moduleId} — legacy mode (workers operate without state machine)`,
    };
  }
  const allowed = STAGE_PERMITTED_TASK_TYPES[state.current_stage];
  if (allowed.includes(taskType)) {
    return {
      permitted: true,
      reason: `Task type "${taskType}" permitted at stage "${state.current_stage}"`,
      current_stage: state.current_stage,
      allowed_task_types: allowed,
    };
  }
  // Find what stage WOULD permit this task type — helps the operator know
  // where to advance the SDLC state to enable this dispatch.
  const requiredStages: SDLCStage[] = [];
  for (const [stage, types] of Object.entries(STAGE_PERMITTED_TASK_TYPES)) {
    if (types.includes(taskType)) requiredStages.push(stage as SDLCStage);
  }
  const reqStr = requiredStages.length === 0
    ? `(no stage permits task type "${taskType}" — type may be unmapped)`
    : `(requires stage in {${requiredStages.join(', ')}})`;
  return {
    permitted: false,
    reason: `Task type "${taskType}" not permitted at stage "${state.current_stage}" ${reqStr}. Current stage allows: [${allowed.join(', ') || '(none — operator must transition)'}]. Run: pnpm auto:sdlc --module ${moduleId} --policy ${requiredStages[0] ?? '<stage>'} to see what's needed for transition.`,
    current_stage: state.current_stage,
    required_stage: requiredStages[0],
    allowed_task_types: allowed,
  };
}

// ─── Module SDLC state ─────────────────────────────────────────────────────
export const ApproverSignature = z.object({
  role: z.string(),
  person: z.string(),
  signed_at: z.string(),
  evidence: z.string(),
});
export type ApproverSignature = z.infer<typeof ApproverSignature>;

export const StageTransition = z.object({
  from: SDLCStage,
  to: SDLCStage,
  at: z.string(),
  by: z.string(),
  reason: z.string(),
  gate_results_summary: z.array(z.object({
    gate_id: z.string(),
    passed: z.boolean(),
    status: z.string(),
  })).default([]),
  evidence_uris: z.array(z.string()).default([]),
  approver_signatures: z.array(ApproverSignature).default([]),
  override_ticket: z.string().optional(),
  /** sha256 chain — sha256(prev_chain_hash || canonical_json(transition w/o hash)) */
  chain_hash: z.string(),
});
export type StageTransition = z.infer<typeof StageTransition>;

export const ModuleSDLCState = z.object({
  module_id: z.string(),
  current_stage: SDLCStage,
  created_at: z.string(),
  last_updated_at: z.string(),
  history: z.array(StageTransition).default([]),
});
export type ModuleSDLCState = z.infer<typeof ModuleSDLCState>;

// ─── Filesystem ────────────────────────────────────────────────────────────
export function sdlcDir(): string {
  return path.join(harnessRoot(), '.agent-runs', 'sdlc');
}

export function sdlcStatePath(moduleId: string): string {
  return path.join(sdlcDir(), `${moduleId}.json`);
}

export function readSDLCState(moduleId: string): ModuleSDLCState | null {
  const p = sdlcStatePath(moduleId);
  if (!fs.existsSync(p)) return null;
  return ModuleSDLCState.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
}

export function writeSDLCState(state: ModuleSDLCState): void {
  const dir = sdlcDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(sdlcStatePath(state.module_id), JSON.stringify(state, null, 2));
}

/** Initialize a module's SDLC state at intake-approved (the only legal start). */
export function initSDLCState(moduleId: string): ModuleSDLCState {
  const existing = readSDLCState(moduleId);
  if (existing) return existing;
  // Intake gate must already pass — this is the precondition for stage [1].
  const intake = readIntake(moduleId);
  if (!intake) {
    throw new Error(`Cannot init SDLC for ${moduleId}: no intake record. Run auto:intake --create first.`);
  }
  if (intake.status !== 'approved') {
    throw new Error(`Cannot init SDLC for ${moduleId}: intake status is "${intake.status}", must be "approved".`);
  }
  const state: ModuleSDLCState = {
    module_id: moduleId,
    current_stage: 'intake-approved',
    created_at: new Date().toISOString(),
    last_updated_at: new Date().toISOString(),
    history: [],
  };
  writeSDLCState(state);
  return state;
}

// ─── Transition evaluation ─────────────────────────────────────────────────
export interface TransitionPrecondition {
  satisfied: boolean;
  failures: string[];
  warnings: string[];
}

export interface TransitionRequest {
  module_id: string;
  to: SDLCStage;
  reason: string;
  by: string;
  /** Gate results gathered by caller (typically from runStageGates). */
  gate_results: GateResult[];
  /** Evidence URIs the caller declares present. */
  evidence_uris: string[];
  /** Approver signatures collected from operators. */
  approver_signatures: ApproverSignature[];
  /** Override ticket if any prereq is being bypassed (audit-logged). */
  override_ticket?: string;
}

/**
 * Evaluate whether the requested transition's preconditions are satisfied
 * given the gate results, evidence, and approver signatures the caller
 * declares. Pure function — does NOT mutate state. Returns a structured
 * report of failures so CLI can show the operator exactly what's missing.
 */
export function evaluateTransition(
  state: ModuleSDLCState,
  req: TransitionRequest
): TransitionPrecondition {
  const policy = findTransition(state.current_stage, req.to);
  const failures: string[] = [];
  const warnings: string[] = [];

  if (!policy) {
    failures.push(`No transition policy from "${state.current_stage}" to "${req.to}". Valid next stages: [${nextValidStages(state.current_stage).join(', ')}].`);
    return { satisfied: false, failures, warnings };
  }

  // Determine whether tier-1 gates apply
  const intake = readIntake(state.module_id);
  const isTier1 = intake?.risk_tier === 'tier-1';
  const requiredGates: HardGateId[] = [
    ...policy.required_gate_ids,
    ...(isTier1 && policy.tier_1_only_gates ? policy.tier_1_only_gates : []),
  ];

  // Required gate IDs: every one must be present in gate_results AND passed=true AND status in {'enforced', 'advisory'}
  for (const gateId of requiredGates) {
    const result = req.gate_results.find((r) => r.gate_id === gateId);
    if (!result) {
      failures.push(`Required gate ${gateId} not found in gate_results. Run: pnpm auto:work or include gate result via --gate.`);
      continue;
    }
    if (result.status === 'not_implemented' || result.status === 'declared') {
      failures.push(`Required gate ${gateId} is status="${result.status}" — cannot satisfy transition until gate is implemented (enforced or advisory).`);
      continue;
    }
    if (!result.passed) {
      failures.push(`Required gate ${gateId} failed: ${result.reason}`);
      continue;
    }
    if (result.status === 'instrumented') {
      warnings.push(`Gate ${gateId} is shadow-mode (instrumented) — does not count toward enforcement.`);
    }
  }

  // Required evidence: every pattern must match at least one URI in evidence_uris
  for (const evidencePattern of policy.required_evidence) {
    const concrete = evidencePattern.replace('<MODULE>', state.module_id);
    const matched = req.evidence_uris.some((uri) => uri.includes(concrete));
    if (!matched) {
      failures.push(`Required evidence pattern "${concrete}" not present in evidence_uris.`);
    }
  }

  // Required approver roles: distinct approver_id count per role
  for (const roleReq of policy.required_approver_roles) {
    const matching = req.approver_signatures.filter((s) => s.role === roleReq.role);
    const distinctPersons = new Set(matching.map((s) => s.person));
    if (distinctPersons.size < roleReq.count) {
      failures.push(`Required approver role "${roleReq.role}" needs ${roleReq.count} distinct signature(s); have ${distinctPersons.size}.`);
    }
  }

  // Override ticket: if any failure exists AND override_ticket is set, demote failures to warnings
  if (req.override_ticket && failures.length > 0) {
    warnings.push(`Override ticket "${req.override_ticket}" provided; ${failures.length} prereq failure(s) will be audited as override.`);
    warnings.push(...failures.map((f) => `[OVERRIDE] ${f}`));
    failures.length = 0;
  }

  return { satisfied: failures.length === 0, failures, warnings };
}

/**
 * Execute a transition. Caller MUST have evaluated preconditions first;
 * this function re-evaluates and refuses if not satisfied. Appends to
 * history with chain hash; persists.
 */
export function executeTransition(
  state: ModuleSDLCState,
  req: TransitionRequest
): { ok: true; state: ModuleSDLCState; transition: StageTransition } | { ok: false; reason: string; precondition: TransitionPrecondition } {
  const precondition = evaluateTransition(state, req);
  if (!precondition.satisfied) {
    return {
      ok: false,
      reason: `Preconditions not satisfied (${precondition.failures.length} failure(s)).`,
      precondition,
    };
  }

  const transition: Omit<StageTransition, 'chain_hash'> = {
    from: state.current_stage,
    to: req.to,
    at: new Date().toISOString(),
    by: req.by,
    reason: req.reason,
    gate_results_summary: req.gate_results.map((r) => ({
      gate_id: r.gate_id,
      passed: r.passed,
      status: r.status,
    })),
    evidence_uris: req.evidence_uris,
    approver_signatures: req.approver_signatures,
    override_ticket: req.override_ticket,
  };

  const prevHash = state.history.length > 0
    ? state.history[state.history.length - 1].chain_hash
    : '';
  const chain_hash = computeChainHash(prevHash, transition);
  const fullTransition: StageTransition = { ...transition, chain_hash };

  const next: ModuleSDLCState = {
    ...state,
    current_stage: req.to,
    last_updated_at: fullTransition.at,
    history: [...state.history, fullTransition],
  };
  writeSDLCState(next);
  return { ok: true, state: next, transition: fullTransition };
}

/**
 * Verify the audit chain across a module's SDLC history. Returns ok:true
 * iff every transition's chain_hash matches the recomputed value from
 * (prev_chain || canonical_json(transition w/o hash)).
 */
export function verifySDLCChain(state: ModuleSDLCState): {
  ok: boolean;
  count: number;
  broken_at?: number;
  reason?: string;
} {
  let prev = '';
  for (let i = 0; i < state.history.length; i++) {
    const t = state.history[i];
    const { chain_hash, ...rest } = t;
    const expected = computeChainHash(prev, rest);
    if (expected !== chain_hash) {
      return {
        ok: false,
        count: state.history.length,
        broken_at: i,
        reason: `Transition ${i} chain mismatch: expected ${expected.slice(0, 16)}…, found ${chain_hash.slice(0, 16)}…`,
      };
    }
    prev = chain_hash;
  }
  return { ok: true, count: state.history.length };
}
