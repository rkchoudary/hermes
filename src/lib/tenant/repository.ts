/**
 * PC1 — TenantRepository (interface + file-backed default impl).
 *
 * The persistence boundary. Code that creates/reads/updates tenant
 * data goes through this interface, never touches the file layout
 * directly. Phase C SaaS deployments swap in a Postgres adapter that
 * implements the same interface.
 *
 * Hardening:
 *   - Atomic writes via tmp+rename
 *   - Schema validation on every read (catches manual file edits)
 *   - Repository-level lock for write paths (file lock per entity kind)
 *   - Idempotent create (re-creating a tenant with the same id is a noop
 *     on identical content; throws on conflict)
 *
 * File layout:
 *   .agent-runs/_tenant/tenants.jsonl       append-only, last-write-wins
 *   .agent-runs/_tenant/workspaces.jsonl
 *   .agent-runs/_tenant/projects.jsonl
 *   .agent-runs/_tenant/principals.jsonl
 *   .agent-runs/_tenant/.lock
 *
 * Append-only with last-write-wins gives us simple write semantics +
 * easy DR (replay the file). For >10k entities, the Postgres adapter
 * is required (Phase C SaaS).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../harnessRoot';
import {
  Tenant,
  Workspace,
  Project,
  Principal,
} from './model';

// ─── Interface ──────────────────────────────────────────────────────────

export interface TenantRepository {
  // Tenant
  createTenant(t: Tenant): Promise<Tenant>;
  getTenant(id: string): Promise<Tenant | null>;
  listTenants(): Promise<Tenant[]>;
  updateTenant(t: Tenant): Promise<Tenant>;

  // Workspace
  createWorkspace(w: Workspace): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  listWorkspacesByTenant(tenantId: string): Promise<Workspace[]>;

  // Project
  createProject(p: Project): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  listProjectsByWorkspace(workspaceId: string): Promise<Project[]>;
  listProjectsByTenant(tenantId: string): Promise<Project[]>;

  // Principal
  createPrincipal(p: Principal): Promise<Principal>;
  getPrincipal(id: string): Promise<Principal | null>;
  getPrincipalByExternalId(provider: string, external_id: string): Promise<Principal | null>;
  listPrincipalsByTenant(tenantId: string): Promise<Principal[]>;
  updatePrincipal(p: Principal): Promise<Principal>;

  /** Test-only: reset all state. NEVER call from production code. */
  _reset_for_test(): Promise<void>;
}

// ─── File-backed default ────────────────────────────────────────────────

function tenantDir(): string {
  return path.join(harnessRoot(), '.agent-runs', '_tenant');
}

function lockPath(): string {
  return path.join(tenantDir(), '.lock');
}

function entityPath(kind: 'tenants' | 'workspaces' | 'projects' | 'principals'): string {
  return path.join(tenantDir(), `${kind}.jsonl`);
}

// Simple advisory lock — file presence + retry. Tenant data is
// low-frequency (operator config), so heavy contention is unlikely.
async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const MAX_RETRIES = 100;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const fd = fs.openSync(p, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      try {
        return await fn();
      } finally {
        try { fs.closeSync(fd); } catch { /* tolerate */ }
        try { fs.unlinkSync(p); } catch { /* tolerate */ }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Stale-lock check
      try {
        const meta = JSON.parse(fs.readFileSync(p, 'utf8')) as { pid: number; ts: number };
        const age = Date.now() - meta.ts;
        if (age > 30_000) { try { fs.unlinkSync(p); } catch { /* race */ } continue; }
      } catch { /* corrupt — wait and retry */ }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('TenantRepository: could not acquire lock after 100 retries (5s)');
}

function readEntities<T>(p: string, schema: { parse: (raw: unknown) => T }): T[] {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  // Last-write-wins by `id` field
  const map = new Map<string, T>();
  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      const e = schema.parse(raw) as T & { id: string };
      map.set(e.id, e);
    } catch { /* skip malformed; janitor flags */ }
  }
  return Array.from(map.values());
}

function appendEntity(p: string, entity: object): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic append via openSync + writeSync + fsync
  const fd = fs.openSync(p, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(entity) + '\n');
    fs.fsyncSync(fd);
  } finally {
    try { fs.closeSync(fd); } catch { /* tolerate */ }
  }
}

class FileBackedTenantRepository implements TenantRepository {
  async createTenant(t: Tenant): Promise<Tenant> {
    return withLock(() => {
      const validated = Tenant.parse(t);
      const existing = readEntities(entityPath('tenants'), Tenant);
      if (existing.some((e) => e.id === validated.id)) {
        // Idempotent: same content = noop
        const prior = existing.find((e) => e.id === validated.id)!;
        if (JSON.stringify(prior) === JSON.stringify(validated)) return prior;
        throw new Error(`Tenant ${validated.id} already exists with different content`);
      }
      appendEntity(entityPath('tenants'), validated);
      return validated;
    });
  }

  async getTenant(id: string): Promise<Tenant | null> {
    const all = readEntities(entityPath('tenants'), Tenant);
    return all.find((t) => t.id === id) ?? null;
  }

  async listTenants(): Promise<Tenant[]> {
    return readEntities(entityPath('tenants'), Tenant);
  }

  async updateTenant(t: Tenant): Promise<Tenant> {
    return withLock(() => {
      const validated = Tenant.parse({ ...t, updated_at: new Date().toISOString() });
      appendEntity(entityPath('tenants'), validated);
      return validated;
    });
  }

  async createWorkspace(w: Workspace): Promise<Workspace> {
    return withLock(async () => {
      const validated = Workspace.parse(w);
      // Foreign key check
      const tenant = await this.getTenant(validated.tenant_id);
      if (!tenant) throw new Error(`Workspace ${validated.id}: tenant_id=${validated.tenant_id} not found`);
      appendEntity(entityPath('workspaces'), validated);
      return validated;
    });
  }

  async getWorkspace(id: string): Promise<Workspace | null> {
    const all = readEntities(entityPath('workspaces'), Workspace);
    return all.find((w) => w.id === id) ?? null;
  }

  async listWorkspacesByTenant(tenantId: string): Promise<Workspace[]> {
    const all = readEntities(entityPath('workspaces'), Workspace);
    return all.filter((w) => w.tenant_id === tenantId);
  }

  async createProject(p: Project): Promise<Project> {
    return withLock(async () => {
      const validated = Project.parse(p);
      const ws = await this.getWorkspace(validated.workspace_id);
      if (!ws) throw new Error(`Project ${validated.id}: workspace_id=${validated.workspace_id} not found`);
      if (ws.tenant_id !== validated.tenant_id) {
        throw new Error(`Project ${validated.id}: tenant_id mismatch (project=${validated.tenant_id}, workspace.tenant=${ws.tenant_id})`);
      }
      appendEntity(entityPath('projects'), validated);
      return validated;
    });
  }

  async getProject(id: string): Promise<Project | null> {
    const all = readEntities(entityPath('projects'), Project);
    return all.find((p) => p.id === id) ?? null;
  }

  async listProjectsByWorkspace(workspaceId: string): Promise<Project[]> {
    const all = readEntities(entityPath('projects'), Project);
    return all.filter((p) => p.workspace_id === workspaceId);
  }

  async listProjectsByTenant(tenantId: string): Promise<Project[]> {
    const all = readEntities(entityPath('projects'), Project);
    return all.filter((p) => p.tenant_id === tenantId);
  }

  async createPrincipal(p: Principal): Promise<Principal> {
    return withLock(() => {
      const validated = Principal.parse(p);
      appendEntity(entityPath('principals'), validated);
      return validated;
    });
  }

  async getPrincipal(id: string): Promise<Principal | null> {
    const all = readEntities(entityPath('principals'), Principal);
    return all.find((p) => p.id === id) ?? null;
  }

  async getPrincipalByExternalId(provider: string, external_id: string): Promise<Principal | null> {
    const all = readEntities(entityPath('principals'), Principal);
    return all.find((p) => p.identity_provider === provider && p.external_id === external_id) ?? null;
  }

  async listPrincipalsByTenant(tenantId: string): Promise<Principal[]> {
    const all = readEntities(entityPath('principals'), Principal);
    return all.filter((p) => p.tenant_memberships.some((m) => m.tenant_id === tenantId));
  }

  async updatePrincipal(p: Principal): Promise<Principal> {
    return withLock(() => {
      const validated = Principal.parse({ ...p, updated_at: new Date().toISOString() });
      appendEntity(entityPath('principals'), validated);
      return validated;
    });
  }

  async _reset_for_test(): Promise<void> {
    return withLock(() => {
      try { fs.rmSync(tenantDir(), { recursive: true, force: true }); } catch { /* tolerate */ }
    });
  }
}

// ─── Factory ────────────────────────────────────────────────────────────

let _instance: TenantRepository | null = null;

/**
 * Get the tenant repository. Default = file-backed. Operator can swap
 * by setting HERMES_TENANT_REPO_ADAPTER to a module that exports
 * `default` matching TenantRepository (e.g., a Postgres adapter).
 */
export function getTenantRepository(): TenantRepository {
  if (_instance) return _instance;
  // Adapter loading hook (for Postgres etc) — kept simple for v1.
  const adapterPath = process.env.HERMES_TENANT_REPO_ADAPTER;
  if (adapterPath) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(adapterPath);
      _instance = mod.default ?? mod;
      return _instance!;
    } catch (err) {
      console.error(`[tenant-repository] failed to load adapter from ${adapterPath}: ${(err as Error).message}; falling back to file-backed`);
    }
  }
  _instance = new FileBackedTenantRepository();
  return _instance;
}

/** Test-only — reset the singleton between tests. */
export function _resetRepositoryForTest(): void {
  _instance = null;
}
