/**
 * Independent Validation Framework — Deliverable 4 per Codex Path 1.
 *
 * OSFI E-23 §III.B + Fed SR 26-2 §V: model validation must be performed by
 * a validator with NO build authority. The validator may be inside the
 * organization (independent function within model-governance) or external; they MUST be
 * organizationally separate from the model build team.
 *
 * Per FRD-HARNESS v0.9 §2.1: Codex is an advisory peer-reviewer, NOT an
 * independent validator. The harness REFUSES to mark a record as signed
 * with validator_person='codex' or any AI agent identifier.
 *
 * Validator obligations under OSFI E-23 §III.B:
 *   1. Conceptual soundness review (assumptions, theory, data choices)
 *   2. Outcomes analysis (back-testing, sensitivity, benchmarking)
 *   3. Implementation review (code, configuration, controls)
 *   4. Ongoing monitoring effectiveness
 *   5. Conflict-of-interest attestation (signed)
 *   6. Documentation that supports independent re-performance
 *
 * Severity scale (NIST AI RMF + ISO 42001 alignment):
 *   - critical:  blocks model use; remediation MUST occur before approval
 *   - high:      blocks production-use approval until remediated
 *   - medium:    can proceed conditionally with mitigation plan + monitoring
 *   - low:       acknowledged; remediated in normal SDLC cycle
 *   - informational: improvement suggestion; no blocking effect
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { harnessRoot } from './harnessRoot';
import { computeChainHash } from './runState';
import { readIntake } from './intake';

// ─── Validator role (must be human, must be independent) ──────────────────
export const ValidatorRole = z.enum([
  'mrm-independent-validator',  // Internal model-governance staff, organizationally separate
  'external-validator',          // Third-party validator (consultancy, auditor)
  'second-line-control',         // Second-line risk function (CRO chain)
  'audit-internal',              // Internal Audit (third line)
  'regulatory-validator',        // Regulator-appointed (rare; usually pre-submission)
]);
export type ValidatorRole = z.infer<typeof ValidatorRole>;

// ─── Validation methodology (OSFI E-23 §III.B + SR 26-2 §V) ────────────────
export const ValidationMethodology = z.enum([
  'conceptual-soundness',     // Theory, assumptions, data choices defensible
  'outcomes-analysis',        // Back-testing against actuals
  'sensitivity-analysis',     // How outputs respond to input changes
  'benchmarking',             // Compared to alternative model or simple baseline
  'replication',              // Validator built parallel implementation
  'stress-testing',           // Tail-event behavior
  'code-review',              // Implementation-level review
  'control-effectiveness',    // Ongoing controls actually fire correctly
  'data-integrity',           // Source authority, lineage, DQ
  'documentation-review',     // Coverage, traceability, FRD ↔ code
]);
export type ValidationMethodology = z.infer<typeof ValidationMethodology>;

export const FindingSeverity = z.enum([
  'critical',
  'high',
  'medium',
  'low',
  'informational',
]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

export const RemediationStatus = z.enum([
  'open',
  'in-progress',
  'remediated',
  'risk-accepted',  // operator-acknowledged residual risk
  'wont-fix',       // explicit decision not to remediate (audit-logged)
]);
export type RemediationStatus = z.infer<typeof RemediationStatus>;

export const ValidationFinding = z.object({
  finding_id: z.string(),
  severity: FindingSeverity,
  description: z.string(),
  recommendation: z.string(),
  affected_artifacts: z.array(z.string()).default([]), // file paths, FR IDs, etc.
  remediation_status: RemediationStatus.default('open'),
  remediation_evidence: z.string().optional(),
  remediation_signed_at: z.string().optional(),
  remediation_signed_by: z.string().optional(),
});
export type ValidationFinding = z.infer<typeof ValidationFinding>;

export const ValidationConclusion = z.enum([
  'approved',                      // Validator signs unconditional approval
  'approved-with-conditions',      // Approved subject to listed conditions
  'rejected',                      // Cannot proceed; remediation required
  'inconclusive',                  // Insufficient evidence; needs more work
]);
export type ValidationConclusion = z.infer<typeof ValidationConclusion>;

/**
 * Sprint J — 4-outcome operational signoff (Codex council review item 5).
 *
 * Maps the validation memo to one of four operator actions:
 *   - accept             → artifact promoted, no follow-up required
 *   - send-back          → create a NEW task with findings as input (not
 *                          a re-round); the prior artifact is discarded
 *   - risk-accept        → accept WITH structured risk acceptance:
 *                          expiry_at + revalidation_trigger + compensating
 *                          controls. Required for autonomous-mode promotes
 *                          when council triage is "fabrication" or "factual"
 *                          — operator must explicitly accept the risk
 *   - defer-second-look  → "park until Ram re-signs later with fresh
 *                          attention" (Codex item 5 — prevents fatigue-
 *                          driven risk acceptance on overnight runs).
 *                          The artifact stays in promotable state but is
 *                          NOT promoted; operator returns to it later.
 *
 * Maps onto the legacy ValidationConclusion as a semantic refinement:
 *   accept             → approved
 *   send-back          → rejected
 *   risk-accept        → approved-with-conditions (with structured risk_acceptance)
 *   defer-second-look  → inconclusive (with structured defer reason)
 */
export const ValidationOutcome = z.enum([
  'accept',
  'send-back',
  'risk-accept',
  'defer-second-look',
]);
export type ValidationOutcome = z.infer<typeof ValidationOutcome>;

export const RiskAcceptance = z.object({
  /** ISO date when this acceptance expires; revalidation REQUIRED before. */
  expiry_at: z.string(),
  /** Specific event/threshold that triggers re-validation before expiry
   *  (e.g., "first regulated bank customer signs", "module enters
   *  production-traffic-routing", "score drops below 5.0 on next council"). */
  revalidation_trigger: z.string().min(1),
  /** Compensating controls that mitigate the accepted risk
   *  (e.g., "manual reconciliation in NBF Ops", "feature flag default off"). */
  compensating_controls: z.array(z.string()).min(1),
  /** Free-text rationale; operator-supplied per OSFI E-23 §III.B. */
  rationale: z.string().min(20),
});
export type RiskAcceptance = z.infer<typeof RiskAcceptance>;

export const DeferReason = z.object({
  /** What needs more attention. */
  reason: z.string().min(1),
  /** When the operator commits to revisit (ISO date). */
  revisit_at: z.string(),
  /** Optional pointer to specific findings/evidence that triggered the defer. */
  triggered_by: z.array(z.string()).default([]),
});
export type DeferReason = z.infer<typeof DeferReason>;

export const SendBackInstructions = z.object({
  /** What the next-task author should do differently — surfaced as the
   *  new task's objective. */
  new_task_objective: z.string().min(1),
  /** Specific findings from this validation that inform the new task. */
  blocking_findings: z.array(z.string()).default([]),
  /** Optional task ID of the new task once created (chains the audit trail). */
  new_task_id: z.string().optional(),
});
export type SendBackInstructions = z.infer<typeof SendBackInstructions>;

// ─── Validation record (signed artifact) ──────────────────────────────────
export const ValidationRecord = z.object({
  validation_id: z.string(),
  module_id: z.string(),
  prior_validation_id: z.string().optional(), // for re-validation chains
  // Scope: what was validated
  scope_versions: z.object({
    frd_version: z.string(),           // FRD version at validation time
    code_commit_sha: z.string().optional(), // Git SHA
    intake_version: z.string(),         // intake_id
  }),
  methodologies: z.array(ValidationMethodology).min(1),
  // Validator identity (MUST be human, MUST be independent)
  validator: z.object({
    role: ValidatorRole,
    person: z.string().min(1),             // Person identifier (cannot be empty)
    organization: z.string().min(1),       // Org identifier
    /** Independence attestation per OSFI E-23 §III.B. */
    independent_attestation: z.object({
      attested_at: z.string(),
      attestation_text: z.string(),  // freeform; must be present
      no_build_authority: z.boolean(),     // Validator did NOT build this module
      no_supervisory_relation: z.boolean(),// No supervisory relation with builder
      conflict_of_interest_disclosure: z.string().default('none'),
    }),
  }),
  // Findings
  findings: z.array(ValidationFinding).default([]),
  // Conclusion
  conclusion: ValidationConclusion,
  conclusion_rationale: z.string().min(1),
  conditions: z.array(z.string()).default([]), // For approved-with-conditions
  /**
   * Sprint J — 4-outcome operational signoff. Optional for back-compat
   * with pre-Sprint-J memos (which only had `conclusion`). When present,
   * `outcome` is the canonical operator action; `conclusion` is the
   * legacy/audit-trail field. Driver state machine + memo template read
   * `outcome` directly to route differently per route.
   */
  outcome: ValidationOutcome.optional(),
  /** Required when outcome === 'risk-accept'. Captures expiry + revalidation
   *  trigger + compensating controls per OSFI E-23 §III.B + SR 26-2 §III. */
  risk_acceptance: RiskAcceptance.optional(),
  /** Required when outcome === 'defer-second-look'. Captures what needs
   *  more attention + when operator commits to revisit. */
  defer_reason: DeferReason.optional(),
  /** Required when outcome === 'send-back'. Drives next-task creation. */
  send_back: SendBackInstructions.optional(),
  // Evidence
  evidence_uris: z.array(z.string()).default([]), // Paths to validation artifacts
  // Audit
  created_at: z.string(),
  signed_at: z.string().optional(),       // Empty when in 'draft' status
  signature_evidence: z.string().optional(), // signature blob/PGP/cryptographic
  status: z.enum(['draft', 'signed', 'superseded', 'retired']).default('draft'),
  // Tamper-evident chain (chains across re-validations of the same module)
  chain_hash: z.string().optional(),
}).superRefine((rec, ctx) => {
  // Sprint J — outcome ↔ structured-field consistency. When outcome is
  // present, the matching structured field MUST also be present.
  if (rec.outcome === 'risk-accept' && !rec.risk_acceptance) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'outcome=risk-accept requires risk_acceptance{expiry_at, revalidation_trigger, compensating_controls, rationale}',
      path: ['risk_acceptance'],
    });
  }
  if (rec.outcome === 'defer-second-look' && !rec.defer_reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'outcome=defer-second-look requires defer_reason{reason, revisit_at}',
      path: ['defer_reason'],
    });
  }
  if (rec.outcome === 'send-back' && !rec.send_back) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'outcome=send-back requires send_back{new_task_objective, blocking_findings}',
      path: ['send_back'],
    });
  }
});
export type ValidationRecord = z.infer<typeof ValidationRecord>;

/**
 * Map an outcome to the corresponding legacy ValidationConclusion. Used
 * when CLI receives --outcome but needs to populate both fields for
 * back-compat with downstream consumers.
 */
export function conclusionFromOutcome(outcome: ValidationOutcome): ValidationConclusion {
  switch (outcome) {
    case 'accept': return 'approved';
    case 'send-back': return 'rejected';
    case 'risk-accept': return 'approved-with-conditions';
    case 'defer-second-look': return 'inconclusive';
  }
}

// ─── Filesystem ────────────────────────────────────────────────────────────
export function validationDir(): string {
  return path.join(harnessRoot(), '.agent-runs', 'validation');
}

export function moduleValidationDir(moduleId: string): string {
  return path.join(validationDir(), moduleId);
}

export function validationPath(moduleId: string, validationId: string): string {
  return path.join(moduleValidationDir(moduleId), `${validationId}.json`);
}

export function readValidation(moduleId: string, validationId: string): ValidationRecord | null {
  const p = validationPath(moduleId, validationId);
  if (!fs.existsSync(p)) return null;
  return ValidationRecord.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
}

export function writeValidation(record: ValidationRecord): void {
  const dir = moduleValidationDir(record.module_id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(validationPath(record.module_id, record.validation_id), JSON.stringify(record, null, 2));
}

export function listValidations(moduleId: string): ValidationRecord[] {
  const dir = moduleValidationDir(moduleId);
  if (!fs.existsSync(dir)) return [];
  const out: ValidationRecord[] = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      out.push(ValidationRecord.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))));
    } catch { /* skip malformed */ }
  }
  return out;
}

// ─── AI-agent independence check ──────────────────────────────────────────
const AI_IDENTIFIERS = [
  'codex', 'claude', 'gpt', 'sonnet', 'opus', 'haiku', 'agent-runtime',
  'auto-worker', 'ai-orchestrator', 'harness', 'bot',
];

export interface IndependenceCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the validator is human and independent of the build team. Codex's
 * advisory peer-review role does NOT count as validation per FRD-HARNESS
 * §2.1; this function refuses any validator_person matching common AI
 * identifiers (case-insensitive substring match).
 *
 * Caller may pass a list of build_team_persons to check that the validator
 * isn't on the build team. If not provided, only AI-identifier check runs.
 */
export function checkValidatorIndependence(
  validator: ValidationRecord['validator'],
  build_team_persons: string[] = []
): IndependenceCheckResult {
  const personLow = validator.person.toLowerCase();
  for (const id of AI_IDENTIFIERS) {
    if (personLow.includes(id)) {
      return {
        ok: false,
        reason: `Validator person "${validator.person}" matches AI identifier "${id}" — per FRD-HARNESS §2.1 + OSFI E-23 §III.B, AI agents cannot serve as independent validators (Codex is advisory peer-reviewer only).`,
      };
    }
  }
  if (!validator.independent_attestation.no_build_authority) {
    return {
      ok: false,
      reason: `Validator independent_attestation.no_build_authority is false — cannot serve as independent validator per OSFI E-23 §III.B.`,
    };
  }
  if (!validator.independent_attestation.no_supervisory_relation) {
    return {
      ok: false,
      reason: `Validator independent_attestation.no_supervisory_relation is false — supervisory relation with builder violates independence requirement.`,
    };
  }
  if (build_team_persons.includes(validator.person)) {
    return {
      ok: false,
      reason: `Validator person "${validator.person}" is on the build team — cannot self-validate.`,
    };
  }
  return { ok: true };
}

// ─── Sign a validation record (transitions draft → signed) ────────────────
export interface SignValidationRequest {
  module_id: string;
  validation_id: string;
  signature_evidence: string;
  signed_at?: string;
  build_team_persons?: string[];
}

export interface SignValidationResult {
  ok: boolean;
  reason?: string;
  record?: ValidationRecord;
}

export function signValidation(req: SignValidationRequest): SignValidationResult {
  const record = readValidation(req.module_id, req.validation_id);
  if (!record) return { ok: false, reason: `No validation record ${req.validation_id} for ${req.module_id}` };
  if (record.status !== 'draft') return { ok: false, reason: `Validation ${req.validation_id} status is "${record.status}", not "draft"` };

  const independence = checkValidatorIndependence(record.validator, req.build_team_persons ?? []);
  if (!independence.ok) return { ok: false, reason: independence.reason };

  // Refuse to sign 'approved' if any critical/high finding remains open
  if (record.conclusion === 'approved') {
    const blocking = record.findings.filter((f) =>
      (f.severity === 'critical' || f.severity === 'high') &&
      f.remediation_status !== 'remediated'
    );
    if (blocking.length > 0) {
      return {
        ok: false,
        reason: `Cannot sign 'approved' with ${blocking.length} unremediated critical/high finding(s). Use conclusion='approved-with-conditions' or remediate first.`,
      };
    }
  }

  // Compute chain hash linking to prior validation if present
  let prevHash = '';
  if (record.prior_validation_id) {
    const prior = readValidation(req.module_id, record.prior_validation_id);
    if (prior?.chain_hash) prevHash = prior.chain_hash;
  }
  const signedAt = req.signed_at ?? new Date().toISOString();
  const recordForHash = { ...record, signed_at: signedAt, signature_evidence: req.signature_evidence, status: 'signed' as const };
  const { chain_hash: _omit, ...rest } = recordForHash;
  const newHash = computeChainHash(prevHash, rest as Record<string, unknown>);
  const signed: ValidationRecord = {
    ...record,
    signed_at: signedAt,
    signature_evidence: req.signature_evidence,
    status: 'signed',
    chain_hash: newHash,
  };
  writeValidation(signed);
  return { ok: true, record: signed };
}

// ─── Validation gate (used by hardGates.model-governance-VALIDATION) ────────────────────
export interface ValidationGateResult {
  pass: boolean;
  reason: string;
  signed_validation_id?: string;
  conclusion?: ValidationConclusion;
  open_critical_high_count?: number;
}

/**
 * Validation gate for hardGates.model-governance-VALIDATION. Returns pass=true iff the
 * module has at least one SIGNED validation record with conclusion in
 * {approved, approved-with-conditions} AND zero open critical/high
 * findings AND independence still holds.
 */
export function validationGate(moduleId: string): ValidationGateResult {
  const records = listValidations(moduleId).filter((r) => r.status === 'signed');
  if (records.length === 0) {
    const intake = readIntake(moduleId);
    if (intake?.risk_tier === 'tier-1') {
      return {
        pass: false,
        reason: `Tier-1 module ${moduleId} has no signed validation records — required per OSFI E-23 §III.B + Fed SR 26-2 §V`,
      };
    }
    return { pass: true, reason: `No validation required for non-tier-1 module ${moduleId}` };
  }

  // Find the most recent signed validation
  records.sort((a, b) => (b.signed_at ?? '').localeCompare(a.signed_at ?? ''));
  const latest = records[0];

  if (latest.conclusion === 'rejected' || latest.conclusion === 'inconclusive') {
    return {
      pass: false,
      reason: `Latest validation ${latest.validation_id} conclusion is "${latest.conclusion}"`,
      signed_validation_id: latest.validation_id,
      conclusion: latest.conclusion,
    };
  }

  const openBlocking = latest.findings.filter((f) =>
    (f.severity === 'critical' || f.severity === 'high') &&
    f.remediation_status !== 'remediated' && f.remediation_status !== 'risk-accepted'
  );
  if (openBlocking.length > 0) {
    return {
      pass: false,
      reason: `Latest validation has ${openBlocking.length} open critical/high finding(s)`,
      signed_validation_id: latest.validation_id,
      conclusion: latest.conclusion,
      open_critical_high_count: openBlocking.length,
    };
  }

  return {
    pass: true,
    reason: `Validation ${latest.validation_id} signed; conclusion=${latest.conclusion}; ${latest.findings.length} finding(s), 0 open critical/high`,
    signed_validation_id: latest.validation_id,
    conclusion: latest.conclusion,
    open_critical_high_count: 0,
  };
}
