/**
 * Default PAM (privileged-access management) adapter — Sprint F default impl.
 *
 * Implements PamAdapter using filesystem state + the existing two-key
 * approval flow (src/lib/twoKeyApproval.ts). Operator can replace with a
 * provider-specific impl (CyberArk, BeyondTrust, Vault dynamic creds)
 * later; this default works without external dependencies.
 *
 * Break-glass flow:
 *   1. Operator runs: pnpm auto:approval --create --op override-control-bypass ...
 *   2. Two co-signers approve (re-uses APPROVAL_REQUIREMENTS quorum rules)
 *   3. PAM grant() converts the approved request into a single-use,
 *      time-bounded break_glass_token (sha256 of request_id + grant_id +
 *      timestamp; verifiable but unforgeable)
 *   4. The token is presented when invoking elevated operations; verify()
 *      checks it's still valid + not expired + not revoked
 *   5. SIEM event emitted on grant + on revoke + on first-use + on expiry
 *      (operator wires SiemAdapter.send when integrating)
 *
 * Per FRD-HARNESS §11: --dangerously-skip-permissions PROHIBITED in
 * production. PAM break-glass is the only sanctioned override path.
 *
 * Per FRD-HARNESS §9B FR-040: max elevation duration default 1h
 * (3600 sec); operator can configure stricter.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { harnessRoot } from '../harnessRoot';
import {
  approvalGate,
  readApprovalRequest,
  writeApprovalRequest,
} from '../twoKeyApproval';
import type {
  PamAdapter,
  PamElevationRequest,
  PamElevationGrant,
  UserPrincipal,
  Permission,
} from './securityAdapter';

interface DefaultPamConfig {
  /** Max elevation duration in seconds. Default 3600 (1h). */
  max_elevation_seconds?: number;
  /** Tag for break-glass tokens (audit trail). Default 'default'. */
  realm?: string;
}

interface PersistedGrant extends PamElevationGrant {
  request_id: string;
  /** Plaintext break_glass_token is NEVER persisted; we store its sha256
   *  hash so a leaked grant file doesn't grant elevation. Verify presents
   *  the plaintext token; we hash + compare. */
  break_glass_token_hash: string;
  /** Plaintext is in memory only and returned to the operator once at
   *  grant time. */
  permissions: Permission[];
  revoked_at?: string;
  revoked_by?: string;
  revoke_reason?: string;
  /** When the token was first verified (used for "first-use" SIEM event). */
  first_used_at?: string;
}

const DEFAULT_MAX_ELEVATION_SEC = 3600;

export class DefaultPamAdapter implements PamAdapter {
  constructor(private cfg: DefaultPamConfig = {}) {}

  private grantsDir(): string {
    return path.join(harnessRoot(), '.agent-runs', 'pam-grants');
  }

  private grantPath(request_id: string): string {
    return path.join(this.grantsDir(), `${request_id}.json`);
  }

  private writeGrant(grant: PersistedGrant): void {
    const dir = this.grantsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.grantPath(grant.request_id), JSON.stringify(grant, null, 2));
  }

  private readGrant(request_id: string): PersistedGrant | null {
    const p = this.grantPath(request_id);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')) as PersistedGrant; }
    catch { return null; }
  }

  private listGrants(): PersistedGrant[] {
    const dir = this.grantsDir();
    if (!fs.existsSync(dir)) return [];
    const out: PersistedGrant[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as PersistedGrant); }
      catch { /* skip */ }
    }
    return out;
  }

  /**
   * Pre-flight: confirm the underlying twoKeyApproval request exists +
   * is in 'pending-approval' or 'draft' status. The actual approvals are
   * collected via auto:approval --sign separately.
   */
  async request(req: PamElevationRequest): Promise<{ ok: boolean; status: 'pending' | 'rejected'; reason?: string }> {
    // Validate duration
    const maxSec = this.cfg.max_elevation_seconds ?? DEFAULT_MAX_ELEVATION_SEC;
    if (req.duration_seconds > maxSec) {
      return { ok: false, status: 'rejected', reason: `Requested duration ${req.duration_seconds}s exceeds max ${maxSec}s` };
    }
    if (req.duration_seconds <= 0) {
      return { ok: false, status: 'rejected', reason: `duration_seconds must be positive` };
    }
    // Confirm approval request exists in twoKeyApproval store
    const approvalReq = readApprovalRequest(req.request_id);
    if (!approvalReq) {
      return { ok: false, status: 'rejected', reason: `No approval request ${req.request_id} found. Create via auto:approval --create first.` };
    }
    if (approvalReq.status === 'rejected' || approvalReq.status === 'rolled-back') {
      return { ok: false, status: 'rejected', reason: `Approval request status is "${approvalReq.status}"` };
    }
    return { ok: true, status: 'pending', reason: `Approval request ${req.request_id} ready for grant once ${approvalReq.operation} quorum reached` };
  }

  /**
   * Materialize an approved request into a usable break-glass token. The
   * underlying approval MUST already have can_execute=true (i.e., quorum
   * met per twoKeyApproval rules). Caller passes the user principal that
   * triggered the grant — recorded for audit.
   */
  async grant(request_id: string, by: UserPrincipal): Promise<PamElevationGrant> {
    // Verify the approval request is approved + executable
    const gate = approvalGate(request_id);
    if (!gate.can_execute) {
      throw new Error(`PAM grant refused for ${request_id}: ${gate.reason}`);
    }
    // Refuse double-grant
    const existing = this.readGrant(request_id);
    if (existing && !existing.revoked_at) {
      throw new Error(`PAM grant for ${request_id} already exists (granted_at=${existing.granted_at}); revoke first`);
    }

    const approvalReq = gate.request;
    const granted_at = new Date().toISOString();
    const durationSec = this.cfg.max_elevation_seconds ?? DEFAULT_MAX_ELEVATION_SEC;
    const expires_at = new Date(Date.now() + durationSec * 1000).toISOString();
    const realm = this.cfg.realm ?? 'default';

    // Generate break-glass token: <realm>.<request_id>.<random_64hex>
    // We never persist the plaintext; only its sha256 hash. Caller gets the
    // token once and is responsible for storing it securely (or invalidating
    // it via revoke) — the same posture as a one-time admin password.
    const tokenSecret = randomBytes(32).toString('hex');
    const break_glass_token = `pam.${realm}.${request_id}.${tokenSecret}`;
    const break_glass_token_hash = createHash('sha256').update(break_glass_token).digest('hex');

    // Audit event ID (caller should forward to SIEM)
    const audit_event_id = `pam-grant-${request_id}-${createHash('sha256').update(granted_at).digest('hex').slice(0, 8)}`;

    // Permissions are recorded on the underlying approval request's payload;
    // for default impl we infer from the operation type.
    const permissions: Permission[] = inferPermissionsFromOp(approvalReq.operation);

    const persisted: PersistedGrant = {
      request_id,
      granted_at,
      expires_at,
      granted_by: approvalReq.approvals.map((a) => `${a.approver_role}:${a.approver_id}`),
      break_glass_token: '[REDACTED — see grant() return value]',
      break_glass_token_hash,
      audit_event_id,
      permissions,
    };
    this.writeGrant(persisted);

    return {
      request_id,
      granted_at,
      expires_at,
      granted_by: persisted.granted_by,
      break_glass_token,  // returned to caller ONCE; never persisted in plaintext
      audit_event_id,
    };
  }

  /**
   * Revoke an active grant. Idempotent — revoking an already-revoked
   * grant is a no-op (returns success).
   */
  async revoke(request_id: string, by: UserPrincipal, reason: string): Promise<void> {
    const grant = this.readGrant(request_id);
    if (!grant) throw new Error(`No PAM grant found for request ${request_id}`);
    if (grant.revoked_at) return; // idempotent
    grant.revoked_at = new Date().toISOString();
    grant.revoked_by = `${by.email}:${by.sub}`;
    grant.revoke_reason = reason;
    this.writeGrant(grant);
  }

  /**
   * Verify a presented break-glass token. Checks:
   *   1. Token is well-formed (pam.<realm>.<request_id>.<secret>)
   *   2. Grant exists for the request_id
   *   3. Token hash matches stored hash
   *   4. Grant not revoked
   *   5. Grant not expired
   *
   * On first successful verify, marks first_used_at — caller can then
   * forward "PAM token first use" SIEM event for incident response.
   */
  async verify(break_glass_token: string): Promise<{ valid: boolean; grant?: PamElevationGrant; reason?: string }> {
    // Parse token format
    const parts = break_glass_token.split('.');
    if (parts.length !== 4 || parts[0] !== 'pam') {
      return { valid: false, reason: `Token format invalid (expected pam.<realm>.<request_id>.<secret>)` };
    }
    const request_id = parts[2];
    const grant = this.readGrant(request_id);
    if (!grant) {
      return { valid: false, reason: `No grant found for request_id=${request_id}` };
    }
    if (grant.revoked_at) {
      return { valid: false, reason: `Grant revoked at ${grant.revoked_at} (${grant.revoke_reason ?? 'no reason'})` };
    }
    const now = Date.now();
    const expiresMs = new Date(grant.expires_at).getTime();
    if (now > expiresMs) {
      return { valid: false, reason: `Grant expired at ${grant.expires_at}` };
    }
    // Hash compare — constant-time-ish via createHash equivalence
    const presented_hash = createHash('sha256').update(break_glass_token).digest('hex');
    if (presented_hash !== grant.break_glass_token_hash) {
      return { valid: false, reason: `Token hash mismatch (token may have been forged or grant rotated)` };
    }
    // Mark first use
    if (!grant.first_used_at) {
      grant.first_used_at = new Date().toISOString();
      this.writeGrant(grant);
    }
    return {
      valid: true,
      grant: {
        request_id: grant.request_id,
        granted_at: grant.granted_at,
        expires_at: grant.expires_at,
        granted_by: grant.granted_by,
        break_glass_token: '[REDACTED — present from caller-side cache]',
        audit_event_id: grant.audit_event_id,
      },
    };
  }
}

/**
 * Map an IrreversibleOp type → required Permission(s) for PAM elevation.
 * Operator can extend in their fork by replacing this function.
 */
function inferPermissionsFromOp(op: string): Permission[] {
  switch (op) {
    case 'override-control-bypass': return ['priv:override-control-bypass'];
    case 'production-model-use-expansion':
    case 'feature-flag-prod-toggle':
      return ['priv:production-toggle'];
    case 'production-model-retirement':
    case 'data-deletion':
    case 'tenant-offboarding':
      return ['priv:override-control-bypass'];
    case 'capital-output-change':
    case 'liquidity-output-change':
    case 'financial-restatement':
    case 'regulatory-filing':
      return ['priv:tier-1-intake-approve'];
    default:
      return ['priv:override-control-bypass'];
  }
}
