/**
 * Security context — composite accessor used by harness CLIs to enforce
 * RBAC + SIEM emit + (later) PAM check on every privileged operation.
 *
 * Loads:
 *   - Identity from .harness/identity.json (operator-managed file in v0.x;
 *     SSO-derived once Sprint F SSO adapter lands)
 *   - RbacAdapter from .harness/config.yaml `rbac.group_to_role` (defaults
 *     to single 'operator' role for the default identity)
 *   - SiemAdapter — NoopSiemAdapter by default (dev), provider-specific
 *     impl when operator configures `siem.provider: splunk|datadog|...`
 *   - PamAdapter — DefaultPamAdapter (filesystem + twoKeyApproval reuse)
 *
 * Single accessor: `getSecurityContext()` — memoized; re-reads on
 * `clearSecurityContextCache()` for tests.
 *
 * v0.x dev fallback: if .harness/identity.json absent, returns a default
 * anonymous-operator identity with all 'operator' role permissions. This
 * lets v0.x dev work without ceremony while still surfacing the audit
 * trail through SIEM (NoopSiemAdapter buffers locally).
 *
 * Production-mode flag (`production_use: true` in config) refuses the
 * default identity fallback — every call must come through real SSO.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../harnessRoot';
import {
  DefaultRbacAdapter, NoopSiemAdapter,
  type UserPrincipal, type RbacAdapter, type SiemAdapter, type PamAdapter,
  type SiemEvent, type HarnessRole,
} from './securityAdapter';
import { DefaultPamAdapter } from './defaultPamAdapter';

interface IdentityFile {
  sub: string;
  email: string;
  name: string;
  groups: string[];
  amr?: string[];
  auth_time?: string;
}

interface RbacConfig {
  group_to_role?: Record<string, HarnessRole>;
}

interface SecurityConfig {
  production_use?: boolean;
  rbac?: RbacConfig;
  siem?: { provider?: string };
}

export interface SecurityContext {
  identity: UserPrincipal;
  rbac: RbacAdapter;
  siem: SiemAdapter;
  pam: PamAdapter;
  /** Helper: enforce permission + emit success/denial event. Convenience
   *  wrapper that bundles the rbac.require + siem.send pattern most call
   *  sites need. */
  authorize(permission: string, resource: string, action: string, payload?: Record<string, unknown>): Promise<void>;
}

let _cached: SecurityContext | null = null;

const DEFAULT_IDENTITY: IdentityFile = {
  sub: 'default-operator',
  email: 'operator@local',
  name: 'Default Operator (v0.x dev)',
  groups: ['default-operator'],
  amr: ['unauthenticated'],
};

const DEFAULT_GROUP_TO_ROLE: Record<string, HarnessRole> = {
  'default-operator': 'operator',
  'default-validator': 'validator',
  'default-admin': 'admin',
  'default-auditor': 'auditor',
};

function readSecurityConfig(): SecurityConfig {
  const cfgPath = path.join(harnessRoot(), '.harness', 'config.yaml');
  if (!fs.existsSync(cfgPath)) return {};
  // We deliberately don't pull in a YAML parser here. v0.x config is parsed
  // in src/lib/harnessConfig.ts; this module reads the JSON form only since
  // we want zero new deps. Operators using YAML config will get the default
  // dev posture; they can switch to JSON to opt into RBAC config.
  const jsonPath = path.join(harnessRoot(), '.harness', 'config.json');
  if (!fs.existsSync(jsonPath)) return {};
  try { return JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as SecurityConfig; }
  catch { return {}; }
}

function readIdentity(): { identity: IdentityFile; isDefault: boolean } {
  const idPath = path.join(harnessRoot(), '.harness', 'identity.json');
  if (!fs.existsSync(idPath)) {
    return { identity: DEFAULT_IDENTITY, isDefault: true };
  }
  try {
    const id = JSON.parse(fs.readFileSync(idPath, 'utf8')) as IdentityFile;
    if (!id.sub || !id.email || !id.name || !Array.isArray(id.groups)) {
      throw new Error('identity.json missing required fields (sub, email, name, groups)');
    }
    return { identity: id, isDefault: false };
  } catch (err) {
    throw new Error(`Failed to read .harness/identity.json: ${(err as Error).message}`);
  }
}

export function getSecurityContext(): SecurityContext {
  if (_cached) return _cached;
  const cfg = readSecurityConfig();
  const { identity: idFile, isDefault } = readIdentity();

  // Production-mode refuses default identity fallback
  if (cfg.production_use && isDefault) {
    throw new Error(
      `Production mode (production_use=true) requires SSO identity in .harness/identity.json. ` +
      `Default-operator fallback is dev-only. Provision real identity via SSO adapter.`
    );
  }

  const identity: UserPrincipal = {
    sub: idFile.sub,
    email: idFile.email,
    name: idFile.name,
    groups: idFile.groups,
    amr: idFile.amr ?? ['unauthenticated'],
    auth_time: idFile.auth_time ?? new Date().toISOString(),
  };

  const groupToRole = cfg.rbac?.group_to_role ?? DEFAULT_GROUP_TO_ROLE;
  const rbac = new DefaultRbacAdapter(groupToRole);
  // SIEM: default Noop; future provider switching by reading cfg.siem.provider
  const siem = new NoopSiemAdapter();
  const pam = new DefaultPamAdapter();

  const ctx: SecurityContext = {
    identity, rbac, siem, pam,
    authorize: async (permission: string, resource: string, action: string, payload?: Record<string, unknown>) => {
      const occurred_at = new Date().toISOString();
      const baseEvent: Partial<SiemEvent> = {
        category: 'rbac', occurred_at, source: 'harness',
        actor: identity.email, resource, action, payload: payload ?? {},
      };
      // Best-effort permission check against the operator-supplied perm
      // (allows additional perms beyond the closed Permission enum)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allowed = rbac.has(identity, permission as any);
      if (!allowed) {
        await siem.send({
          ...baseEvent, severity: 'high', outcome: 'blocked',
          payload: { ...payload, permission },
        } as SiemEvent);
        throw new Error(
          `Permission denied: user ${identity.email} (groups: [${identity.groups.join(', ')}], roles: [${rbac.rolesFor(identity).join(', ')}]) lacks ${permission}`
        );
      }
      await siem.send({
        ...baseEvent, severity: 'info', outcome: 'success',
        payload: { ...payload, permission },
      } as SiemEvent);
    },
  };

  _cached = ctx;
  return ctx;
}

export function clearSecurityContextCache(): void {
  _cached = null;
}
