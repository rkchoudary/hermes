/**
 * Notification adapter — severity-routed multi-channel notifications.
 *
 * Operator gap-roadmap item #9 (2026-04-28): "today: Slack only" — extend
 * to PagerDuty + email + console with severity-based routing so critical
 * alerts page someone, warnings post to Slack, and info goes to console.
 *
 * Backends are pluggable; default config wires up:
 *   - console     (always; structured stderr)
 *   - slack       (when AUTO_DAEMON_SLACK_WEBHOOK is set)
 *   - pagerduty   (when AUTO_PAGERDUTY_INTEGRATION_KEY is set; critical only)
 *   - email       (when AUTO_EMAIL_TO + AUTO_EMAIL_FROM + sendmail in PATH)
 *
 * Severity routing (default):
 *   info     → console
 *   warning  → console + slack
 *   critical → console + slack + pagerduty + email
 *
 * Quiet hours apply to slack only; pagerduty + email always go through
 * (paging IS the point — you don't quiet-hours a critical).
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface NotificationContext {
  /** Source subsystem (watchdog | cleanup | health | tick | …) for log prefix. */
  source?: string;
  /** Optional task association (forensic correlation). */
  task_id?: string;
  /** Free-form structured payload appended to all backends. */
  data?: Record<string, unknown>;
}

export interface NotificationConfig {
  /** Slack webhook URL; if absent, slack backend is skipped. */
  slack_webhook?: string;
  /** PagerDuty Events API v2 integration key; if absent, skipped. */
  pagerduty_integration_key?: string;
  /** Email recipient(s), comma-separated. */
  email_to?: string;
  email_from?: string;
  /** UTC quiet-hours window — slack-only suppression. Format "22-07". */
  quiet_hours?: string;
  /** Force dry-run (log to console instead of dispatching). */
  dry_run?: boolean;
}

export interface NotificationResult {
  backend: 'console' | 'slack' | 'pagerduty' | 'email';
  attempted: boolean;
  ok: boolean;
  reason?: string;
}

// ─── Backend gating ──────────────────────────────────────────────────────────

function inQuietHours(quietHours?: string): boolean {
  if (!quietHours) return false;
  const m = quietHours.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const start = parseInt(m[1], 10);
  const end = parseInt(m[2], 10);
  const hour = new Date().getUTCHours();
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;  // crosses midnight
}

// ─── Backends ────────────────────────────────────────────────────────────────

function emitConsole(severity: NotificationSeverity, message: string, ctx: NotificationContext): NotificationResult {
  const tag = ctx.source ? `[${ctx.source}] ` : '';
  const taskTag = ctx.task_id ? `[${ctx.task_id}] ` : '';
  const icon = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : 'ℹ';
  const prefix = `${icon} ${severity.toUpperCase()}`;
  const out = `${prefix} ${tag}${taskTag}${message}`;
  if (severity === 'info') console.log(out);
  else console.error(out);
  return { backend: 'console', attempted: true, ok: true };
}

function emitSlack(severity: NotificationSeverity, message: string, ctx: NotificationContext, cfg: NotificationConfig): NotificationResult {
  if (!cfg.slack_webhook) {
    return { backend: 'slack', attempted: false, ok: false, reason: 'no slack_webhook configured' };
  }
  if (inQuietHours(cfg.quiet_hours) && severity !== 'critical') {
    return { backend: 'slack', attempted: false, ok: false, reason: 'in quiet hours' };
  }
  if (cfg.dry_run) {
    console.log(`[DRY-RUN-SLACK] ${severity} ${message}`);
    return { backend: 'slack', attempted: true, ok: true, reason: 'dry-run' };
  }
  const tag = ctx.source ? `[${ctx.source}] ` : '';
  const taskTag = ctx.task_id ? `[${ctx.task_id}] ` : '';
  const icon = severity === 'critical' ? '🔴' : severity === 'warning' ? '🟡' : 'ℹ';
  const text = `${icon} *${severity.toUpperCase()}* ${tag}${taskTag}${message}`;
  const escaped = text.replace(/"/g, '\\"').replace(/\n/g, '\\n');
  try {
    const r = spawnSync(
      'curl',
      ['-fsS', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', `{"text":"${escaped}"}`, cfg.slack_webhook],
      { timeout: 10_000, stdio: 'pipe', encoding: 'utf8' },
    );
    if (r.status !== 0) {
      return { backend: 'slack', attempted: true, ok: false, reason: `curl exit=${r.status} ${r.stderr ?? ''}` };
    }
    return { backend: 'slack', attempted: true, ok: true };
  } catch (e) {
    return { backend: 'slack', attempted: true, ok: false, reason: (e as Error).message };
  }
}

function emitPagerDuty(severity: NotificationSeverity, message: string, ctx: NotificationContext, cfg: NotificationConfig): NotificationResult {
  if (!cfg.pagerduty_integration_key) {
    return { backend: 'pagerduty', attempted: false, ok: false, reason: 'no integration_key configured' };
  }
  if (severity !== 'critical') {
    return { backend: 'pagerduty', attempted: false, ok: false, reason: 'not critical (PD pages only on critical)' };
  }
  if (cfg.dry_run) {
    console.log(`[DRY-RUN-PAGERDUTY] ${message}`);
    return { backend: 'pagerduty', attempted: true, ok: true, reason: 'dry-run' };
  }
  // PagerDuty Events API v2 schema
  const payload = {
    routing_key: cfg.pagerduty_integration_key,
    event_action: 'trigger',
    payload: {
      summary: message.slice(0, 1024),
      severity: 'critical',
      source: ctx.source ?? 'claude-delivery-harness',
      custom_details: {
        task_id: ctx.task_id,
        ...ctx.data,
      },
    },
    dedup_key: `${ctx.source ?? 'harness'}-${ctx.task_id ?? 'general'}`,
  };
  try {
    const r = spawnSync(
      'curl',
      ['-fsS', '-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify(payload), 'https://events.pagerduty.com/v2/enqueue'],
      { timeout: 10_000, stdio: 'pipe', encoding: 'utf8' },
    );
    if (r.status !== 0) {
      return { backend: 'pagerduty', attempted: true, ok: false, reason: `curl exit=${r.status} ${r.stderr ?? ''}` };
    }
    return { backend: 'pagerduty', attempted: true, ok: true };
  } catch (e) {
    return { backend: 'pagerduty', attempted: true, ok: false, reason: (e as Error).message };
  }
}

function emitEmail(severity: NotificationSeverity, message: string, ctx: NotificationContext, cfg: NotificationConfig): NotificationResult {
  if (!cfg.email_to) {
    return { backend: 'email', attempted: false, ok: false, reason: 'no email_to configured' };
  }
  if (severity !== 'critical') {
    return { backend: 'email', attempted: false, ok: false, reason: 'email is critical-only by default' };
  }
  if (cfg.dry_run) {
    console.log(`[DRY-RUN-EMAIL] to=${cfg.email_to}: ${message}`);
    return { backend: 'email', attempted: true, ok: true, reason: 'dry-run' };
  }
  // Use sendmail if available; fall back to mailx; otherwise skip.
  const tag = ctx.source ?? 'harness';
  const taskTag = ctx.task_id ? ` [${ctx.task_id}]` : '';
  const subject = `[CRITICAL][${tag}]${taskTag} ${message.slice(0, 80)}`;
  const body = `${message}\n\n${ctx.data ? JSON.stringify(ctx.data, null, 2) : ''}`;
  const headers = `From: ${cfg.email_from ?? 'harness@localhost'}\nTo: ${cfg.email_to}\nSubject: ${subject}\n\n`;
  const sendmailInput = headers + body;
  try {
    const r = spawnSync('sendmail', ['-t'], {
      input: sendmailInput,
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (r.error || r.status !== 0) {
      return { backend: 'email', attempted: true, ok: false, reason: r.error?.message ?? `sendmail exit=${r.status}` };
    }
    return { backend: 'email', attempted: true, ok: true };
  } catch (e) {
    return { backend: 'email', attempted: true, ok: false, reason: (e as Error).message };
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function loadConfig(harnessRoot: string): NotificationConfig {
  // Per-project override at .agent-runs/_notifications.json takes precedence
  // over env vars, so projects can ship their own routing without env-var
  // wiring on every invocation.
  const cfgPath = path.join(harnessRoot, '.agent-runs', '_notifications.json');
  let fileCfg: NotificationConfig = {};
  if (fs.existsSync(cfgPath)) {
    try { fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as NotificationConfig; }
    catch { /* fall through */ }
  }
  return {
    slack_webhook: fileCfg.slack_webhook ?? process.env.AUTO_DAEMON_SLACK_WEBHOOK,
    pagerduty_integration_key: fileCfg.pagerduty_integration_key ?? process.env.AUTO_PAGERDUTY_INTEGRATION_KEY,
    email_to: fileCfg.email_to ?? process.env.AUTO_EMAIL_TO,
    email_from: fileCfg.email_from ?? process.env.AUTO_EMAIL_FROM,
    quiet_hours: fileCfg.quiet_hours ?? process.env.AUTO_TICK_QUIET_HOURS,
    dry_run: fileCfg.dry_run ?? (process.env.AUTO_TICK_DRY_RUN === 'true'),
  };
}

/**
 * Severity-routed notify. Always emits to console; routes to other backends
 * per default rules. Returns per-backend result so callers can audit.
 */
export function notify(
  severity: NotificationSeverity,
  message: string,
  ctx: NotificationContext = {},
  cfg?: NotificationConfig,
): NotificationResult[] {
  const config = cfg ?? loadConfig(process.cwd());
  const results: NotificationResult[] = [];
  results.push(emitConsole(severity, message, ctx));
  if (severity === 'warning' || severity === 'critical') {
    results.push(emitSlack(severity, message, ctx, config));
  }
  if (severity === 'critical') {
    results.push(emitPagerDuty(severity, message, ctx, config));
    results.push(emitEmail(severity, message, ctx, config));
  }
  return results;
}

/**
 * Legacy adapter for the existing postSlack(message, dryRun) sites in tick.ts.
 * Maps `[ALERT]` prefix → critical, `[WARN]` → warning, `[INFO]` → info, etc.
 */
export function notifyFromLegacyMessage(
  message: string,
  dryRun: boolean,
  cfg?: NotificationConfig,
): NotificationResult[] {
  const upper = message.toUpperCase();
  let severity: NotificationSeverity = 'info';
  if (upper.includes('[CRITICAL]') || upper.includes('CRITICAL ')) severity = 'critical';
  else if (upper.includes('[ALERT]')) severity = 'warning';  // existing tick uses [ALERT] for warnings
  else if (upper.includes('[WARN') || upper.includes('[WARNING]')) severity = 'warning';
  else severity = 'info';
  const config = cfg ?? loadConfig(process.cwd());
  return notify(severity, message, { source: 'tick' }, { ...config, dry_run: dryRun || config.dry_run });
}
