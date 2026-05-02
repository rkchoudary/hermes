/**
 * Segregation of Duties (PUB-8) — identity capture + policy-as-code enforcement.
 *
 * Per END-TO-END-PUBLISHABILITY-AUDIT.md PUB-8:
 *   "Segregation-of-Duties (SoD) enforcement — task-pack creator ≠ reviewer ≠
 *    landing-approver; identity captured in evidence; policy-as-code matrix"
 *
 * Required for SOX (ICFR), generic-model-governance (model risk), SOC-2 (operational controls)
 * compliance. Without this, a single principal can author code, review it, and
 * land it to production — a classic SoD violation that flunks any regulated-industry audit.
 *
 * Phase 1 scope:
 *   - Identity schema: name + email + source + captured_at
 *   - captureIdentity(): read git config user.name/email; fall back to OS
 *     username; honor AUTO_ACTOR_OVERRIDE env var (for daemon/CI use)
 *   - SoDPolicy: which role pairs must differ (defaults to all three)
 *   - enforceSoD(actors, role, incoming): returns ok/reason
 *   - human-override path: --by <name> --reason "…" + audit log
 *
 * Phase 2/3 deferred:
 *   - SAML/OIDC integration (Phase 2 — needs platform/auth)
 *   - Hardware-backed identity (signed commits per BP3 SLSA-L2)
 *   - Quorum policy (N-of-M reviewers per role)
 */
import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';

export const Identity = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  /** Where this identity came from. */
  source: z.enum(['git-config', 'env-override', 'os-user', 'manual']),
  captured_at: z.string(),
});
export type Identity = z.infer<typeof Identity>;

export const ActorRole = z.enum(['creator', 'reviewer', 'approver']);
export type ActorRole = z.infer<typeof ActorRole>;

export const Actors = z.object({
  /** First principal who ran auto:work / auto:plan and produced the diff. */
  creator: Identity.optional(),
  /** Principals who ran auto:consensus (one per round; typically daemon or operator). */
  reviewers: z.array(Identity).default([]),
  /** Principals who ran auto:land or auto:promote (one per attempt). */
  approvers: z.array(Identity).default([]),
});
export type Actors = z.infer<typeof Actors>;

export const SoDPolicy = z.object({
  schema_version: z.literal('1').default('1'),
  /** When true, creator must differ from every reviewer. Default true. */
  creator_differs_from_reviewer: z.boolean().default(true),
  /** When true, creator must differ from every approver. Default true. */
  creator_differs_from_approver: z.boolean().default(true),
  /** When true, NO reviewer can also be an approver. Default true. */
  reviewer_differs_from_approver: z.boolean().default(true),
  /** Minimum number of distinct reviewers required before approval. Default 1. */
  min_reviewers: z.number().int().min(0).default(1),
  /** Minimum number of distinct approvers required to land. Default 1. */
  min_approvers: z.number().int().min(0).default(1),
  /** When true, refuse SoD-violating transitions even with --human-override. Default false. */
  block_overrides: z.boolean().default(false),
});
export type SoDPolicy = z.infer<typeof SoDPolicy>;

export function defaultSoDPolicy(): SoDPolicy {
  return SoDPolicy.parse({});
}

/**
 * Capture the current operator's identity. Resolution order:
 *   1. AUTO_ACTOR_OVERRIDE env var (e.g., "daemon@nightly-build" set by CI)
 *   2. git config user.name + user.email
 *   3. OS user (os.userInfo().username) as last resort
 *
 * Always succeeds — at minimum returns an os-user identity. The audit trail
 * records WHICH source was used so reviewers can detect missing config.
 */
export function captureIdentity(): Identity {
  const at = new Date().toISOString();

  const override = process.env.AUTO_ACTOR_OVERRIDE;
  if (override && override.trim().length > 0) {
    return Identity.parse({
      name: override.trim(),
      source: 'env-override',
      captured_at: at,
    });
  }

  const nameRes = spawnSync('git', ['config', '--get', 'user.name'], { encoding: 'utf8', timeout: 2000 });
  const emailRes = spawnSync('git', ['config', '--get', 'user.email'], { encoding: 'utf8', timeout: 2000 });
  const name = nameRes.status === 0 ? nameRes.stdout.trim() : '';
  const email = emailRes.status === 0 ? emailRes.stdout.trim() : '';
  if (name) {
    return Identity.parse({
      name,
      email: email && email.includes('@') ? email : undefined,
      source: 'git-config',
      captured_at: at,
    });
  }

  let osUser = 'unknown';
  try { osUser = os.userInfo().username; } catch { /* fall through */ }
  return Identity.parse({
    name: osUser,
    source: 'os-user',
    captured_at: at,
  });
}

/**
 * Compare two identities. Identities match when the canonical key (lowercased
 * email if present, else lowercased name) is equal. We don't trust raw name
 * comparisons because casing/whitespace varies across git config installs.
 */
export function identityKey(id: Identity): string {
  return (id.email ?? id.name).toLowerCase().trim();
}

export function identitiesMatch(a: Identity, b: Identity): boolean {
  return identityKey(a) === identityKey(b);
}

export interface SoDCheck {
  ok: boolean;
  reason?: string;
  /** Suggested operator action if the check failed (auditable). */
  remediation?: string;
}

/**
 * Enforce the SoD policy when `incoming` is about to take on `role` for a
 * task whose actors-so-far are `actors`. Returns ok=true when the transition
 * is allowed, ok=false with reason+remediation when blocked.
 *
 * For role='reviewer' or role='approver', we ALSO check the role-count
 * minimum here — the caller can choose to enforce or warn.
 */
export function enforceSoD(
  policy: SoDPolicy,
  actors: Actors,
  role: ActorRole,
  incoming: Identity
): SoDCheck {
  const inKey = identityKey(incoming);

  if (role === 'reviewer') {
    if (policy.creator_differs_from_reviewer && actors.creator && identityKey(actors.creator) === inKey) {
      return {
        ok: false,
        reason: `SoD violation: reviewer '${incoming.name}' is the task creator. Per SOX/generic-model-governance, reviewer must differ from creator.`,
        remediation: `Either dispatch consensus from a different operator/host, OR set AUTO_ACTOR_OVERRIDE to a distinct principal, OR human-override with --reason citing the policy exception.`,
      };
    }
  }
  if (role === 'approver') {
    if (policy.creator_differs_from_approver && actors.creator && identityKey(actors.creator) === inKey) {
      return {
        ok: false,
        reason: `SoD violation: approver '${incoming.name}' is the task creator. Per SOX/generic-model-governance, approver must differ from creator.`,
        remediation: `Have a different operator run auto:land/auto:promote, OR human-override with --reason.`,
      };
    }
    if (policy.reviewer_differs_from_approver) {
      for (const r of actors.reviewers) {
        if (identityKey(r) === inKey) {
          return {
            ok: false,
            reason: `SoD violation: approver '${incoming.name}' was already a reviewer for this task. Per SOX/generic-model-governance, no principal may both review and approve.`,
            remediation: `Have a different operator approve, OR human-override with --reason.`,
          };
        }
      }
    }
    if (policy.min_reviewers > 0 && actors.reviewers.length < policy.min_reviewers) {
      return {
        ok: false,
        reason: `SoD violation: fewer than ${policy.min_reviewers} reviewer(s) on record. Cannot approve until reviewers logged.`,
        remediation: `Run pnpm auto:consensus first, then re-attempt approval.`,
      };
    }
  }

  return { ok: true };
}

/**
 * Append an identity to the actors record without violating uniqueness
 * (idempotent on identity key). Returns the updated Actors.
 */
export function appendActor(actors: Actors, role: ActorRole, identity: Identity): Actors {
  const next: Actors = {
    creator: actors.creator,
    reviewers: [...actors.reviewers],
    approvers: [...actors.approvers],
  };
  if (role === 'creator') {
    next.creator = identity;
    return next;
  }
  const list = role === 'reviewer' ? next.reviewers : next.approvers;
  const inKey = identityKey(identity);
  if (!list.some((i) => identityKey(i) === inKey)) {
    list.push(identity);
  }
  return next;
}
