/**
 * PC2 — Per-tenant secret store (interface + file-backed default).
 *
 * Codex critique: "Per-tenant secret isolation, rotation, least
 * privilege, and audit. Keychain-derived Claude credentials mounted RW
 * into 100 containers is risky."
 *
 * Production model:
 *   - Each tenant has its own credential namespace
 *   - Workers see only their tenant's secrets at dispatch time
 *   - The host enforces isolation; the worker never sees the raw store
 *   - Rotation is first-class — getSecret returns the latest version,
 *     versions kept for rollback, old ones expire on schedule
 *   - Every fetch is audit-logged (who, what, when, why)
 *
 * This file ships the interface + file-backed default. Adapters for
 * macOS Keychain (per-tenant Keychain entries) / AWS Secrets Manager /
 * GCP Secret Manager / HashiCorp Vault plug in via
 * HERMES_SECRET_STORE_ADAPTER env.
 *
 * File layout (encrypted-at-rest is the operator's storage layer
 * concern — file-backed default uses 600-mode files; production
 * deployments should use AWS Secrets Manager / Vault):
 *
 *   .agent-runs/_secrets/<tenant_id>/<secret_kind>.json
 *
 * Secret kinds (closed enum):
 *   - 'claude_oauth'     ← claude max plan creds (Keychain extract)
 *   - 'claude_api_key'   ← per-token billing alternative
 *   - 'codex_api_key'    ← OpenAI codex auth
 *   - 'gh_token'         ← GitHub PAT
 *   - 'git_ssh_key'      ← git push auth
 *   - 'aws_role_arn'     ← S3 manifest upload (PD)
 *   - 'stripe_api_key'   ← billing (PE)
 *   - 'webhook_signing'  ← outbound webhook secrets
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { harnessRoot } from '../harnessRoot';

// ─── Schema ─────────────────────────────────────────────────────────────

export const SecretKind = z.enum([
  'claude_oauth',
  'claude_api_key',
  'codex_api_key',
  'gh_token',
  'git_ssh_key',
  'aws_role_arn',
  'stripe_api_key',
  'webhook_signing',
]);
export type SecretKind = z.infer<typeof SecretKind>;

export const SecretVersion = z.object({
  version: z.number().int().nonnegative(),
  /** The secret material itself. Operator's storage layer must
   *  encrypt-at-rest. */
  value: z.string(),
  created_at: z.string(),
  /** Optional expiry; null means non-expiring. */
  expires_at: z.string().nullable().default(null),
  /** Who created this version (principal id). */
  rotated_by: z.string(),
  /** Rotation note (e.g., "scheduled rotation", "incident response"). */
  rotation_reason: z.string().nullable().default(null),
});
export type SecretVersion = z.infer<typeof SecretVersion>;

export const SecretRecord = z.object({
  schema_version: z.literal('1'),
  tenant_id: z.string(),
  kind: SecretKind,
  /** Versions in chronological order. The latest is the active one. */
  versions: z.array(SecretVersion).min(1),
  /** Operator-supplied labels (rotation policy, owner, etc). */
  labels: z.record(z.string()).default({}),
});
export type SecretRecord = z.infer<typeof SecretRecord>;

// ─── Audit trail ────────────────────────────────────────────────────────

export const SecretAccessEvent = z.object({
  schema_version: z.literal('1'),
  tenant_id: z.string(),
  kind: SecretKind,
  version: z.number().int().nonnegative(),
  accessed_at: z.string(),
  accessed_by: z.string(),
  /** Why this access happened — operator-readable. */
  purpose: z.string(),
  /** Rotation? Read? Both audit-relevant. */
  operation: z.enum(['read', 'rotate', 'create', 'delete']),
  /** Optional: dispatch task this access was for. */
  task_id: z.string().nullable().default(null),
});
export type SecretAccessEvent = z.infer<typeof SecretAccessEvent>;

// ─── Interface ──────────────────────────────────────────────────────────

export interface SecretStore {
  /**
   * Get the active version of a secret. Throws if no secret exists for
   * this (tenant, kind). Audit-logs the read.
   */
  getSecret(opts: {
    tenant_id: string;
    kind: SecretKind;
    accessed_by: string;
    purpose: string;
    task_id?: string;
  }): Promise<{ value: string; version: number }>;

  /**
   * Create or rotate a secret. Always appends a new version; never
   * overwrites the current version. Returns the new version number.
   */
  setSecret(opts: {
    tenant_id: string;
    kind: SecretKind;
    value: string;
    rotated_by: string;
    rotation_reason: string;
    expires_at?: string | null;
  }): Promise<number>;

  /**
   * List versions (metadata only — value is NOT returned). Used by
   * operator surface to confirm rotation history.
   */
  listVersions(tenant_id: string, kind: SecretKind): Promise<Omit<SecretVersion, 'value'>[]>;

  /**
   * Read recent access events for audit surface.
   */
  recentAccess(tenant_id: string, opts?: { limit?: number; sinceMs?: number }): Promise<SecretAccessEvent[]>;

  /** Test-only reset. */
  _reset_for_test(): Promise<void>;
}

// ─── File-backed default ────────────────────────────────────────────────

function secretsDir(): string {
  return path.join(harnessRoot(), '.agent-runs', '_secrets');
}

function tenantSecretsDir(tenantId: string): string {
  return path.join(secretsDir(), tenantId);
}

function secretFilePath(tenantId: string, kind: SecretKind): string {
  return path.join(tenantSecretsDir(tenantId), `${kind}.json`);
}

function accessLogPath(tenantId: string): string {
  return path.join(tenantSecretsDir(tenantId), '_access.jsonl');
}

class FileBackedSecretStore implements SecretStore {
  async getSecret(opts: {
    tenant_id: string;
    kind: SecretKind;
    accessed_by: string;
    purpose: string;
    task_id?: string;
  }): Promise<{ value: string; version: number }> {
    const p = secretFilePath(opts.tenant_id, opts.kind);
    if (!fs.existsSync(p)) {
      throw new Error(`SecretStore: no ${opts.kind} for tenant=${opts.tenant_id}`);
    }
    const raw = fs.readFileSync(p, 'utf8');
    const rec = SecretRecord.parse(JSON.parse(raw));
    // Latest version = highest version number
    const active = rec.versions.reduce((max, v) => v.version > max.version ? v : max, rec.versions[0]);
    // Expiry check
    if (active.expires_at && new Date(active.expires_at).getTime() < Date.now()) {
      throw new Error(`SecretStore: ${opts.kind} for tenant=${opts.tenant_id} expired at ${active.expires_at}`);
    }
    // Audit-log
    this._appendAccess({
      schema_version: '1',
      tenant_id: opts.tenant_id,
      kind: opts.kind,
      version: active.version,
      accessed_at: new Date().toISOString(),
      accessed_by: opts.accessed_by,
      purpose: opts.purpose,
      operation: 'read',
      task_id: opts.task_id ?? null,
    });
    return { value: active.value, version: active.version };
  }

  async setSecret(opts: {
    tenant_id: string;
    kind: SecretKind;
    value: string;
    rotated_by: string;
    rotation_reason: string;
    expires_at?: string | null;
  }): Promise<number> {
    const p = secretFilePath(opts.tenant_id, opts.kind);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    let rec: SecretRecord;
    if (fs.existsSync(p)) {
      rec = SecretRecord.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
    } else {
      rec = {
        schema_version: '1',
        tenant_id: opts.tenant_id,
        kind: opts.kind,
        versions: [],
        labels: {},
      };
    }
    const nextVersion = rec.versions.reduce((max, v) => Math.max(max, v.version), -1) + 1;
    const newVersion: SecretVersion = {
      version: nextVersion,
      value: opts.value,
      created_at: new Date().toISOString(),
      expires_at: opts.expires_at ?? null,
      rotated_by: opts.rotated_by,
      rotation_reason: opts.rotation_reason,
    };
    rec.versions.push(newVersion);
    // Atomic write via tmp+rename, mode 600
    const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(SecretRecord.parse(rec), null, 2), { mode: 0o600 });
    fs.renameSync(tmp, p);
    fs.chmodSync(p, 0o600);
    // Audit
    this._appendAccess({
      schema_version: '1',
      tenant_id: opts.tenant_id,
      kind: opts.kind,
      version: nextVersion,
      accessed_at: new Date().toISOString(),
      accessed_by: opts.rotated_by,
      purpose: opts.rotation_reason,
      operation: nextVersion === 0 ? 'create' : 'rotate',
      task_id: null,
    });
    return nextVersion;
  }

  async listVersions(tenant_id: string, kind: SecretKind): Promise<Omit<SecretVersion, 'value'>[]> {
    const p = secretFilePath(tenant_id, kind);
    if (!fs.existsSync(p)) return [];
    const rec = SecretRecord.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
    return rec.versions.map(({ value: _v, ...rest }) => { void _v; return rest; });
  }

  async recentAccess(tenant_id: string, opts: { limit?: number; sinceMs?: number } = {}): Promise<SecretAccessEvent[]> {
    const p = accessLogPath(tenant_id);
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const events: SecretAccessEvent[] = [];
    for (const line of lines) {
      try {
        const e = SecretAccessEvent.parse(JSON.parse(line));
        if (opts.sinceMs && new Date(e.accessed_at).getTime() < Date.now() - opts.sinceMs) continue;
        events.push(e);
      } catch { /* skip malformed */ }
    }
    return opts.limit ? events.slice(-opts.limit) : events;
  }

  async _reset_for_test(): Promise<void> {
    try { fs.rmSync(secretsDir(), { recursive: true, force: true }); } catch { /* tolerate */ }
  }

  private _appendAccess(ev: SecretAccessEvent): void {
    const p = accessLogPath(ev.tenant_id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(ev) + '\n');
  }
}

// ─── Factory ────────────────────────────────────────────────────────────

let _instance: SecretStore | null = null;

export function getSecretStore(): SecretStore {
  if (_instance) return _instance;
  const adapterPath = process.env.HERMES_SECRET_STORE_ADAPTER;
  if (adapterPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(adapterPath);
      _instance = mod.default ?? mod;
      return _instance!;
    } catch (err) {
      console.error(`[secret-store] failed to load adapter from ${adapterPath}: ${(err as Error).message}; falling back to file-backed`);
    }
  }
  _instance = new FileBackedSecretStore();
  return _instance;
}

export function _resetSecretStoreForTest(): void {
  _instance = null;
}

/**
 * Helper: deterministic content hash for secret material. Used by
 * audit comparisons (did the same value get rotated again?) without
 * leaking the value itself.
 */
export function secretFingerprint(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}
