#!/usr/bin/env node
/**
 * pnpm auto:metrics — emit harness operational metrics in Prometheus textfile format.
 *
 * For consumer projects with a Prometheus / Grafana / OTel stack. Writes to
 * stdout (default) or a file ($AUTO_METRICS_TEXTFILE) for the
 * Prometheus textfile collector to scrape.
 *
 * Metrics emitted:
 *   harness_workers_in_flight                 (gauge) — active claude-cli-worker count
 *   harness_consensus_in_flight               (gauge) — active codex-consensus count
 *   harness_tasks_by_state{state="…"}         (gauge) — count per state bucket
 *   harness_audit_log_bytes                   (gauge) — _override-audit.jsonl size
 *   harness_escalation_log_open                (gauge) — open escalations
 *   harness_queue_depth                       (gauge) — taskQueue entry count
 *   harness_cost_today_usd                    (gauge) — today's spend (UTC)
 *   harness_cost_dispatches_today             (counter) — today's dispatch count
 *   harness_cleanup_state_age_seconds         (gauge) — last cleanup run age
 *   harness_health_overall{severity="…"}      (gauge 0/1) — current overall severity
 *   harness_disk_usage_pct                    (gauge)
 *
 * Usage:
 *   pnpm auto:metrics                         # to stdout
 *   pnpm auto:metrics --textfile /tmp/m.prom  # to file (atomic move)
 *   pnpm auto:metrics --json                  # JSON instead of Prom format
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessRoot } from '../lib/harnessRoot';
import { listRegistered } from '../lib/processWatchdog';
import { runHealthChecks } from '../lib/systemHealth';
import { rollupToday } from '../lib/costRollup';
import { listQueue } from '../lib/taskQueue';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
void __dirname;
const HARNESS_ROOT = harnessRoot();

interface Args {
  textfile?: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '--textfile' && i + 1 < argv.length) a.textfile = argv[++i];
  }
  return a;
}

interface Metric {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
  labels?: Record<string, string>;
}

function collectMetrics(): Metric[] {
  const m: Metric[] = [];

  // Process registry
  const reg = listRegistered(HARNESS_ROOT);
  m.push({ name: 'harness_workers_in_flight', help: 'Active claude-cli-worker processes registered in the watchdog', type: 'gauge', value: reg.filter((r) => r.kind === 'claude-cli-worker').length });
  m.push({ name: 'harness_consensus_in_flight', help: 'Active codex-consensus processes', type: 'gauge', value: reg.filter((r) => r.kind === 'codex-consensus').length });
  m.push({ name: 'harness_promote_in_flight', help: 'Active auto-promote processes', type: 'gauge', value: reg.filter((r) => r.kind === 'auto-promote').length });
  m.push({ name: 'harness_pipeline_test_in_flight', help: 'Active pipeline-test (build) processes', type: 'gauge', value: reg.filter((r) => r.kind === 'pipeline-test').length });

  // Tasks by state
  const stateCount: Record<string, number> = {};
  try {
    for (const runId of listRuns()) {
      for (const taskId of listTasks(runId)) {
        try {
          const pack = readTaskPack(runId, taskId);
          stateCount[pack.state] = (stateCount[pack.state] ?? 0) + 1;
        } catch { /* malformed pack */ }
      }
    }
  } catch { /* */ }
  for (const [state, count] of Object.entries(stateCount)) {
    m.push({ name: 'harness_tasks_by_state', help: 'Number of task packs per state bucket', type: 'gauge', value: count, labels: { state } });
  }

  // Audit log size
  try {
    const auditPath = path.join(HARNESS_ROOT, '.agent-runs', '_override-audit.jsonl');
    if (fs.existsSync(auditPath)) {
      m.push({ name: 'harness_audit_log_bytes', help: 'Size of _override-audit.jsonl in bytes', type: 'gauge', value: fs.statSync(auditPath).size });
    }
  } catch { /* */ }

  // Open escalations
  try {
    const escPath = path.join(HARNESS_ROOT, '.agent-runs', '_escalation-log.jsonl');
    if (fs.existsSync(escPath)) {
      const lines = fs.readFileSync(escPath, 'utf8').split('\n').filter((l) => l.trim());
      let open = 0;
      for (const line of lines) {
        try { if (!JSON.parse(line).cleared_by) open++; } catch { /* */ }
      }
      m.push({ name: 'harness_escalation_log_open', help: 'Number of open (uncleared) escalations', type: 'gauge', value: open });
    }
  } catch { /* */ }

  // Queue depth
  try {
    const q = listQueue(HARNESS_ROOT);
    m.push({ name: 'harness_queue_depth', help: 'Number of tasks queued behind path-overlap blockers', type: 'gauge', value: q.length });
  } catch { /* */ }

  // Cost today
  try {
    const r = rollupToday(HARNESS_ROOT);
    m.push({ name: 'harness_cost_today_usd', help: "Today's UTC spend (USD) across all cost_telemetry entries", type: 'gauge', value: r.total.total_usd });
    m.push({ name: 'harness_cost_dispatches_today', help: "Today's UTC dispatch count", type: 'gauge', value: r.total.dispatch_count });
    m.push({ name: 'harness_cost_duration_seconds_today', help: "Today's UTC total dispatch duration in seconds", type: 'gauge', value: r.total.total_duration_ms / 1000 });
  } catch { /* */ }

  // Cleanup state age
  try {
    const cleanupStatePath = path.join(HARNESS_ROOT, '.agent-runs', '_cleanup-state.json');
    if (fs.existsSync(cleanupStatePath)) {
      const st = fs.statSync(cleanupStatePath);
      m.push({ name: 'harness_cleanup_state_age_seconds', help: 'Seconds since the last cleanup-policy state write', type: 'gauge', value: (Date.now() - st.mtimeMs) / 1000 });
    }
  } catch { /* */ }

  // Health
  try {
    const h = runHealthChecks(HARNESS_ROOT);
    const severities: Array<'ok' | 'info' | 'warning' | 'critical'> = ['ok', 'info', 'warning', 'critical'];
    for (const s of severities) {
      m.push({ name: 'harness_health_overall', help: 'Current overall health severity (1 = matches, 0 = doesn\'t)', type: 'gauge', value: h.overall === s ? 1 : 0, labels: { severity: s } });
    }
    // Disk usage from the disk check
    const disk = h.checks.find((c) => c.id === 'disk-usage');
    if (disk && typeof disk.value === 'string') {
      const pct = parseFloat(String(disk.value).replace('%', ''));
      if (!isNaN(pct)) m.push({ name: 'harness_disk_usage_pct', help: 'Disk usage percent for the harness root mount', type: 'gauge', value: pct });
    }
  } catch { /* */ }

  return m;
}

function formatPrometheus(metrics: Metric[]): string {
  const groups = new Map<string, Metric[]>();
  for (const m of metrics) {
    if (!groups.has(m.name)) groups.set(m.name, []);
    groups.get(m.name)!.push(m);
  }
  const lines: string[] = [];
  for (const [name, mlist] of groups) {
    lines.push(`# HELP ${name} ${mlist[0].help}`);
    lines.push(`# TYPE ${name} ${mlist[0].type}`);
    for (const m of mlist) {
      const labelStr = m.labels && Object.keys(m.labels).length > 0
        ? '{' + Object.entries(m.labels).map(([k, v]) => `${k}="${String(v).replace(/"/g, '\\"')}"`).join(',') + '}'
        : '';
      lines.push(`${name}${labelStr} ${m.value}`);
    }
  }
  return lines.join('\n') + '\n';
}

function atomicWrite(targetPath: string, content: string): void {
  const tmp = targetPath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, targetPath);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const metrics = collectMetrics();

  if (args.json) {
    console.log(JSON.stringify({ at: new Date().toISOString(), metrics }, null, 2));
    return;
  }

  const text = formatPrometheus(metrics);
  if (args.textfile) {
    atomicWrite(args.textfile, text);
    console.error(`[metrics] wrote ${metrics.length} metrics to ${args.textfile}`);
  } else {
    process.stdout.write(text);
  }
}

try { main(); }
catch (e) {
  console.error(`[metrics] error: ${(e as Error).message}`);
  process.exit(1);
}
