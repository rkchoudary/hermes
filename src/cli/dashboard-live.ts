#!/usr/bin/env node
/**
 * pnpm auto:dashboard-live [--port 7777]
 *
 * Live HTTP dashboard. Browser-renderable HTML auto-refreshing every 5s.
 * Read-only — no write ops exposed.
 *
 * Endpoints:
 *   GET /                  HTML dashboard
 *   GET /api/status        Run + drivers + merges + council + parked + disk + worktrees
 *   GET /api/engines       Engine availability matrix (PATH-detected)
 *   GET /api/cost          Per-task cost rollup (sum + per-task list, current run)
 *   GET /api/replay/<id>   Timeline for a task: state transitions + codex rounds
 *   GET /health            "ok"
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';
import { getRegistry } from '../lib/engineRegistry';

const PORT = parseInt(process.env.AUTO_DASHBOARD_PORT || '7777', 10);

function snapshot(): unknown {
  const root = harnessRoot();
  const runsRoot = path.join(root, '.agent-runs');
  if (!fs.existsSync(runsRoot)) {
    return { ts: new Date().toISOString(), run: { id: '', states: {}, total: 0 }, parked_count: 0, recent_merges: [], council_health: { passed: 0, failed: 0, pending: 0, eval_error: 0 }, disk: { used_gb: 0, free_gb: 0, pct: 0 }, worktrees: 0, drivers: [], note: 'no .agent-runs yet' };
  }
  const runs = fs.readdirSync(runsRoot).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latestRun = runs[runs.length - 1] || '';
  const tasksDir = path.join(runsRoot, latestRun, 'tasks');
  const states: Record<string, number> = {};
  let total = 0;
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      try { const p = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')); states[p.state || 'unknown'] = (states[p.state || 'unknown'] || 0) + 1; total++; } catch { /* skip */ }
    }
  }
  const parkedFile = path.join(runsRoot, '_parked-modules.jsonl');
  const parked_count = fs.existsSync(parkedFile) ? fs.readFileSync(parkedFile, 'utf8').split('\n').filter(Boolean).length : 0;
  const councilDir = path.join(runsRoot, '_audit', 'council');
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

function engines(): unknown {
  // Re-detect availability fresh each call (operator may install/uninstall mid-session).
  const registry = getRegistry().map((spec) => {
    const probe = spawnSync('which', [spec.bin], { encoding: 'utf8' });
    const available = probe.status === 0 && (probe.stdout || '').trim().length > 0;
    return { key: spec.key, bin: spec.bin, description: spec.notes, available, binPath: available ? (probe.stdout || '').trim() : null };
  });
  return { ts: new Date().toISOString(), engines: registry };
}

function costRollup(): unknown {
  const root = harnessRoot();
  const runsRoot = path.join(root, '.agent-runs');
  if (!fs.existsSync(runsRoot)) return { ts: new Date().toISOString(), run_id: null, total_usd: 0, per_task: [] };
  const runs = fs.readdirSync(runsRoot).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latestRun = runs[runs.length - 1];
  if (!latestRun) return { ts: new Date().toISOString(), run_id: null, total_usd: 0, per_task: [] };
  const tasksDir = path.join(runsRoot, latestRun, 'tasks');
  if (!fs.existsSync(tasksDir)) return { ts: new Date().toISOString(), run_id: latestRun, total_usd: 0, per_task: [] };
  const perTask: Array<{ task_id: string; module: string; type: string; state: string; usd: number; entries: number }> = [];
  let total = 0;
  for (const f of fs.readdirSync(tasksDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
      const tel = Array.isArray(p.cost_telemetry) ? p.cost_telemetry : [];
      let usd = 0;
      for (const e of tel) { if (typeof e.est_usd === 'number') usd += e.est_usd; }
      total += usd;
      if (tel.length > 0 || usd > 0) {
        perTask.push({ task_id: p.task_id, module: p.module_or_sprint, type: p.type, state: p.state, usd: Math.round(usd * 1000) / 1000, entries: tel.length });
      }
    } catch { /* skip */ }
  }
  perTask.sort((a, b) => b.usd - a.usd);
  return { ts: new Date().toISOString(), run_id: latestRun, total_usd: Math.round(total * 1000) / 1000, per_task: perTask };
}

function replay(taskId: string): unknown {
  const root = harnessRoot();
  const runsRoot = path.join(root, '.agent-runs');
  if (!fs.existsSync(runsRoot)) return { error: 'no .agent-runs yet' };
  // Find which run holds the task
  let runId = '';
  let pack: Record<string, unknown> | null = null;
  for (const r of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r)) continue;
    const p = path.join(runsRoot, r, 'tasks', `${taskId}.json`);
    if (fs.existsSync(p)) {
      runId = r;
      try { pack = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* skip */ }
      break;
    }
  }
  if (!runId || !pack) return { error: `task ${taskId} not found` };

  // State log entries for this task
  const stateLogPath = path.join(runsRoot, runId, 'state-log.jsonl');
  const transitions: Array<Record<string, unknown>> = [];
  if (fs.existsSync(stateLogPath)) {
    for (const line of fs.readFileSync(stateLogPath, 'utf8').split('\n').filter(Boolean)) {
      try { const e = JSON.parse(line); if (e.task_id === taskId) transitions.push(e); } catch { /* skip */ }
    }
  }

  // Codex rounds from pack
  const codex = (pack as { codex?: { score_history?: Array<unknown> } }).codex;
  const codexRounds = codex?.score_history ?? [];

  // Evidence file list
  const evDir = path.join(runsRoot, runId, 'evidence', taskId);
  const evidence: Array<{ name: string; size: number; mtime: string }> = [];
  if (fs.existsSync(evDir)) {
    for (const f of fs.readdirSync(evDir)) {
      try { const st = fs.statSync(path.join(evDir, f)); if (st.isFile()) evidence.push({ name: f, size: st.size, mtime: st.mtime.toISOString() }); } catch { /* skip */ }
    }
    evidence.sort((a, b) => a.mtime.localeCompare(b.mtime));
  }

  // Council sidecar lookup
  const councilDir = path.join(runsRoot, '_audit', 'council', String((pack as { module_or_sprint?: string }).module_or_sprint || '').split('-')[0]);
  const sidecars: Array<{ phase: string; status: string; score?: number }> = [];
  if (fs.existsSync(councilDir)) {
    for (const phase of fs.readdirSync(councilDir)) {
      const phaseDir = path.join(councilDir, phase);
      if (!fs.statSync(phaseDir).isDirectory()) continue;
      for (const verFile of fs.readdirSync(phaseDir)) {
        try {
          const sc = JSON.parse(fs.readFileSync(path.join(phaseDir, verFile), 'utf8'));
          sidecars.push({ phase, status: sc.status, score: sc.result?.average_score_10 });
        } catch { /* skip */ }
      }
    }
  }

  return {
    task_id: taskId,
    run_id: runId,
    type: (pack as { type?: string }).type,
    module: (pack as { module_or_sprint?: string }).module_or_sprint,
    state: (pack as { state?: string }).state,
    transitions,
    codex_rounds: codexRounds,
    evidence,
    council_sidecars: sidecars,
  };
}

const HTML = `<!DOCTYPE html><html><head><title>Hermes Dashboard</title><style>
body{font-family:system-ui;margin:20px;background:#0f0f10;color:#e6e6e6}
h1{margin-bottom:6px}h2{margin:0 0 8px;font-size:14px;color:#9ec5ff;text-transform:uppercase;letter-spacing:0.5px}
.ts{color:#888;font-size:12px}
.tabs{display:flex;gap:0;margin-top:16px;border-bottom:1px solid #2a2a2e}
.tab{padding:10px 18px;cursor:pointer;color:#888;border-bottom:2px solid transparent}
.tab.active{color:#9ec5ff;border-bottom-color:#9ec5ff}
.panel{display:none;margin-top:16px}.panel.active{display:block}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:#1a1a1c;padding:14px;border-radius:8px;border:1px solid #2a2a2e}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:4px 8px}td:first-child{color:#888}
.ok{color:#5fcc7f}.fail{color:#ff7878}.warn{color:#ffc857}.pr{color:#9ec5ff}.branch{color:#bbb;font-size:11px}
input{background:#1a1a1c;color:#e6e6e6;border:1px solid #2a2a2e;padding:8px;border-radius:4px;width:340px;margin-right:8px}
button{background:#9ec5ff;color:#0f0f10;border:0;padding:8px 14px;border-radius:4px;cursor:pointer;font-weight:600}
.timeline{position:relative;padding-left:24px}
.timeline-item{padding:8px 0;border-left:2px solid #2a2a2e;padding-left:12px;margin-left:8px}
.timeline-item .ts{display:block;color:#888;font-size:11px}
.cost-bar{height:6px;background:#2a2a2e;border-radius:3px;overflow:hidden}.cost-bar-fill{height:100%;background:#9ec5ff}
pre{margin:0;font-size:12px;color:#aaa;white-space:pre-wrap}
</style></head><body>
<h1>🚀 Hermes Dashboard <span class="ts" id="ts"></span></h1>
<div class="tabs">
  <div class="tab active" data-tab="overview">Overview</div>
  <div class="tab" data-tab="engines">Engines</div>
  <div class="tab" data-tab="cost">Cost</div>
  <div class="tab" data-tab="replay">Replay</div>
</div>

<div id="panel-overview" class="panel active">
  <div class="grid">
    <div class="card"><h2>Run / Tasks</h2><div id="run"></div></div>
    <div class="card"><h2>Drivers</h2><div id="drivers"></div></div>
    <div class="card"><h2>Recent Merges</h2><div id="merges"></div></div>
    <div class="card"><h2>Council Health</h2><div id="council"></div></div>
    <div class="card"><h2>Parked Queue</h2><div id="parked"></div></div>
    <div class="card"><h2>Resources</h2><div id="resources"></div></div>
  </div>
</div>

<div id="panel-engines" class="panel">
  <div class="card"><h2>Engine availability</h2><div id="engines"></div></div>
</div>

<div id="panel-cost" class="panel">
  <div class="card"><h2>Cost rollup (current run)</h2><div id="cost"></div></div>
</div>

<div id="panel-replay" class="panel">
  <div class="card">
    <h2>Replay a task</h2>
    <input id="replay-id" placeholder="TP-2026-05-02-001" />
    <button onclick="loadReplay()">Load</button>
    <div id="replay" style="margin-top:14px"></div>
  </div>
</div>

<script>
function tab(name){
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('active',p.id==='panel-'+name));
  if(name==='engines') loadEngines();
  if(name==='cost') loadCost();
}
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>tab(t.dataset.tab));

function refreshOverview(){
  fetch('/api/status').then(r=>r.json()).then(s=>{
    document.getElementById('ts').textContent=s.ts;
    document.getElementById('run').innerHTML='<table><tr><td>Run</td><td>'+s.run.id+'</td></tr><tr><td>Total</td><td>'+s.run.total+'</td></tr>'+Object.entries(s.run.states).map(([k,v])=>'<tr><td>'+k+'</td><td>'+v+'</td></tr>').join('')+'</table>';
    document.getElementById('drivers').innerHTML=s.drivers.length===0?'<em>none</em>':'<table>'+s.drivers.map(d=>'<tr><td>PID '+d.pid+'</td><td>'+d.etime+'</td></tr>').join('')+'</table>';
    document.getElementById('merges').innerHTML='<table>'+s.recent_merges.map(m=>'<tr><td class=pr>#'+m.pr+'</td><td><span class=branch>'+m.branch+'</span></td></tr>').join('')+'</table>';
    document.getElementById('council').innerHTML='<table><tr><td class=ok>passed</td><td>'+s.council_health.passed+'</td></tr><tr><td class=fail>failed</td><td>'+s.council_health.failed+'</td></tr><tr><td class=warn>pending</td><td>'+s.council_health.pending+'</td></tr><tr><td>eval-error</td><td>'+s.council_health.eval_error+'</td></tr></table>';
    document.getElementById('parked').innerHTML='<strong>'+s.parked_count+'</strong> parked';
    document.getElementById('resources').innerHTML='<table><tr><td>Disk</td><td>'+s.disk.used_gb+'/'+(s.disk.used_gb+s.disk.free_gb)+'GB ('+s.disk.pct+'%)</td></tr><tr><td>Worktrees</td><td>'+s.worktrees+'</td></tr></table>';
  });
}
function loadEngines(){
  fetch('/api/engines').then(r=>r.json()).then(s=>{
    const rows=s.engines.map(e=>'<tr><td class="'+(e.available?'ok':'fail')+'">'+(e.available?'✓':'✗')+'</td><td>'+e.key+'</td><td>'+e.bin+'</td><td>'+(e.binPath||'')+'</td><td style="color:#aaa">'+e.description+'</td></tr>').join('');
    document.getElementById('engines').innerHTML='<table><thead><tr><td></td><td>Engine</td><td>Bin</td><td>Path</td><td>Description</td></tr></thead><tbody>'+rows+'</tbody></table>';
  });
}
function loadCost(){
  fetch('/api/cost').then(r=>r.json()).then(s=>{
    if(s.per_task.length===0){document.getElementById('cost').innerHTML='<em>No cost telemetry recorded yet for run '+(s.run_id||'(none)')+'.</em>';return;}
    const max=Math.max(...s.per_task.map(t=>t.usd))||1;
    const rows=s.per_task.map(t=>'<tr><td>'+t.task_id+'</td><td>'+t.module+'</td><td>'+t.type+'</td><td>'+t.state+'</td><td>$'+t.usd.toFixed(3)+'</td><td><div class="cost-bar"><div class="cost-bar-fill" style="width:'+(100*t.usd/max)+'%"></div></div></td></tr>').join('');
    document.getElementById('cost').innerHTML='<p>Run <strong>'+s.run_id+'</strong> total: <strong style="color:#9ec5ff">$'+s.total_usd.toFixed(3)+'</strong> across '+s.per_task.length+' task(s).</p><table><thead><tr><td>Task</td><td>Module</td><td>Type</td><td>State</td><td>$ USD</td><td>Share</td></tr></thead><tbody>'+rows+'</tbody></table>';
  });
}
function loadReplay(){
  const id=document.getElementById('replay-id').value.trim();
  if(!id) return;
  fetch('/api/replay/'+encodeURIComponent(id)).then(r=>r.json()).then(s=>{
    if(s.error){document.getElementById('replay').innerHTML='<em class=fail>'+s.error+'</em>';return;}
    let html='<p><strong>'+s.task_id+'</strong> · '+s.module+' · '+s.type+' · state: <strong>'+s.state+'</strong> · run: '+s.run_id+'</p>';
    html+='<h2 style=margin-top:14px>Timeline</h2><div class=timeline>';
    s.transitions.forEach(t=>{html+='<div class=timeline-item><span class=ts>'+t.at+' · '+t.by+'</span><strong>'+t.from+'</strong> → <strong>'+t.to+'</strong>'+(t.reason?'<br><span style="color:#aaa;font-size:11px">'+t.reason+'</span>':'')+'</div>';});
    html+='</div>';
    if(s.codex_rounds&&s.codex_rounds.length){html+='<h2 style=margin-top:14px>Codex rounds</h2><table>';s.codex_rounds.forEach(r=>{html+='<tr><td>R'+r.round+'</td><td>'+r.score+'/10</td><td class="'+(r.verdict==='GO'?'ok':'fail')+'">'+r.verdict+'</td><td class=ts>'+r.at+'</td></tr>';});html+='</table>';}
    if(s.council_sidecars&&s.council_sidecars.length){html+='<h2 style=margin-top:14px>Council sidecars</h2><table>';s.council_sidecars.forEach(c=>{html+='<tr><td>'+c.phase+'</td><td class="'+(c.status==='passed'?'ok':c.status==='failed'?'fail':'warn')+'">'+c.status+'</td><td>'+(c.score||'')+'</td></tr>';});html+='</table>';}
    if(s.evidence&&s.evidence.length){html+='<h2 style=margin-top:14px>Evidence files</h2><table>';s.evidence.forEach(e=>{html+='<tr><td>'+e.name+'</td><td>'+(e.size/1024).toFixed(1)+' KB</td><td class=ts>'+e.mtime+'</td></tr>';});html+='</table>';}
    document.getElementById('replay').innerHTML=html;
  });
}
refreshOverview();setInterval(refreshOverview,5000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  if (!req.url) { res.writeHead(404); res.end(); return; }
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
  if (req.url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (req.url === '/api/status') {
    try { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(snapshot())); }
    catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return;
  }
  if (req.url === '/api/engines') {
    try { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(engines())); }
    catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return;
  }
  if (req.url === '/api/cost') {
    try { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(costRollup())); }
    catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return;
  }
  const replayMatch = req.url.match(/^\/api\/replay\/([A-Za-z0-9_-]+)$/);
  if (replayMatch) {
    try { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(replay(replayMatch[1]))); }
    catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
    return;
  }
  res.writeHead(404); res.end('not found');
});
server.listen(PORT, () => console.log(`[dashboard-live] http://localhost:${PORT}`));
