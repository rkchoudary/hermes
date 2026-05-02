/**
 * System health monitor — continuous "system is healthy and performing at peak".
 *
 * Operator directive (2026-04-28): "I want to make sure system is healthy all
 * the time and performing at its peak."
 *
 * Pairs with cleanupPolicy.ts (which prevents drift) and processWatchdog.ts
 * (which kills hung work). This module ALERTS when the system is degrading.
 *
 * Health checks:
 *   1. DISK: harness root disk usage % (alert >85%, critical >95%)
 *   2. /TMP DRIFT: count of stale /tmp/auto-worker-* + /tmp/codex-* files
 *      (alert >50, critical >200) — signals cleanup falling behind
 *   3. SESSION-HISTORY DRIFT: count of session-history JSONs (alert >300,
 *      critical >1000) — caps prevent runaway flush
 *   4. PROCESS REGISTRY: registered process count (alert >10, critical >25)
 *      — detects watchdog backlog or runaway dispatch
 *   5. AUDIT LOG SIZE: _override-audit.jsonl size (alert >100MB, critical
 *      >500MB) — append-only but should be rotated to S3 in Phase 2
 *   6. STALE-LOCK COUNT: in-progress tasks with dead-pid locks (alert >0)
 *      — watchdog rollback should keep this at 0
 *   7. ESCALATION COUNT: unclear escalations in _escalation-log.jsonl
 *      (alert >0) — operator action pending
 *
 * Returns severity-tagged HealthIssue[]. Caller decides what to do: tick
 * posts to Slack + audits as 'health-alert', cleanup runs the relevant
 * policy under --apply, etc.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

export type HealthSeverity = 'info' | 'warning' | 'critical';

export interface HealthCheck {
  /** Check id (stable). */
  id: string;
  /** Human-readable name shown in CLI. */
  name: string;
  /** Current observed value. */
  value: number | string;
  /** Threshold context (e.g., "alert>50, critical>200"). */
  threshold: string;
  /** OK | warning | critical | info-only. */
  severity: HealthSeverity | 'ok';
  /** Free-text recommendation when severity != 'ok'. */
  recommendation?: string;
}

export interface HealthReport {
  at: string;
  host: string;
  overall: 'ok' | HealthSeverity;
  checks: HealthCheck[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function diskUsagePercent(p: string): number | null {
  try {
    // df -kP <path> outputs portable POSIX format. Used = $3, total = $2 (kb).
    const out = execSync(`df -kP "${p}"`, { encoding: 'utf8', timeout: 3_000 });
    const lines = out.trim().split('\n');
    if (lines.length < 2) return null;
    const cols = lines[1].split(/\s+/);
    const used = parseInt(cols[2], 10);
    const total = parseInt(cols[1], 10);
    if (!total || isNaN(used)) return null;
    return (used / total) * 100;
  } catch {
    return null;
  }
}

function countMatching(dir: string, basenameRegex: RegExp, minAgeSeconds = 0): number {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  const now = Date.now();
  const minAgeMs = minAgeSeconds * 1000;
  try {
    for (const e of fs.readdirSync(dir)) {
      if (!basenameRegex.test(e)) continue;
      // Optional age filter: ignore files newer than minAgeSeconds. Used by
      // health checks (e.g. tmp-drift) to count only files OLD enough to be
      // cleanup candidates per their policy TTL — fixes prior over-counting
      // where the health check warned even though every matching file was
      // still under the policy TTL (operator-reported 2026-04-29).
      if (minAgeSeconds > 0) {
        try {
          const st = fs.statSync(path.join(dir, e));
          if (now - st.mtimeMs < minAgeMs) continue;
        } catch { continue; }
      }
      count++;
    }
  } catch { /* permission */ }
  return count;
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function check(
  id: string,
  name: string,
  value: number | string,
  threshold: string,
  severity: HealthCheck['severity'],
  recommendation?: string,
): HealthCheck {
  const out: HealthCheck = { id, name, value, threshold, severity };
  if (recommendation) out.recommendation = recommendation;
  return out;
}

// ─── Individual checks ───────────────────────────────────────────────────────

export function checkDisk(harnessRoot: string): HealthCheck {
  const pct = diskUsagePercent(harnessRoot);
  if (pct === null) {
    return check('disk-usage', 'Disk usage %', 'unknown', 'alert>85, critical>95', 'info', 'df failed; check filesystem');
  }
  const v = `${pct.toFixed(1)}%`;
  if (pct > 95) return check('disk-usage', 'Disk usage %', v, 'alert>85, critical>95', 'critical', 'free up disk; check large logs / build artifacts');
  if (pct > 85) return check('disk-usage', 'Disk usage %', v, 'alert>85, critical>95', 'warning', 'cleanup recommended');
  return check('disk-usage', 'Disk usage %', v, 'alert>85, critical>95', 'ok');
}

export function checkTmpDrift(): HealthCheck {
  const re = /^(auto-worker-(prompt|output)-TP-|codex-|consensus-tp|work-tp)/;
  // Only count files older than the cleanup-policy TTL (24h for
  // tmp-worker-prompts; matches src/lib/cleanupPolicy.ts:DEFAULT_POLICIES).
  // Without this filter the metric over-counts in-flight worker outputs
  // and warns even though the cleanup policy is correctly skipping those
  // files (they're not yet eligible for deletion). Operator hit this
  // 2026-04-29: 60 matching files in /tmp, all <14h old, cleanup policy
  // correctly preserved them but health check warned.
  const TTL_SECONDS = 24 * 3600;
  const n = countMatching('/tmp', re, TTL_SECONDS);
  if (n > 200) return check('tmp-drift', '/tmp harness files (older than cleanup TTL)', n, 'alert>50, critical>200', 'critical', 'run pnpm auto:cleanup --apply --force');
  if (n > 50)  return check('tmp-drift', '/tmp harness files (older than cleanup TTL)', n, 'alert>50, critical>200', 'warning', 'run pnpm auto:cleanup --apply');
  return check('tmp-drift', '/tmp harness files (older than cleanup TTL)', n, 'alert>50, critical>200', 'ok');
}

export function checkSessionHistoryDrift(harnessRoot: string): HealthCheck {
  const dir = path.join(harnessRoot, 'tools', 'autonomous-delivery', 'session-history');
  const n = countMatching(dir, /^\d{4}-\d{2}-\d{2}T.*\.json$/);
  if (n > 1000) return check('session-history-drift', 'session-history snapshots', n, 'alert>300, critical>1000', 'critical', 'run pnpm auto:cleanup --apply --only session-history-cap');
  if (n > 300)  return check('session-history-drift', 'session-history snapshots', n, 'alert>300, critical>1000', 'warning', 'cleanup recommended');
  return check('session-history-drift', 'session-history snapshots', n, 'alert>300, critical>1000', 'ok');
}

export function checkProcessRegistry(harnessRoot: string): HealthCheck {
  const p = path.join(harnessRoot, '.agent-runs', '_process-registry.json');
  let n = 0;
  if (fs.existsSync(p)) {
    try {
      const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(arr)) n = arr.length;
    } catch { /* */ }
  }
  if (n > 25) return check('process-registry', 'Watchdog registry size', n, 'alert>10, critical>25', 'critical', 'investigate dispatch backlog or runaway spawns');
  if (n > 10) return check('process-registry', 'Watchdog registry size', n, 'alert>10, critical>25', 'warning', 'unusual concurrency');
  return check('process-registry', 'Watchdog registry size', n, 'alert>10, critical>25', 'ok');
}

export function checkAuditLogSize(harnessRoot: string): HealthCheck {
  const p = path.join(harnessRoot, '.agent-runs', '_override-audit.jsonl');
  const st = safeStat(p);
  const bytes = st?.size ?? 0;
  const mb = bytes / (1024 * 1024);
  const v = `${mb.toFixed(1)} MB`;
  if (mb > 500) return check('audit-log-size', 'Override-audit log', v, 'alert>100MB, critical>500MB', 'critical', 'rotate to WORM (S3 Object Lock); never delete');
  if (mb > 100) return check('audit-log-size', 'Override-audit log', v, 'alert>100MB, critical>500MB', 'warning', 'plan rotation; do NOT delete');
  return check('audit-log-size', 'Override-audit log', v, 'alert>100MB, critical>500MB', 'ok');
}

export function checkStaleLocks(harnessRoot: string): HealthCheck {
  // Walk task packs; count those with state=in-progress AND a same-host
  // lock pid that's not alive. Codex harness review MEDIUM #8: ignoring
  // lock.host previously misclassified remote locks as stale.
  const runsDir = path.join(harnessRoot, '.agent-runs');
  const currentHost = os.hostname();
  let stale = 0;
  let crossHost = 0;
  if (!fs.existsSync(runsDir)) {
    return check('stale-locks', 'Tasks with dead-pid locks (this host)', stale, 'alert>0', 'ok');
  }
  for (const runEntry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!runEntry.isDirectory() || runEntry.name.startsWith('_')) continue;
    const tasksDir = path.join(runsDir, runEntry.name, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
        if (pack.state === 'in-progress' && pack.lock && typeof pack.lock.pid === 'number') {
          // Only kill -0 same-host pids — remote daemon owns its own locks.
          if (pack.lock.host && pack.lock.host !== currentHost) {
            crossHost++;
            continue;
          }
          try {
            process.kill(pack.lock.pid, 0);
            // alive — fine
          } catch (e) {
            const err = e as NodeJS.ErrnoException;
            if (err.code === 'ESRCH') stale++;
          }
        }
      } catch { /* malformed pack */ }
    }
  }
  const valueLabel = crossHost > 0 ? `${stale} (+${crossHost} cross-host)` : String(stale);
  if (stale > 0) {
    return check('stale-locks', 'Tasks with dead-pid locks (this host)', valueLabel, 'alert>0', 'warning', 'run pnpm auto:resurrect --apply OR pnpm auto:watchdog --apply (rollback should auto-fix)');
  }
  return check('stale-locks', 'Tasks with dead-pid locks (this host)', valueLabel, 'alert>0', 'ok');
}

export function checkEscalations(harnessRoot: string): HealthCheck {
  const p = path.join(harnessRoot, '.agent-runs', '_escalation-log.jsonl');
  if (!fs.existsSync(p)) {
    return check('open-escalations', 'Open escalations', 0, 'alert>0', 'ok');
  }
  let open = 0;
  try {
    const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (!e.cleared_by) open++;
      } catch { /* */ }
    }
  } catch { /* */ }
  if (open > 0) {
    return check('open-escalations', 'Open escalations', open, 'alert>0', 'warning', 'review _escalation-log.jsonl; clear via auto:escalate');
  }
  return check('open-escalations', 'Open escalations', open, 'alert>0', 'ok');
}

// ─── Aggregate ───────────────────────────────────────────────────────────────

export function runHealthChecks(harnessRoot: string): HealthReport {
  const checks = [
    checkDisk(harnessRoot),
    checkTmpDrift(),
    checkSessionHistoryDrift(harnessRoot),
    checkProcessRegistry(harnessRoot),
    checkAuditLogSize(harnessRoot),
    checkStaleLocks(harnessRoot),
    checkEscalations(harnessRoot),
  ];
  const sev = (c: HealthCheck): number => c.severity === 'critical' ? 3 : c.severity === 'warning' ? 2 : c.severity === 'info' ? 1 : 0;
  const max = checks.reduce((m, c) => Math.max(m, sev(c)), 0);
  const overall: HealthReport['overall'] = max === 3 ? 'critical' : max === 2 ? 'warning' : max === 1 ? 'info' : 'ok';
  return {
    at: new Date().toISOString(),
    host: os.hostname(),
    overall,
    checks,
  };
}
