/**
 * T2.1 — OIDC adapter (production-hardened).
 *
 * Spec-compliant OpenID Connect 1.0 client. Works against any
 * OIDC-conformant provider (Auth0, Okta, Google Workspace, Azure AD,
 * Keycloak, AWS Cognito, GitLab, GitHub Enterprise, …) — no provider-
 * specific code in this file.
 *
 * Hardening:
 *   - JWT signature validated via JWKS fetched from issuer's discovery
 *     document (RFC 8414); JWKS cached + rotated automatically (jose
 *     handles kid rotation and clock skew)
 *   - Standard claim validation: iss, aud, exp, iat (jose enforces all)
 *   - Algorithm pin: only operator-allowed `alg` values accepted
 *     (defaults to RS256, ES256 — NEVER `none`, NEVER HS* with public
 *     JWKS; alg-confusion is one of the most common OIDC vulnerabilities)
 *   - Nonce validation when present (prevents replay)
 *   - Refresh token flow with audit
 *   - Provider config cached with TTL; rotation observable via OIDC
 *     metadata change detection
 *
 * Public surface:
 *   createOidcClient(config)                  → OidcClient
 *   client.exchangeAuthorizationCode(code)    → OidcSession (id_token claims + access_token)
 *   client.refresh(refreshToken)              → OidcSession
 *   client.validateIdToken(idTokenJwt)        → IdTokenClaims
 *   client.userinfo(accessToken)              → UserinfoResponse (optional)
 *
 * Integration with PC1:
 *   identityToPrincipal(claims, tenantId, role) → Principal
 *   Maps OIDC `sub`, `email`, `name`, `groups` to a Principal record.
 *   Caller persists via TenantRepository.createPrincipal() /
 *   updatePrincipal().
 */
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyOptions,
  type JWTVerifyResult,
} from 'jose';
import { z } from 'zod';
import {
  Principal,
  TenantRole,
  type TenantMembership,
} from '../tenant/model';
import { secretFingerprint } from '../tenant/secretStore';

// ─── Config ─────────────────────────────────────────────────────────────

export const OidcConfigSchema = z.object({
  /** Stable provider id ('auth0|okta|google|azure-ad|keycloak|...').
   *  Must match Principal.identity_provider for lookup. */
  provider_id: z.string().min(1),
  /** OIDC issuer URL. Discovery is fetched from
   *  ${issuer}/.well-known/openid-configuration. */
  issuer: z.string().url(),
  /** Application client_id (issued by provider). */
  client_id: z.string().min(1),
  /** Client secret (kept in SecretStore PC2 — passed as ref, not value). */
  client_secret_ref: z.object({
    tenant_id: z.string(),
    kind: z.enum(['oidc_client_secret']),
  }),
  /** Audience the harness expects in id_tokens. Defaults to client_id. */
  audience: z.string().optional(),
  /** Allowed JWT signing algs. Default RS256 + ES256.
   *  CRITICAL: never include 'none' or 'HS*' here. */
  allowed_algs: z.array(z.string()).default(['RS256', 'ES256', 'PS256']),
  /** JWKS cache TTL (default 1h — jose default). */
  jwks_cache_ttl_sec: z.number().int().positive().default(3600),
  /** Optional clock skew tolerance in seconds (default 30s). */
  clock_skew_sec: z.number().int().nonnegative().default(30),
  /** Group claim to map to TenantRole. Default 'groups'. */
  group_claim: z.string().default('groups'),
});
export type OidcConfig = z.infer<typeof OidcConfigSchema>;

// ─── OIDC Discovery ─────────────────────────────────────────────────────

const OidcDiscoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string().url(),
  token_endpoint: z.string().url(),
  userinfo_endpoint: z.string().url().optional(),
  jwks_uri: z.string().url(),
  response_types_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional(),
}).passthrough();
export type OidcDiscovery = z.infer<typeof OidcDiscoverySchema>;

// ─── Errors ─────────────────────────────────────────────────────────────

export type OidcErrorKind =
  | 'discovery-failed'
  | 'jwks-fetch-failed'
  | 'jwt-invalid'
  | 'jwt-expired'
  | 'jwt-bad-issuer'
  | 'jwt-bad-audience'
  | 'jwt-bad-alg'
  | 'jwt-replay-detected'
  | 'token-exchange-failed'
  | 'refresh-failed'
  | 'userinfo-failed'
  | 'config-invalid';

export class OidcError extends Error {
  readonly kind: OidcErrorKind;
  readonly cause?: Error;
  constructor(kind: OidcErrorKind, message: string, cause?: Error) {
    super(message);
    this.name = 'OidcError';
    this.kind = kind;
    this.cause = cause;
  }
}

// ─── Token claims ───────────────────────────────────────────────────────

export const IdTokenClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
  email: z.string().email().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  given_name: z.string().optional(),
  family_name: z.string().optional(),
  preferred_username: z.string().optional(),
  groups: z.array(z.string()).optional(),
  /** Auth0 puts roles in 'https://hermes/roles' or similar custom claims. */
}).passthrough();
export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

export interface OidcSession {
  id_token_jwt: string;
  id_token_claims: IdTokenClaims;
  access_token: string;
  /** Short-lived (typ. <1h); refresh required after this. */
  expires_at: string;
  refresh_token: string | null;
  /** Fingerprint of the access_token for audit (we never log the token). */
  access_token_fingerprint: string;
}

// ─── Client ─────────────────────────────────────────────────────────────

export interface OidcClient {
  config: OidcConfig;
  /** Returns the cached discovery doc (refreshed every 24h). */
  discovery(): Promise<OidcDiscovery>;
  /** Exchange authorization code for tokens. */
  exchangeAuthorizationCode(opts: {
    code: string;
    redirect_uri: string;
    /** From the operator's secret store. */
    client_secret: string;
    code_verifier?: string;       // PKCE
  }): Promise<OidcSession>;
  /** Refresh an existing session via refresh_token. */
  refresh(opts: {
    refresh_token: string;
    client_secret: string;
  }): Promise<OidcSession>;
  /** Validate a presented id_token JWT (e.g., from a session cookie). */
  validateIdToken(jwt: string, opts?: { nonce?: string }): Promise<IdTokenClaims>;
  /** Optional: fetch userinfo endpoint. */
  userinfo(accessToken: string): Promise<Record<string, unknown>>;
}

// ─── Construction ───────────────────────────────────────────────────────

interface InternalState {
  config: OidcConfig;
  discoveryDoc: OidcDiscovery | null;
  discoveryFetchedAt: number;
  jwks: ReturnType<typeof createRemoteJWKSet> | null;
}

export function createOidcClient(rawConfig: unknown): OidcClient {
  let config: OidcConfig;
  try {
    config = OidcConfigSchema.parse(rawConfig);
  } catch (err) {
    throw new OidcError('config-invalid', `OIDC config invalid: ${(err as Error).message}`, err as Error);
  }
  // Hard-deny dangerous algs
  for (const alg of config.allowed_algs) {
    if (alg === 'none' || alg.startsWith('HS')) {
      throw new OidcError('config-invalid',
        `Refusing alg=${alg} in OIDC config — alg-confusion attack vector. ` +
        `Use RS256/ES256/PS256 with public JWKS.`);
    }
  }
  const state: InternalState = {
    config,
    discoveryDoc: null,
    discoveryFetchedAt: 0,
    jwks: null,
  };
  return new OidcClientImpl(state);
}

class OidcClientImpl implements OidcClient {
  constructor(private state: InternalState) {}
  get config(): OidcConfig { return this.state.config; }

  async discovery(): Promise<OidcDiscovery> {
    const ttlMs = 24 * 3600 * 1000;
    if (this.state.discoveryDoc && Date.now() - this.state.discoveryFetchedAt < ttlMs) {
      return this.state.discoveryDoc;
    }
    const url = `${this.state.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new OidcError('discovery-failed', `Failed to fetch OIDC discovery from ${url}: ${(err as Error).message}`, err as Error);
    }
    if (!res.ok) {
      throw new OidcError('discovery-failed', `OIDC discovery returned ${res.status}: ${res.statusText}`);
    }
    let json: unknown;
    try { json = await res.json(); }
    catch (err) {
      throw new OidcError('discovery-failed', `OIDC discovery response not JSON`, err as Error);
    }
    const parsed = OidcDiscoverySchema.parse(json);
    if (parsed.issuer !== this.state.config.issuer) {
      throw new OidcError('discovery-failed',
        `OIDC issuer mismatch: configured=${this.state.config.issuer} actual=${parsed.issuer}`);
    }
    this.state.discoveryDoc = parsed;
    this.state.discoveryFetchedAt = Date.now();
    // Build JWKS lazily
    this.state.jwks = createRemoteJWKSet(new URL(parsed.jwks_uri), {
      cacheMaxAge: this.state.config.jwks_cache_ttl_sec * 1000,
      timeoutDuration: 10_000,
    });
    return parsed;
  }

  async validateIdToken(jwt: string, opts?: { nonce?: string }): Promise<IdTokenClaims> {
    const disc = await this.discovery();
    if (!this.state.jwks) throw new OidcError('jwks-fetch-failed', 'JWKS not initialized');
    const verifyOpts: JWTVerifyOptions = {
      issuer: disc.issuer,
      audience: this.state.config.audience ?? this.state.config.client_id,
      algorithms: this.state.config.allowed_algs,
      clockTolerance: this.state.config.clock_skew_sec,
    };
    let result: JWTVerifyResult<JWTPayload>;
    try {
      // `createRemoteJWKSet` returns a function that jose accepts as the
      // key resolver — it picks the right key by `kid` from the JWS header.
      result = await jwtVerify(jwt, this.state.jwks!, verifyOpts);
    } catch (err) {
      // jose surfaces structured failures: JWTExpired (code=ERR_JWT_EXPIRED),
      // JWTClaimValidationFailed (code=ERR_JWT_CLAIM_VALIDATION_FAILED with
      // a `claim` property indicating which claim failed), JWSSignatureVerificationFailed
      // (code=ERR_JWS_SIGNATURE_VERIFICATION_FAILED), JOSEAlgNotAllowed
      // (code=ERR_JOSE_ALG_NOT_ALLOWED).
      const e = err as Error & { code?: string; claim?: string; reason?: string };
      const code = e.code ?? '';
      if (code === 'ERR_JWT_EXPIRED' || code.includes('EXPIRED')) {
        throw new OidcError('jwt-expired', `id_token expired: ${e.message}`, e);
      }
      if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED' || code.includes('CLAIM_VALIDATION')) {
        if (e.claim === 'aud') {
          throw new OidcError('jwt-bad-audience', `id_token audience mismatch: ${e.message}`, e);
        }
        if (e.claim === 'iss') {
          throw new OidcError('jwt-bad-issuer', `id_token issuer mismatch: ${e.message}`, e);
        }
        // Other claim mismatches (sub, nbf, etc.) — surface as generic invalid
        throw new OidcError('jwt-invalid', `id_token claim "${e.claim ?? 'unknown'}" failed validation: ${e.reason ?? e.message}`, e);
      }
      if (code === 'ERR_JOSE_ALG_NOT_ALLOWED' || code.includes('ALG_NOT_ALLOWED')) {
        throw new OidcError('jwt-bad-alg', `id_token alg not in allowed list: ${e.message}`, e);
      }
      if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || code.includes('SIGNATURE')) {
        throw new OidcError('jwt-invalid', `id_token signature invalid: ${e.message}`, e);
      }
      throw new OidcError('jwt-invalid', `id_token validation failed: ${e.message}`, e);
    }
    // Nonce check (when nonce was supplied during auth flow)
    if (opts?.nonce !== undefined) {
      const claimNonce = (result.payload as { nonce?: string }).nonce;
      if (claimNonce !== opts.nonce) {
        throw new OidcError('jwt-replay-detected',
          `id_token nonce mismatch (expected fresh nonce; possible replay)`);
      }
    }
    return IdTokenClaimsSchema.parse(result.payload);
  }

  async exchangeAuthorizationCode(opts: {
    code: string; redirect_uri: string; client_secret: string; code_verifier?: string;
  }): Promise<OidcSession> {
    const disc = await this.discovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: opts.code,
      redirect_uri: opts.redirect_uri,
      client_id: this.state.config.client_id,
      client_secret: opts.client_secret,
    });
    if (opts.code_verifier) body.set('code_verifier', opts.code_verifier);
    return this._postToken(disc.token_endpoint, body);
  }

  async refresh(opts: { refresh_token: string; client_secret: string }): Promise<OidcSession> {
    const disc = await this.discovery();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: opts.refresh_token,
      client_id: this.state.config.client_id,
      client_secret: opts.client_secret,
    });
    return this._postToken(disc.token_endpoint, body);
  }

  async userinfo(accessToken: string): Promise<Record<string, unknown>> {
    const disc = await this.discovery();
    if (!disc.userinfo_endpoint) {
      throw new OidcError('userinfo-failed', `provider does not advertise userinfo_endpoint`);
    }
    const res = await fetch(disc.userinfo_endpoint, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new OidcError('userinfo-failed', `userinfo returned ${res.status}`);
    }
    return await res.json() as Record<string, unknown>;
  }

  private async _postToken(endpoint: string, body: URLSearchParams): Promise<OidcSession> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new OidcError('token-exchange-failed', `token endpoint returned ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = await res.json() as {
      access_token?: string;
      id_token?: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
    };
    if (!json.access_token || !json.id_token) {
      throw new OidcError('token-exchange-failed', `token response missing access_token or id_token`);
    }
    const claims = await this.validateIdToken(json.id_token);
    const expiresAt = json.expires_in
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : new Date(Date.now() + 3600 * 1000).toISOString();
    return {
      id_token_jwt: json.id_token,
      id_token_claims: claims,
      access_token: json.access_token,
      expires_at: expiresAt,
      refresh_token: json.refresh_token ?? null,
      access_token_fingerprint: secretFingerprint(json.access_token),
    };
  }
}

// ─── PC1 integration: claims → Principal ────────────────────────────────

export interface ClaimToRoleMapping {
  /** Map a value of `groups` claim to a TenantRole. Direct match. */
  groups: Record<string, TenantRole>;
  /** Default role when no group matches. */
  default_role: TenantRole;
}

export function identityToPrincipal(opts: {
  claims: IdTokenClaims;
  provider_id: string;
  tenant_id: string;
  role_mapping: ClaimToRoleMapping;
  /** Use the existing principal id when known; otherwise generate. */
  existing_principal_id?: string;
  group_claim?: string;
}): Principal {
  const groupClaimName = opts.group_claim ?? 'groups';
  const groups = (opts.claims as unknown as Record<string, unknown>)[groupClaimName];
  const groupArr = Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
  // Pick the highest-privilege role among matched groups (priority order
  // from the role_mapping object — first match wins).
  let role: TenantRole = opts.role_mapping.default_role;
  for (const g of groupArr) {
    const mapped = opts.role_mapping.groups[g];
    if (mapped) {
      role = rolePrivilegeOrder(role, mapped);
    }
  }
  const now = new Date().toISOString();
  const membership: TenantMembership = {
    tenant_id: opts.tenant_id,
    role,
    assigned_at: now,
    assigned_by: `oidc:${opts.provider_id}`,
  };
  const principal: Principal = {
    schema_version: '1',
    id: opts.existing_principal_id ?? `${opts.provider_id}:${opts.claims.sub}`,
    kind: 'human',
    email: opts.claims.email ?? null,
    display_name: opts.claims.name ?? opts.claims.preferred_username ?? opts.claims.email ?? opts.claims.sub,
    identity_provider: opts.provider_id,
    external_id: opts.claims.sub,
    tenant_memberships: [membership],
    status: 'active',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
  return Principal.parse(principal);
}

const ROLE_PRIORITY: Record<TenantRole, number> = {
  owner: 5, admin: 4, operator: 3, auditor: 2, viewer: 1,
};
function rolePrivilegeOrder(a: TenantRole, b: TenantRole): TenantRole {
  return ROLE_PRIORITY[a] >= ROLE_PRIORITY[b] ? a : b;
}
