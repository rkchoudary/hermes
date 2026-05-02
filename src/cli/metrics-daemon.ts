#!/usr/bin/env node
/**
 * pnpm auto:metrics-daemon [--port 9090]
 *
 * Sprint M v3 (item E): async telemetry daemon. Publishes Prometheus-format
 * metrics on http://localhost:9090/metrics for scraping by Grafana / Prom.
 *
 * Metrics:
 *   harness_modules_completed_total{phase}
 *   harness_modules_parked_total{phase}
 *   harness_drivers_alive
 *   harness_disk_free_gb
 *   harness_council_status{status="passed|failed|pending"}
 *   harness_skill_memory_entries{phase}
 *   harness_open_module_prs
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const PORT = parseInt(process.env.AUTO_METRICS_PORT || '9090', 10);

function gather(): string {
  const lines: string[] = [];
  const root = harnessRoot();

  // 1. Drivers alive
  const ps = spawnSync('pgrep', ['-af', 'serial-by-module|parallel-by-module'], { encoding: 'utf8' });
  const drivers = ps.status === 0 ? (ps.stdout || '').split('\n').filter(Boolean).length : 0;
  lines.push('# HELP harness_drivers_alive Number of harness driver processes running');
  lines.push('# TYPE harness_drivers_alive gauge');
  lines.push(`harness_drivers_alive ${drivers}`);

  // 2. Module tallies (from worker logs)
  const completed = (() => {
    try {
      const r = spawnSync('sh', ['-c', `grep -h "★ ALL 28 STEPS RAN" /tmp/harness-runs/parallel-worker-*.log 2>/dev/null | wc -l`], { encoding: 'utf8' });
      return parseInt(r.stdout?.trim() || '0', 10);
    } catch { return 0; }
  })();
  const parked = (() => {
    try {
      const r = spawnSync('sh', ['-c', `grep -h "MODULE.*parked at" /tmp/harness-runs/parallel-worker-*.log 2>/dev/null | wc -l`], { encoding: 'utf8' });
      return parseInt(r.stdout?.trim() || '0', 10);
    } catch { return 0; }
  })();
  lines.push('# HELP harness_modules_completed_total Modules completed via Sprint M v2 pipeline');
  lines.push('# TYPE harness_modules_completed_total counter');
  lines.push(`harness_modules_completed_total ${completed}`);
  lines.push('# HELP harness_modules_parked_total Modules parked');
  lines.push('# TYPE harness_modules_parked_total counter');
  lines.push(`harness_modules_parked_total ${parked}`);

  // 3. Disk free GB
  const dfR = spawnSync('df', ['-k', process.env.HOME || '/'], { encoding: 'utf8' });
  let freeGb = 0;
  if (dfR.status === 0) {
    const ln = (dfR.stdout || '').split('\n')[1];
    if (ln) freeGb = Math.round(parseInt(ln.split(/\s+/)[3], 10) / 1024 / 1024);
  }
  lines.push('# HELP harness_disk_free_gb Free disk space in GB');
  lines.push('# TYPE harness_disk_free_gb gauge');
  lines.push(`harness_disk_free_gb ${freeGb}`);

  // 4. Council sidecars by status
  const counts = { passed: 0, failed: 0, pending: 0, eval_error: 0 };
  const councilDir = path.join(root, '.agent-runs', '_audit', 'council');
  if (fs.existsSync(councilDir)) {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.json')) {
          try {
            const sc = JSON.parse(fs.readFileSync(p, 'utf8'));
            const s = (sc.status || '').replace('-', '_');
            if (s in counts) counts[s as keyof typeof counts]++;
          } catch { /* skip */ }
        }
      }
    };
    walk(councilDir);
  }
  lines.push('# HELP harness_council_status Council sidecar count by status');
  lines.push('# TYPE harness_council_status gauge');
  for (const [k, v] of Object.entries(counts)) {
    lines.push(`harness_council_status{status="${k}"} ${v}`);
  }

  // 5. Skill memory entries by phase
  const skillDir = path.join(root, '.agent-runs', '_skill-memory');
  if (fs.existsSync(skillDir)) {
    lines.push('# HELP harness_skill_memory_entries Producer log entry count');
    lines.push('# TYPE harness_skill_memory_entries gauge');
    for (const f of fs.readdirSync(skillDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const phase = f.replace('.jsonl', '');
      const count = fs.readFileSync(path.join(skillDir, f), 'utf8').split('\n').filter(Boolean).length;
      lines.push(`harness_skill_memory_entries{phase="${phase}"} ${count}`);
    }
  }

  // 6. Open module PRs
  const ghR = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '30', '--json', 'headRefName'], { encoding: 'utf8' });
  let openModulePrs = 0;
  if (ghR.status === 0) {
    try {
      const prs = JSON.parse(ghR.stdout || '[]') as Array<{ headRefName: string }>;
      openModulePrs = prs.filter(p => /^(docs|feat)\/(trd|sprint-plan|.+-impl)-m\d+/.test(p.headRefName)).length;
    } catch { /* skip */ }
  }
  lines.push('# HELP harness_open_module_prs Open PRs for harness modules');
  lines.push('# TYPE harness_open_module_prs gauge');
  lines.push(`harness_open_module_prs ${openModulePrs}`);

  return lines.join('\n') + '\n';
}

const server = http.createServer((req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' });
    res.end(gather());
  } else if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
  } else {
    res.writeHead(404); res.end('not found');
  }
});

server.listen(PORT, () => console.log(`[metrics-daemon] http://localhost:${PORT}/metrics`));
