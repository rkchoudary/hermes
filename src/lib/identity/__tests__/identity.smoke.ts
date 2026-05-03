/**
 * Smoke for the identity layer: SCIM + breakGlass + perTenantAuth.
 *
 * SAML signature validation requires a real RSA cert pair; we generate
 * one in-process and synthesize a SAML Response, then verify the
 * adapter validates it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { _resetHarnessRootCacheForTest } from '../../harnessRoot';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-identity-'));
process.env.HERMES_PROJECT_ROOT = TMP;
fs.mkdirSync(path.join(TMP, '.agent-runs'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'package.json'), '{}');
_resetHarnessRootCacheForTest();

const { Tenant, Principal } = await import('../../tenant/model');
const { getTenantRepository, _resetRepositoryForTest } = await import('../../tenant/repository');
const { getSecretStore, _resetSecretStoreForTest } = await import('../../tenant/secretStore');
const { startScimServer } = await import('../scim');
const {
  requestElevation, approveElevation, denyElevation, revokeElevation,
  hasElevatedPermission, listPendingElevations, listActiveElevations,
  BreakGlassError, _resetForTest: _resetBgForTest,
} = await import('../breakGlass');
const { resolveDispatchCredentials } = await import('../../tenant/perTenantAuth');
const { createSamlAdapter, samlClaimsToPrincipal, SamlError } = await import('../saml');

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('identity.smoke');

// ─── Setup: a tenant + alice (admin) + bob (viewer) ───────────────────
_resetRepositoryForTest();
_resetSecretStoreForTest();
_resetBgForTest();
const repo = getTenantRepository();
await repo._reset_for_test();

await repo.createTenant(Tenant.parse({
  schema_version: '1',
  id: 'acme', display_name: 'Acme',
  status: 'active', labels: { scim_default_role: 'viewer', scim_group_mapping: '{"admins":"admin","engineers":"operator"}' },
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  created_by: 'admin', compliance_regime: 'none',
  quota: { max_dispatches_per_day: null, max_usd_per_day: null, max_concurrent_dispatches: null },
}));

const alice = await repo.createPrincipal(Principal.parse({
  schema_version: '1',
  id: 'alice', kind: 'human', email: 'alice@acme.test', display_name: 'Alice',
  identity_provider: 'local', external_id: null,
  tenant_memberships: [{ tenant_id: 'acme', role: 'admin', assigned_at: '2026-01-01T00:00:00Z', assigned_by: 'system' }],
  status: 'active',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_seen_at: null,
}));
const bob = await repo.createPrincipal(Principal.parse({
  schema_version: '1',
  id: 'bob', kind: 'human', email: 'bob@acme.test', display_name: 'Bob',
  identity_provider: 'local', external_id: null,
  tenant_memberships: [{ tenant_id: 'acme', role: 'viewer', assigned_at: '2026-01-01T00:00:00Z', assigned_by: 'system' }],
  status: 'active',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_seen_at: null,
}));
const ownerOliver = await repo.createPrincipal(Principal.parse({
  schema_version: '1',
  id: 'oliver', kind: 'human', email: 'oliver@acme.test', display_name: 'Oliver',
  identity_provider: 'local', external_id: null,
  tenant_memberships: [{ tenant_id: 'acme', role: 'owner', assigned_at: '2026-01-01T00:00:00Z', assigned_by: 'system' }],
  status: 'active',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', last_seen_at: null,
}));

// Provision a SCIM bearer token for the tenant (stored in webhook_signing slot per scim.ts comment)
const ss = getSecretStore();
await ss._reset_for_test();
await ss.setSecret({
  tenant_id: 'acme', kind: 'webhook_signing',
  value: 'scim-bearer-token-acme-1234567890abcdef',
  rotated_by: 'oliver', rotation_reason: 'scim-server provisioning',
});

// ─── SCIM tests ────────────────────────────────────────────────────────
console.log('\n1. SCIM endpoint');
const scimServer = await startScimServer({ noListen: true });

// 1a. Unauthenticated request → 401
const r1 = await scimServer.handleRequest({
  method: 'GET', path: '/scim/v2/Users', query: {}, headers: {}, remoteIp: '127.0.0.1',
});
assert(r1.statusCode === 401, `unauthenticated → 401 (got ${r1.statusCode})`);

// 1b. ServiceProviderConfig is unauth
const r1b = await scimServer.handleRequest({
  method: 'GET', path: '/scim/v2/ServiceProviderConfig', query: {}, headers: {}, remoteIp: '127.0.0.1',
});
assert(r1b.statusCode === 200, `ServiceProviderConfig 200 (got ${r1b.statusCode})`);

// 1c. Authenticated GET /Users
const headers = { 'authorization': 'Bearer scim-bearer-token-acme-1234567890abcdef' };
const r2 = await scimServer.handleRequest({
  method: 'GET', path: '/scim/v2/Users', query: {}, headers, remoteIp: '127.0.0.1',
});
assert(r2.statusCode === 200, `auth GET /Users → 200 (got ${r2.statusCode})`);
const body2 = r2.body as { Resources: Array<{ id: string }> };
assert(body2.Resources.length === 3, `3 principals listed (got ${body2.Resources.length})`);

// 1d. POST creates new principal
const r3 = await scimServer.handleRequest({
  method: 'POST', path: '/scim/v2/Users', query: {}, headers,
  body: {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'scim-charlie@acme.test',
    externalId: 'okta-charlie-789',
    name: { formatted: 'Charlie SCIM' },
    emails: [{ value: 'scim-charlie@acme.test', primary: true }],
    groups: [{ value: 'engineers' }],
    active: true,
  },
  remoteIp: '127.0.0.1',
});
assert(r3.statusCode === 201, `POST /Users → 201 (got ${r3.statusCode})`);
const charlie = r3.body as { id: string };
assert(typeof charlie.id === 'string', 'created principal has id');

// 1e. PATCH active=false (deactivation)
const r4 = await scimServer.handleRequest({
  method: 'PATCH', path: `/scim/v2/Users/${charlie.id}`, query: {}, headers,
  body: {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: 'active', value: false }],
  },
  remoteIp: '127.0.0.1',
});
assert(r4.statusCode === 200, `PATCH active=false → 200 (got ${r4.statusCode})`);
const charlieAfter = await repo.getPrincipal(charlie.id);
assert(charlieAfter?.status === 'suspended', 'principal status set to suspended');

// 1f. Bad bearer token → 401 (constant-time compare)
const r5 = await scimServer.handleRequest({
  method: 'GET', path: '/scim/v2/Users', query: {},
  headers: { 'authorization': 'Bearer wrong-token-of-similar-length-to-1234' },
  remoteIp: '127.0.0.1',
});
assert(r5.statusCode === 401, `wrong bearer → 401 (got ${r5.statusCode})`);

await scimServer.close();

// ─── Break-glass tests ────────────────────────────────────────────────
console.log('\n2. Break-glass elevation');

// 2a. Bob (viewer) requests admin elevation
const reqBob = requestElevation({
  requester: bob, tenant_id: 'acme', requested_role: 'admin',
  reason: 'incident response — emergency revert of bad deploy 2026-05-03',
  duration_sec: 3600,
});
assert(reqBob.status === 'pending', 'admin request starts pending');
assert(reqBob.dual_control_required === true, 'admin requests require dual-control');

// 2b. Self-approval refused
let selfApproveThrew = false;
try { approveElevation({ request_id: reqBob.request_id, approver: bob }); }
catch (err) { selfApproveThrew = err instanceof BreakGlassError && err.kind === 'self-approval'; }
assert(selfApproveThrew, 'self-approval refused');

// 2c. First approver (alice — admin) approves; still pending (need 2)
const after1 = approveElevation({ request_id: reqBob.request_id, approver: alice });
assert(after1.status === 'pending', `dual-control still pending after 1 approver (got ${after1.status})`);
assert(after1.approvers.length === 1, '1 approver recorded');

// 2d. Second approver (oliver — owner) approves; activates
const after2 = approveElevation({ request_id: reqBob.request_id, approver: ownerOliver });
assert(after2.status === 'active', `activates after 2 approvers (got ${after2.status})`);
assert(after2.approvers.length === 2, '2 approvers recorded');
assert(after2.effective_until !== null, 'effective_until set');

// 2e. Viewer base RBAC denies dispatch.start (use a fresh principal id
//     to avoid the active-elevation log granting it via bob's existing
//     elevation).
const fakeViewer: Principal = { ...bob, id: 'fake-viewer-no-elevations' };
assert(!hasElevatedPermission(fakeViewer, 'acme', 'dispatch.start').allowed, 'viewer base RBAC denies dispatch.start');
// 2f. Bob (now elevated to admin via approved request) has dispatch.start
const bobNow = hasElevatedPermission(bob, 'acme', 'dispatch.start');
assert(bobNow.allowed, 'bob has elevated dispatch.start');
assert(bobNow.via_role === 'admin', `via_role=admin (got ${bobNow.via_role})`);
assert(bobNow.via_elevation === reqBob.request_id, 'via_elevation references the request');

// 2f. Single-control path: bob requests operator (not admin/owner)
const reqOpRole = requestElevation({
  requester: bob, tenant_id: 'acme', requested_role: 'operator',
  reason: 'temporary dispatch privileges for log harvest 2026-05-03',
  duration_sec: 600,
});
assert(!reqOpRole.dual_control_required, 'operator does not require dual-control');
const opRoleAfter = approveElevation({ request_id: reqOpRole.request_id, approver: alice });
assert(opRoleAfter.status === 'active', 'single-control activates after 1 approver');

// 2g. Listing
const pending = listPendingElevations('acme');
const active = listActiveElevations('acme');
assert(pending.length === 0, `no pending after both approved (got ${pending.length})`);
assert(active.length === 2, `2 active elevations (got ${active.length})`);

// 2h. Revoke ALL of bob's active elevations; verify dispatch.start
//     falls back to base RBAC (which denies it for a viewer).
const revokedAdmin = revokeElevation({ request_id: reqBob.request_id, revoker: ownerOliver, reason: 'incident closed' });
assert(revokedAdmin.status === 'revoked', 'admin elevation revoked');
const revokedOp = revokeElevation({ request_id: reqOpRole.request_id, revoker: ownerOliver, reason: 'incident closed' });
assert(revokedOp.status === 'revoked', 'operator elevation revoked');
const bobAfterRevoke = hasElevatedPermission(bob, 'acme', 'dispatch.start');
assert(!bobAfterRevoke.allowed, 'all revoked → no elevated permission, falls back to viewer base = denied');

// 2i. Reason length enforcement
let shortReasonThrew = false;
try {
  requestElevation({ requester: bob, tenant_id: 'acme', requested_role: 'operator', reason: 'too short', duration_sec: 60 });
} catch (err) { shortReasonThrew = err instanceof BreakGlassError && err.kind === 'reason-too-short'; }
assert(shortReasonThrew, 'short reason refused');

// 2j. Duration ceiling
let longThrew = false;
try {
  requestElevation({ requester: bob, tenant_id: 'acme', requested_role: 'admin', reason: 'long-running incident response 2026-05-03', duration_sec: 5 * 3600 });
} catch (err) { longThrew = err instanceof BreakGlassError && err.kind === 'duration-too-long'; }
assert(longThrew, 'duration > 4h refused');

// ─── Per-tenant auth tests ────────────────────────────────────────────
console.log('\n3. Per-tenant claude/codex auth');
await ss.setSecret({
  tenant_id: 'acme', kind: 'claude_oauth',
  value: JSON.stringify({ claudeAiOauth: { accessToken: 'tenant-acme-tok', refreshToken: 'tenant-acme-rt', expiresAt: Date.now() + 3600_000, rateLimitTier: 'tier1', scopes: [], subscriptionType: 'pro' } }),
  rotated_by: 'oliver', rotation_reason: 'initial provisioning',
});
await ss.setSecret({
  tenant_id: 'acme', kind: 'codex_api_key',
  value: 'sk-codex-tenant-acme',
  rotated_by: 'oliver', rotation_reason: 'initial',
});
await ss.setSecret({
  tenant_id: 'acme', kind: 'gh_token',
  value: 'ghp_tenant_acme',
  rotated_by: 'oliver', rotation_reason: 'initial',
});

const credsClaude = await resolveDispatchCredentials({
  tenant_id: 'acme', task_id: 'TP-test', initiated_by: 'alice', engine: 'claude-code-cli',
});
assert(credsClaude.claude_credentials_file !== null, 'claude_credentials_file resolved');
const fileContent = fs.readFileSync(credsClaude.claude_credentials_file!, 'utf8');
assert(fileContent.includes('tenant-acme-tok'), 'claude file contains tenant value');
assert(credsClaude.env_vars.GH_TOKEN === 'ghp_tenant_acme', 'gh_token in env');
const stat = fs.statSync(credsClaude.claude_credentials_file!);
assert((stat.mode & 0o777) === 0o600, `creds file mode 600 (got ${(stat.mode & 0o777).toString(8)})`);
credsClaude.cleanup();
assert(!fs.existsSync(credsClaude.claude_credentials_file!), 'tmpfile cleaned up');

const credsCodex = await resolveDispatchCredentials({
  tenant_id: 'acme', task_id: 'TP-test', initiated_by: 'alice', engine: 'codex-cli',
});
assert(credsCodex.env_vars.OPENAI_API_KEY === 'sk-codex-tenant-acme', 'codex OPENAI_API_KEY in env');

// Refuse for non-existent tenant
let nonexistThrew = false;
try {
  await resolveDispatchCredentials({ tenant_id: 'ghost-tenant', task_id: 'TP-test', initiated_by: 'alice', engine: 'claude-code-cli' });
} catch { nonexistThrew = true; }
assert(nonexistThrew, 'non-existent tenant refused');

// ─── SAML tests ───────────────────────────────────────────────────────
console.log('\n4. SAML signed Response');
// Generate an in-process RSA keypair to simulate an IdP signing cert
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Build a minimal SAML Response with a signed Assertion
const assertionId = 'A_assertion_001';
const now = new Date();
const notBefore = new Date(now.getTime() - 60_000).toISOString();
const notOnOrAfter = new Date(now.getTime() + 600_000).toISOString();
const assertionInner = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" IssueInstant="${now.toISOString()}" Version="2.0">
  <saml:Issuer>https://idp.acme.test/saml</saml:Issuer>
  <saml:Subject>
    <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">alice@acme.test</saml:NameID>
    <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
      <saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}"/>
    </saml:SubjectConfirmation>
  </saml:Subject>
  <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">
    <saml:AudienceRestriction><saml:Audience>https://hermes.acme.test/saml</saml:Audience></saml:AudienceRestriction>
  </saml:Conditions>
  <saml:AttributeStatement>
    <saml:Attribute Name="email"><saml:AttributeValue>alice@acme.test</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="displayName"><saml:AttributeValue>Alice</saml:AttributeValue></saml:Attribute>
    <saml:Attribute Name="groups"><saml:AttributeValue>admins</saml:AttributeValue><saml:AttributeValue>engineers</saml:AttributeValue></saml:Attribute>
  </saml:AttributeStatement>
</saml:Assertion>`;
// Build SignedInfo + sign it
const signedInfo = `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/><ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/><ds:Reference URI="#${assertionId}"><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>placeholder</ds:DigestValue></ds:Reference></ds:SignedInfo>`;
const signer = crypto.createSign('RSA-SHA256');
signer.update(signedInfo);
signer.end();
const sigB64 = signer.sign(privateKey).toString('base64');
const signature = `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${signedInfo}<ds:SignatureValue>${sigB64}</ds:SignatureValue></ds:Signature>`;
// Inject signature inside assertion (after Issuer is the canonical position; for tests, place before Subject)
const signedAssertion = assertionInner.replace(
  '</saml:Issuer>',
  '</saml:Issuer>' + signature,
);
const fullResponse = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">
  <saml:Issuer>https://idp.acme.test/saml</saml:Issuer>
  ${signedAssertion}
</samlp:Response>`;

const samlAdapter = createSamlAdapter({
  provider_id: 'idp-acme',
  idp_issuer: 'https://idp.acme.test/saml',
  sp_entity_id: 'https://hermes.acme.test/saml',
  idp_signing_cert_pem: publicKey,
});
let claims;
try {
  claims = samlAdapter.validateResponse(fullResponse);
  assert(true, 'SAML response validated');
  assert(claims.subject_name_id === 'alice@acme.test', 'subject_name_id extracted');
  assert(claims.email === 'alice@acme.test', 'email extracted');
  assert(claims.groups.includes('admins'), 'admins group extracted');
  assert(claims.groups.includes('engineers'), 'engineers group extracted');
  assert(claims.assertion_id === assertionId, 'assertion_id extracted');
} catch (err) {
  assert(false, `SAML validation failed: ${(err as Error).message}`);
}

// 4b. Replay refused
let replayThrew = false;
try { samlAdapter.validateResponse(fullResponse); }
catch (err) { replayThrew = err instanceof SamlError && err.kind === 'replay-detected'; }
assert(replayThrew, 'replay of same assertion refused');

// 4c. Wrong issuer
const tamperedIssuer = fullResponse.replace('https://idp.acme.test/saml', 'https://attacker.example.com');
let issMismatchThrew = false;
try { samlAdapter.validateResponse(tamperedIssuer); }
catch (err) { issMismatchThrew = err instanceof SamlError; }
// Either signature-invalid (canonicalization changes) OR issuer-mismatch — both acceptable
assert(issMismatchThrew, 'tampered issuer rejected');

// 4d. SAML claims → Principal
if (claims) {
  const samlPrincipal = samlClaimsToPrincipal({
    claims,
    provider_id: 'idp-acme',
    tenant_id: 'acme',
    role_mapping: { groups: { admins: 'admin', engineers: 'operator' }, default_role: 'viewer' },
  });
  assert(samlPrincipal.id === 'idp-acme:alice@acme.test', 'principal id = provider:nameid');
  assert(samlPrincipal.tenant_memberships[0].role === 'admin', `admin wins (got ${samlPrincipal.tenant_memberships[0].role})`);
}

// ─── Cleanup ──────────────────────────────────────────────────────────
await repo._reset_for_test();
await ss._reset_for_test();
_resetBgForTest();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* tolerate */ }

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
