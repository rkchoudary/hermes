#!/usr/bin/env node
/**
 * pnpm auto:dashboard-live [--port 7777]
 *
 * Sprint M (#20): live HTTP dashboard. Browser-renderable HTML auto-refreshing
 * every 5s. Read-only — no write ops exposed.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const PORT = parseInt(process.env.AUTO_DASHBOARD_PORT || '7777', 10);

function snapshot(): unknown {
  const root = harnessRoot();
  const runs = fs.readdirSync(path.join(root, '.agent-runs')).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latestRun = runs[runs.length - 1] || '';
  const tasksDir = path.join(root, '.agent-runs', latestRun, 'tasks');
  const states: Record<string, number> = {};
  let total = 0;
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      try { const p = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')); states[p.state || 'unknown'] = (states[p.state || 'unknown'] || 0) + 1; total++; } catch { /* skip */ }
    }
  }
  const parkedFile = path.join(root, '.agent-runs', '_parked-modules.jsonl');
  const parked_count = fs.existsSync(parkedFile) ? fs.readFileSync(parkedFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const councilDir = path.join(root, '.agent-runs', '_audit', 'council');
  const cHealth = { passed: 0, failed: 0, pending: 0, eval_error: 0 };
  if (fs.existsSync(councilDir)) {
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.json')) {
          try { const sc = JSON.parse(fs.readFileSync(p, 'utf8')); const s = (sc.status || '').replace('-', '_'); if (s in cHealth) (cHealth as Record<string, number>)[s]++; } catch { /* skip */ }
        }
      }
    };
    walk(councilDir);
  }
  const recent: Array<{ pr: number; branch: string; merged_at?: string }> = [];
  try {
    const r = spawnSync('gh', ['pr', 'list', '--state', 'merged', '--limit', '8', '--json', 'number,headRefName,mergedAt'], { encoding: 'utf8' });
    if (r.status === 0) JSON.parse(r.stdout || '[]').forEach((p: { number: number; headRefName: string; mergedAt: string }) => recent.push({ pr: p.number, branch: p.headRefName, merged_at: p.mergedAt }));
  } catch { /* skip */ }
  const dfR = spawnSync('df', ['-k', process.env.HOME || '/'], { encoding: 'utf8' });
  let used_gb = 0, free_gb = 0, pct = 0;
  if (dfR.status === 0) { const lines = (dfR.stdout || '').split('\n'); if (lines[1]) { const parts = lines[1].split(/\s+/); used_gb = Math.round(parseInt(parts[2], 10) / 1024 / 1024); free_gb = Math.round(parseInt(parts[3], 10) / 1024 / 1024); pct = parseInt((parts[4] || '0').replace('%', ''), 10); } }
  const wt = spawnSync('git', ['-C', process.env.HERMES_PROJECT_ROOT || process.cwd(), 'worktree', 'list'], { encoding: 'utf8' });
  const worktrees = wt.status === 0 ? (wt.stdout || '').split('\n').filter(Boolean).length : 0;
  const ps = spawnSync('pgrep', ['-af', 'serial-by-module|parallel-by-module'], { encoding: 'utf8' });
  const drivers: Array<{ pid: number; etime: string; cmd: string }> = [];
  if (ps.status === 0) {
    for (const line of (ps.stdout || '').split('\n').filter(Boolean)) {
      const m = line.match(/^(\d+)\s+(.*)/);
      if (m) {
        const psR = spawnSync('ps', ['-o', 'etime=', '-p', m[1]], { encoding: 'utf8' });
        drivers.push({ pid: parseInt(m[1], 10), etime: (psR.stdout || '').trim(), cmd: m[2].slice(0, 80) });
      }
    }
  }
  return { ts: new Date().toISOString(), run: { id: latestRun, states, total }, parked_count, recent_merges: recent, council_health: cHealth, disk: { used_gb, free_gb, pct }, worktrees, drivers };
}

const HTML = `<!DOCTYPE html><html><head><title>Harness Dashboard</title><style>body{font-family:system-ui;margin:20px;background:#0f0f10;color:#e6e6e6}h1{margin-bottom:6px}.ts{color:#888;font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}.card{background:#1a1a1c;padding:14px;border-radius:8px;border:1px solid #2a2a2e}.card h2{margin:0 0 8px;font-size:14px;color:#9ec5ff;text-transform:uppercase;letter-spacing:0.5px}table{width:100%;border-collapse:collapse;font-size:13px}td{padding:4px 8px}td:first-child{color:#888}.ok{color:#5fcc7f}.fail{color:#ff7878}.warn{color:#ffc857}.pr{color:#9ec5ff}.branch{color:#bbb;font-size:11px}pre{margin:0;font-size:12px;color:#aaa;white-space:pre-wrap}</style></head><body><h1>🚀 Harness Dashboard <span class="ts" id="ts"></span></h1><div class="grid"><div class="card"><h2>Run / Tasks</h2><div id="run"></div></div><div class="card"><h2>Drivers</h2><div id="drivers"></div></div><div class="card"><h2>Recent Merges</h2><div id="merges"></div></div><div class="card"><h2>Council Health</h2><div id="council"></div></div><div class="card"><h2>Parked Queue</h2><div id="parked"></div></div><div class="card"><h2>Resources</h2><div id="resources"></div></div></div><script>function refresh(){fetch('/api/status').then(r=>r.json()).then(s=>{document.getElementById('ts').textContent=s.ts;document.getElementById('run').innerHTML='<table><tr><td>Run</td><td>'+s.run.id+'</td></tr><tr><td>Total</td><td>'+s.run.total+'</td></tr>'+Object.entries(s.run.states).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>';document.getElementById('drivers').innerHTML=s.drivers.length===0?'<em>none</em>':'<table>'+s.drivers.map(d=>'<tr><td>PID '+d.pid+'</td><td>'+d.etime+'</td></tr>').join('')+'</table>';document.getElementById('merges').innerHTML='<table>'+s.recent_merges.map(m=>'<tr><td class=pr>#'+m.pr+'</td><td><span class=branch>'+m.branch+'</span></td></tr>').join('')+'</table>';document.getElementById('council').innerHTML='<table><tr><td class=ok>passed</td><td>'+s.council_health.passed+'</td></tr><tr><td class=fail>failed</td><td>'+s.council_health.failed+'</td></tr><tr><td class=warn>pending</td><td>'+s.council_health.pending+'</td></tr><tr><td>eval-error</td><td>'+s.council_health.eval_error+'</td></tr></table>';document.getElementById('parked').innerHTML='<strong>'+s.parked_count+'</strong> parked';document.getElementById('resources').innerHTML='<table><tr><td>Disk</td><td>'+s.disk.used_gb+'/'+(s.disk.used_gb+s.disk.free_gb)+'GB ('+s.disk.pct+'%)</td></tr><tr><td>Worktrees</td><td>'+s.worktrees+'</td></tr></table>';});}refresh();setInterval(refresh,5000);</script></body></html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); }
  else if (req.url === '/api/status') {
    try { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(snapshot())); }
    catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
  } else { res.writeHead(404); res.end('not found'); }
});
server.listen(PORT, () => console.log(`[dashboard-live] http://localhost:${PORT}`));
