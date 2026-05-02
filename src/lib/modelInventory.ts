/**
 * Model inventory + change-control (PUB-10 / Codex R2 model-risk-management).
 *
 * Per END-TO-END-PUBLISHABILITY-AUDIT.md:143:
 *   "Model inventory + change-control — pinned model_id + temperature +
 *    system_prompt_hash + tool_versions per dispatch; new model versions
 *    require qualification before promotion"
 *
 * Required for generic-model-governance (model governance) compliance: every model that
 * touches a compliance-sensitive change must be on the qualified list, with audit trail
 * of who approved it and why.
 *
 * Phase 1 scope:
 *   - Schema for the inventory file (.agent-runs/_model-inventory.json)
 *   - readInventory / writeInventory
 *   - isQualified() pre-dispatch guard
 *   - defaultInventory() — bundles the models in active use today
 *   - enforce flag: when true (default), non-qualified models refuse dispatch
 *
 * Phase 2/3 deferred:
 *   - SoD on qualification approvals (PUB-8)
 *   - Continuous-eval of qualified models against private holdout (PUB-11)
 *   - SLSA-L2/L3 signed qualification attestations (BP3)
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ModelRole = z.enum([
  'impl-worker',     // dispatches via auto:work to write code
  'codex-reviewer',  // dispatches via auto:consensus for review
  'consensus',       // synonym kept for clarity in some docs
  'experimental',    // allowed but flagged in evidence; not for SOX-scope merges
]);
export type ModelRole = z.infer<typeof ModelRole>;

export const QualifiedModel = z.object({
  /** Engine that routes to this model. */
  engine: z.enum(['claude-code-cli', 'claude-agent-sdk', 'codex-cli', 'subagent', 'manual']),
  /** Pinned model id. */
  model_id: z.string().min(1),
  /** Optional: pinned model version (e.g., '2026-04-01' or full SHA). */
  model_version: z.string().optional(),
  /** ISO timestamp of qualification. */
  qualified_at: z.string(),
  /** Identity who approved (operator or sponsor). */
  qualified_by: z.string().min(1),
  /** Free-form audit justification. */
  qualification_reason: z.string().min(1),
  /** Roles this model is qualified for. */
  roles: z.array(ModelRole).min(1),
  /** Maximum temperature allowed (NaN/undefined = engine default only). */
  max_temperature: z.number().min(0).max(2).optional(),
  /** Tool-version constraints (e.g., { codex: '>=0.125.0' }). Free-form for Phase 1. */
  tool_versions_constraints: z.record(z.string()).optional(),
  /** SHA-256 of the system prompt approved with this model (for replay audit). */
  system_prompt_hash: z.string().optional(),
});
export type QualifiedModel = z.infer<typeof QualifiedModel>;

export const ModelInventory = z.object({
  schema_version: z.literal('1').default('1'),
  models: z.array(QualifiedModel),
  /** When true, non-qualified models refuse dispatch. Default true (generic-model-governance). */
  enforce: z.boolean().default(true),
  /** Last operator review of the inventory (audit cadence). */
  last_reviewed_at: z.string().optional(),
  last_reviewed_by: z.string().optional(),
});
export type ModelInventory = z.infer<typeof ModelInventory>;

const INVENTORY_REL_PATH = '.agent-runs/_model-inventory.json';

export function inventoryPath(harnessRoot: string): string {
  return path.join(harnessRoot, INVENTORY_REL_PATH);
}

export function readInventory(harnessRoot: string): ModelInventory | null {
  const p = inventoryPath(harnessRoot);
  if (!fs.existsSync(p)) return null;
  try {
    return ModelInventory.parse(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (e) {
    throw new Error(`[model-inventory] Failed to parse ${p}: ${(e as Error).message}`);
  }
}

export function writeInventory(harnessRoot: string, inventory: ModelInventory): void {
  const p = inventoryPath(harnessRoot);
  if (!fs.existsSync(path.dirname(p))) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  // Atomic write — tempfile + rename, mirroring atomicWriteFile in runState.
  const tempPath = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(inventory, null, 2));
  fs.renameSync(tempPath, p);
}

export interface QualificationCheck {
  ok: boolean;
  reason?: string;
  matched?: QualifiedModel;
}

/**
 * Verify a model is qualified for the given engine + role.
 *
 * Returns ok=true if either:
 *   - inventory is null and enforce defaults are not yet established (warn-only mode), OR
 *   - inventory.enforce is false, OR
 *   - a model entry matches engine + model_id (and optionally model_version) AND
 *     includes the requested role.
 *
 * Returns ok=false otherwise, with a human-readable reason.
 */
export function isQualified(
  inventory: ModelInventory | null,
  engine: string,
  model_id: string,
  role: ModelRole,
  model_version?: string
): QualificationCheck {
  if (!inventory) {
    // R7 fix: missing inventory is now FAIL-CLOSED, not warn-open. generic-model-governance
    // requires every model touching a compliance-sensitive change to be on the qualified
    // list; "no list = ok" is exactly the gap PUB-10 was supposed to close.
    // Operator opts in via `pnpm auto:model init` (one-time bootstrap) or
    // sets AUTO_MODEL_INVENTORY_BYPASS=1 + AUTO_MODEL_INVENTORY_BYPASS_REASON
    // for emergency dispatch (R8+1: stated reason now required for audit).
    if (process.env.AUTO_MODEL_INVENTORY_BYPASS === '1') {
      const reason = process.env.AUTO_MODEL_INVENTORY_BYPASS_REASON;
      if (!reason || reason.length < 3) {
        return {
          ok: false,
          reason:
            'AUTO_MODEL_INVENTORY_BYPASS=1 set but AUTO_MODEL_INVENTORY_BYPASS_REASON missing or empty. ' +
            'SOX requires a stated reason for every bypass. Set both env vars.',
        };
      }
      return {
        ok: true,
        reason: `AUTO_MODEL_INVENTORY_BYPASS=1 set with reason='${reason.slice(0, 60)}' — caller MUST appendOverrideAudit before dispatch.`,
      };
    }
    return {
      ok: false,
      reason:
        'No inventory file at .agent-runs/_model-inventory.json. generic-model-governance requires qualification before dispatch. ' +
        'Run `pnpm auto:model init` to bootstrap, or set AUTO_MODEL_INVENTORY_BYPASS=1 + AUTO_MODEL_INVENTORY_BYPASS_REASON="…" for emergency dispatch.',
    };
  }
  if (!inventory.enforce) {
    return { ok: true, reason: 'inventory.enforce=false — qualification check skipped (operator opt-out)' };
  }
  for (const m of inventory.models) {
    if (m.engine !== engine) continue;
    if (m.model_id !== model_id) continue;
    if (model_version && m.model_version && m.model_version !== model_version) continue;
    if (!m.roles.includes(role)) {
      return {
        ok: false,
        reason: `model ${engine}/${model_id} is qualified but NOT for role '${role}'; qualified roles: ${m.roles.join(', ')}`,
        matched: m,
      };
    }
    return { ok: true, matched: m };
  }
  return {
    ok: false,
    reason:
      `model ${engine}/${model_id}${model_version ? `@${model_version}` : ''} is NOT in the qualified inventory. ` +
      `Either: (a) qualify it explicitly via pnpm auto:model qualify, ` +
      `(b) set inventory.enforce=false to opt out (NOT recommended for generic-model-governance scope), or ` +
      `(c) re-dispatch with a qualified model.`,
  };
}

/**
 * Default inventory — pre-populated with the models in active use today.
 * Operators must update last_reviewed_* on ratification per generic-model-governance cadence.
 */
export function defaultInventory(): ModelInventory {
  const at = new Date().toISOString();
  return ModelInventory.parse({
    schema_version: '1',
    enforce: true,
    last_reviewed_at: at,
    last_reviewed_by: 'harness-bootstrap',
    models: [
      {
        engine: 'claude-code-cli',
        model_id: 'claude-opus-4-7',
        qualified_at: at,
        qualified_by: 'harness-bootstrap',
        qualification_reason:
          'Default impl-worker — Claude Code CLI (Max plan, no API billing). Set via AUTO_CLAUDE_BIN env if claude CLI is at non-default path.',
        roles: ['impl-worker'],
      },
      {
        engine: 'codex-cli',
        model_id: 'gpt-5.5',
        qualified_at: at,
        qualified_by: 'harness-bootstrap',
        qualification_reason:
          'Default consensus reviewer — independent vendor. Set via AUTO_CODEX_BIN env. xhigh reasoning effort. Independent verifier (separate vendor from impl-worker).',
        roles: ['codex-reviewer', 'consensus'],
      },
      {
        engine: 'claude-agent-sdk',
        model_id: 'claude-opus-4-7',
        qualified_at: at,
        qualified_by: 'harness-bootstrap',
        qualification_reason:
          'Opt-in API-billed path for environments without Max subscription. Requires AUTO_ALLOW_API_BILLING=1 to dispatch (per work.ts preflight). Same model_id as claude-code-cli; routes through @anthropic-ai/sdk.',
        roles: ['impl-worker', 'experimental'],
      },
    ],
  });
}
