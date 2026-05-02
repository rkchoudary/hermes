#!/usr/bin/env node
/**
 * pnpm auto:replay TP-… [--json]
 *
 * Promotion-decision explainer (Codex tier-plan first-sprint scope item:
 * "Add auto:replay TP-X or minimal promotion-decision explainer").
 *
 * Reconstructs the COMPLETE story of a task pack: every state transition,
 * every codex round, every override, every reviewer finding, every cost
 * record. For an operator asking "why did this task land in state X?",
 * this is the single command that answers it.
 *
 * Sources read (all already produced by the existing harness):
 *   - .agent-runs/<run>/tasks/<TP>.json                   (current state)
 *   - .agent-runs/<run>/state-log.jsonl                   (transition history)
 *   - .agent-runs/<run>/_codex/<TP>/r*-review.md          (codex verdicts)
 *   - .agent-runs/<run>/evidence/<TP>/ux/*                (Pillar 4+5 evidence)
 *   - .agent-runs/<run>/evidence/<TP>/                    (worker evidence)
 *   - .agent-runs/_override-audit.jsonl                   (every --force / SoD bypass / cleanup)
 *   - .agent-runs/_escalation-log.jsonl                   (human-escalations)
 *
 * Output: a single human-readable timeline + a structured JSON when --json.
 *
 * Per Codex (bgxrqvh58): "Treat promotion as a reproducible decision over
 * immutable evidence records." This command IS the reproduction.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();

interface Args {
  taskId: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  let taskId = '';
  let json = false;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (!a.startsWith('--') && !taskId) taskId = a;
  }
  if (!taskId) {
    console.error('usage: pnpm auto:replay <TP-…> [--json]');
    process.exit(64);
  }
  return { taskId, json };
}

function findRun(taskId: string): string | null {
  for (const runId of listRuns()) {
    if (listTasks(runId).includes(taskId)) return runId;
  }
  return null;
}

interface TimelineEvent {
  at: string;
  kind: 'state-transition' | 'codex-round' | 'override' | 'escalation' | 'cost' | 'pivot';
  detail: Record<string, unknown>;
}

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((x): x is Record<string, unknown> => x !== null);
}

function buildTimeline(taskId: string, runId: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1. State transitions
  const stateLogPath = path.join(HARNESS_ROOT, '.agent-runs', runId, 'state-log.jsonl');
  for (const e of readJsonl(stateLogPath)) {
    if (e.task_id === taskId) {
      events.push({
        at: String(e.at),
        kind: 'state-transition',
        detail: { from: e.from, to: e.to, by: e.by, reason: e.reason },
      });
    }
  }

  // 2. Codex review markdowns (one per round)
  const codexDir = path.join(HARNESS_ROOT, '.agent-runs', runId, '_codex', taskId);
  if (fs.existsSync(codexDir)) {
    const files = fs.readdirSync(codexDir).filter((f) => /^r\d+-review\.md$/.test(f)).sort();
    for (const f of files) {
      const round = parseInt(f.match(/^r(\d+)/)![1], 10);
      const content = fs.readFileSync(path.join(codexDir, f), 'utf8');
      const scoreMatch = content.match(/Score:\s*(\d+\.?\d*)\s*\/\s*10/);
      const verdictMatch = content.match(/Verdict:\s*(\w+(?:-\w+)?)/);
      const stat = fs.statSync(path.join(codexDir, f));
      events.push({
        at: stat.mtime.toISOString(),
        kind: 'codex-round',
        detail: {
          round,
          score: scoreMatch ? parseFloat(scoreMatch[1]) : null,
          verdict: verdictMatch ? verdictMatch[1] : null,
          path: path.join(codexDir, f),
          findings_first_500_chars: content.slice(0, 500),
        },
      });
    }
  }

  // 3. Override audit entries scoped to this task
  const overridePath = path.join(HARNESS_ROOT, '.agent-runs', '_override-audit.jsonl');
  for (const e of readJsonl(overridePath)) {
    if (e.task_id === taskId || (e.context && (e.context as Record<string, unknown>).task_id === taskId)) {
      events.push({
        at: String(e.at),
        kind: 'override',
        detail: { kind: e.kind, actor: e.actor, reason: e.reason, context: e.context },
      });
    }
  }

  // 4. Escalation entries
  const escalPath = path.join(HARNESS_ROOT, '.agent-runs', '_escalation-log.jsonl');
  for (const e of readJsonl(escalPath)) {
    if (e.task_id === taskId) {
      events.push({
        at: String(e.at),
        kind: 'escalation',
        detail: { reason: e.reason, detail: e.detail, cleared_by: e.cleared_by },
      });
    }
  }

  // 5. Cost telemetry from the task pack itself
  try {
    const pack = readTaskPack(runId, taskId);
    for (const c of pack.cost_telemetry) {
      events.push({
        at: c.at,
        kind: 'cost',
        detail: {
          round: c.round,
          engine: c.engine,
          duration_ms: c.duration_ms,
          exit_code: c.exit_code,
          model_id: c.model_id,
          output_bytes: c.output_bytes,
        },
      });
    }
    // 6. Plateau pivots (recorded in pack.notes)
    for (const note of pack.notes) {
      if (note.text && note.text.toLowerCase().includes('plateau-pivot')) {
        events.push({
          at: note.at,
          kind: 'pivot',
          detail: { by: note.by, text: note.text },
        });
      }
    }
  } catch { /* malformed pack; rely on other sources */ }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

interface PromotionPredicate {
  name: string;
  passed: boolean;
  reason: string;
}

function evaluatePromotionPredicates(taskId: string, runId: string): PromotionPredicate[] {
  const predicates: PromotionPredicate[] = [];
  let pack: ReturnType<typeof readTaskPack>;
  try { pack = readTaskPack(runId, taskId); } catch (e) {
    return [{ name: 'task-pack-readable', passed: false, reason: `Cannot read pack: ${(e as Error).message}` }];
  }
  predicates.push({ name: 'task-pack-readable', passed: true, reason: 'pack parsed ok' });
  predicates.push({
    name: 'state-promotable-or-beyond',
    passed: ['promotable', 'ready-for-merge', 'merged'].includes(pack.state),
    reason: `current state: ${pack.state}`,
  });
  predicates.push({
    name: 'codex-go-recorded',
    passed: pack.codex?.verdict === 'GO' || pack.codex?.verdict === 'SIGNOFF-READY',
    reason: pack.codex ? `codex.verdict=${pack.codex.verdict} score=${pack.codex.score}` : 'no codex result yet',
  });
  predicates.push({
    name: 'score-meets-threshold',
    passed: (pack.codex?.score ?? 0) >= pack.consensus.gate_threshold,
    reason: `codex.score=${pack.codex?.score ?? 'n/a'} threshold=${pack.consensus.gate_threshold}`,
  });
  // depends_on satisfied
  const depsBlocking: string[] = [];
  for (const dep of pack.depends_on) {
    try {
      const depPack = readTaskPack(runId, dep);
      if (!['merged', 'ready-for-merge'].includes(depPack.state)) {
        depsBlocking.push(`${dep} state=${depPack.state}`);
      }
    } catch {
      depsBlocking.push(`${dep} not-found`);
    }
  }
  predicates.push({
    name: 'depends-on-satisfied',
    passed: depsBlocking.length === 0,
    reason: depsBlocking.length === 0 ? `${pack.depends_on.length} deps; all merged/ready` : `blocked by: ${depsBlocking.join(', ')}`,
  });

  // auto_promote eligibility (Pillar 5 v0.5.0)
  if (pack.auto_promote_policy.enabled) {
    predicates.push({
      name: 'auto-promote-policy-enabled',
      passed: true,
      reason: `pack.auto_promote_policy.enabled=true; allowed_types=[${pack.auto_promote_policy.allowed_task_types.join(', ')}], min_score=${pack.auto_promote_policy.min_score}`,
    });
    predicates.push({
      name: 'task-type-in-auto-promote-allowlist',
      passed: pack.auto_promote_policy.allowed_task_types.includes(pack.type as never),
      reason: `pack.type=${pack.type}`,
    });
  } else {
    predicates.push({
      name: 'auto-promote-policy-enabled',
      passed: false,
      reason: 'auto_promote_policy.enabled=false (operator-gated promote)',
    });
  }

  // ux_validation (if enabled, must have passed)
  if (pack.ux_validation.enabled) {
    const uxVerdictPath = path.join(HARNESS_ROOT, '.agent-runs', runId, 'evidence', taskId, 'ux', 'ux-verdict.json');
    if (fs.existsSync(uxVerdictPath)) {
      try {
        const v = JSON.parse(fs.readFileSync(uxVerdictPath, 'utf8'));
        predicates.push({
          name: 'ux-validation-passed',
          passed: v.passed === true,
          reason: `ux-verdict: ${v.summary ?? 'present'}`,
        });
      } catch {
        predicates.push({ name: 'ux-validation-passed', passed: false, reason: 'ux-verdict.json corrupt' });
      }
    } else {
      predicates.push({
        name: 'ux-validation-passed',
        passed: false,
        reason: 'ux_validation.enabled=true but no ux-verdict.json — run auto:ux-validate',
      });
    }
  }

  // a11y-auditor (if listed in specialized_reviewers)
  if (pack.consensus.specialized_reviewers.includes('a11y-auditor')) {
    const reviewerJsonPath = path.join(HARNESS_ROOT, '.agent-runs', runId, 'evidence', taskId, 'ux', 'reviewer-a11y-auditor.json');
    if (fs.existsSync(reviewerJsonPath)) {
      try {
        const r = JSON.parse(fs.readFileSync(reviewerJsonPath, 'utf8'));
        predicates.push({
          name: 'a11y-auditor-non-blocking',
          passed: r.reviewer_blocks !== true,
          reason: `${r.findings?.length ?? 0} findings; reviewer_blocks=${r.reviewer_blocks}`,
        });
      } catch {
        predicates.push({ name: 'a11y-auditor-non-blocking', passed: false, reason: 'reviewer JSON corrupt' });
      }
    } else {
      predicates.push({
        name: 'a11y-auditor-non-blocking',
        passed: false,
        reason: 'specialized_reviewers includes a11y-auditor but no reviewer JSON — run reviewer',
      });
    }
  }

  return predicates;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRun(args.taskId);
  if (!runId) {
    console.error(`task ${args.taskId} not found in any run`);
    process.exit(2);
  }

  const events = buildTimeline(args.taskId, runId);
  const predicates = evaluatePromotionPredicates(args.taskId, runId);
  const pack = readTaskPack(runId, args.taskId);

  if (args.json) {
    console.log(JSON.stringify({
      task_id: args.taskId,
      run_id: runId,
      current_state: pack.state,
      timeline: events,
      promotion_predicates: predicates,
      summary: {
        state_transitions: events.filter((e) => e.kind === 'state-transition').length,
        codex_rounds: events.filter((e) => e.kind === 'codex-round').length,
        overrides: events.filter((e) => e.kind === 'override').length,
        escalations: events.filter((e) => e.kind === 'escalation').length,
        plateau_pivots: events.filter((e) => e.kind === 'pivot').length,
      },
    }, null, 2));
    return;
  }

  // Human-readable
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:replay  ${args.taskId}  (run: ${runId})`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Current state:    ${pack.state}`);
  console.log(`Module/sprint:    ${pack.module_or_sprint}  (${pack.type})`);
  console.log(`Codex score:      ${pack.codex?.score ?? '—'}  verdict: ${pack.codex?.verdict ?? '—'}`);
  console.log(`Rounds executed:  ${pack.codex?.rounds_executed ?? 0}  (max: ${pack.consensus.max_rounds})`);
  console.log('');

  console.log('Timeline');
  console.log('────────');
  for (const e of events) {
    const ts = e.at.length >= 19 ? e.at.slice(0, 19) + 'Z' : e.at;
    let line = '';
    switch (e.kind) {
      case 'state-transition':
        line = `${ts}  ⇨  STATE  ${e.detail.from} → ${e.detail.to}  by ${e.detail.by}` + (e.detail.reason ? `  — ${String(e.detail.reason).slice(0, 80)}` : '');
        break;
      case 'codex-round':
        line = `${ts}  📋 CODEX  round ${e.detail.round}  score ${e.detail.score ?? '?'} ${e.detail.verdict ?? ''}`;
        break;
      case 'override':
        line = `${ts}  ⚠️  OVERRIDE  kind=${e.detail.kind}  reason=${String(e.detail.reason).slice(0, 80)}`;
        break;
      case 'escalation':
        line = `${ts}  🚨 ESCALATE  reason=${String(e.detail.reason).slice(0, 80)}` + (e.detail.cleared_by ? `  (cleared by ${e.detail.cleared_by})` : '');
        break;
      case 'cost':
        line = `${ts}  💵 COST  round ${e.detail.round}  engine=${e.detail.engine}  ${((e.detail.duration_ms as number) / 1000).toFixed(1)}s  exit=${e.detail.exit_code}`;
        break;
      case 'pivot':
        line = `${ts}  🔀 PIVOT  ${String(e.detail.text).slice(0, 100)}`;
        break;
    }
    console.log('  ' + line);
  }
  if (events.length === 0) console.log('  (no recorded events for this task)');

  console.log('');
  console.log('Promotion predicates');
  console.log('────────────────────');
  for (const p of predicates) {
    const icon = p.passed ? '✓' : '✗';
    console.log(`  ${icon} ${p.name.padEnd(38)} ${p.reason}`);
  }
  const allPassed = predicates.every((p) => p.passed);
  console.log('');
  console.log(`Verdict: ${allPassed ? '✓ ALL PREDICATES PASSED — task is promote-eligible' : '✗ FAILING PREDICATES — task NOT promote-eligible'}`);
}

main();
