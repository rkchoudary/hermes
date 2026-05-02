#!/usr/bin/env node
/**
 * pnpm auto:diagnose-task <task_id>
 *
 * Failure analysis surface (MI1). When a task is parked or stuck, this
 * generates a one-page report covering:
 *
 *   - Pack metadata (type, module, mode, risk_class, current state)
 *   - Last patch attempt: which round, exit code, stderr tail
 *   - Council sidecar status + score (if any)
 *   - Comparable patterns from skill memory (same phase, similar
 *     module / AC count / patch_rounds)
 *   - Last 30 lines of relevant /tmp/serial-<mod>-* logs
 *   - Suggested next action: one of {continue patching, cognitive
 *     recovery, redefine scope, escalate to operator memo}
 *
 * Output: human-readable text by default; --json for tooling integration.
 *
 * Why: when something's stuck, "what now?" should be one click, not 15
 * minutes of grepping logs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs { taskId?: string; json: boolean; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--json') a.json = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:diagnose-task <task_id> [--json]

Generate a failure-analysis report for a stuck or parked task. Combines
pack state, patch history, council verdict, comparable skill-memory
patterns, and recent logs into one human-readable summary plus a
suggested next action.`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.taskId) a.taskId = x;
  }
  return a;
}

interface Diagnosis {
  task_id: string;
  found: boolean;
  run_id?: string;
  pack_summary?: { type: string; module: string; state: string; risk_class: string; mode: string };
  patch_attempts?: { round: number; outcome: string }[];
  codex_rounds?: { round: number; score: number; verdict: string }[];
  council_status?: string;
  comparable_patterns?: { module: string; patch_rounds: number; recovered_via: string }[];
  log_tails?: { source: string; lines: string[] }[];
  suggestion: string;
  rationale: string[];
}

function findPack(taskId: string): { runId: string; pack: Record<string, unknown>; runDir: string } | null {
  const runsRoot = path.join(harnessRoot(), '.agent-runs');
  if (!fs.existsSync(runsRoot)) return null;
  for (const r of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r)) continue;
    const p = path.join(runsRoot, r, 'tasks', `${taskId}.json`);
    if (fs.existsSync(p)) {
      try {
        return { runId: r, pack: JSON.parse(fs.readFileSync(p, 'utf8')), runDir: path.join(runsRoot, r) };
      } catch { /* skip */ }
    }
  }
  return null;
}

function loadSkillPatterns(phase: string, currentACCount: number): Diagnosis['comparable_patterns'] {
  const skillFile = path.join(harnessRoot(), '.agent-runs', '_skill-memory', `${phase}.jsonl`);
  if (!fs.existsSync(skillFile)) return [];
  const lines = fs.readFileSync(skillFile, 'utf8').split('\n').filter(Boolean);
  const entries: Array<{ module: string; patch_rounds: number; recovered_via: string; ac_count?: number }> = [];
  for (const ln of lines) {
    try { entries.push(JSON.parse(ln)); } catch { /* skip */ }
  }
  // Comparable = top-3 closest by AC count + has been recovered (provides recipe)
  const scored = entries
    .filter(e => e.recovered_via)
    .map(e => ({ ...e, distance: Math.abs((e.ac_count ?? 0) - currentACCount) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3);
  return scored.map(e => ({ module: e.module, patch_rounds: e.patch_rounds, recovered_via: e.recovered_via }));
}

function tailLogs(taskId: string, runId: string, module: string, count: number = 30): Diagnosis['log_tails'] {
  const tails: Diagnosis['log_tails'] = [];
  const tryTail = (label: string, p: string): void => {
    if (!fs.existsSync(p)) return;
    try {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
      tails!.push({ source: label, lines: lines.slice(-count) });
    } catch { /* skip */ }
  };
  // /tmp/harness-runs/serial-<mod>-* logs
  const tmpRoot = '/tmp/harness-runs';
  if (fs.existsSync(tmpRoot)) {
    for (const f of fs.readdirSync(tmpRoot)) {
      if (f.includes(module) || f.includes(taskId)) tryTail(`/tmp/harness-runs/${f}`, path.join(tmpRoot, f));
    }
  }
  // Per-stage logs in /tmp/
  for (const stage of ['validation', 'merge', 'tick', 'stage29', 'postflight']) {
    tryTail(`/tmp/serial-${module}-${stage}.log`, `/tmp/serial-${module}-${stage}.log`);
  }
  return tails;
}

function suggestNext(d: Diagnosis): { suggestion: string; rationale: string[] } {
  const reasons: string[] = [];
  if (!d.found) {
    return { suggestion: 'task not found — verify task_id', rationale: ['no pack file matched in any run'] };
  }
  const state = d.pack_summary?.state || '';
  const lastPatchRound = d.patch_attempts?.length ?? 0;
  const lastVerdict = d.codex_rounds?.[d.codex_rounds.length - 1]?.verdict ?? null;
  const lastScore = d.codex_rounds?.[d.codex_rounds.length - 1]?.score ?? null;
  const councilStatus = d.council_status || 'none';

  if (state === 'merged' || state === 'ready-for-merge' || state === 'promotable') {
    reasons.push(`task is in ${state} — no diagnosis needed`);
    return { suggestion: 'no action — task is past the failure window', rationale: reasons };
  }

  if (state === 'abandoned') {
    return { suggestion: 'task was abandoned by operator; redefine scope or open a new task', rationale: [`pack.state=abandoned`] };
  }

  if (lastPatchRound >= 3) {
    reasons.push(`${lastPatchRound} patch rounds exhausted (max 3 by default)`);
    if (d.comparable_patterns && d.comparable_patterns.some(p => p.recovered_via === 'cognitive-recovery')) {
      reasons.push(`skill memory shows ${d.comparable_patterns.filter(p => p.recovered_via === 'cognitive-recovery').length}/3 comparable tasks recovered via cognitive recovery`);
      return { suggestion: 'dispatch cognitive recovery: pnpm auto:work <task_id> --fix-bugs --force', rationale: reasons };
    }
    reasons.push('no comparable cognitive-recovery success in skill memory; consider operator memo with scope reduction');
    return { suggestion: 'open Stage 25 operator memo to redefine scope OR park manually with documented reason', rationale: reasons };
  }

  if (lastVerdict === 'NO-GO' && lastScore !== null && lastScore < 5) {
    reasons.push(`codex verdict NO-GO with low score (${lastScore}/10) — fundamental issue, not a fix-able patch`);
    return { suggestion: 'redefine scope: the codex review indicates the approach is wrong, not the implementation', rationale: reasons };
  }

  if (lastVerdict === 'NO-GO') {
    reasons.push(`codex verdict NO-GO at ${lastScore}/10 — borderline; one more revision round is reasonable`);
    return { suggestion: 'continue patching: pnpm auto:work <task_id> --force (if not at round 3)', rationale: reasons };
  }

  if (councilStatus === 'failed') {
    reasons.push('council sidecar status=failed; advisory but operator should review');
    return { suggestion: 'review council sidecar findings, then operator memo at Stage 25', rationale: reasons };
  }

  if (state === 'needs-revision') {
    reasons.push('state=needs-revision — codex flagged improvements needed');
    return { suggestion: 'continue: write revised evidence + pnpm auto:work <task_id> --force + pnpm auto:consensus <task_id>', rationale: reasons };
  }

  reasons.push(`state=${state} with no obvious blocker`);
  return { suggestion: 'review pack.notes + recent logs above; if no clear next step, open operator memo at Stage 25', rationale: reasons };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId) {
    console.error('Usage: pnpm auto:diagnose-task <task_id> [--json]');
    process.exit(2);
  }

  const found = findPack(args.taskId);
  const d: Diagnosis = { task_id: args.taskId, found: !!found, suggestion: '', rationale: [] };

  if (found) {
    const pack = found.pack as Record<string, unknown>;
    const codex = pack.codex as { score_history?: Array<{ round: number; score: number; verdict: string }> } | undefined;
    const moduleId = String(pack.module_or_sprint || '').split('-')[0];

    d.run_id = found.runId;
    d.pack_summary = {
      type: String(pack.type || ''),
      module: String(pack.module_or_sprint || ''),
      state: String(pack.state || ''),
      risk_class: String(pack.risk_class || 'medium'),
      mode: String(pack.mode || 'brownfield'),
    };
    d.codex_rounds = codex?.score_history ?? [];
    d.patch_attempts = (d.codex_rounds || []).map((r, i) => ({ round: i + 1, outcome: r.verdict === 'GO' ? 'pass' : 'fail' }));

    // Council sidecar status
    const councilDir = path.join(harnessRoot(), '.agent-runs', '_audit', 'council', moduleId);
    if (fs.existsSync(councilDir)) {
      let aggregate = 'none';
      for (const phase of fs.readdirSync(councilDir)) {
        const phaseDir = path.join(councilDir, phase);
        if (!fs.statSync(phaseDir).isDirectory()) continue;
        for (const verFile of fs.readdirSync(phaseDir)) {
          try {
            const sc = JSON.parse(fs.readFileSync(path.join(phaseDir, verFile), 'utf8'));
            if (sc.status === 'failed') aggregate = 'failed';
            else if (aggregate === 'none' && sc.status === 'passed') aggregate = 'passed';
            else if (aggregate === 'none') aggregate = sc.status;
          } catch { /* skip */ }
        }
      }
      d.council_status = aggregate;
    }

    d.comparable_patterns = loadSkillPatterns(String(pack.type || ''), (pack.acceptance_criteria as Array<unknown> ?? []).length);
    d.log_tails = tailLogs(args.taskId, found.runId, moduleId);
  }

  const { suggestion, rationale } = suggestNext(d);
  d.suggestion = suggestion;
  d.rationale = rationale;

  if (args.json) {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Diagnosis — ${d.task_id}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  if (!d.found) {
    console.log(`✗ Task not found in any run under ${path.join(harnessRoot(), '.agent-runs')}`);
    console.log('');
    console.log(`Suggestion: ${d.suggestion}`);
    return;
  }
  console.log(`Run:         ${d.run_id}`);
  console.log(`Type:        ${d.pack_summary!.type}`);
  console.log(`Module:      ${d.pack_summary!.module}`);
  console.log(`State:       ${d.pack_summary!.state}`);
  console.log(`Risk class:  ${d.pack_summary!.risk_class}`);
  console.log(`Mode:        ${d.pack_summary!.mode}`);
  console.log('');
  if (d.codex_rounds && d.codex_rounds.length > 0) {
    console.log(`Codex rounds (${d.codex_rounds.length}):`);
    for (const r of d.codex_rounds) {
      const icon = r.verdict === 'GO' ? '✓' : '✗';
      console.log(`  R${r.round}  ${icon}  ${r.score}/10  ${r.verdict}`);
    }
    console.log('');
  }
  if (d.council_status && d.council_status !== 'none') {
    const icon = d.council_status === 'passed' ? '✓' : d.council_status === 'failed' ? '✗' : '·';
    console.log(`Council:     ${icon} ${d.council_status}`);
    console.log('');
  }
  if (d.comparable_patterns && d.comparable_patterns.length > 0) {
    console.log('Comparable patterns from skill memory:');
    for (const p of d.comparable_patterns) {
      console.log(`  ${p.module}  ${p.patch_rounds} patches  recovered via: ${p.recovered_via}`);
    }
    console.log('');
  }
  if (d.log_tails && d.log_tails.length > 0) {
    console.log('Recent log tails:');
    for (const t of d.log_tails) {
      console.log(`  ── ${t.source} ────`);
      for (const ln of t.lines.slice(-10)) console.log(`    ${ln}`);
    }
    console.log('');
  }
  console.log('───────────────────────────────────────────────────────────────');
  console.log(`  Suggested next action`);
  console.log('───────────────────────────────────────────────────────────────');
  console.log('');
  console.log(`  ${d.suggestion}`);
  console.log('');
  if (d.rationale.length > 0) {
    console.log('  Rationale:');
    for (const r of d.rationale) console.log(`    • ${r}`);
    console.log('');
  }
}

main();
