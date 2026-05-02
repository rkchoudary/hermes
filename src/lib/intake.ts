/**
 * Stage 0 — Module Intake & Risk Tiering (per Codex feedback 2026-04-30).
 *
 * Per OSFI E-23 (effective 2027-05-01) and Fed SR 26-2 (effective 2026-04-17):
 * Every model-bearing module must have an intake record BEFORE FRD generation.
 * The intake record is the accountability anchor — it identifies:
 *   - Tier (regulatory severity)
 *   - Owner (accountable human, NOT AI)
 *   - Approved use(s)
 *   - Data classification
 *   - Inherent + residual risk rating
 *   - Control mapping (SOX, BCBS 239, OSFI E-23, SR 26-2)
 *   - Threat model link
 *
 * Persisted in Aurora `module_intake` table (prod) and JSON files in
 * .agent-runs/intake/{module}.json (local). Immutable once approved;
 * changes require new intake-amendment record.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';

// ─── Risk tiering per OSFI E-23 §III.A + SR 26-2 §III ──────────────────────
export const RiskTier = z.enum([
  'tier-1', // Material to capital, liquidity, regulatory submission, customer-facing pricing
  'tier-2', // Internal use, internal-use planning, non-regulatory analytics
  'tier-3', // Dev tools, internal dashboards, non-financial
  'not-a-model', // Pure passthrough / data-plumbing (no judgment, no learned parameters)
]);
export type RiskTier = z.infer<typeof RiskTier>;

// ─── Model classification ──────────────────────────────────────────────────
export const ModelClassification = z.enum([
  'regulatory-model',     // Direct regulatory submission (CCAR, Basel, COREP, BCAR, compliance submissions)
  'mrm-tier-1-internal',  // Internal model, model-governance Tier-1 governance applies
  'mrm-tier-2-internal',  // Internal model, model-governance Tier-2 governance applies
  'mrm-tier-3-internal',  // Internal model, model-governance Tier-3 governance applies
  'analytics-tool',       // Not a model per SR 26-2; analytics/visualization only
  'data-pipeline',        // Data movement, no model behavior
  'ui-component',         // UI primitive, no business logic
  'platform-infra',       // Multi-tenancy, governance, lineage layer (not a model itself)
  // v0.7.1 addition: AI orchestration systems that make governance decisions
  // about other models. Per OSFI E-23 self-application reasoning (FRD-HARNESS
  // v0.9 §1, §9), the autonomous-delivery harness IS a Tier-1 model because
  // its decisions cascade into capital/liquidity/regulatory submissions
  // through 87 downstream modules. Distinct from `regulatory-model` (no
  // direct regulatory submission) and `mrm-tier-1-internal` (no model-of-
  // record decisioning) — this captures the "model that supervises models"
  // governance posture.
  'ai-decisioning-system',
]);
export type ModelClassification = z.infer<typeof ModelClassification>;

// ─── Data classification per BCBS 239 + GDPR + GLBA ────────────────────────
export const DataClassification = z.enum([
  'public',
  'internal',
  'confidential',
  'restricted',
  'npi',     // Non-public personal information (GLBA)
  'phi',     // Protected health information (HIPAA)
  'pci',     // Payment card industry data
  'mnpi',    // Material non-public information (insider trading)
]);
export type DataClassification = z.infer<typeof DataClassification>;

// ─── Approved use enumeration ──────────────────────────────────────────────
export const ApprovedUse = z.object({
  use_id: z.string(), // e.g., "ccar-submission-fed-y-14a"
  description: z.string(),
  jurisdiction: z.array(z.enum(['US', 'CA', 'EU', 'UK', 'global'])),
  effective_date: z.string().optional(), // ISO date when use was approved
  approver_role: z.enum(['CRO', 'CCO', 'Controller', 'CFO', 'CIO', 'model-governance-Lead', 'Compliance-Lead', 'Domain-PM']),
  approver_id: z.string().optional(), // Filled in when human signs
  approval_evidence_pointer: z.string().optional(), // Path to signed artifact
});
export type ApprovedUse = z.infer<typeof ApprovedUse>;

// ─── Risk rating ───────────────────────────────────────────────────────────
export const RiskRating = z.object({
  inherent: z.enum(['low', 'medium', 'high', 'critical']),
  residual: z.enum(['low', 'medium', 'high', 'critical']), // After controls
  rationale: z.string(),
  last_assessed_at: z.string(), // ISO timestamp
  assessor_role: z.string(),
});
export type RiskRating = z.infer<typeof RiskRating>;

// ─── Control mapping (SOX, BCBS 239, OSFI E-23, SR 26-2) ───────────────────
export const ControlMapping = z.object({
  sox_controls: z.array(z.string()).default([]), // e.g., ["ITGC-01", "ITGC-04", "FC-15"]
  bcbs_239_principles: z.array(z.string()).default([]), // e.g., ["P3", "P6"]
  osfi_e_23_elements: z.array(z.string()).default([]), // e.g., ["§III.A.1", "§III.B.2"]
  sr_26_2_sections: z.array(z.string()).default([]), // e.g., ["§III", "§V"]
  ifrs_us_gaap: z.array(z.string()).default([]), // e.g., ["ASC 606", "IFRS 15"]
  jurisdiction_specific: z.array(z.object({
    jurisdiction: z.string(),
    citations: z.array(z.string()),
  })).default([]),
});
export type ControlMapping = z.infer<typeof ControlMapping>;

// ─── Owner assignment ──────────────────────────────────────────────────────
export const OwnerAssignment = z.object({
  // Accountable human owners — these are NOT AI agents per OSFI E-23
  business_owner: z.object({
    role: z.string(), // e.g., "Treasury PM"
    person: z.string().optional(), // Filled when assigned (operator drives)
    accountability_scope: z.string(), // e.g., "Approved-use definition, business value, retirement decision"
  }),
  technical_owner: z.object({
    role: z.string(),
    person: z.string().optional(),
    accountability_scope: z.string(),
  }),
  validator_owner: z.object({
    role: z.string(), // Independent of build team per OSFI E-23
    person: z.string().optional(),
    accountability_scope: z.string(), // e.g., "Independent validation, model-governance signoff"
  }),
  control_owner: z.object({
    role: z.string(), // SOX control owner
    person: z.string().optional(),
    accountability_scope: z.string(),
  }),
});
export type OwnerAssignment = z.infer<typeof OwnerAssignment>;

// ─── Intake record (full) ──────────────────────────────────────────────────
export const ModuleIntake = z.object({
  intake_id: z.string(), // e.g., "INT-M22-2026-04-30-001"
  module_id: z.string(), // e.g., "M22"
  created_at: z.string(),
  status: z.enum(['draft', 'approved', 'amended', 'retired']),
  // ─── OSFI E-23 + SR 26-2 required fields ───
  risk_tier: RiskTier,
  model_classification: ModelClassification,
  approved_uses: z.array(ApprovedUse).min(1),
  data_classification: z.array(DataClassification).min(1), // Highest classification touched
  inherent_residual_risk: RiskRating,
  control_mapping: ControlMapping,
  owners: OwnerAssignment,
  // ─── Threat model link ───
  threat_model_path: z.string().optional(), // Path to threat-model artifact
  // ─── Goal contract for this module ───
  frd_target_score: z.number().min(0).max(10).default(7.0),
  regulatory_deadlines: z.array(z.object({
    regulator: z.string(),
    citation: z.string(),
    effective_date: z.string(),
  })).default([]),
  upstream_dependencies: z.array(z.string()).default([]), // e.g., ["M02", "M03"]
  downstream_consumers: z.array(z.string()).default([]),
  // ─── Approval audit trail ───
  approvals: z.array(z.object({
    approver_role: z.string(),
    approver_id: z.string(),
    approved_at: z.string(),
    signature_evidence: z.string(),
  })).default([]),
  // ─── Amendment history ───
  amendment_history: z.array(z.object({
    amended_at: z.string(),
    amended_by: z.string(),
    reason: z.string(),
    prior_intake_id: z.string(),
  })).default([]),
});
export type ModuleIntake = z.infer<typeof ModuleIntake>;

// ─── Filesystem helpers ────────────────────────────────────────────────────
export function intakeDir(): string {
  return path.join(harnessRoot(), '.agent-runs', 'intake');
}

export function intakePath(moduleId: string): string {
  return path.join(intakeDir(), `${moduleId}.json`);
}

export function readIntake(moduleId: string): ModuleIntake | null {
  const p = intakePath(moduleId);
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  return ModuleIntake.parse(raw);
}

export function writeIntake(intake: ModuleIntake): void {
  const dir = intakeDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(intakePath(intake.module_id), JSON.stringify(intake, null, 2));
}

export function isIntakeApproved(moduleId: string): boolean {
  const intake = readIntake(moduleId);
  if (!intake) return false;
  if (intake.status !== 'approved') return false;
  // For Tier-1: require ≥4 approver signatures (Business+Technical+Validator+Control owner)
  if (intake.risk_tier === 'tier-1' && intake.approvals.length < 4) return false;
  // For Tier-2: ≥2 approvals (Business+Technical)
  if (intake.risk_tier === 'tier-2' && intake.approvals.length < 2) return false;
  return true;
}

// ─── Intake gate (called before FRD generation) ────────────────────────────
export interface IntakeGateResult {
  pass: boolean;
  reason?: string;
  intake?: ModuleIntake;
}

export function intakeGate(moduleId: string): IntakeGateResult {
  const intake = readIntake(moduleId);
  if (!intake) {
    return {
      pass: false,
      reason: `No intake record for ${moduleId}. Run \`pnpm auto:intake --module ${moduleId}\` to create one.`,
    };
  }
  if (intake.status !== 'approved') {
    return {
      pass: false,
      reason: `Intake ${intake.intake_id} status is "${intake.status}", not "approved". Cannot proceed.`,
      intake,
    };
  }
  if (!isIntakeApproved(moduleId)) {
    return {
      pass: false,
      reason: `Intake ${intake.intake_id} approved but missing required approver signatures for tier ${intake.risk_tier}.`,
      intake,
    };
  }
  return { pass: true, intake };
}
