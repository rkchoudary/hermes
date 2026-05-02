#!/usr/bin/env node
/**
 * pnpm auto:dashboard — live status dashboard (web UI + CLI summary mode).
 *
 * Usage:
 *   pnpm auto:dashboard                       # start web dashboard at http://localhost:3001/auto/dashboard
 *   pnpm auto:dashboard --port 4001           # alternate port
 *   pnpm auto:dashboard --cli                 # CLI table only; no web server
 *   pnpm auto:dashboard --json                # machine-readable status as JSON
 *
 * v0.1 STUB — implements --cli + --json modes; v0.2 adds the web UI (Next.js page).
 *
 * The dashboard answers the operator's "walk away with visibility" need by surfacing:
 *  - Burndown: X of total modules complete; estimated days-to-finish
 *  - In-flight workers: which task each is on, started-at, expected-completion
 *  - Recent verdicts: last 20 Codex outputs with score + verdict + evidence link
 *  - Blocked tasks: anything in needs-revision after max_rounds
 *  - Cost meter: today's spend vs daily budget
 *  - Awareness freshness: when each awareness file was last refreshed
 *  - GitHub state: open PRs + recent merges + CI status
 *  - Obsidian state: which FRDs were modified in the last hour
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGoalSnapshot, readGoal, evaluateGoal, defaultGoal } from '../lib/goal';
import { readBudget, evaluateBudget, defaultBudget } from '../lib/budget';
import { readEscalationLog } from '../lib/escalation';
import { readTaskPack, evidenceDir } from '../lib/runState';
import { evaluateMergePolicy, defaultMergePolicy } from '../lib/mergePolicy';
import { readOverrideAudit } from '../lib/overrideAudit';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

interface DashboardArgs {
  port?: number;
  cli?: boolean;
  json?: boolean;
}

function parseArgs(argv: string[]): DashboardArgs {
  const args: DashboardArgs = { port: 3001 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) args.port = parseInt(argv[++i], 10);
    else if (arg === '--cli') args.cli = true;
    else if (arg === '--json') args.json = true;
  }
  return args;
}

interface TaskSummary {
  task_id: string;
  module_or_sprint: string;
  state: string;
  codex_score?: number;
  codex_verdict?: string;
  age_min: number;
  evidence_count: number;
}

function discoverAllTasks(): TaskSummary[] {
  // Resolve runs dir from script location, NOT cwd. Previously used a relative
  // path that broke under `pnpm auto:status` (pnpm sets cwd to the package dir
  // tools/autonomous-delivery/, where .agent-runs/ doesn't exist — the runs
  // dir is at harness root, two levels up). Surfaced as "Total tasks: 0" even
  // when 7 task packs were live (verified 2026-04-28).
  const HARNESS_ROOT = harnessRoot();
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) return [];

  const tasks: TaskSummary[] = [];
  for (const runId of fs.readdirSync(runsDir)) {
    const tasksDir = path.join(runsDir, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const taskFile of fs.readdirSync(tasksDir)) {
      if (!taskFile.endsWith('.json')) continue;
      try {
        const taskPath = path.join(tasksDir, taskFile);
        const pack = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        // Skip lock-sentinel files (e.g. TP-XXX.lock.json) — not real task packs.
        if (!pack.task_id || !pack.module_or_sprint || !Array.isArray(pack.state_history)) continue;
        const evDir = path.join(runsDir, runId, 'evidence', pack.task_id);
        const evCount = fs.existsSync(evDir) ? fs.readdirSync(evDir).length : 0;
        const lastTransition = pack.state_history[pack.state_history.length - 1];
        const ageMin = lastTransition
          ? (Date.now() - new Date(lastTransition.at).getTime()) / 60000
          : 0;
        tasks.push({
          task_id: pack.task_id,
          module_or_sprint: pack.module_or_sprint,
          state: pack.state,
          codex_score: pack.codex?.score,
          codex_verdict: pack.codex?.verdict,
          age_min: ageMin,
          evidence_count: evCount,
        });
      } catch {
        // skip malformed
      }
    }
  }
  return tasks.sort((a, b) => b.age_min - a.age_min);
}

// ─── Phase 1 lite views (operator-local, read-only) ──────────────────────────

/** Render a horizontal progress bar of `width` chars at `pct` (0-1). */
function bar(pct: number, width: number = 30): string {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(filled) + '▒'.repeat(width - filled);
}

/** View 1: Inflight workers — task packs in-progress + their lock holders. */
function showInflightPanel(): void {
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) return;
  const inflight: Array<{
    task_id: string;
    module: string;
    pid?: number;
    host?: string;
    holder?: string;
    acquired_at?: string;
    last_heartbeat_at?: string;
  }> = [];
  for (const runId of fs.readdirSync(runsDir)) {
    if (runId.startsWith('_')) continue;
    const tasksDir = path.join(runsDir, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
        if (pack.state === 'in-progress' || pack.lock) {
          inflight.push({
            task_id: pack.task_id,
            module: pack.module_or_sprint,
            pid: pack.lock?.pid,
            host: pack.lock?.host,
            holder: pack.lock?.holder,
            acquired_at: pack.lock?.acquired_at,
            last_heartbeat_at: pack.lock?.last_heartbeat_at,
          });
        }
      } catch { /* skip */ }
    }
  }
  console.log(`\n┌─ Inflight workers (${inflight.length}) ──────────────────────────────`);
  if (inflight.length === 0) {
    console.log(`│  (none — no task pack in 'in-progress' state with active lock)`);
  } else {
    for (const w of inflight) {
      const elapsedMin = w.acquired_at
        ? ((Date.now() - new Date(w.acquired_at).getTime()) / 60000).toFixed(1)
        : '?';
      const hbAgeSec = w.last_heartbeat_at
        ? ((Date.now() - new Date(w.last_heartbeat_at).getTime()) / 1000).toFixed(0)
        : '?';
      console.log(`│  ⏵ ${w.task_id} · ${w.module} · ${elapsedMin}m elapsed · pid ${w.pid ?? '?'}`);
      console.log(`│    holder: ${(w.holder ?? 'unknown').slice(0, 50)} · host: ${w.host ?? 'unknown'}`);
      console.log(`│    last heartbeat: ${hbAgeSec}s ago`);
    }
  }
  console.log(`└─────────────────────────────────────────────────────────────`);
}

/** View 2: Goal contract gauge — read goal + evaluate against live snapshot. */
function showGoalGauge(): void {
  const goal = readGoal(HARNESS_ROOT) ?? defaultGoal();
  const snapshot = buildGoalSnapshot(HARNESS_ROOT, PACKAGE_ROOT);
  const eval_ = evaluateGoal(goal, snapshot);
  console.log(`\n┌─ Goal: ${goal.goal_id} ─────────────────────────────────────`);
  const status = eval_.complete ? 'COMPLETE' : 'in progress';
  console.log(`│  Status: ${status} — ${eval_.criteria_met}/${eval_.total_criteria} criteria met` +
    (eval_.criteria_overridden > 0 ? ` (${eval_.criteria_overridden} overridden)` : ''));
  for (const c of eval_.per_criterion) {
    const target = c.target > 0 ? c.target : 1;
    const pct = Math.min(1, c.current / target);
    const icon = c.met ? '✓' : (c.override_active ? '⊘' : '⏳');
    const ratio = `${c.current}/${c.target}`.padStart(8);
    console.log(`│  ${icon} ${c.id.padEnd(28)} ${ratio}  ${bar(pct, 16)}`);
  }
  console.log(`└─────────────────────────────────────────────────────────────`);
}

/** View 3: Escalation inbox — open escalations + kill switch state. */
function showEscalationInbox(): void {
  const log = readEscalationLog(HARNESS_ROOT);
  const killFile = path.join(HARNESS_ROOT, '.agent-runs', '_KILL_SWITCH');
  const killActive = fs.existsSync(killFile);
  const killBody = killActive ? (fs.readFileSync(killFile, 'utf8').slice(0, 200).trim()) : '';
  const open = log.filter((e) => !e.cleared_at);
  console.log(`\n┌─ Open escalations (${open.length}) ─────────────────────────────────`);
  if (killActive) {
    console.log(`│  🚨 KILL SWITCH ACTIVE: ${killBody.slice(0, 60)}`);
  }
  if (open.length === 0 && !killActive) {
    console.log(`│  (none — escalation log clean, kill switch released)`);
  } else {
    for (const e of open.slice(0, 5)) {
      const ageMin = ((Date.now() - new Date(e.at).getTime()) / 60000).toFixed(0);
      console.log(`│  ⚠ ${e.task_id ?? '(no task)'} · ${e.reason} · ${ageMin}m old`);
      console.log(`│    "${e.detail.slice(0, 60)}"`);
    }
    if (open.length > 5) console.log(`│  ... ${open.length - 5} more`);
  }
  console.log(`└─────────────────────────────────────────────────────────────`);
}

/** View 4: Cost guardian — budget windows + per-engine breakdown. */
function showCostGuardian(): void {
  const persisted = readBudget(HARNESS_ROOT);
  // Fall back to defaultBudget() so the panel shows real spend numbers even
  // when the operator hasn't authored a custom budget contract. The default
  // budget ($50/day, $250/week, $800/month per defaultBudget() in budget.ts)
  // is the same one M9 uses at runtime when readBudget returns null.
  const budget = persisted ?? defaultBudget();
  console.log(`\n┌─ Cost guardian ────────────────────────────────────────────`);
  if (!persisted) {
    console.log(`│  (using default budget — no custom contract at .agent-runs/_budget.json)`);
  }
  const eval_ = evaluateBudget(budget, path.join(HARNESS_ROOT, '.agent-runs'));
  for (const w of eval_.windows) {
    const pct = (w.utilization * 100).toFixed(0).padStart(3);
    const spent = `$${w.spent_usd.toFixed(2)}`.padStart(8);
    const cap = `$${w.cap_usd.toFixed(2)}`.padStart(8);
    const icon = w.status === 'ok' ? ' ' : (w.status === 'warning' ? '⚠' : '🚨');
    console.log(`│  ${icon} ${w.period.padEnd(8)}  ${spent} / ${cap}  ${bar(w.utilization, 14)}  ${pct}%`);
  }
  if (eval_.worst_window && eval_.worst_window.per_engine_utilization) {
    console.log(`│`);
    console.log(`│  By engine (${eval_.worst_window.period}):`);
    for (const [engine, util] of Object.entries(eval_.worst_window.per_engine_utilization)) {
      console.log(`│    ${engine.padEnd(20)}  ${(util * 100).toFixed(0).padStart(3)}%`);
    }
  }
  const ks = eval_.should_engage_kill_switch ? 'WILL ENGAGE on next dispatch' :
             eval_.should_release_kill_switch ? 'released' : 'released';
  console.log(`│`);
  console.log(`│  Kill switch (budget-driven): ${ks}`);
  console.log(`└─────────────────────────────────────────────────────────────`);
}

/** View 5: Merge readiness — per-task PUB-9 gate evaluation. */
function showMergeReadiness(): void {
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) return;
  // Only show tasks in states close to merging (ranked by readiness signal).
  const RELEVANT_STATES = new Set(['awaiting-review', 'codex-reviewing', 'promotable', 'ready-for-merge']);
  // R11 fix (LOW): pick phase per task state. Pre-land for tasks that haven't
  // yet been landed (no PR/branch); pre-merge for tasks where landing has
  // happened and we're checking ship-readiness.
  const PRELAND_STATES = new Set(['awaiting-review', 'codex-reviewing']);
  type Row = { task_id: string; module: string; state: string; phase: string; pass: boolean; violations: number; skipped: number; rules: string[] };
  const rows: Row[] = [];
  const policy = defaultMergePolicy();
  for (const runId of fs.readdirSync(runsDir)) {
    if (runId.startsWith('_')) continue;
    const tasksDir = path.join(runsDir, runId, 'tasks');
    if (!fs.existsSync(tasksDir)) continue;
    for (const f of fs.readdirSync(tasksDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const pack = readTaskPack(runId, f.replace('.json', ''));
        if (!RELEVANT_STATES.has(pack.state)) continue;
        const phase: 'pre-land' | 'pre-merge' = PRELAND_STATES.has(pack.state) ? 'pre-land' : 'pre-merge';
        const result = evaluateMergePolicy(pack, evidenceDir(runId, pack.task_id), HARNESS_ROOT, policy, { phase });
        rows.push({
          task_id: pack.task_id,
          module: pack.module_or_sprint,
          state: pack.state,
          phase,
          pass: result.ok,
          violations: result.violations.length,
          skipped: result.skipped_rules.length,
          rules: result.violations.map((v) => v.rule),
        });
      } catch { /* skip malformed */ }
    }
  }
  console.log(`\n┌─ Merge readiness (PUB-9 gate, ${rows.length} candidate task${rows.length === 1 ? '' : 's'}) ─────`);
  if (rows.length === 0) {
    console.log(`│  (no tasks in awaiting-review/codex-reviewing/promotable/ready-for-merge)`);
  } else {
    for (const r of rows) {
      const icon = r.pass ? '✓' : '✗';
      const state = r.state.padEnd(18);
      const evaluated = 10 - r.skipped;
      const phaseTag = `[${r.phase}]`.padEnd(11);
      const summary = r.pass ? `READY ${phaseTag}` : `BLOCK ${phaseTag} ${r.violations}/${evaluated}`;
      console.log(`│  ${icon} ${r.task_id} · ${r.module.padEnd(15)} · ${state} · ${summary}`);
      if (!r.pass) {
        const top = r.rules.slice(0, 3).join(', ');
        const more = r.rules.length > 3 ? `, +${r.rules.length - 3}` : '';
        console.log(`│      blocking rules: ${top}${more}`);
      }
    }
  }
  console.log(`└─────────────────────────────────────────────────────────────`);
}

/** View 6: Override audit summary — recent bypass entries (SOX visibility). */
function showOverrideAuditPanel(): void {
  const entries = readOverrideAudit(HARNESS_ROOT);
  console.log(`\n┌─ Override audit (${entries.length} total bypass${entries.length === 1 ? '' : 'es'} recorded) ────`);
  if (entries.length === 0) {
    console.log(`│  (no bypasses recorded — clean SOX posture)`);
  } else {
    // Show last 5 entries by recency.
    const recent = entries.slice(-5).reverse();
    for (const e of recent) {
      const ageMin = ((Date.now() - new Date(e.at).getTime()) / 60000).toFixed(0);
      const taskRef = e.task_id ? ` · ${e.task_id}` : '';
      console.log(`│  ⚠ ${e.kind.padEnd(28)} · ${ageMin}m ago${taskRef}`);
      console.log(`│    by ${e.actor.name} · "${e.reason.slice(0, 50)}${e.reason.length > 50 ? '…' : ''}"`);
    }
    if (entries.length > 5) console.log(`│  ... ${entries.length - 5} more (full log at .agent-runs/_override-audit.jsonl)`);
    // Per-kind breakdown
    const byKind: Record<string, number> = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    console.log(`│`);
    console.log(`│  By kind:`);
    for (const [kind, count] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
      console.log(`│    ${kind.padEnd(28)}  ${count}`);
    }
  }
  console.log(`└─────────────────────────────────────────────────────────────`);
}

function showCli(): void {
  const tasks = discoverAllTasks();

  console.log(`\nNBF Autonomous Delivery — Dashboard (CLI mode)\n`);

  // Phase 1 lite views (added 2026-04-28; 6 operator-visible panels)
  showInflightPanel();
  showGoalGauge();
  showEscalationInbox();
  showCostGuardian();
  showMergeReadiness();
  showOverrideAuditPanel();

  console.log(`\n─── Task summary ────────────────────────────────────────────`);
  console.log(`Total tasks: ${tasks.length}`);

  const byState = tasks.reduce(
    (acc, t) => {
      acc[t.state] = (acc[t.state] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  console.log(`\nBy state:`);
  Object.entries(byState).forEach(([state, count]) => {
    console.log(`  ${state.padEnd(20)} ${count}`);
  });

  console.log(`\nRecent activity (top 15):`);
  console.log('TASK              MOD/SPRINT        STATE              CODEX  AGE      EVIDENCE');
  console.log('───────────────── ────────────────── ────────────────── ────── ──────── ──────────');
  tasks.slice(0, 15).forEach((t) => {
    const taskId = t.task_id.padEnd(17);
    const mod = (t.module_or_sprint || '').slice(0, 18).padEnd(18);
    const state = t.state.padEnd(18);
    const codex = (t.codex_score?.toFixed(1) ?? '—').padStart(5);
    const age = `${t.age_min.toFixed(0)}m`.padStart(7);
    const ev = `${t.evidence_count}`.padStart(8);
    console.log(`${taskId} ${mod} ${state} ${codex}  ${age} ${ev}`);
  });

  // Awareness freshness
  console.log(`\nAwareness freshness:`);
  const awarenessDir = path.join(__dirname, '..', '..', 'awareness');
  if (fs.existsSync(awarenessDir)) {
    const files = fs.readdirSync(awarenessDir).filter((f) => f.endsWith('.json'));
    files.forEach((f) => {
      try {
        const json = JSON.parse(fs.readFileSync(path.join(awarenessDir, f), 'utf8'));
        const refreshed = json._schema?.last_refreshed ?? 'unknown';
        const ageHr = refreshed === 'unknown' ? '—' : ((Date.now() - new Date(refreshed).getTime()) / 3600000).toFixed(1) + 'h ago';
        console.log(`  ${f.padEnd(28)} ${ageHr}`);
      } catch {
        console.log(`  ${f.padEnd(28)} (parse error)`);
      }
    });
  }

  console.log(`\nFor live web dashboard: pnpm auto:dashboard (default port 3001)`);
  console.log(`For machine-readable: pnpm auto:dashboard --json`);
}

function showJson(): void {
  const tasks = discoverAllTasks();
  const data = {
    generated_at: new Date().toISOString(),
    total_tasks: tasks.length,
    by_state: tasks.reduce(
      (acc, t) => {
        acc[t.state] = (acc[t.state] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>
    ),
    tasks,
  };
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Event-driven web dashboard. Replaces the v0.1 stub — operator directive
 * "dashboard to be event driven as well and observability is key".
 *
 * Architecture:
 *   GET /                     → static HTML dashboard
 *   GET /auto/state           → current state snapshot (initial render)
 *   GET /auto/events          → Server-Sent Events stream
 *
 * Push triggers (no polling on the server):
 *   - fs.watch on .agent-runs/ recursive — emits a 'state-changed' event
 *     on every TaskPack JSON write or _*.json change (goal, budget,
 *     escalation log, kill switch, model inventory).
 *   - Coalescing: bursts of writes within 250ms collapse into one event.
 *
 * Client uses EventSource (native browser API; no library) to subscribe.
 */
import * as http from 'node:http';

const STATIC_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>NBF Autonomous Delivery — Dashboard</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0e1a; color: #e6edf3; margin: 0; padding: 16px; font-size: 13px; }
  h1 { font-size: 16px; margin: 0 0 12px; color: #5B9BD5; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .card { background: #0d1117; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; padding: 12px; }
  .card h2 { font-size: 12px; margin: 0 0 8px; color: #9B7FD4; text-transform: uppercase; letter-spacing: 0.5px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td, th { padding: 4px 6px; text-align: left; border-bottom: 1px solid rgba(255,255,255,0.04); }
  th { color: #6B7590; font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.4px; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; font-weight: 600; }
  .planned { background: #20303f; color: #5B9BD5; }
  .in-progress { background: #4d3520; color: #ffaa44; }
  .needs-revision { background: #4d2020; color: #ff6b6b; }
  .promotable { background: #1d3a25; color: #4ade80; }
  .ready-for-merge { background: #1d4a3d; color: #4adeb0; }
  .merged { background: #1a2d1a; color: #6b8b6b; }
  .abandoned { background: #2a2a2a; color: #6b6b6b; }
  .live { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4ade80; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .stale { background: #ff6b6b; }
  .meta { color: #6B7590; font-size: 11px; margin-top: 4px; }
  .progress { display: inline-block; vertical-align: middle; width: 120px; height: 6px; background: rgba(255,255,255,0.06); border-radius: 3px; overflow: hidden; }
  .progress > div { height: 100%; background: #5B9BD5; }
  pre { background: #0a0d12; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; max-height: 200px; }
  .events { max-height: 240px; overflow-y: auto; font-family: 'SF Mono', Menlo, monospace; font-size: 11px; }
  .events div { padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .events div .t { color: #6B7590; margin-right: 6px; }
</style></head><body>
<h1><span id="conn" class="live"></span>NBF Autonomous Delivery — Dashboard <span id="updated" style="color:#6B7590;font-size:11px;font-weight:normal;margin-left:8px"></span></h1>
<div class="grid">
  <div class="card"><h2>Goal — Project</h2><div id="goal">…</div></div>
  <div class="card"><h2>Cost guardian (daily)</h2><div id="cost">…</div></div>
  <div class="card" style="grid-column:1/-1"><h2>Currently working <span id="working-count" class="meta"></span></h2><div id="working">…</div></div>
  <div class="card" style="grid-column:1/-1"><h2>Backlog <span id="backlog-count" class="meta"></span></h2><div id="backlog">…</div></div>
  <div class="card" style="grid-column:1/-1"><h2>Completed <span id="completed-count" class="meta"></span></h2><div id="completed">…</div></div>
  <div class="card"><h2>Open escalations</h2><div id="escal">…</div></div>
  <div class="card"><h2>Recent state changes</h2><div id="events" class="events"></div></div>
</div>
<script>
function pill(state) { return '<span class="pill ' + state + '">' + state + '</span>'; }
function fmt(n, w) { const s = String(n); return s.padEnd(w, ' '); }
async function loadInitial() {
  const r = await fetch('/auto/state'); const d = await r.json(); render(d);
}
function render(d) {
  document.getElementById('updated').textContent = 'updated ' + new Date(d.generated_at).toLocaleTimeString();
  // Goal
  const goal = d.goal || {};
  let g = '<table>';
  for (const c of (goal.criteria || [])) {
    const pct = c.target ? Math.round(100 * c.current / c.target) : 0;
    g += '<tr><td>' + c.id + '</td><td>' + c.current + '/' + c.target +
         '</td><td><span class="progress"><div style="width:' + pct + '%"></div></span></td></tr>';
  }
  g += '</table><div class="meta">Status: ' + (goal.status || 'unknown') + '</div>';
  document.getElementById('goal').innerHTML = g;
  // Cost
  const c = d.cost || {};
  let cost = '';
  for (const w of (c.windows || [])) {
    const pct = w.cap ? Math.round(100 * w.used / w.cap) : 0;
    cost += '<div>' + w.period + ' &middot; $' + (w.used || 0).toFixed(2) + '/$' + w.cap +
            ' <span class="progress"><div style="width:' + Math.min(pct, 100) + '%' +
            (pct > 90 ? ';background:#ff6b6b' : '') + '"></div></span> ' + pct + '%</div>';
  }
  document.getElementById('cost').innerHTML = cost || '<div class="meta">no cost data</div>';
  // Tasks bucketed: backlog / working / completed (operator directive — durability across restarts)
  const tasks = d.tasks || [];
  const WORKING_STATES = new Set(['in-progress', 'awaiting-review', 'codex-reviewing']);
  const COMPLETED_STATES = new Set(['promotable', 'ready-for-merge', 'merged', 'abandoned']);
  const BACKLOG_STATES = new Set(['planned', 'needs-revision']);
  function tableFor(rows) {
    if (rows.length === 0) return '<div class="meta">(empty)</div>';
    let s = '<table><tr><th>Task</th><th>Module</th><th>State</th><th>Type</th><th>Codex</th><th>Round</th><th>Age</th></tr>';
    for (const x of rows) {
      s += '<tr><td>' + x.task_id + '</td><td>' + (x.module_or_sprint || '') +
           '</td><td>' + pill(x.state) + '</td><td>' + (x.type || '') + '</td><td>' +
           (x.codex_score ?? '—') + '</td><td>' + (x.codex_rounds || 0) +
           '</td><td>' + (x.age_min ? x.age_min + 'm' : '') + '</td></tr>';
    }
    return s + '</table>';
  }
  const working = tasks.filter(x => WORKING_STATES.has(x.state));
  const backlog = tasks.filter(x => BACKLOG_STATES.has(x.state));
  const completed = tasks.filter(x => COMPLETED_STATES.has(x.state));
  document.getElementById('working').innerHTML = tableFor(working);
  document.getElementById('working-count').textContent = '· ' + working.length;
  document.getElementById('backlog').innerHTML = tableFor(backlog);
  document.getElementById('backlog-count').textContent = '· ' + backlog.length;
  document.getElementById('completed').innerHTML = tableFor(completed);
  document.getElementById('completed-count').textContent = '· ' + completed.length;
  // Escalations
  const esc = d.escalations || [];
  document.getElementById('escal').innerHTML = esc.length === 0
    ? '<div class="meta">no open escalations &middot; kill switch released</div>'
    : '<pre>' + esc.slice(0, 10).map(e => JSON.stringify(e)).join('\\n') + '</pre>';
}
const evDiv = document.getElementById('events');
const events = new EventSource('/auto/events');
events.onmessage = (m) => {
  try {
    const d = JSON.parse(m.data);
    const ts = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.innerHTML = '<span class="t">' + ts + '</span>' +
                    (d.kind || 'event') + ' ' + (d.summary || JSON.stringify(d).slice(0, 200));
    evDiv.insertBefore(div, evDiv.firstChild);
    while (evDiv.children.length > 50) evDiv.removeChild(evDiv.lastChild);
    if (d.refresh) loadInitial();
  } catch {}
};
events.onerror = () => { document.getElementById('conn').classList.add('stale'); };
events.onopen = () => { document.getElementById('conn').classList.remove('stale'); };
loadInitial();
</script></body></html>`;

interface SseClient { id: number; res: http.ServerResponse; }
let nextClientId = 1;

function buildSnapshot(): Record<string, unknown> {
  const tasks = discoverAllTasks();
  const goal = readGoal(HARNESS_ROOT) ?? defaultGoal();
  let goalEval: ReturnType<typeof evaluateGoal> | null = null;
  try {
    const snap = buildGoalSnapshot(HARNESS_ROOT, HARNESS_ROOT);
    goalEval = evaluateGoal(goal, snap);
  } catch { /* defaults */ }
  const budget = readBudget(HARNESS_ROOT) ?? defaultBudget();
  let budgetEval: ReturnType<typeof evaluateBudget> | null = null;
  try {
    budgetEval = evaluateBudget(budget, path.join(HARNESS_ROOT, '.agent-runs'));
  } catch { /* defaults */ }
  const escalations = readEscalationLog(HARNESS_ROOT).slice(0, 20);
  const tasksMin = tasks.map((t: any) => ({
    task_id: t.task_id,
    module_or_sprint: t.module_or_sprint,
    state: t.state,
    type: t.type,
    codex_score: t.codex_score,
    codex_rounds: t.codex_rounds,
    age_min: t.age_min,
  }));
  return {
    generated_at: new Date().toISOString(),
    goal: goalEval ? {
      status: goalEval.complete ? 'met' : 'in-progress',
      criteria: goalEval.per_criterion.map((c: any) => ({ id: c.id, current: c.current, target: c.target })),
    } : null,
    cost: budgetEval ? {
      windows: budgetEval.windows.map((w: any) => ({ period: w.period, used: w.spent_usd ?? 0, cap: w.cap_usd })),
    } : { windows: [] },
    tasks: tasksMin,
    escalations,
  };
}

function showWeb(port: number): void {
  const clients = new Set<SseClient>();
  let coalesceTimer: NodeJS.Timeout | null = null;

  const broadcastChange = (kind: string, summary: string): void => {
    const payload = JSON.stringify({ kind, summary, refresh: true });
    for (const c of clients) {
      try { c.res.write(`data: ${payload}\n\n`); } catch { /* client gone */ }
    }
  };

  const onFsChange = (eventType: string, filename: string | null): void => {
    if (!filename) return;
    if (coalesceTimer) clearTimeout(coalesceTimer);
    coalesceTimer = setTimeout(() => {
      let kind = 'state-changed';
      const f = filename;
      if (f.endsWith('.json') && f.includes('/tasks/')) kind = 'task-changed';
      else if (f.endsWith('_KILL_SWITCH')) kind = 'kill-switch';
      else if (f.endsWith('_goal.json')) kind = 'goal-updated';
      else if (f.endsWith('_budget.json')) kind = 'budget-updated';
      else if (f.endsWith('_escalation-log.jsonl')) kind = 'escalation';
      broadcastChange(kind, f);
    }, 250);
  };

  const RUNS_DIR_LOCAL = path.join(HARNESS_ROOT, '.agent-runs');
  if (fs.existsSync(RUNS_DIR_LOCAL)) {
    try {
      fs.watch(RUNS_DIR_LOCAL, { recursive: true }, onFsChange);
    } catch (e) {
      console.warn(`[dashboard] fs.watch on ${RUNS_DIR_LOCAL} failed: ${(e as Error).message} — events will not stream`);
    }
  }

  const server = http.createServer((req, res) => {
    if (!req.url) { res.writeHead(400); res.end(); return; }
    if (req.url === '/' || req.url === '/auto/dashboard') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(STATIC_HTML);
      return;
    }
    if (req.url === '/auto/state') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      try { res.end(JSON.stringify(buildSnapshot())); }
      catch (e) { res.end(JSON.stringify({ error: (e as Error).message })); }
      return;
    }
    if (req.url === '/auto/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        'connection': 'keep-alive',
      });
      res.write(`data: {"kind":"hello","summary":"connected"}\n\n`);
      const client: SseClient = { id: nextClientId++, res };
      clients.add(client);
      const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* ignore */ }
      }, 25_000);
      req.on('close', () => { clearInterval(heartbeat); clients.delete(client); });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  server.listen(port, () => {
    console.log(`pnpm auto:dashboard live at http://localhost:${port}/`);
    console.log(`  • SSE event stream:  http://localhost:${port}/auto/events`);
    console.log(`  • Snapshot JSON:     http://localhost:${port}/auto/state`);
    console.log(`Watching: ${RUNS_DIR_LOCAL}`);
    console.log(`Connected clients: 0 (will appear here on first browser connect)`);
  });

  setInterval(() => {
    if (clients.size > 0) {
      process.stdout.write(`\r[dashboard] ${clients.size} client(s) · ${Date.now()}      `);
    }
  }, 30_000);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.json) showJson();
  else if (args.cli) showCli();
  else showWeb(args.port!);
}

main();
