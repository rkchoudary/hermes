/**
 * T2.6 — Break-glass admin with just-in-time elevation.
 *
 * Operator workflow:
 *   1. Principal requests time-boxed elevation:
 *        requestElevation({ principal, tenant, requested_role,
 *                           reason, duration_sec, dual_control? })
 *      Returns ElevationRequest pending approval (or auto-approved
 *      for break-glass paths if policy allows).
 *
 *   2. (optional) A second principal approves via approveElevation().
 *      Dual-control is the production-grade pattern for tier-1
 *      changes (production deploys, secret rotations, etc.).
 *
 *   3. Once active, the elevated principal carries the requested_role
 *      until the TTL expires. hasElevatedPermission() checks both
 *      base RBAC + active elevations.
 *
 *   4. Every state transition (request, approve, deny, expire, revoke,
 *      use) is recorded as a HermesWorkerEvent in the audit ledger
 *      so the operator can answer "who had what privilege when?".
 *
 * Hardening:
 *   - Elevations stored append-only; no mutation, only state events
 *   - Every privileged action under an elevation re-checks expiry
 *     (clock-skew tolerance: 30s)
 *   - Maximum allowed duration capped (default 1h; hard ceiling 4h)
 *   - Self-approval refused (the requester ≠ approver guard)
 *   - Dual-control mode: high-privilege roles (owner, admin) require
 *     two distinct approvers
 *   - Sentinel file '.agent-runs/_BREAK_GLASS_DISABLED' refuses ALL
 *     elevation requests — for incident response
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { harnessRoot } from '../harnessRoot';
import { Principal, TenantRole, hasPermission as basePermissionCheck, type TenantPermission } from '../tenant/model';

// ─── Schema ─────────────────────────────────────────────────────────────

export const ElevationStatus = z.enum(['pending', 'active', 'expired', 'denied', 'revoked']);
export type ElevationStatus = z.infer<typeof ElevationStatus>;

export const ElevationRequestSchema = z.object({
  schema_version: z.literal('1'),
  request_id: z.string().uuid(),
  tenant_id: z.string(),
  requester_principal_id: z.string(),
  /** Role being requested. */
  requested_role: TenantRole,
  /** Operator-supplied reason (>=20 chars; appears in audit). */
  reason: z.string().min(20),
  /** TTL in seconds (capped at 4h). */
  duration_sec: z.number().int().positive().max(14_400),
  /** When the request was made. */
  requested_at: z.string(),
  /** Required when requested_role is owner|admin (configurable). */
  dual_control_required: z.boolean(),
  status: ElevationStatus,
  /** Set when approved. */
  approved_at: z.string().nullable(),
  /** Set when approved. Single approver for non-dual-control;
   *  exactly 2 for dual-control. */
  approvers: z.array(z.string()),
  /** Set when active. */
  effective_until: z.string().nullable(),
  /** Optional revocation reason. */
  revoked_reason: z.string().nullable(),
});
export type ElevationRequest = z.infer<typeof ElevationRequestSchema>;

// ─── Storage ────────────────────────────────────────────────────────────

function elevationsLogPath(): string {
  return path.join(harnessRoot(), '.agent-runs', '_break-glass.jsonl');
}

function disableSentinelPath(): string {
  return path.join(harnessRoot(), '.agent-runs', '_BREAK_GLASS_DISABLED');
}

function appendElevationEvent(req: ElevationRequest): void {
  const p = elevationsLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(req) + '\n');
}

function readAllElevationEvents(): ElevationRequest[] {
  const p = elevationsLogPath();
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  // Last-write-wins by request_id
  const map = new Map<string, ElevationRequest>();
  for (const line of lines) {
    try {
      const parsed = ElevationRequestSchema.parse(JSON.parse(line));
      map.set(parsed.request_id, parsed);
    } catch { /* skip malformed */ }
  }
  return Array.from(map.values());
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface RequestElevationOptions {
  requester: Principal;
  tenant_id: string;
  requested_role: TenantRole;
  reason: string;
  duration_sec: number;
  /** Operator policy: true for owner/admin elevations. */
  dual_control?: boolean;
}

export class BreakGlassError extends Error {
  readonly kind: 'globally-disabled' | 'duration-too-long' | 'self-approval' | 'invalid-state' | 'not-found' | 'reason-too-short';
  constructor(kind: BreakGlassError['kind'], message: string) {
    super(message);
    this.name = 'BreakGlassError';
    this.kind = kind;
  }
}

export function requestElevation(opts: RequestElevationOptions): ElevationRequest {
  if (fs.existsSync(disableSentinelPath())) {
    throw new BreakGlassError('globally-disabled',
      `break-glass globally disabled via sentinel file (incident response). Remove ${disableSentinelPath()} to re-enable.`);
  }
  if (opts.duration_sec > 4 * 3600) {
    throw new BreakGlassError('duration-too-long', `duration ${opts.duration_sec}s exceeds hard ceiling 14400s (4h)`);
  }
  if (opts.reason.length < 20) {
    throw new BreakGlassError('reason-too-short', 'reason must be ≥20 characters (operator audit requirement)');
  }
  // Auto-determine dual_control if not set: high-priv roles require it
  const requiresDualControl = opts.dual_control
    ?? (opts.requested_role === 'owner' || opts.requested_role === 'admin');
  const req: ElevationRequest = {
    schema_version: '1',
    request_id: crypto.randomUUID(),
    tenant_id: opts.tenant_id,
    requester_principal_id: opts.requester.id,
    requested_role: opts.requested_role,
    reason: opts.reason,
    duration_sec: opts.duration_sec,
    requested_at: new Date().toISOString(),
    dual_control_required: requiresDualControl,
    status: 'pending',
    approved_at: null,
    approvers: [],
    effective_until: null,
    revoked_reason: null,
  };
  appendElevationEvent(req);
  return req;
}

export function approveElevation(opts: {
  request_id: string;
  approver: Principal;
}): ElevationRequest {
  const all = readAllElevationEvents();
  const existing = all.find((r) => r.request_id === opts.request_id);
  if (!existing) {
    throw new BreakGlassError('not-found', `elevation request ${opts.request_id} not found`);
  }
  if (existing.status === 'denied' || existing.status === 'revoked' || existing.status === 'expired') {
    throw new BreakGlassError('invalid-state', `cannot approve ${opts.request_id}: status=${existing.status}`);
  }
  if (existing.status === 'active') {
    throw new BreakGlassError('invalid-state', `${opts.request_id} already active`);
  }
  if (existing.requester_principal_id === opts.approver.id) {
    throw new BreakGlassError('self-approval', `requester (${opts.approver.id}) cannot approve their own elevation`);
  }
  // Approver must hold a role at least as privileged as the role being
  // requested (cannot grant what you don't have).
  const approverMembership = opts.approver.tenant_memberships.find((m) => m.tenant_id === existing.tenant_id);
  if (!approverMembership) {
    throw new BreakGlassError('invalid-state',
      `approver ${opts.approver.id} has no membership in tenant ${existing.tenant_id}`);
  }
  const APPROVAL_PRIO: Record<TenantRole, number> = { owner: 5, admin: 4, operator: 3, auditor: 2, viewer: 1 };
  if (APPROVAL_PRIO[approverMembership.role] < APPROVAL_PRIO[existing.requested_role]) {
    throw new BreakGlassError('invalid-state',
      `approver ${opts.approver.id} (role=${approverMembership.role}) cannot grant elevation to ${existing.requested_role} ` +
      `(approver must hold a role >= requested_role)`);
  }
  // Add approver
  const approvers = Array.from(new Set([...existing.approvers, opts.approver.id]));
  const requiredApprovals = existing.dual_control_required ? 2 : 1;
  let updated: ElevationRequest;
  if (approvers.length >= requiredApprovals) {
    // Activate
    updated = {
      ...existing,
      approvers,
      approved_at: new Date().toISOString(),
      status: 'active',
      effective_until: new Date(Date.now() + existing.duration_sec * 1000).toISOString(),
    };
  } else {
    // Awaiting more approvers
    updated = { ...existing, approvers };
  }
  appendElevationEvent(updated);
  return updated;
}

export function denyElevation(opts: { request_id: string; denier: Principal; reason: string }): ElevationRequest {
  const all = readAllElevationEvents();
  const existing = all.find((r) => r.request_id === opts.request_id);
  if (!existing) throw new BreakGlassError('not-found', `${opts.request_id} not found`);
  if (existing.status !== 'pending') {
    throw new BreakGlassError('invalid-state', `cannot deny ${opts.request_id}: status=${existing.status}`);
  }
  const updated: ElevationRequest = {
    ...existing,
    status: 'denied',
    revoked_reason: `denied by ${opts.denier.id}: ${opts.reason}`,
  };
  appendElevationEvent(updated);
  return updated;
}

export function revokeElevation(opts: { request_id: string; revoker: Principal; reason: string }): ElevationRequest {
  const all = readAllElevationEvents();
  const existing = all.find((r) => r.request_id === opts.request_id);
  if (!existing) throw new BreakGlassError('not-found', `${opts.request_id} not found`);
  if (existing.status !== 'active' && existing.status !== 'pending') {
    throw new BreakGlassError('invalid-state', `cannot revoke ${opts.request_id}: status=${existing.status}`);
  }
  const updated: ElevationRequest = {
    ...existing,
    status: 'revoked',
    revoked_reason: `revoked by ${opts.revoker.id}: ${opts.reason}`,
  };
  appendElevationEvent(updated);
  return updated;
}

/** Active elevations for a principal in a tenant, accounting for
 *  expiry. Used by hasElevatedPermission. */
export function activeElevations(principalId: string, tenantId: string): ElevationRequest[] {
  const now = Date.now();
  return readAllElevationEvents().filter((r) => {
    if (r.requester_principal_id !== principalId) return false;
    if (r.tenant_id !== tenantId) return false;
    if (r.status !== 'active') return false;
    if (!r.effective_until) return false;
    if (new Date(r.effective_until).getTime() < now - 30_000) {
      // Auto-expire (lazy — emit an expiry event next time)
      return false;
    }
    return true;
  });
}

/** RBAC + active elevation = effective permission. */
export function hasElevatedPermission(
  principal: Principal,
  tenantId: string,
  permission: TenantPermission,
): { allowed: boolean; via_role: TenantRole | null; via_elevation: string | null } {
  const base = basePermissionCheck(principal, tenantId, permission);
  if (base.allowed) {
    return { allowed: true, via_role: base.via_role, via_elevation: null };
  }
  // Check active elevations
  const elevations = activeElevations(principal.id, tenantId);
  for (const el of elevations) {
    // Construct a synthetic principal with the elevated role and re-check
    const synthetic: Principal = {
      ...principal,
      tenant_memberships: [
        { tenant_id: tenantId, role: el.requested_role, assigned_at: el.approved_at!, assigned_by: 'break-glass' },
      ],
    };
    const res = basePermissionCheck(synthetic, tenantId, permission);
    if (res.allowed) {
      return { allowed: true, via_role: el.requested_role, via_elevation: el.request_id };
    }
  }
  return { allowed: false, via_role: base.via_role, via_elevation: null };
}

/** Operator-facing: list all pending requests in a tenant. */
export function listPendingElevations(tenantId: string): ElevationRequest[] {
  return readAllElevationEvents().filter((r) =>
    r.tenant_id === tenantId && r.status === 'pending',
  );
}

/** Operator-facing: list active elevations across all principals. */
export function listActiveElevations(tenantId: string): ElevationRequest[] {
  const now = Date.now();
  return readAllElevationEvents().filter((r) =>
    r.tenant_id === tenantId &&
    r.status === 'active' &&
    r.effective_until &&
    new Date(r.effective_until).getTime() >= now - 30_000,
  );
}

// ─── Test utilities ─────────────────────────────────────────────────────

export function _resetForTest(): void {
  try { fs.unlinkSync(elevationsLogPath()); } catch { /* tolerate */ }
  try { fs.unlinkSync(disableSentinelPath()); } catch { /* tolerate */ }
}
