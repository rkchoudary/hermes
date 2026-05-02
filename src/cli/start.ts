#!/usr/bin/env node
/**
 * pnpm auto:start — single entry point for "pick up where we left off."
 *
 * Operator directive (2026-04-28): "there should be a single entry point in
 * case of failures or reboots to start from where we had the last completion
 * or the best place as if we never left."
 *
 * Pipeline (idempotent, audited at every step):
 *   1. AUDIT READBACK         — last 5 _override-audit + _escalation entries
 *                                (so the operator sees what happened while away)
 *   2. RESURRECT              — auto:resurrect --apply (release dead-pid locks
 *                                + archive volatile reviews)
 *   3. WATCHDOG REAP          — auto:watchdog --apply (kill over-deadline +
 *                                heartbeat-stale + dead-pid registered procs)
 *   4. CLEANUP                — auto:cleanup --apply (cadence-respecting
 *                                retention enforcement)
 *   5. HEALTH                 — runHealthChecks → human-readable summary
 *   6. TASK SUMMARY           — discoverTasks() → state buckets
 *   7. RUBRIC NEXT-ACTION     — pickNextAction() → recommendation
 *   8. DISPATCH (optional)    — if --dispatch-next: actually invoke the
 *                                recommended action (worker / consensus /
 *                                promote-recommendation / escalate)
 *
 * Usage:
 *   pnpm auto:start                      # report-only (recovery + status; no dispatch)
 *   pnpm auto:start --dispatch-next      # also dispatch the rubric's recommended next action
 *   pnpm auto:start --json               # machine-readable bundle for tooling
 *   pnpm auto:start --no-recovery        # skip resurrect+watchdog+cleanup (just status)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_start = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_start);
const HARNESS_ROOT = harnessRoot();
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

interface Args {
  dispatchNext: boolean;
  json: boolean;
  noRecovery: boolean;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    dispatchNext: argv.includes('--dispatch-next'),
    json: argv.includes('--json'),
    noRecovery: argv.includes('--no-recovery'),
    verbose: argv.includes('--verbose') || !argv.includes('--quiet'),
  };
}

function readJsonLines(file: string, lastN: number): unknown[] {
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter((l) => l.trim());
    const tail = lines.slice(-lastN);
    return tail.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function runCli(label: string, cmd: string, args: string[]): { ok: boolean; output: string; exitCode: number | null } {
  const result = spawnSync(cmd, args, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    output: (result.stdout ?? '') + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''),
    exitCode: result.status,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const startReport: Record<string, unknown> = {
    at: new Date().toISOString(),
    host: os.hostname(),
    pid: process.pid,
    harness_root: HARNESS_ROOT,
    package_root: PACKAGE_ROOT,
    dispatch_next: args.dispatchNext,
    no_recovery: args.noRecovery,
  };

  if (!args.json) {
    console.log('═══════════════════════════════════════════════════════════════════════');
    console.log(`  auto:start — picking up where we left off`);
    console.log(`  ${startReport.at}  host=${startReport.host}`);
    console.log('═══════════════════════════════════════════════════════════════════════\n');
  }

  // ─── 0. FULL CONTEXT BUNDLE ─────────────────────────────────────────────
  // Operator directive 2026-04-28: "with full context" — surface
  // session-handoff brief + git state + awareness + goal so the next
  // session lands fully primed without manual digging.
  const context: Record<string, unknown> = {};

  // 0a. Session-handoff brief (the AUTONOMOUS-PROGRESS.md last-flush state)
  const handoffPath = process.env.AUTONOMOUS_PROGRESS_PATH ??
    path.join(os.homedir(), process.env.HERMES_PROGRESS_PATH || './PROGRESS.md');
  if (fs.existsSync(handoffPath)) {
    try {
      const stat = fs.statSync(handoffPath);
      const ageHours = (Date.now() - stat.mtimeMs) / 3600_000;
      context.handoff_brief = {
        path: handoffPath,
        last_modified: new Date(stat.mtimeMs).toISOString(),
        age_hours: ageHours,
        size_bytes: stat.size,
        is_fresh: ageHours < 24,
      };
    } catch { /* */ }
  }

  // 0b. Awareness layer freshness
  const awarenessDir = path.join(PACKAGE_ROOT, 'awareness');
  const awarenessFiles: { name: string; age_hours: number; size_bytes: number }[] = [];
  if (fs.existsSync(awarenessDir)) {
    for (const f of fs.readdirSync(awarenessDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const st = fs.statSync(path.join(awarenessDir, f));
        awarenessFiles.push({
          name: f,
          age_hours: (Date.now() - st.mtimeMs) / 3600_000,
          size_bytes: st.size,
        });
      } catch { /* */ }
    }
  }
  context.awareness = awarenessFiles;

  // 0c. Git state (current branch, ahead-of-main, dirty)
  const git: Record<string, unknown> = {};
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 3000 });
    git.branch = (branch.stdout ?? '').trim();
    const head = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 3000 });
    git.head_short = (head.stdout ?? '').trim();
    const headSubj = spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 3000 });
    git.head_subject = (headSubj.stdout ?? '').trim();
    const aheadBehind = spawnSync('git', ['rev-list', '--left-right', '--count', 'HEAD...origin/main'], { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 3000 });
    if (aheadBehind.status === 0) {
      const [ahead, behind] = (aheadBehind.stdout ?? '').trim().split(/\s+/);
      git.ahead_of_origin_main = parseInt(ahead || '0', 10);
      git.behind_origin_main = parseInt(behind || '0', 10);
    }
    const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 3000 });
    git.dirty_files = (dirty.stdout ?? '').trim().split('\n').filter((l) => l.trim()).length;
  } catch { /* git unavailable */ }
  context.git = git;

  // 0d. Goal contract + evaluation (if defined)
  try {
    const { readGoal, evaluateGoal, buildGoalSnapshot } = await import('../lib/goal');
    const goal = readGoal(HARNESS_ROOT);
    if (goal) {
      const snapshot = buildGoalSnapshot(HARNESS_ROOT, PACKAGE_ROOT, {});
      const eval_ = evaluateGoal(goal, snapshot);
      context.goal = {
        defined: true,
        complete: eval_.complete,
        criteria_met: eval_.criteria_met,
        total_criteria: eval_.total_criteria,
        per_criterion: eval_.per_criterion.map((c) => ({ id: c.id, met: c.met, current: c.current, target: c.target })),
      };
    } else {
      context.goal = { defined: false };
    }
  } catch { context.goal = { defined: false }; }

  startReport.context = context;
  if (!args.json) {
    console.log('0️⃣  FULL CONTEXT:');
    if (context.handoff_brief) {
      const h = context.handoff_brief as { path: string; age_hours: number; is_fresh: boolean };
      console.log(`   handoff brief: ${h.path}`);
      console.log(`     age=${h.age_hours.toFixed(1)}h ${h.is_fresh ? '(fresh)' : '(STALE — older than 24h; consider auto:flush-progress on prior session)'}`);
    } else {
      console.log('   handoff brief: (not found; run auto:flush-progress to create one)');
    }
    if (awarenessFiles.length > 0) {
      console.log(`   awareness: ${awarenessFiles.length} files (oldest ${Math.max(...awarenessFiles.map((f) => f.age_hours)).toFixed(1)}h)`);
    } else {
      console.log('   awareness: (empty — populate awareness/*.json for project context)');
    }
    if (git.branch) {
      const ahead = git.ahead_of_origin_main ?? 0;
      const behind = git.behind_origin_main ?? 0;
      const dirty = git.dirty_files ?? 0;
      console.log(`   git: branch=${git.branch} HEAD=${git.head_short} (ahead ${ahead} / behind ${behind}; ${dirty} dirty file${dirty === 1 ? '' : 's'})`);
      if (git.head_subject) console.log(`        last commit: ${git.head_subject}`);
    }
    if (context.goal && (context.goal as { defined: boolean }).defined) {
      const g = context.goal as { complete: boolean; criteria_met: number; total_criteria: number };
      console.log(`   goal: ${g.complete ? '🎉 COMPLETE' : 'in progress'} — ${g.criteria_met}/${g.total_criteria} criteria met`);
    }
    console.log('');
  }

  // ─── 1. AUDIT READBACK ──────────────────────────────────────────────────
  const auditTail = readJsonLines(path.join(HARNESS_ROOT, '.agent-runs', '_override-audit.jsonl'), 5);
  const escalationTail = readJsonLines(path.join(HARNESS_ROOT, '.agent-runs', '_escalation-log.jsonl'), 5);
  startReport.audit_tail = auditTail;
  startReport.escalation_tail = escalationTail;
  if (!args.json) {
    console.log('1️⃣  AUDIT TRAIL — last 5 override/audit entries:');
    if (auditTail.length === 0) console.log('   (none)');
    for (const a of auditTail as { at?: string; kind?: string; reason?: string; task_id?: string }[]) {
      const tag = a.task_id ? `[${a.task_id}] ` : '';
      console.log(`   ${a.at}  ${a.kind?.padEnd(22)} ${tag}${(a.reason ?? '').slice(0, 100)}`);
    }
    console.log(`\n   Last 5 escalations:`);
    if (escalationTail.length === 0) console.log('   (none)');
    for (const e of escalationTail as { at?: string; reason?: string; detail?: string; cleared_by?: string }[]) {
      const status = e.cleared_by ? '✓ cleared' : '⚠ open';
      console.log(`   ${e.at}  ${status}  ${e.reason}: ${(e.detail ?? '').slice(0, 80)}`);
    }
    console.log('');
  }

  // ─── 2-4. RECOVERY (resurrect + watchdog + cleanup) ─────────────────────
  const recovery: Record<string, unknown> = {};
  if (!args.noRecovery) {
    if (!args.json) console.log('2️⃣  RESURRECT (release stale-pid locks):');
    const resurrect = runCli('resurrect', 'pnpm', ['--silent', 'auto:resurrect', '--apply']);
    recovery.resurrect = { ok: resurrect.ok, exit_code: resurrect.exitCode };
    if (!args.json) console.log(`   ${resurrect.ok ? '✓' : '✗'} exit=${resurrect.exitCode}`);

    if (!args.json) console.log('\n3️⃣  WATCHDOG REAP (kill over-deadline / heartbeat-stale / dead-pid):');
    const watchdog = runCli('watchdog', 'pnpm', ['--silent', 'auto:watchdog', '--apply', '--json']);
    let watchdogResults: unknown = null;
    try { watchdogResults = JSON.parse(watchdog.output); } catch { /* */ }
    recovery.watchdog = { ok: watchdog.ok, exit_code: watchdog.exitCode, results: watchdogResults };
    if (!args.json) {
      const wj = watchdogResults as { results?: { verdict?: string; pid?: number; task_id?: string }[] } | null;
      const reaped = (wj?.results ?? []).filter((r) => r.verdict !== 'keep');
      console.log(`   ${watchdog.ok ? '✓' : '✗'} reaped=${reaped.length}`);
      for (const r of reaped) console.log(`     • pid=${r.pid} ${r.task_id ?? ''} verdict=${r.verdict}`);
    }

    if (!args.json) console.log('\n4️⃣  CLEANUP (apply retention policies):');
    const cleanup = runCli('cleanup', 'pnpm', ['--silent', 'auto:cleanup', '--apply', '--json']);
    let cleanupResults: unknown = null;
    try { cleanupResults = JSON.parse(cleanup.output); } catch { /* */ }
    recovery.cleanup = { ok: cleanup.ok, exit_code: cleanup.exitCode, results: cleanupResults };
    if (!args.json) {
      const cj = cleanupResults as { total_actions?: number; total_bytes?: number } | null;
      console.log(`   ${cleanup.ok ? '✓' : '✗'} actions=${cj?.total_actions ?? 0} bytes=${((cj?.total_bytes ?? 0) / 1024).toFixed(1)} KB`);
    }
  } else {
    if (!args.json) console.log('2️⃣-4️⃣  RECOVERY: skipped (--no-recovery)');
  }
  startReport.recovery = recovery;

  // ─── 5. HEALTH ──────────────────────────────────────────────────────────
  if (!args.json) console.log('\n5️⃣  HEALTH:');
  const { runHealthChecks } = await import('../lib/systemHealth');
  const health = runHealthChecks(HARNESS_ROOT);
  startReport.health = health;
  if (!args.json) {
    const icon = health.overall === 'critical' ? '🔴' :
                 health.overall === 'warning' ? '🟡' :
                 health.overall === 'info' ? '🔵' : '🟢';
    console.log(`   ${icon} overall=${health.overall.toUpperCase()}`);
    for (const c of health.checks) {
      if (c.severity === 'ok') continue;
      console.log(`   ${c.severity === 'critical' ? '✗' : c.severity === 'warning' ? '⚠' : 'ℹ'} ${c.id}: ${c.value}${c.recommendation ? ` — ${c.recommendation}` : ''}`);
    }
  }

  // ─── 6. TASK SUMMARY ────────────────────────────────────────────────────
  if (!args.json) console.log('\n6️⃣  TASKS:');
  const { listRuns, listTasks, readTaskPack } = await import('../lib/runState');
  const taskRefs: { runId: string; taskId: string }[] = [];
  for (const runId of listRuns()) {
    for (const taskId of listTasks(runId)) taskRefs.push({ runId, taskId });
  }
  const tasks: { task_id: string; run_id: string; state: string; module?: string; codex?: { score?: number; verdict?: string; rounds_executed?: number } }[] = [];
  for (const ref of taskRefs) {
    try {
      const pack = readTaskPack(ref.runId, ref.taskId);
      tasks.push({
        task_id: pack.task_id,
        run_id: pack.run_id,
        state: pack.state,
        module: pack.module_or_sprint,
        codex: pack.codex ? { score: pack.codex.score, verdict: pack.codex.verdict, rounds_executed: pack.codex.rounds_executed } : undefined,
      });
    } catch { /* malformed pack */ }
  }
  startReport.tasks = tasks;
  if (!args.json) {
    if (tasks.length === 0) console.log('   (no tasks)');
    const byState = tasks.reduce<Record<string, number>>((m, t) => { m[t.state] = (m[t.state] ?? 0) + 1; return m; }, {});
    for (const [state, n] of Object.entries(byState)) {
      console.log(`   ${state.padEnd(20)} ${n}`);
    }
    console.log(`   ${'TOTAL'.padEnd(20)} ${tasks.length}`);
  }

  // ─── 7. RUBRIC NEXT-ACTION ──────────────────────────────────────────────
  if (!args.json) console.log('\n7️⃣  RUBRIC RECOMMENDATION:');
  const { applyRubric, pickNextAction } = await import('../lib/decisionRubric');
  const packs = taskRefs.map((ref) => { try { return readTaskPack(ref.runId, ref.taskId); } catch { return null; } }).filter(Boolean);
  const decisions = (packs as NonNullable<typeof packs[number]>[]).map(applyRubric);
  const next = pickNextAction(packs as NonNullable<typeof packs[number]>[]);
  startReport.rubric_decisions = decisions;
  startReport.rubric_recommended = next;
  if (!args.json) {
    if (next === null) {
      console.log('   (no actionable tasks)');
    } else {
      const a = next.action;
      const reason = 'reason' in a ? a.reason : '';
      console.log(`   ▸ task: ${next.task_id}`);
      console.log(`   ▸ action: ${a.kind} (precedence ${next.precedence})`);
      console.log(`   ▸ reason: ${reason}`);
    }
  }

  // ─── 8. DISPATCH (optional) ─────────────────────────────────────────────
  if (args.dispatchNext && next && next.action.kind !== 'idle' && next.action.kind !== 'skip-task') {
    if (!args.json) console.log('\n8️⃣  DISPATCH:');
    let dispatchCmd: string | null = null;
    let dispatchArgs: string[] = [];
    switch (next.action.kind) {
      case 'dispatch-worker-fresh':
      case 'dispatch-worker-revise':
        dispatchCmd = 'pnpm';
        // v0.4.14 (Codex MEDIUM #10): drop --force from auto-dispatch.
        // Operator can opt back in via env var if they really mean it.
        dispatchArgs = process.env.AUTO_START_DISPATCH_FORCE === 'true'
          ? ['auto:work', next.task_id, '--force']
          : ['auto:work', next.task_id];
        break;
      case 'dispatch-consensus':
        dispatchCmd = 'pnpm';
        dispatchArgs = ['auto:consensus', next.task_id, '--gate', 'completion', '--apply'];
        break;
      case 'auto-promote':
        dispatchCmd = 'pnpm';
        dispatchArgs = ['auto:promote', next.task_id];
        break;
      case 'escalate':
        if (!args.json) console.log(`   ⚠ rubric recommends escalation — please review _escalation-log.jsonl + take manual action`);
        break;
    }
    if (dispatchCmd) {
      if (!args.json) console.log(`   spawning: ${dispatchCmd} ${dispatchArgs.join(' ')}`);
      const r = runCli('dispatch', dispatchCmd, dispatchArgs);
      startReport.dispatched = { ok: r.ok, exit_code: r.exitCode };
      if (!args.json) console.log(`   ${r.ok ? '✓' : '✗'} exit=${r.exitCode}`);
    }
  } else if (!args.dispatchNext && next && next.action.kind !== 'idle' && next.action.kind !== 'skip-task') {
    if (!args.json) {
      console.log('\n8️⃣  DISPATCH: skipped (pass --dispatch-next to auto-execute)');
    }
  }

  if (args.json) {
    console.log(JSON.stringify(startReport, null, 2));
  } else {
    console.log('\n═══════════════════════════════════════════════════════════════════════');
    console.log('  auto:start complete.');
    console.log('═══════════════════════════════════════════════════════════════════════');
  }

  process.exit(health.overall === 'critical' ? 2 : 0);
}

main().catch((e) => {
  console.error(`[auto:start] fatal: ${(e as Error).message}`);
  process.exit(1);
});
