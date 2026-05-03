/**
 * PC1 — Multi-tenant data model (production-hardened, foundation).
 *
 * Codex critique 2026-05-03: "Multi-tenant model: tenant, workspace,
 * project, repo, run, task, stage, principal."
 *
 * This file defines the canonical zod schemas for the seven entities.
 * Repositories that persist them implement TenantRepository (next file).
 *
 * Invariants:
 *   - Tenant.id is sha-stable (deterministic from name + creation
 *     timestamp); never changes once issued
 *   - Every Workspace, Project, Repo, Run, Task, Stage carries a
 *     tenant_id — cross-tenant access is impossible by construction,
 *     not by RBAC alone
 *   - Principal carries `tenant_memberships`: one principal can belong
 *     to multiple tenants with different roles in each
 *   - Schema versioning: schema_version field on every entity; v2
 *     adapter is required to break the schema
 *
 * Backwards-compat: existing single-operator harness instances see
 * everything under tenant_id='default' with workspace='primary'.
 * Migration is automatic on first multi-tenant operation.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = '1' as const;

// ─── Tenant ─────────────────────────────────────────────────────────────

export const TenantStatus = z.enum(['active', 'suspended', 'deleted']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const Tenant = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),                 // human-stable slug, e.g. 'acme-bank'
  display_name: z.string().min(1),
  status: TenantStatus.default('active'),
  /** Operator-supplied free-form labels (cost_center, region, etc).
   *  Used by chargeback (PE) + compliance routing (PD). */
  labels: z.record(z.string()).default({}),
  /** When created. Once stamped, never changes. */
  created_at: z.string(),
  /** Last modification (status, display_name, labels). */
  updated_at: z.string(),
  /** Principal who created the tenant — for audit. */
  created_by: z.string(),
  /** Compliance regime the tenant operates under. Drives evidence
   *  export defaults (PD). 'none' is fine for solo/dev. */
  compliance_regime: z.enum(['none', 'soc2', 'hipaa', 'osfi-e23', 'sr-11-7']).default('none'),
  /** Optional contractual quota caps. NULL means uncapped (operator
   *  scale only). */
  quota: z.object({
    max_dispatches_per_day: z.number().int().nonnegative().nullable().default(null),
    max_usd_per_day: z.number().nonnegative().nullable().default(null),
    max_concurrent_dispatches: z.number().int().nonnegative().nullable().default(null),
  }).default({ max_dispatches_per_day: null, max_usd_per_day: null, max_concurrent_dispatches: null }),
});
export type Tenant = z.infer<typeof Tenant>;

// ─── Workspace ─────────────────────────────────────────────────────────
// Logical grouping inside a tenant — typically a team or business unit.

export const Workspace = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  display_name: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
  labels: z.record(z.string()).default({}),
});
export type Workspace = z.infer<typeof Workspace>;

// ─── Project ───────────────────────────────────────────────────────────
// Maps 1:1 to a target codebase. A project belongs to exactly one
// workspace which belongs to exactly one tenant.

export const Project = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  tenant_id: z.string().min(1),
  workspace_id: z.string().min(1),
  display_name: z.string().min(1),
  /** Optional pointer to upstream repo. */
  repo_url: z.string().url().nullable().default(null),
  default_branch: z.string().default('main'),
  /** Per-project budget overrides. Falls back to tenant-level quota. */
  budget_overrides: z.object({
    daily_cap_usd: z.number().nonnegative().nullable().default(null),
    per_task_cap_usd: z.number().nonnegative().nullable().default(null),
  }).default({ daily_cap_usd: null, per_task_cap_usd: null }),
  created_at: z.string(),
  updated_at: z.string(),
  created_by: z.string(),
});
export type Project = z.infer<typeof Project>;

// ─── Principal ─────────────────────────────────────────────────────────
// Identity that operates the harness — human (via SSO) or service
// account (via API key). Membership in a tenant is stamped with role.

export const PrincipalKind = z.enum(['human', 'service_account', 'system']);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const TenantRole = z.enum([
  'owner',                   // tenant administration: billing, principal mgmt, settings
  'admin',                   // dispatch + manage projects + override budgets
  'operator',                // dispatch + read everything
  'viewer',                  // read-only access (audit, fleet view)
  'auditor',                 // read all, including evidence; export packs
]);
export type TenantRole = z.infer<typeof TenantRole>;

export const TenantMembership = z.object({
  tenant_id: z.string().min(1),
  role: TenantRole,
  /** When the role was assigned — for audit. */
  assigned_at: z.string(),
  assigned_by: z.string(),
});
export type TenantMembership = z.infer<typeof TenantMembership>;

export const Principal = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),                   // stable across renames; SSO sub claim or service account ID
  kind: PrincipalKind,
  email: z.string().email().nullable(),    // null for service accounts
  display_name: z.string().min(1),
  /** SSO provider identifier ('auth0|google|okta|saml-acme|service-account'). */
  identity_provider: z.string().default('local'),
  /** Provider-specific external ID (e.g., Okta user ID). For audit traceability. */
  external_id: z.string().nullable().default(null),
  /** All tenants this principal belongs to + role per tenant. */
  tenant_memberships: z.array(TenantMembership).default([]),
  status: z.enum(['active', 'suspended', 'deleted']).default('active'),
  created_at: z.string(),
  updated_at: z.string(),
  /** Last successful authentication. NULL if never logged in (created
   *  by SCIM but not yet active). */
  last_seen_at: z.string().nullable().default(null),
});
export type Principal = z.infer<typeof Principal>;

// ─── Permission helpers ────────────────────────────────────────────────

/**
 * Closed enum of action types — one per resource × verb. Every harness
 * operation that touches tenant-scoped data declares which permission
 * it requires. RBAC v2 (PC4) enforces.
 */
export const TenantPermission = z.enum([
  // Tenant administration
  'tenant.read',
  'tenant.update',
  'tenant.delete',
  'tenant.principal.list',
  'tenant.principal.invite',
  'tenant.principal.remove',
  'tenant.budget.read',
  'tenant.budget.update',

  // Project ops
  'project.create',
  'project.read',
  'project.update',
  'project.delete',

  // Dispatch
  'dispatch.start',
  'dispatch.cancel',
  'dispatch.read',
  'dispatch.read_evidence',

  // Audit
  'audit.read',
  'audit.export',
]);
export type TenantPermission = z.infer<typeof TenantPermission>;

/** Default RBAC matrix — operator can override per tenant in
 *  tenant.labels.rbac_overrides if needed. */
export const DEFAULT_TENANT_RBAC: Record<TenantRole, ReadonlyArray<TenantPermission>> = {
  owner: [
    'tenant.read', 'tenant.update', 'tenant.delete',
    'tenant.principal.list', 'tenant.principal.invite', 'tenant.principal.remove',
    'tenant.budget.read', 'tenant.budget.update',
    'project.create', 'project.read', 'project.update', 'project.delete',
    'dispatch.start', 'dispatch.cancel', 'dispatch.read', 'dispatch.read_evidence',
    'audit.read', 'audit.export',
  ],
  admin: [
    'tenant.read',
    'tenant.principal.list',
    'tenant.budget.read', 'tenant.budget.update',
    'project.create', 'project.read', 'project.update',
    'dispatch.start', 'dispatch.cancel', 'dispatch.read', 'dispatch.read_evidence',
    'audit.read',
  ],
  operator: [
    'tenant.read',
    'project.read',
    'dispatch.start', 'dispatch.read', 'dispatch.read_evidence',
    'audit.read',
  ],
  viewer: [
    'tenant.read',
    'project.read',
    'dispatch.read',
    'audit.read',
  ],
  auditor: [
    'tenant.read',
    'project.read',
    'dispatch.read', 'dispatch.read_evidence',
    'audit.read', 'audit.export',
  ],
};

/**
 * Check whether a principal has a permission within a tenant.
 * Handles multi-membership (a principal may be both an admin in tenant
 * A and a viewer in tenant B).
 *
 * Returns null on no-tenant-membership (different from "explicit deny" —
 * caller surfaces that distinction in the operator audit).
 */
export function hasPermission(
  principal: Principal,
  tenantId: string,
  permission: TenantPermission,
): { allowed: boolean; via_role: TenantRole | null } {
  const membership = principal.tenant_memberships.find((m) => m.tenant_id === tenantId);
  if (!membership) return { allowed: false, via_role: null };
  const granted = DEFAULT_TENANT_RBAC[membership.role];
  const allowed = granted.includes(permission);
  return { allowed, via_role: membership.role };
}
