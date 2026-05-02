/**
 * Override audit log (R8 closure for the MEDIUM "durable bypass audit" gap).
 *
 * Per Codex R8: "AUTO_SOD_REVIEWER_OVERRIDE and AUTO_MODEL_INVENTORY_BYPASS
 * print warnings but do not create durable audit records." Same problem with
 * --force on auto:land and --human-override on auto:promote — the bypass
 * happens, but no SOX-style append-only record exists.
 *
 * This module adds the missing primitive: appendOverrideAudit(harnessRoot,
 * entry) writes to .agent-runs/_override-audit.jsonl (append-only,
 * line-atomic per POSIX). Every bypass site (4 in current code) now writes
 * an entry; auditors can grep the file for "who bypassed what when, with
 * what stated reason."
 *
 * Phase 2 will:
 *   - Cryptographically sign each entry (BP3 SLSA-L2)
 *   - Mirror to WORM-grade external store (S3 + Object Lock)
 *   - Wire into PUB-9 require_operator_overrides_logged rule (currently stub)
 */
import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Identity } from './sod';

export const OverrideKind = z.enum([
  'force-land',                    // --force passed to auto:land
  'force-work',                    // --force passed to auto:work (R12 closure)
  'human-override-promote',        // --human-override passed to auto:promote
  'sod-reviewer-bypass',           // AUTO_SOD_REVIEWER_OVERRIDE=1 in auto:consensus
  'model-inventory-bypass',        // AUTO_MODEL_INVENTORY_BYPASS=1 in any dispatcher
  'budget-meter-bypass',           // (Phase 2 reserved)
  'kill-switch-clear',             // (Phase 2 reserved — currently `pnpm auto:kill-off`)
  'watchdog-reap',                 // processWatchdog killed a stale/hung/over-deadline process
  'cleanup-action',                // cleanupPolicy deleted/archived stale resources per retention rules
  'health-alert',                  // systemHealth raised an alert (disk, memory, registry size, etc.)
  'auto-promote-decision',         // v0.5.0: auto:tick --auto-promote evaluated a promotable task (eligible OR not)
  'interrupt-task',                // operator wrote a per-task interrupt sentinel (auto:interrupt)
  'steer-task',                    // operator issued a mid-task steering directive (auto:steer)
]);
export type OverrideKind = z.infer<typeof OverrideKind>;

export const OverrideAuditEntry = z.object({
  schema_version: z.literal('1').default('1'),
  /** ISO timestamp; this is the audit anchor. */
  at: z.string(),
  /** Who bypassed. */
  actor: Identity,
  /** What was bypassed. */
  kind: OverrideKind,
  /** Free-form operator-stated reason (REQUIRED — empty refused). */
  reason: z.string().min(3),
  /** Optional: which task was affected. */
  task_id: z.string().optional(),
  /** Optional: which run was affected. */
  run_id: z.string().optional(),
  /** Optional: extra context for forensic audit (rule, severity, etc.). */
  context: z.record(z.unknown()).optional(),
  /** Process info for forensic correlation. */
  pid: z.number().int(),
  host: z.string().optional(),
});
export type OverrideAuditEntry = z.infer<typeof OverrideAuditEntry>;

const AUDIT_REL_PATH = '.agent-runs/_override-audit.jsonl';

export function auditPath(harnessRoot: string): string {
  return path.join(harnessRoot, AUDIT_REL_PATH);
}

/**
 * Append a single audit entry. Line-atomic on POSIX (per POSIX guarantees
 * for writes ≤ PIPE_BUF = 4KB; an OverrideAuditEntry is ~400 bytes), so
 * concurrent appenders never interleave bytes within a single entry.
 *
 * Throws on schema violation (which means a caller forgot to pass `reason`
 * — that's a programming error worth surfacing, not a silent skip).
 */
export function appendOverrideAudit(harnessRoot: string, entry: OverrideAuditEntry): void {
  const validated = OverrideAuditEntry.parse(entry);
  const p = auditPath(harnessRoot);
  if (!fs.existsSync(path.dirname(p))) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
  }
  fs.appendFileSync(p, JSON.stringify(validated) + '\n');
}

/**
 * Read all audit entries (for forensic review or PUB-9 rule evaluation).
 * Returns [] if the file doesn't exist.
 */
export function readOverrideAudit(harnessRoot: string): OverrideAuditEntry[] {
  const p = auditPath(harnessRoot);
  if (!fs.existsSync(p)) return [];
  const body = fs.readFileSync(p, 'utf8');
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const entries: OverrideAuditEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(OverrideAuditEntry.parse(JSON.parse(line)));
    } catch {
      // Skip malformed lines; production audit infra would alert here.
    }
  }
  return entries;
}
