/**
 * Cleanup policy engine — proactive resource cleanup at right intervals.
 *
 * Operator directive (2026-04-28): "Make sure proactive clean up of resources
 * is scheduled at right regular intervals and clean up is done smartly as per
 * standards and best practices."
 *
 * Design principles:
 *
 *   1. DECLARATIVE POLICIES per resource type (CleanupPolicy[]).
 *      Each policy: scope (where to look), match (what files), retention
 *      (mtime-based ttl OR count-based cap), action (delete | archive),
 *      cadence (how often the policy is allowed to run).
 *
 *   2. DRY-RUN BY DEFAULT. apply=false enumerates what WOULD be deleted;
 *      apply=true actually removes. Every removal audited via
 *      appendOverrideAudit kind='cleanup-action' with byte-count + path
 *      so SOX-style audit trails are preserved.
 *
 *   3. NEVER DELETE AUDIT/COMPLIANCE FILES. _override-audit.jsonl,
 *      _escalation-log.jsonl, _process-registry.json — these are managed
 *      by their own subsystems or are append-only retention. Cleanup never
 *      touches them.
 *
 *   4. RATE-LIMITED. State stored in `.agent-runs/_cleanup-state.json`:
 *      last_run_at[policy_id] timestamps. Tick-driven invocation skips
 *      policies that ran within their cadence window — so cleanup runs
 *      hourly/daily/weekly per policy, not every minute.
 *
 *   5. ATOMIC + IDEMPOTENT. fs.unlinkSync on individual files; failures
 *      logged but never block other policies. Re-running is safe.
 *
 * Standards: POSIX `find -mtime` semantics, 12-factor ephemeral filesystem,
 * SOX audit retention (append-only logs untouched).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { atomicWriteFile } from './runState';
import { captureIdentity } from './sod';
import { appendOverrideAudit } from './overrideAudit';

// ─── Policy schema ──────────────────────────────────────────────────────────

export const CleanupPolicy = z.object({
  /** Stable id used for rate-limit state + audit context. */
  id: z.string().min(1),
  /** Human description shown in CLI. */
  description: z.string(),
  /** Directory to scan; absolute path or relative to harnessRoot. */
  scope: z.string(),
  /** Regex match against the file basename. Anchored implicitly. */
  match_basename: z.string(),
  /** Recurse into subdirs? Default false. */
  recursive: z.boolean().default(false),
  /** TTL in seconds — files with mtime older than this get cleaned. 0 = no ttl rule. */
  ttl_seconds: z.number().int().nonnegative().default(0),
  /** Max-count cap — keep N newest, delete the rest. 0 = no count cap. */
  max_count: z.number().int().nonnegative().default(0),
  /** Min file age (sec) before considering deletion — protects in-flight files. Default 60s. */
  min_age_seconds: z.number().int().nonnegative().default(60),
  /** Cadence — minimum sec between runs of this policy. */
  cadence_seconds: z.number().int().positive(),
  /** Action: delete (unlink) or archive (move to archive_dir). MVP supports delete only. */
  action: z.enum(['delete']).default('delete'),
});
export type CleanupPolicy = z.infer<typeof CleanupPolicy>;

// ─── Built-in policies (best-practice retention windows) ─────────────────────

export const DEFAULT_POLICIES: CleanupPolicy[] = [
  {
    id: 'tmp-worker-prompts',
    description: '/tmp auto-worker prompt + output files (volatile per-task)',
    scope: '/tmp',
    match_basename: '^auto-worker-(prompt|output)-TP-\\d{4}-\\d{2}-\\d{2}-\\d+\\.txt$',
    recursive: false,
    ttl_seconds: 24 * 3600,
    max_count: 0,
    min_age_seconds: 300,
    cadence_seconds: 3600,  // hourly
    action: 'delete',
  },
  {
    id: 'tmp-codex-md',
    description: '/tmp codex-*.md ad-hoc dispatch outputs (re-creatable from prompts)',
    scope: '/tmp',
    match_basename: '^codex-.*\\.md$',
    recursive: false,
    ttl_seconds: 24 * 3600,
    max_count: 0,
    min_age_seconds: 300,
    cadence_seconds: 3600,
    action: 'delete',
  },
  {
    id: 'tmp-codex-prompts',
    description: '/tmp codex-*-prompt.txt ad-hoc dispatch prompts',
    scope: '/tmp',
    match_basename: '^codex-.*-prompt\\.txt$',
    recursive: false,
    ttl_seconds: 24 * 3600,
    max_count: 0,
    min_age_seconds: 300,
    cadence_seconds: 3600,
    action: 'delete',
  },
  {
    id: 'tmp-consensus-logs',
    description: '/tmp consensus-tp*.log + work-tp*.log from background bash runs',
    scope: '/tmp',
    match_basename: '^(consensus|work)-tp\\d+(-r\\d+)?(-retry)?\\.log$',
    recursive: false,
    ttl_seconds: 24 * 3600,
    max_count: 0,
    min_age_seconds: 300,
    cadence_seconds: 3600,
    action: 'delete',
  },
  {
    id: 'session-history-cap',
    description: 'session-history snapshots — cap at 200 newest (auto:tick can write many per hour)',
    scope: 'tools/autonomous-delivery/session-history',
    match_basename: '^\\d{4}-\\d{2}-\\d{2}T.*\\.json$',
    recursive: false,
    ttl_seconds: 7 * 24 * 3600,  // also delete >7d old
    max_count: 200,              // and keep only 200 newest regardless
    min_age_seconds: 60,
    cadence_seconds: 6 * 3600,   // 6-hourly
    action: 'delete',
  },
  {
    id: 'codex-prompts-30d',
    description: 'durable Codex round prompts (.agent-runs/<run>/_codex/<task>/r*-prompt.txt) — 30d retention',
    scope: '.agent-runs',
    match_basename: '^r\\d+-prompt\\.txt$',
    recursive: true,
    ttl_seconds: 30 * 24 * 3600,
    max_count: 0,
    min_age_seconds: 60,
    cadence_seconds: 24 * 3600,  // daily
    action: 'delete',
  },
  {
    id: 'codex-bundles-30d',
    description: 'evidence/codex-bundle.txt files — 30d retention (re-creatable from evidence)',
    scope: '.agent-runs',
    match_basename: '^codex-bundle\\.txt$',
    recursive: true,
    ttl_seconds: 30 * 24 * 3600,
    max_count: 0,
    min_age_seconds: 60,
    cadence_seconds: 24 * 3600,
    action: 'delete',
  },
];

// ─── Rate-limit state (per-policy last_run_at) ───────────────────────────────

const STATE_REL = '.agent-runs/_cleanup-state.json';

interface CleanupState {
  schema_version: '1';
  last_run_at: Record<string, string>;  // policy_id → ISO
}

function statePath(harnessRoot: string): string {
  return path.join(harnessRoot, STATE_REL);
}

function readState(harnessRoot: string): CleanupState {
  const p = statePath(harnessRoot);
  if (!fs.existsSync(p)) return { schema_version: '1', last_run_at: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (typeof raw === 'object' && raw && 'last_run_at' in raw) return raw as CleanupState;
  } catch { /* fall through */ }
  return { schema_version: '1', last_run_at: {} };
}

function writeState(harnessRoot: string, state: CleanupState): void {
  const dir = path.dirname(statePath(harnessRoot));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWriteFile(statePath(harnessRoot), JSON.stringify(state, null, 2));
}

// ─── File enumeration helpers ────────────────────────────────────────────────

function listFiles(scope: string, recursive: boolean): string[] {
  const out: string[] = [];
  if (!fs.existsSync(scope)) return out;
  const stack: string[] = [scope];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive) stack.push(full);
        continue;
      }
      if (e.isFile() || e.isSymbolicLink()) out.push(full);
    }
  }
  return out;
}

// ─── Engine-level denylist (Codex harness review MEDIUM #7) ─────────────────
//
// "Never delete" compliance artifacts must not be deletable by ANY policy,
// including a misconfigured custom one. Belt + suspenders: filename basename
// match + suffix match in any path component. Audit logs, escalation logs,
// process registry, override audit — all SOX-grade append-only.
const ENGINE_DENYLIST_BASENAMES = new Set<string>([
  '_override-audit.jsonl',
  '_escalation-log.jsonl',
  '_process-registry.json',
  '_cleanup-state.json',
  '_goal.json',
  '_budget.json',
  '_model-inventory.json',
]);
const ENGINE_DENYLIST_SUFFIXES = ['.jsonl'];  // any *.jsonl is treated as audit

function isProtectedFromCleanup(filePath: string): boolean {
  const base = path.basename(filePath);
  if (ENGINE_DENYLIST_BASENAMES.has(base)) return true;
  // Append-only logs always end with .jsonl in this codebase; never let a
  // future policy author wipe one by accident.
  for (const suffix of ENGINE_DENYLIST_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  return false;
}

// ─── Per-policy runner ───────────────────────────────────────────────────────

export interface CleanupAction {
  policy_id: string;
  path: string;
  reason: 'ttl' | 'max-count';
  bytes: number;
  mtime: string;
}

export interface CleanupResult {
  policy_id: string;
  scanned: number;
  matched: number;
  actions: CleanupAction[];
  applied: boolean;
  bytes_freed: number;
  errors: string[];
  skipped_for_cadence?: boolean;
  cadence_remaining_sec?: number;
}

export interface RunOpts {
  apply?: boolean;
  /** Override built-in policies. */
  policies?: CleanupPolicy[];
  /** Force-run even if cadence not elapsed. */
  force?: boolean;
  /** Limit to specific policy_ids. */
  only?: string[];
  /** Hostname (for audit). */
  host?: string;
  /** Resolve scope relative to this root (defaults to harnessRoot). */
  scope_root?: string;
}

function resolveScope(scope: string, scopeRoot: string): string {
  return path.isAbsolute(scope) ? scope : path.join(scopeRoot, scope);
}

export function runPolicy(
  harnessRoot: string,
  policy: CleanupPolicy,
  opts: RunOpts = {},
): CleanupResult {
  const apply = opts.apply ?? false;
  const scopeRoot = opts.scope_root ?? harnessRoot;
  const scope = resolveScope(policy.scope, scopeRoot);
  const result: CleanupResult = {
    policy_id: policy.id,
    scanned: 0,
    matched: 0,
    actions: [],
    applied: apply,
    bytes_freed: 0,
    errors: [],
  };

  const files = listFiles(scope, policy.recursive);
  result.scanned = files.length;

  const re = new RegExp(policy.match_basename);
  const now = Date.now();
  const candidates: { full: string; mtime: number; size: number }[] = [];
  for (const f of files) {
    if (!re.test(path.basename(f))) continue;
    // Engine-level denylist: never let any policy delete SOX-protected files
    // (Codex harness review MEDIUM #7). Belt + suspenders alongside the
    // built-in policies' regexes — protects against future custom policies.
    if (isProtectedFromCleanup(f)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(f); }
    catch { continue; }
    const ageSec = (now - st.mtimeMs) / 1000;
    if (ageSec < policy.min_age_seconds) continue;  // protect in-flight
    candidates.push({ full: f, mtime: st.mtimeMs, size: st.size });
  }
  result.matched = candidates.length;

  // newest-first for max_count
  candidates.sort((a, b) => b.mtime - a.mtime);

  const toDelete: { c: { full: string; mtime: number; size: number }; reason: 'ttl' | 'max-count' }[] = [];

  for (const c of candidates) {
    const ageSec = (now - c.mtime) / 1000;
    if (policy.ttl_seconds > 0 && ageSec > policy.ttl_seconds) {
      toDelete.push({ c, reason: 'ttl' });
    }
  }
  if (policy.max_count > 0 && candidates.length > policy.max_count) {
    const overflow = candidates.slice(policy.max_count);
    for (const c of overflow) {
      // Avoid double-listing if already TTL-deleted
      if (!toDelete.find((d) => d.c.full === c.full)) {
        toDelete.push({ c, reason: 'max-count' });
      }
    }
  }

  for (const { c, reason } of toDelete) {
    const action: CleanupAction = {
      policy_id: policy.id,
      path: c.full,
      reason,
      bytes: c.size,
      mtime: new Date(c.mtime).toISOString(),
    };
    if (apply) {
      try {
        fs.unlinkSync(c.full);
        result.bytes_freed += c.size;
        result.actions.push(action);
      } catch (e) {
        result.errors.push(`unlink ${c.full}: ${(e as Error).message}`);
      }
    } else {
      result.actions.push(action);
    }
  }

  return result;
}

/**
 * Run all policies, respecting cadence + rate-limit state. apply=false
 * is dry-run; apply=true persists state + audits actions.
 */
export function runAll(harnessRoot: string, opts: RunOpts = {}): CleanupResult[] {
  const apply = opts.apply ?? false;
  const force = opts.force ?? false;
  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  const host = opts.host ?? os.hostname();
  const policies = opts.policies ?? DEFAULT_POLICIES;
  const state = readState(harnessRoot);
  const now = Date.now();
  const results: CleanupResult[] = [];

  for (const p of policies) {
    if (only && !only.has(p.id)) continue;
    const last = state.last_run_at[p.id];
    if (!force && last) {
      const sinceSec = (now - new Date(last).getTime()) / 1000;
      if (sinceSec < p.cadence_seconds) {
        results.push({
          policy_id: p.id,
          scanned: 0,
          matched: 0,
          actions: [],
          applied: false,
          bytes_freed: 0,
          errors: [],
          skipped_for_cadence: true,
          cadence_remaining_sec: Math.ceil(p.cadence_seconds - sinceSec),
        });
        continue;
      }
    }
    // v0.4.14 (Codex MEDIUM #9): intent-then-result audit pattern. We
    // audit BEFORE deletion (intent) and AFTER (result). If the intent
    // audit fails, we DO NOT delete — fail-closed for SOX compliance.
    // This eliminates the prior gap where post-hoc audit failure left
    // unaudited deletions.
    let dryRun: CleanupResult | null = null;
    if (apply) {
      // Compute the deletion plan in dry-run mode first
      dryRun = runPolicy(harnessRoot, p, { apply: false, scope_root: opts.scope_root });
      if (dryRun.actions.length > 0) {
        let intentOk = false;
        try {
          appendOverrideAudit(harnessRoot, {
            schema_version: '1',
            at: new Date().toISOString(),
            actor: captureIdentity(),
            kind: 'cleanup-action',
            reason: `[INTENT] cleanup policy '${p.id}' WILL delete ${dryRun.actions.length} file${dryRun.actions.length === 1 ? '' : 's'}`,
            context: {
              phase: 'intent',
              policy_id: p.id,
              policy_description: p.description,
              actions_count: dryRun.actions.length,
              sample_paths: dryRun.actions.slice(0, 5).map((a) => a.path),
              host,
            },
            pid: process.pid,
            host,
          });
          intentOk = true;
        } catch (e) {
          console.error(`[cleanup] FAIL-CLOSED: intent audit failed for policy ${p.id}: ${(e as Error).message} — REFUSING TO DELETE`);
          // Push a synthetic result reflecting the refusal
          const refused: CleanupResult = {
            policy_id: p.id,
            scanned: dryRun.scanned,
            matched: dryRun.matched,
            actions: [],
            applied: false,
            bytes_freed: 0,
            errors: [`intent audit unavailable; deletions refused: ${(e as Error).message}`],
          };
          results.push(refused);
          continue;
        }
        void intentOk;
      }
    }

    const r = runPolicy(harnessRoot, p, { apply, scope_root: opts.scope_root });
    if (apply) {
      state.last_run_at[p.id] = new Date().toISOString();
      // Result audit (one entry per applied policy invocation with non-empty
      // actions; skip-empty to avoid log noise). If THIS audit fails, the
      // damage is already done — but the prior intent audit caught it for
      // forensic reconstruction.
      if (r.actions.length > 0 || r.errors.length > 0) {
        try {
          appendOverrideAudit(harnessRoot, {
            schema_version: '1',
            at: new Date().toISOString(),
            actor: captureIdentity(),
            kind: 'cleanup-action',
            reason: `[RESULT] cleanup policy '${p.id}' deleted ${r.actions.length} file${r.actions.length === 1 ? '' : 's'} (${(r.bytes_freed / 1024).toFixed(1)} KB)`,
            context: {
              phase: 'result',
              policy_id: p.id,
              policy_description: p.description,
              scanned: r.scanned,
              matched: r.matched,
              actions_count: r.actions.length,
              bytes_freed: r.bytes_freed,
              errors: r.errors,
              sample_paths: r.actions.slice(0, 5).map((a) => a.path),
              host,
            },
            pid: process.pid,
            host,
          });
        } catch (e) {
          // Result audit failure: still record to error stream so it
          // appears in tick logs. Forensic reconstructable from intent + fs.
          console.error(`[cleanup] result audit failed for policy ${p.id}: ${(e as Error).message} (intent recorded; result missing)`);
        }
      }
    }
    results.push(r);
  }

  if (apply) writeState(harnessRoot, state);
  return results;
}

/** Total bytes that WOULD be freed (dry-run) or WERE freed (apply). */
export function totalBytesFreed(results: CleanupResult[]): number {
  return results.reduce((acc, r) => acc + (r.applied ? r.bytes_freed : r.actions.reduce((s, a) => s + a.bytes, 0)), 0);
}

export function totalActions(results: CleanupResult[]): number {
  return results.reduce((acc, r) => acc + r.actions.length, 0);
}
