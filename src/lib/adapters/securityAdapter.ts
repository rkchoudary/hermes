/**
 * Security stack adapter interface — Sprint F per FRD-HARNESS §9B + threat model.
 *
 * Defines the provider-agnostic contracts the harness uses for:
 *   - SSO/OIDC authentication (Azure AD, Okta, Auth0 — operator picks)
 *   - RBAC authorization (operator/validator/admin/auditor + permission matrix)
 *   - PAM break-glass for elevated operations
 *   - KMS-encrypted secrets at rest (AWS KMS, GCP KMS, Vault — operator picks)
 *   - SIEM event forwarding (Splunk HEC, Datadog Audit, Sentinel — operator picks)
 *
 * Provider-specific implementations land in sibling files (azureAdSsoAdapter.ts,
 * splunkSiemAdapter.ts, etc.) once operator picks vendors. The harness call
 * sites depend only on the interfaces here.
 *
 * Per FRD-HARNESS §11: --dangerously-skip-permissions is PROHIBITED in
 * production (production_use=true). The PAM adapter's break-glass path
 * is the only sanctioned override path; it requires:
 *   - Two-key approval (re-uses src/lib/twoKeyApproval.ts)
 *   - Reason recorded
 *   - SIEM event emitted on grant + on revoke
 *   - Time-bounded (default 1h max)
 */

// ─── SSO / OIDC ───────────────────────────────────────────────────────────
export interface UserPrincipal {
  /** Stable identifier (subject claim from OIDC). Never rotated. */
  sub: string;
  /** Email or username for display + audit logs. */
  email: string;
  /** Display name (operator-visible). */
  name: string;
  /** OIDC groups claim (or equivalent SAML attribute). Drives RBAC role lookup. */
  groups: string[];
  /** Authentication-method context — e.g., 'mfa-totp', 'fido2', 'sso-saml'. */
  amr: string[];
  /** ISO timestamp of original authentication; harness rejects sessions older than session_max_age. */
  auth_time: string;
}

export interface SsoAdapter {
  /** Validate an OIDC ID token + return the user principal. */
  verifyToken(token: string): Promise<UserPrincipal | null>;

  /** Refresh an active session (returns new token + renewed expiry). */
  refreshSession(refreshToken: string): Promise<{ id_token: string; refresh_token: string; expires_at: string } | null>;

  /** Health check the IdP. */
  health(): Promise<{ ok: boolean; detail: string; idp_host?: string }>;
}

// ─── RBAC ─────────────────────────────────────────────────────────────────
export const HARNESS_ROLES = ['operator', 'validator', 'admin', 'auditor'] as const;
export type HarnessRole = typeof HARNESS_ROLES[number];

/**
 * Permission domain enumeration. Maps to harness operations.
 */
export const PERMISSIONS = [
  // Read permissions
  'read:intake',
  'read:sdlc-state',
  'read:validation-record',
  'read:approval-request',
  'read:evidence-graph',
  'read:task-pack',
  'read:audit-pack',

  // Write — module workflow
  'write:intake-create',
  'write:intake-approve',           // tier-3/2; tier-1 requires admin
  'write:intake-amend',
  'write:sdlc-transition',
  'write:validation-create',
  'write:validation-sign',          // validator only
  'write:approval-request',
  'write:approval-sign',
  'write:task-pack',

  // Privileged
  'priv:override-control-bypass',   // PAM break-glass required
  'priv:kill-switch',
  'priv:tier-1-intake-approve',
  'priv:production-toggle',

  // Audit-only
  'audit:read-all',                 // auditor — read all without write
  'audit:export-pack',
] as const;
export type Permission = typeof PERMISSIONS[number];

/**
 * Default permission matrix per role. Operator can extend in
 * .harness/config.yaml `rbac.role_permissions: {role: [perm,...]}` to add
 * org-specific permissions. Mins below are baseline.
 */
export const DEFAULT_PERMISSIONS: Record<HarnessRole, readonly Permission[]> = {
  operator: [
    'read:intake', 'read:sdlc-state', 'read:validation-record',
    'read:approval-request', 'read:evidence-graph', 'read:task-pack',
    'read:audit-pack',
    'write:intake-create', 'write:intake-amend', 'write:sdlc-transition',
    'write:approval-request', 'write:task-pack',
  ],
  validator: [
    'read:intake', 'read:sdlc-state', 'read:validation-record',
    'read:approval-request', 'read:evidence-graph', 'read:task-pack',
    'read:audit-pack',
    'write:validation-create', 'write:validation-sign',
  ],
  admin: [
    'read:intake', 'read:sdlc-state', 'read:validation-record',
    'read:approval-request', 'read:evidence-graph', 'read:task-pack',
    'read:audit-pack',
    'write:intake-create', 'write:intake-approve', 'write:intake-amend',
    'write:sdlc-transition', 'write:validation-create',
    'write:approval-request', 'write:approval-sign', 'write:task-pack',
    'priv:tier-1-intake-approve', 'priv:production-toggle',
  ],
  auditor: [
    'read:intake', 'read:sdlc-state', 'read:validation-record',
    'read:approval-request', 'read:evidence-graph', 'read:task-pack',
    'read:audit-pack',
    'audit:read-all', 'audit:export-pack',
  ],
};

export interface RbacAdapter {
  /** Resolve roles for a user principal from group claims. */
  rolesFor(user: UserPrincipal): HarnessRole[];

  /** Check whether a user has a permission. */
  has(user: UserPrincipal, permission: Permission): boolean;

  /** Throw with structured reason if user lacks permission. */
  require(user: UserPrincipal, permission: Permission): void;

  /** All effective permissions for a user across their roles + inheritance. */
  effective(user: UserPrincipal): Permission[];
}

// ─── PAM (privileged-access management) ──────────────────────────────────
export interface PamElevationRequest {
  request_id: string;
  requested_by: string;
  requested_at: string;
  /** Permissions being elevated to (subset of priv:*). */
  permissions: Permission[];
  /** Justification for the elevation. */
  reason: string;
  /** Time-box for the elevation; refused if > pam.max_elevation_seconds. */
  duration_seconds: number;
}

export interface PamElevationGrant {
  request_id: string;
  granted_at: string;
  expires_at: string;
  granted_by: string[];          // co-signers from twoKeyApproval flow
  break_glass_token: string;     // single-use token presented for elevated ops
  audit_event_id: string;        // SIEM event ID for the grant
}

export interface PamAdapter {
  request(req: PamElevationRequest): Promise<{ ok: boolean; status: 'pending' | 'rejected'; reason?: string }>;
  grant(request_id: string, by: UserPrincipal): Promise<PamElevationGrant>;
  revoke(grant_id: string, by: UserPrincipal, reason: string): Promise<void>;
  /** Verify a presented break_glass_token is currently valid + not expired. */
  verify(break_glass_token: string): Promise<{ valid: boolean; grant?: PamElevationGrant; reason?: string }>;
}

// ─── KMS (secrets at rest) ────────────────────────────────────────────────
export interface KmsAdapter {
  /** Encrypt arbitrary plaintext under a named key. Returns ciphertext blob. */
  encrypt(plaintext: string, key_alias: string, context?: Record<string, string>): Promise<string>;

  /** Decrypt a ciphertext blob. context must match encrypt() context for AAD-bound keys. */
  decrypt(ciphertext: string, context?: Record<string, string>): Promise<string>;

  /** Verify the configured KMS root key is accessible + permissioned. */
  health(): Promise<{ ok: boolean; detail: string; key_arn?: string }>;
}

// ─── SIEM (security event forwarding) ────────────────────────────────────
export interface SiemEvent {
  /** Event class — drives SIEM rule routing. */
  category: 'auth' | 'rbac' | 'pam' | 'audit-trail' | 'override' | 'kill-switch' | 'data-access' | 'config-change';
  /** Severity level — drives alerting. */
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  /** ISO timestamp the event occurred (not the forward time). */
  occurred_at: string;
  /** Source — which harness component emitted this. */
  source: string;  // e.g. 'auto:work', 'auto:approval', 'auto:sdlc'
  /** User principal sub claim, or 'system'/'auto-worker' identifier. */
  actor: string;
  /** Resource being acted on — module_id, intake_id, request_id, etc. */
  resource: string;
  /** Operation verb — 'sign', 'approve', 'override', 'kill-switch-engage', etc. */
  action: string;
  /** Outcome — drives downstream rules. */
  outcome: 'success' | 'failure' | 'blocked';
  /** Free-form structured payload for SIEM rule extraction. */
  payload: Record<string, unknown>;
}

export interface SiemAdapter {
  /** Send a single event. Adapter handles batching internally. */
  send(event: SiemEvent): Promise<{ ok: boolean; siem_event_id?: string; error?: string }>;

  /** Bulk-send (for backfill or graph-export scenarios). */
  sendBatch(events: SiemEvent[]): Promise<{ sent: number; failed: number; failures: { index: number; reason: string }[] }>;

  /** Health probe to confirm the SIEM endpoint is reachable + authenticated. */
  health(): Promise<{ ok: boolean; detail: string; endpoint?: string }>;

  /** Ensure pending events are flushed (called on graceful shutdown). */
  flush(): Promise<void>;
}

// ─── Composite security store ────────────────────────────────────────────
export interface HarnessSecurityStack {
  backend_name: string;
  sso: SsoAdapter;
  rbac: RbacAdapter;
  pam: PamAdapter;
  kms: KmsAdapter;
  siem: SiemAdapter;
  health(): Promise<{ ok: boolean; per_subsystem: Record<string, { ok: boolean; detail: string }> }>;
}

// ─── Default RBAC implementation (config-only; works without external deps) ──
export class DefaultRbacAdapter implements RbacAdapter {
  constructor(
    /** Operator-supplied: group → role mapping (e.g., {"banking-mrm": "validator"}). */
    private groupToRole: Record<string, HarnessRole>,
    /** Optional override of DEFAULT_PERMISSIONS. */
    private rolePermissions: Partial<Record<HarnessRole, readonly Permission[]>> = {}
  ) {}

  rolesFor(user: UserPrincipal): HarnessRole[] {
    const roles = new Set<HarnessRole>();
    for (const g of user.groups) {
      const r = this.groupToRole[g];
      if (r) roles.add(r);
    }
    return Array.from(roles);
  }

  has(user: UserPrincipal, permission: Permission): boolean {
    return this.effective(user).includes(permission);
  }

  require(user: UserPrincipal, permission: Permission): void {
    if (!this.has(user, permission)) {
      throw new Error(`Permission denied: user ${user.email} (roles: [${this.rolesFor(user).join(', ')}]) lacks ${permission}`);
    }
  }

  effective(user: UserPrincipal): Permission[] {
    const out = new Set<Permission>();
    for (const role of this.rolesFor(user)) {
      const perms = this.rolePermissions[role] ?? DEFAULT_PERMISSIONS[role];
      for (const p of perms) out.add(p);
    }
    return Array.from(out);
  }
}

// ─── No-op SIEM adapter (for dev/test where no SIEM is provisioned) ───────
export class NoopSiemAdapter implements SiemAdapter {
  private buffer: SiemEvent[] = [];
  async send(event: SiemEvent) {
    this.buffer.push(event);
    return { ok: true, siem_event_id: `noop-${Date.now()}-${this.buffer.length}` };
  }
  async sendBatch(events: SiemEvent[]) {
    this.buffer.push(...events);
    return { sent: events.length, failed: 0, failures: [] };
  }
  async health() {
    return { ok: true, detail: `NoopSiemAdapter — ${this.buffer.length} events buffered locally (NOT forwarded; configure real SIEM for production_use)` };
  }
  async flush() { /* nothing to flush */ }
  /** Test/diagnostic accessor. */
  getBufferedEvents(): readonly SiemEvent[] { return this.buffer; }
  clearBuffer(): void { this.buffer.length = 0; }
}
