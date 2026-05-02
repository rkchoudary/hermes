/**
 * Two-Key Approval Router (per Codex E2E review 2026-04-30).
 *
 * Codex hard-no on full autonomy for: data deletion, regulatory filings, material
 * financial restatements, customer pricing, capital/liquidity outputs, production
 * model-use expansion. These require human two-key approval, dry-run evidence,
 * blast-radius report, legal/compliance signoff, and rollback plan.
 *
 * AI:
 *  - Generates content
 *  - Provides dry-run evidence + blast-radius report
 *  - Drafts legal/compliance signoff package
 *  - Drafts rollback / compensating-control plan
 *
 * Humans:
 *  - Two-key approval (e.g., CRO + CCO; Controller + CFO)
 *  - Sign legal attestation
 *
 * Per OSFI E-23 + SR 26-2 + SOX §404: every irreversible operation must have
 * an approval record retained for 7 years.
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';

// ─── Operation classification ──────────────────────────────────────────────
export const IrreversibleOp = z.enum([
  'data-deletion',                  // Bulk delete from prod tables; data destruction
  'regulatory-filing',              // External submission to compliance, Fed, EBA, FCA, etc.
  'financial-restatement',          // Material change to prior-period financials
  'customer-pricing-change',        // Pricing rule change affecting customer billing
  'capital-output-change',          // Material change to capital ratio / RWA / TLAC output
  'liquidity-output-change',        // Material change to LCR / NSFR output
  'production-model-use-expansion', // Adding new approved-use to production model
  'production-model-retirement',    // Retiring a production model
  'tenant-onboarding',              // New tenant in M42 (multi-tenancy)
  'tenant-offboarding',             // Tenant data deletion + access revocation
  'schema-breaking-change',         // Backward-incompatible schema migration
  'cross-region-data-movement',     // Data residency change
  'access-grant-elevated',          // Granting elevated production access
  'feature-flag-prod-toggle',       // Toggling a high-risk feature flag in prod
  'override-control-bypass',        // Bypassing a control with documented exception
]);
export type IrreversibleOp = z.infer<typeof IrreversibleOp>;

// ─── Approver role enumeration ─────────────────────────────────────────────
export const ApproverRole = z.enum([
  'CRO',                  // Chief Risk Officer
  'CCO',                  // Chief Compliance Officer
  'Controller',           // Group Controller
  'CFO',                  // Chief Financial Officer
  'CIO',                  // Chief Information Officer
  'CISO',                 // Chief Information Security Officer
  'GeneralCounsel',
  'model-governance-Lead',             // Model Risk Management Lead (independent of build per OSFI E-23)
  'Compliance-Lead',
  'Domain-PM',            // Module business owner
  'Eng-Lead',             // Module technical owner
  'SRE-OnCall',           // Production-readiness sign-off
  'DPO',                  // Data Protection Officer (GDPR)
  'BSA-Officer',          // Bank Secrecy Act / AML Officer
  'Reg-Affairs-Lead',     // Regulatory Affairs (jurisdiction-specific)
]);
export type ApproverRole = z.infer<typeof ApproverRole>;

// ─── Per-op approval requirements ──────────────────────────────────────────
export interface ApprovalRequirement {
  // Minimum number of approvals (the "two-key" minimum is 2; high-risk ops require more)
  min_approvals: number;
  // Which roles MUST be among the approvers (any 1 from each group required)
  required_role_groups: ApproverRole[][];
  // Whether the operator (requester) is excluded from approving their own request
  no_self_approval: boolean;
  // Whether legal attestation is required (e.g., regulatory filings)
  requires_legal_attestation: boolean;
  // Whether model-governance signoff is required (model-bearing ops)
  requires_mrm_signoff: boolean;
  // Whether dry-run evidence must be collected before approval
  requires_dry_run: boolean;
  // Whether blast-radius report must be attached
  requires_blast_radius: boolean;
  // Whether rollback plan must be attached
  requires_rollback_plan: boolean;
}

export const APPROVAL_REQUIREMENTS: Record<IrreversibleOp, ApprovalRequirement> = {
  'data-deletion': {
    min_approvals: 3,
    required_role_groups: [['CRO', 'CISO'], ['Controller', 'CFO'], ['DPO']],
    no_self_approval: true,
    requires_legal_attestation: true,
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'regulatory-filing': {
    min_approvals: 3,
    required_role_groups: [['Controller'], ['Reg-Affairs-Lead'], ['CCO', 'Compliance-Lead']],
    no_self_approval: true,
    requires_legal_attestation: true, // External submission requires legal sign-off
    requires_mrm_signoff: true,       // Models feeding the submission must be model-governance-validated
    requires_dry_run: true,
    requires_blast_radius: false,     // External; not internal blast
    requires_rollback_plan: false,    // External submissions are immutable once filed
  },
  'financial-restatement': {
    min_approvals: 4,
    required_role_groups: [['Controller'], ['CFO'], ['CRO'], ['GeneralCounsel']],
    no_self_approval: true,
    requires_legal_attestation: true,
    requires_mrm_signoff: true,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'customer-pricing-change': {
    min_approvals: 3,
    required_role_groups: [['Domain-PM'], ['CFO', 'Controller'], ['CCO', 'Compliance-Lead']],
    no_self_approval: true,
    requires_legal_attestation: true,
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'capital-output-change': {
    min_approvals: 3,
    required_role_groups: [['CRO'], ['Controller', 'CFO'], ['model-governance-Lead']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: true,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'liquidity-output-change': {
    min_approvals: 3,
    required_role_groups: [['CRO'], ['Controller', 'CFO'], ['model-governance-Lead']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: true,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'production-model-use-expansion': {
    min_approvals: 3,
    required_role_groups: [['model-governance-Lead'], ['Domain-PM'], ['CRO', 'Compliance-Lead']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: true,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'production-model-retirement': {
    min_approvals: 2,
    required_role_groups: [['model-governance-Lead'], ['Domain-PM']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: true,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'tenant-onboarding': {
    min_approvals: 3,
    required_role_groups: [['Domain-PM'], ['CISO'], ['Compliance-Lead', 'CCO']],
    no_self_approval: true,
    requires_legal_attestation: true, // Customer contract signed
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'tenant-offboarding': {
    min_approvals: 3,
    required_role_groups: [['Domain-PM'], ['DPO', 'CISO'], ['GeneralCounsel']],
    no_self_approval: true,
    requires_legal_attestation: true,
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'schema-breaking-change': {
    min_approvals: 2,
    required_role_groups: [['Eng-Lead'], ['Domain-PM']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'cross-region-data-movement': {
    min_approvals: 3,
    required_role_groups: [['DPO'], ['CISO'], ['GeneralCounsel']],
    no_self_approval: true,
    requires_legal_attestation: true,
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'access-grant-elevated': {
    min_approvals: 2,
    required_role_groups: [['CISO'], ['Eng-Lead']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: false,
    requires_dry_run: false,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'feature-flag-prod-toggle': {
    min_approvals: 2,
    required_role_groups: [['Eng-Lead'], ['Domain-PM']],
    no_self_approval: true,
    requires_legal_attestation: false,
    requires_mrm_signoff: false,
    requires_dry_run: true,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
  'override-control-bypass': {
    min_approvals: 4,
    required_role_groups: [['CRO'], ['CCO'], ['CISO'], ['GeneralCounsel']],
    no_self_approval: true,
    requires_legal_attestation: true,
    requires_mrm_signoff: false,
    requires_dry_run: false,
    requires_blast_radius: true,
    requires_rollback_plan: true,
  },
};

// ─── Approval request record ───────────────────────────────────────────────
export const ApprovalRequest = z.object({
  request_id: z.string(),
  operation: IrreversibleOp,
  module_id: z.string().optional(),
  requested_at: z.string(),
  requested_by: z.string(), // operator or AI orchestrator id
  description: z.string(),
  blast_radius_report_path: z.string().optional(),
  dry_run_evidence_path: z.string().optional(),
  rollback_plan_path: z.string().optional(),
  legal_attestation_path: z.string().optional(),
  mrm_signoff_path: z.string().optional(),
  approvals: z.array(z.object({
    approver_role: ApproverRole,
    approver_id: z.string(),
    approved_at: z.string(),
    rationale: z.string(),
    signature_evidence: z.string(),
  })).default([]),
  status: z.enum(['draft', 'pending-approval', 'approved', 'rejected', 'executed', 'rolled-back']),
  executed_at: z.string().optional(),
  rolled_back_at: z.string().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

// ─── Filesystem helpers ────────────────────────────────────────────────────
export function approvalDir(): string {
  return path.join(harnessRoot(), '.agent-runs', 'approvals');
}

export function approvalPath(requestId: string): string {
  return path.join(approvalDir(), `${requestId}.json`);
}

export function readApprovalRequest(requestId: string): ApprovalRequest | null {
  const p = approvalPath(requestId);
  if (!fs.existsSync(p)) return null;
  return ApprovalRequest.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
}

export function writeApprovalRequest(req: ApprovalRequest): void {
  const dir = approvalDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(approvalPath(req.request_id), JSON.stringify(req, null, 2));
}

// ─── Approval gate ─────────────────────────────────────────────────────────
export interface ApprovalGateResult {
  can_execute: boolean;
  reason?: string;
  required: ApprovalRequirement;
  request: ApprovalRequest;
  remaining_approvals: number;
  missing_role_groups: ApproverRole[][];
}

export function approvalGate(requestId: string): ApprovalGateResult {
  const req = readApprovalRequest(requestId);
  if (!req) {
    throw new Error(`No approval request: ${requestId}`);
  }
  const required = APPROVAL_REQUIREMENTS[req.operation];

  // Check prerequisites
  const prereqs: string[] = [];
  if (required.requires_dry_run && !req.dry_run_evidence_path) prereqs.push('dry-run evidence');
  if (required.requires_blast_radius && !req.blast_radius_report_path) prereqs.push('blast-radius report');
  if (required.requires_rollback_plan && !req.rollback_plan_path) prereqs.push('rollback plan');
  if (required.requires_legal_attestation && !req.legal_attestation_path) prereqs.push('legal attestation');
  if (required.requires_mrm_signoff && !req.mrm_signoff_path) prereqs.push('model-governance signoff');

  if (prereqs.length > 0) {
    return {
      can_execute: false,
      reason: `Missing prerequisites: ${prereqs.join(', ')}`,
      required,
      request: req,
      remaining_approvals: required.min_approvals,
      missing_role_groups: required.required_role_groups,
    };
  }

  // Check no-self-approval
  if (required.no_self_approval) {
    const selfApproval = req.approvals.find((a) => a.approver_id === req.requested_by);
    if (selfApproval) {
      return {
        can_execute: false,
        reason: `Self-approval not allowed: ${req.requested_by} cannot approve their own request`,
        required,
        request: req,
        remaining_approvals: required.min_approvals,
        missing_role_groups: required.required_role_groups,
      };
    }
  }

  // Check role-group coverage
  const presentRoles = new Set(req.approvals.map((a) => a.approver_role));
  const missingGroups: ApproverRole[][] = [];
  for (const group of required.required_role_groups) {
    const coveredByThisGroup = group.some((r) => presentRoles.has(r));
    if (!coveredByThisGroup) missingGroups.push(group);
  }

  if (missingGroups.length > 0) {
    return {
      can_execute: false,
      reason: `Missing approvals from required role groups: ${missingGroups.map((g) => g.join('|')).join(', ')}`,
      required,
      request: req,
      remaining_approvals: missingGroups.length,
      missing_role_groups: missingGroups,
    };
  }

  // Check minimum count
  if (req.approvals.length < required.min_approvals) {
    return {
      can_execute: false,
      reason: `Need ${required.min_approvals} approvals, have ${req.approvals.length}`,
      required,
      request: req,
      remaining_approvals: required.min_approvals - req.approvals.length,
      missing_role_groups: [],
    };
  }

  return {
    can_execute: true,
    required,
    request: req,
    remaining_approvals: 0,
    missing_role_groups: [],
  };
}
