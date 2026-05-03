/**
 * Layer 8 — Idempotent plan ID hashing.
 *
 * Doctrine: re-running plan against the same (module, stage, version,
 * FRD-sha, harness-version) produces the same plan ID. The driver
 * refuses to create a duplicate task pack with the same hash unless
 * --force.
 *
 * Closes the failure mode where a crashed driver, re-invoked, would
 * spawn a fresh task pack (TP-N+1) for the same logical work and the
 * operator ends up with two parallel attempts at the same module-stage.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export interface PlanIdInput {
  module: string;
  stage: string;
  version: string;
  /** Path to FRD/spec file. Hash of contents is what makes the ID stable. */
  frd_path?: string;
  /** Pre-computed FRD sha if caller already has it. */
  frd_sha256?: string;
  /** Harness version stamp for blue-green coexistence. */
  harness_version?: string;
}

export function computePlanId(input: PlanIdInput): string {
  let frdSha = input.frd_sha256 ?? '';
  if (!frdSha && input.frd_path && fs.existsSync(input.frd_path)) {
    frdSha = crypto.createHash('sha256').update(fs.readFileSync(input.frd_path)).digest('hex');
  }
  const components = [
    input.module,
    input.stage,
    input.version,
    frdSha,
    input.harness_version ?? '',
  ].join('|');
  return crypto.createHash('sha256').update(components).digest('hex').slice(0, 16);
}
