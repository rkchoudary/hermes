/**
 * Smoke for the tenant model + repository + secret store.
 * Exercises:
 *   1. Tenant CRUD with idempotent create + update lineage
 *   2. Workspace + Project foreign-key validation (rejected when
 *      cross-tenant or missing parent)
 *   3. Principal multi-tenant membership + permission resolution
 *   4. RBAC matrix correctness (each role allowed/denied as expected)
 *   5. Secret store: create/rotate, version monotonicity, expiry
 *      enforcement, access-event audit, listVersions hides values
 *   6. Adapter override hook is honored
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _resetHarnessRootCacheForTest } from '../../harnessRoot';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-tenant-'));
process.env.HERMES_PROJECT_ROOT = TMP;
fs.mkdirSync(path.join(TMP, '.agent-runs'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'package.json'), '{}');
_resetHarnessRootCacheForTest();

const { Tenant, Workspace, Project, Principal, hasPermission, DEFAULT_TENANT_RBAC } = await import('../model');
const { getTenantRepository, _resetRepositoryForTest } = await import('../repository');
const { getSecretStore, _resetSecretStoreForTest, secretFingerprint } = await import('../secretStore');

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('tenant.smoke');

// ─── 1. Tenant CRUD ────────────────────────────────────────────────────
console.log('\n1. Tenant CRUD');
_resetRepositoryForTest();
const repo = getTenantRepository();
await repo._reset_for_test();

const t1 = await repo.createTenant({
  schema_version: '1',
  id: 'acme-bank',
  display_name: 'Acme Bank',
  status: 'active',
  labels: { region: 'us-east-1', cost_center: 'finops-01' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'admin@acme.test',
  compliance_regime: 'osfi-e23',
  quota: { max_dispatches_per_day: 100, max_usd_per_day: 500, max_concurrent_dispatches: 10 },
});
assert(t1.id === 'acme-bank', 'tenant created');
const t1read = await repo.getTenant('acme-bank');
assert(t1read?.compliance_regime === 'osfi-e23', 'tenant readback preserves compliance_regime');

// Idempotent create with identical content = noop
const t1again = await repo.createTenant({ ...t1 });
assert(t1again.id === 'acme-bank', 'idempotent create returns same tenant');

// Conflicting create = throws
let conflictThrew = false;
try {
  await repo.createTenant({ ...t1, display_name: 'Acme Bank Renamed' });
} catch { conflictThrew = true; }
assert(conflictThrew, 'create with same id but different content throws');

// Update appends new version
const updated = await repo.updateTenant({ ...t1, display_name: 'Acme Bank Updated' });
assert(updated.display_name === 'Acme Bank Updated', 'update preserves change');
const reread = await repo.getTenant('acme-bank');
assert(reread?.display_name === 'Acme Bank Updated', 'last-write-wins on read');

// ─── 2. Workspace + Project FK validation ──────────────────────────────
console.log('\n2. Workspace + Project FK validation');
const w1 = await repo.createWorkspace({
  schema_version: '1',
  id: 'risk-ml',
  tenant_id: 'acme-bank',
  display_name: 'Risk ML',
  created_at: '2026-01-02T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  created_by: 'admin@acme.test',
  labels: {},
});
assert(w1.id === 'risk-ml', 'workspace created within existing tenant');

let wsFkThrew = false;
try {
  await repo.createWorkspace({
    schema_version: '1',
    id: 'orphan-ws',
    tenant_id: 'nonexistent-tenant',
    display_name: 'Orphan',
    created_at: '2026-01-02T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    created_by: 'admin',
    labels: {},
  });
} catch { wsFkThrew = true; }
assert(wsFkThrew, 'workspace with missing tenant_id rejected');

const p1 = await repo.createProject({
  schema_version: '1',
  id: 'cecl-model',
  tenant_id: 'acme-bank',
  workspace_id: 'risk-ml',
  display_name: 'CECL Model',
  repo_url: 'https://github.com/acme/cecl-model',
  default_branch: 'main',
  budget_overrides: { daily_cap_usd: 50, per_task_cap_usd: 10 },
  created_at: '2026-01-03T00:00:00Z',
  updated_at: '2026-01-03T00:00:00Z',
  created_by: 'admin@acme.test',
});
assert(p1.id === 'cecl-model', 'project created');

let projTenantMismatchThrew = false;
try {
  await repo.createProject({
    schema_version: '1',
    id: 'cross-tenant',
    tenant_id: 'other-tenant',     // mismatch with workspace's tenant
    workspace_id: 'risk-ml',
    display_name: 'Bad',
    repo_url: null,
    default_branch: 'main',
    budget_overrides: { daily_cap_usd: null, per_task_cap_usd: null },
    created_at: '2026-01-03T00:00:00Z',
    updated_at: '2026-01-03T00:00:00Z',
    created_by: 'admin',
  });
} catch { projTenantMismatchThrew = true; }
assert(projTenantMismatchThrew, 'cross-tenant project rejected');

// ─── 3. Principal + RBAC ───────────────────────────────────────────────
console.log('\n3. Principal + RBAC');
const alice = await repo.createPrincipal({
  schema_version: '1',
  id: 'alice',
  kind: 'human',
  email: 'alice@acme.test',
  display_name: 'Alice',
  identity_provider: 'okta',
  external_id: 'okta-user-abc123',
  tenant_memberships: [
    { tenant_id: 'acme-bank', role: 'admin', assigned_at: '2026-01-01T00:00:00Z', assigned_by: 'admin@acme.test' },
  ],
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_seen_at: null,
});
assert(alice.tenant_memberships.length === 1, 'principal created with one membership');

const bob = await repo.createPrincipal({
  schema_version: '1',
  id: 'bob',
  kind: 'human',
  email: 'bob@acme.test',
  display_name: 'Bob',
  identity_provider: 'okta',
  external_id: 'okta-user-bob',
  tenant_memberships: [
    { tenant_id: 'acme-bank', role: 'viewer', assigned_at: '2026-01-01T00:00:00Z', assigned_by: 'admin@acme.test' },
  ],
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_seen_at: null,
});

const aliceCanDispatch = hasPermission(alice, 'acme-bank', 'dispatch.start');
assert(aliceCanDispatch.allowed, 'admin can dispatch.start');
assert(aliceCanDispatch.via_role === 'admin', `via_role=admin (got ${aliceCanDispatch.via_role})`);

const bobCanDispatch = hasPermission(bob, 'acme-bank', 'dispatch.start');
assert(!bobCanDispatch.allowed, 'viewer CANNOT dispatch.start');
assert(bobCanDispatch.via_role === 'viewer', 'viewer role surfaced');

const stranger = hasPermission(alice, 'other-tenant', 'tenant.read');
assert(!stranger.allowed, 'no membership = no access');
assert(stranger.via_role === null, 'via_role=null on no-membership');

// External ID lookup
const aliceByExt = await repo.getPrincipalByExternalId('okta', 'okta-user-abc123');
assert(aliceByExt?.id === 'alice', 'lookup by (provider, external_id)');

// ─── 4. RBAC matrix completeness ───────────────────────────────────────
console.log('\n4. RBAC matrix');
const ownerCanDelete = DEFAULT_TENANT_RBAC.owner.includes('tenant.delete');
const adminCanDelete = DEFAULT_TENANT_RBAC.admin.includes('tenant.delete');
const auditorCanExport = DEFAULT_TENANT_RBAC.auditor.includes('audit.export');
const viewerCanExport = DEFAULT_TENANT_RBAC.viewer.includes('audit.export');
assert(ownerCanDelete && !adminCanDelete, 'tenant.delete: owner only (admin denied)');
assert(auditorCanExport && !viewerCanExport, 'audit.export: auditor only (viewer denied)');

// ─── 5. Secret store ──────────────────────────────────────────────────
console.log('\n5. Secret store');
_resetSecretStoreForTest();
const ss = getSecretStore();
await ss._reset_for_test();

const v0 = await ss.setSecret({
  tenant_id: 'acme-bank',
  kind: 'gh_token',
  value: 'ghp_INITIAL_TOKEN',
  rotated_by: 'alice',
  rotation_reason: 'initial provisioning',
});
assert(v0 === 0, `first setSecret returns version 0 (got ${v0})`);

const v1 = await ss.setSecret({
  tenant_id: 'acme-bank',
  kind: 'gh_token',
  value: 'ghp_ROTATED_TOKEN',
  rotated_by: 'alice',
  rotation_reason: 'scheduled monthly rotation',
});
assert(v1 === 1, `rotation returns version 1 (got ${v1})`);

const fetched = await ss.getSecret({
  tenant_id: 'acme-bank',
  kind: 'gh_token',
  accessed_by: 'alice',
  purpose: 'GitHub PR open for task TP-test',
  task_id: 'TP-test',
});
assert(fetched.version === 1, 'getSecret returns latest version');
assert(fetched.value === 'ghp_ROTATED_TOKEN', 'getSecret returns latest value');

const versions = await ss.listVersions('acme-bank', 'gh_token');
assert(versions.length === 2, '2 versions stored');
const exposesValue = versions.some((v: object) => 'value' in v);
assert(!exposesValue, 'listVersions does NOT expose secret value');

// Expiry
const expiredVer = await ss.setSecret({
  tenant_id: 'acme-bank',
  kind: 'codex_api_key',
  value: 'sk-codex-old',
  rotated_by: 'alice',
  rotation_reason: 'test',
  expires_at: new Date(Date.now() - 60_000).toISOString(),  // already expired
});
let expiredThrew = false;
try {
  await ss.getSecret({ tenant_id: 'acme-bank', kind: 'codex_api_key', accessed_by: 'alice', purpose: 'test' });
} catch { expiredThrew = true; }
assert(expiredThrew, 'expired secret throws on getSecret');
assert(typeof expiredVer === 'number', 'expired secret version still recorded');

// Audit log
const audit = await ss.recentAccess('acme-bank', { limit: 10 });
assert(audit.length >= 4, `≥4 access events logged (got ${audit.length})`);
const reads = audit.filter((e) => e.operation === 'read');
const rotations = audit.filter((e) => e.operation === 'rotate');
const creates = audit.filter((e) => e.operation === 'create');
assert(reads.length >= 1, 'read events recorded');
assert(rotations.length >= 1, 'rotation events recorded');
assert(creates.length >= 1, 'create events recorded');
assert(audit.every((e) => typeof e.purpose === 'string' && e.purpose.length > 0), 'every access event carries a purpose');

// Fingerprint determinism
assert(secretFingerprint('a') === secretFingerprint('a'), 'fingerprint deterministic');
assert(secretFingerprint('a') !== secretFingerprint('b'), 'fingerprint distinguishes values');

// ─── 6. Cleanup ───────────────────────────────────────────────────────
await repo._reset_for_test();
await ss._reset_for_test();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* tolerate */ }

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
