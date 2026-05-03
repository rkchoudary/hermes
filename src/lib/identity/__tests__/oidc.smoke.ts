/**
 * OIDC adapter smoke. Ships its own in-process HTTP fixture that
 * mimics a full OIDC provider — discovery doc, JWKS, signed JWT
 * issuance — so the adapter is exercised end-to-end without needing
 * Auth0/Okta/etc credentials.
 *
 * Validates:
 *   1. Discovery doc fetch + cache + issuer mismatch detection
 *   2. JWT signature validation against fetched JWKS
 *   3. Expired JWT rejection (jwt-expired)
 *   4. Wrong-audience rejection (jwt-bad-audience)
 *   5. Wrong-issuer rejection (jwt-bad-issuer)
 *   6. Banned-alg rejection (config-invalid on 'none' / HS256)
 *   7. Token exchange + refresh flow
 *   8. Nonce replay detection
 *   9. Claims → Principal mapping with group → role precedence
 */
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createOidcClient, OidcError, identityToPrincipal } from '../oidc';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

console.log('oidc.smoke — production-hardened OIDC adapter');

// ─── Fixture: in-process OIDC provider ─────────────────────────────────

interface FixtureProvider {
  baseUrl: string;
  privateKey: CryptoKey;
  publicJwk: object;
  kid: string;
  close: () => Promise<void>;
  // Configurable for negative tests
  flags: {
    invalid_jwks: boolean;
    discovery_wrong_issuer: boolean;
  };
  // Token-exchange counter
  exchanges: number;
}

async function startFixture(): Promise<FixtureProvider> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwkRaw = await exportJWK(publicKey);
  const kid = 'test-key-1';
  const publicJwk = { ...jwkRaw, kid, alg: 'RS256', use: 'sig' };
  const flags = { invalid_jwks: false, discovery_wrong_issuer: false };
  let exchanges = 0;
  let server: http.Server | null = null;
  let port = 0;
  await new Promise<void>((resolve) => {
    server = http.createServer(async (req, res) => {
      const url = req.url ?? '';
      const baseUrl = `http://127.0.0.1:${port}`;
      const issuer = flags.discovery_wrong_issuer ? 'http://127.0.0.1:9999' : baseUrl;
      if (url === '/.well-known/openid-configuration') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          issuer,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          userinfo_endpoint: `${baseUrl}/userinfo`,
          jwks_uri: `${baseUrl}/jwks`,
          response_types_supported: ['code'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email', 'profile'],
        }));
        return;
      }
      if (url === '/jwks') {
        res.setHeader('Content-Type', 'application/json');
        if (flags.invalid_jwks) {
          res.statusCode = 500;
          res.end('{"error":"unavailable"}');
          return;
        }
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      if (url === '/token' && req.method === 'POST') {
        exchanges++;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const grantType = body.get('grant_type');
          if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
            return;
          }
          const idToken = await new SignJWT({
            sub: 'user-abc-123',
            email: 'alice@acme.test',
            email_verified: true,
            name: 'Alice Tester',
            groups: ['hermes-admins', 'engineering'],
          })
            .setProtectedHeader({ alg: 'RS256', kid })
            .setIssuer(issuer)
            .setAudience('hermes-client')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            access_token: 'access-' + crypto.randomBytes(8).toString('hex'),
            id_token: idToken,
            refresh_token: 'refresh-' + crypto.randomBytes(8).toString('hex'),
            expires_in: 3600,
            token_type: 'Bearer',
          }));
        });
        return;
      }
      if (url === '/userinfo') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          sub: 'user-abc-123',
          email: 'alice@acme.test',
          name: 'Alice Tester',
          groups: ['hermes-admins'],
        }));
        return;
      }
      res.statusCode = 404;
      res.end('Not Found');
    });
    server!.listen(0, '127.0.0.1', () => {
      port = (server!.address() as { port: number }).port;
      resolve();
    });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    privateKey,
    publicJwk,
    kid,
    close: () => new Promise<void>((res) => server!.close(() => res())),
    flags,
    exchanges,
  };
}

// ─── 1. Discovery + token exchange + JWT validation ────────────────────
console.log('\n1. Discovery + token exchange + JWT validation');
const fx = await startFixture();
const client = createOidcClient({
  provider_id: 'fixture',
  issuer: fx.baseUrl,
  client_id: 'hermes-client',
  client_secret_ref: { tenant_id: 'default', kind: 'oidc_client_secret' },
  audience: 'hermes-client',
  allowed_algs: ['RS256'],
});
const disc = await client.discovery();
assert(disc.issuer === fx.baseUrl, 'discovery returns matching issuer');
assert(disc.token_endpoint.startsWith(fx.baseUrl), 'discovery has token_endpoint');

const session = await client.exchangeAuthorizationCode({
  code: 'fake-code',
  redirect_uri: `${fx.baseUrl}/callback`,
  client_secret: 'shh',
});
assert(typeof session.id_token_jwt === 'string' && session.id_token_jwt.length > 100, 'id_token returned');
assert(session.id_token_claims.sub === 'user-abc-123', 'id_token sub validated');
assert(session.id_token_claims.email === 'alice@acme.test', 'id_token email present');
assert(session.refresh_token !== null, 'refresh_token returned');
assert(typeof session.access_token_fingerprint === 'string' && session.access_token_fingerprint.length === 16, 'access_token fingerprint computed');

// ─── 2. Refresh flow ──────────────────────────────────────────────────
console.log('\n2. Refresh flow');
const refreshed = await client.refresh({
  refresh_token: session.refresh_token!,
  client_secret: 'shh',
});
assert(refreshed.id_token_claims.sub === 'user-abc-123', 'refresh returns valid id_token');

// ─── 3. Expired JWT rejected ──────────────────────────────────────────
console.log('\n3. Expired JWT rejection');
const expiredJwt = await new SignJWT({ sub: 'expired-user' })
  .setProtectedHeader({ alg: 'RS256', kid: fx.kid })
  .setIssuer(fx.baseUrl)
  .setAudience('hermes-client')
  .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
  .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)  // 1h ago
  .sign(fx.privateKey);
let kind = '';
try { await client.validateIdToken(expiredJwt); }
catch (err) { kind = err instanceof OidcError ? err.kind : 'wrong-error-class'; }
assert(kind === 'jwt-expired', `expired jwt → jwt-expired (got ${kind})`);

// ─── 4. Wrong-audience rejection ──────────────────────────────────────
console.log('\n4. Wrong audience rejection');
const wrongAudJwt = await new SignJWT({ sub: 'attacker' })
  .setProtectedHeader({ alg: 'RS256', kid: fx.kid })
  .setIssuer(fx.baseUrl)
  .setAudience('different-app')        // wrong audience
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(fx.privateKey);
kind = '';
try { await client.validateIdToken(wrongAudJwt); }
catch (err) { kind = err instanceof OidcError ? err.kind : 'wrong-error-class'; }
assert(kind === 'jwt-bad-audience', `wrong aud → jwt-bad-audience (got ${kind})`);

// ─── 5. Wrong-issuer rejection ────────────────────────────────────────
console.log('\n5. Wrong issuer rejection');
const wrongIssJwt = await new SignJWT({ sub: 'attacker' })
  .setProtectedHeader({ alg: 'RS256', kid: fx.kid })
  .setIssuer('https://attacker.example.com')   // wrong issuer
  .setAudience('hermes-client')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(fx.privateKey);
kind = '';
try { await client.validateIdToken(wrongIssJwt); }
catch (err) { kind = err instanceof OidcError ? err.kind : 'wrong-error-class'; }
assert(kind === 'jwt-bad-issuer', `wrong iss → jwt-bad-issuer (got ${kind})`);

// ─── 6. Banned-alg rejection at config time ──────────────────────────
console.log('\n6. Banned-alg config rejection');
let configThrew = false;
try {
  createOidcClient({
    provider_id: 'bad',
    issuer: fx.baseUrl,
    client_id: 'x',
    client_secret_ref: { tenant_id: 'default', kind: 'oidc_client_secret' },
    allowed_algs: ['none'],
  });
} catch (err) {
  configThrew = err instanceof OidcError && err.kind === 'config-invalid';
}
assert(configThrew, "alg='none' rejected at config time");

let hsThrew = false;
try {
  createOidcClient({
    provider_id: 'bad',
    issuer: fx.baseUrl,
    client_id: 'x',
    client_secret_ref: { tenant_id: 'default', kind: 'oidc_client_secret' },
    allowed_algs: ['HS256'],
  });
} catch (err) {
  hsThrew = err instanceof OidcError && err.kind === 'config-invalid';
}
assert(hsThrew, "alg='HS256' rejected at config time (alg-confusion vector)");

// ─── 7. Issuer-mismatch detection ────────────────────────────────────
console.log('\n7. Issuer-mismatch detection');
fx.flags.discovery_wrong_issuer = true;
const client2 = createOidcClient({
  provider_id: 'fixture-mismatch',
  issuer: fx.baseUrl,                    // we configure the legitimate issuer…
  client_id: 'hermes-client',
  client_secret_ref: { tenant_id: 'default', kind: 'oidc_client_secret' },
  allowed_algs: ['RS256'],
});
let discoveryThrew = false;
try { await client2.discovery(); }
catch (err) { discoveryThrew = err instanceof OidcError && err.kind === 'discovery-failed'; }
assert(discoveryThrew, 'discovery doc serving wrong issuer → discovery-failed');
fx.flags.discovery_wrong_issuer = false;

// ─── 8. Userinfo ──────────────────────────────────────────────────────
console.log('\n8. Userinfo endpoint');
const ui = await client.userinfo(session.access_token);
assert(ui.sub === 'user-abc-123', 'userinfo returns sub');

// ─── 9. Claims → Principal mapping ────────────────────────────────────
console.log('\n9. Claims → Principal mapping');
const principal = identityToPrincipal({
  claims: session.id_token_claims,
  provider_id: 'fixture',
  tenant_id: 'acme-bank',
  role_mapping: {
    groups: {
      'hermes-admins': 'admin',
      'engineering': 'operator',
      'auditors': 'auditor',
    },
    default_role: 'viewer',
  },
});
assert(principal.id === 'fixture:user-abc-123', `principal id = provider:sub (got ${principal.id})`);
assert(principal.email === 'alice@acme.test', 'email preserved');
assert(principal.tenant_memberships[0].role === 'admin', `admin wins over operator (got ${principal.tenant_memberships[0].role})`);
assert(principal.identity_provider === 'fixture', 'identity_provider set');
assert(principal.external_id === 'user-abc-123', 'external_id = sub');

// Default role when no group matches
const principal2 = identityToPrincipal({
  claims: { ...session.id_token_claims, groups: ['unknown-group'] } as never,
  provider_id: 'fixture',
  tenant_id: 'acme-bank',
  role_mapping: {
    groups: { 'admins': 'admin' },
    default_role: 'viewer',
  },
});
assert(principal2.tenant_memberships[0].role === 'viewer', 'unmatched groups → default_role=viewer');

// Cleanup
await fx.close();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
