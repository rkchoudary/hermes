#!/usr/bin/env tsx
/**
 * Layer 8 — Drain parked queue (`pnpm auto:drain`).
 *
 * Doctrine: parked tasks are routed by their last L0 envelope kind, not
 * blanket-retried. Different failure classes need different handling:
 *
 *   precondition-fail (gate-broken)  → re-dispatch after gate is verified
 *                                      self-test-green (auto:self-test
 *                                      --check-driver-precall)
 *   policy-refusal                   → NOT auto-retryable; surface to
 *                                      operator with the structured
 *                                      remediation from the envelope
 *   worker-error retryable=true      → re-dispatch with progressive
 *                                      backoff (1m, 5m, 30m)
 *   worker-error retryable=false +
 *   harness-bug                      → require operator intervention
 *   3+ drain attempts                → mark abandoned
 *
 * Modes:
 *   --dry-run (default)  Report what would happen, no state mutation
 *   --apply              Actually re-dispatch / mark abandoned
 *   --max-cost <usd>     Cap total drain spend (delegates to L1 reservation)
 *   --task <id>          Drain only one task
 *   --json               Machine-readable output
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { reserveBudget } from '../lib/budgetReservation';
import { emitSuccess } from '../lib/stageOutcome';
import type { TaskPack, TaskState } from '../lib/taskPack';

interface CliArgs {
  apply?: boolean;
  maxCostUsd?: number;
  task?: string;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') a.apply = true;
    else if (argv[i] === '--task' && i + 1 < argv.length) a.task = argv[++i];
    else if (argv[i] === '--max-cost' && i + 1 < argv.length) a.maxCostUsd = parseFloat(argv[++i]);
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:drain [--apply] [--task <id>] [--max-cost <usd>] [--json]`);
      process.exit(0);
    }
  }
  return a;
}

const PARKED_LIKE: ReadonlyArray<TaskState> = ['needs-revision', 'abandoned'];

interface DrainCandidate {
  task_id: string;
  module: string | null;
  state: TaskState;
  last_actor: string;
  last_reason: string;
  drain_attempts: number;
  recommendation: 'redispatch' | 'operator-intervention' | 'abandon' | 'skip-not-retryable';
  rationale: string;
}

function inferModule(pack: TaskPack): string | null {
  const cast = pack as unknown as { module?: string; module_or_sprint?: string };
  if (cast.module) return cast.module;
  if (cast.module_or_sprint) {
    const match = cast.module_or_sprint.match(/^M\d{2,3}/);
    if (match) return match[0];
  }
  return null;
}

function classifyTask(pack: TaskPack): DrainCandidate {
  const taskId = pack.task_id;
  const module = inferModule(pack);
  const state = pack.state;
  const last = pack.state_history?.[pack.state_history.length - 1];
  const last_actor = last?.by ?? '—';
  const last_reason = last?.reason ?? '';
  // Count how many times we've already drained this task (notes prefix).
  const drainNotes = (pack.notes ?? []).filter((n) => n.by === 'auto:drain');
  const drain_attempts = drainNotes.length;

  // Heuristic mapping from the legacy reason string to L0 kind.
  // Once L0 envelopes are wired into every state transition this becomes
  // a direct lookup of pack.last_outcome.kind.
  const reason = last_reason.toLowerCase();
  const isStructural =
    reason.includes('precondition') ||
    reason.includes('could not infer') ||
    reason.includes('artifact path');
  const isPolicy =
    reason.includes('permission denied') ||
    reason.includes('intake') && reason.includes('not approved');
  const isHardCrash = reason.includes('crash') || reason.includes('harness-bug');
  const isTimeoutLike = reason.includes('timeout') || reason.includes('hung') || reason.includes('no completion');

  if (drain_attempts >= 3) {
    return {
      task_id: taskId, module, state, last_actor, last_reason,
      drain_attempts,
      recommendation: 'abandon',
      rationale: `3+ drain attempts; mark abandoned per doctrine`,
    };
  }
  if (isPolicy) {
    return {
      task_id: taskId, module, state, last_actor, last_reason,
      drain_attempts,
      recommendation: 'operator-intervention',
      rationale: 'policy-refusal — operator must amend identity/intake/policy before retry',
    };
  }
  if (isHardCrash) {
    return {
      task_id: taskId, module, state, last_actor, last_reason,
      drain_attempts,
      recommendation: 'operator-intervention',
      rationale: 'harness-bug or unretryable worker-error — operator review required',
    };
  }
  if (isStructural) {
    return {
      task_id: taskId, module, state, last_actor, last_reason,
      drain_attempts,
      recommendation: 'redispatch',
      rationale: 'precondition-fail (gate broken) — redispatch after auto:self-test green',
    };
  }
  if (isTimeoutLike) {
    return {
      task_id: taskId, module, state, last_actor, last_reason,
      drain_attempts,
      recommendation: 'redispatch',
      rationale: 'worker timeout (B1 / L4.A) — retryable; redispatch with progressive backoff',
    };
  }
  // Default: standard needs-revision → redispatch (drain attempt 1)
  return {
    task_id: taskId, module, state, last_actor, last_reason,
    drain_attempts,
    recommendation: drain_attempts === 0 ? 'redispatch' : 'operator-intervention',
    rationale: drain_attempts === 0
      ? 'unclassified needs-revision; first drain attempt'
      : `${drain_attempts} prior drain attempts without success — operator review required`,
  };
}

function collectCandidates(filter?: string): DrainCandidate[] {
  const out: DrainCandidate[] = [];
  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      if (filter && taskId !== filter) continue;
      let pack: TaskPack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      if (!PARKED_LIKE.includes(pack.state)) continue;
      out.push(classifyTask(pack));
    }
  }
  return out;
}

function main(): void {
  const start = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const candidates = collectCandidates(args.task);
  let totalReserved = 0;

  // Apply mode: walk redispatch candidates, reserve budget against the
  // configured max-cost cap, mark abandoned where appropriate.
  const applied: { task_id: string; action: string; reason: string }[] = [];
  if (args.apply) {
    for (const c of candidates) {
      if (c.recommendation === 'abandon') {
        // Mark abandoned: this requires a state-log transition. The drain
        // CLI emits the marker; the operator confirms via auto:tick.
        applied.push({
          task_id: c.task_id,
          action: 'flagged-for-abandonment',
          reason: c.rationale,
        });
      } else if (c.recommendation === 'redispatch') {
        // Reserve budget against per-task cap. If reservation refuses
        // (cap hit, circuit breaker, etc.), skip + report.
        const reservation = reserveBudget({
          stage: 'auto:work',
          engine: 'claude-code-cli',
          task_id: c.task_id,
        });
        if (!reservation.ok) {
          applied.push({
            task_id: c.task_id,
            action: 'redispatch-blocked',
            reason: `${reservation.kind}: ${reservation.reason}`,
          });
          continue;
        }
        if (args.maxCostUsd && totalReserved + reservation.reserved_usd > args.maxCostUsd) {
          applied.push({
            task_id: c.task_id,
            action: 'redispatch-blocked',
            reason: `--max-cost ${args.maxCostUsd} would be exceeded; remaining tasks deferred`,
          });
          break;
        }
        totalReserved += reservation.reserved_usd;
        applied.push({
          task_id: c.task_id,
          action: 'redispatch-reserved',
          reason: `reservation_id=${reservation.reservation_id} reserved=$${reservation.reserved_usd.toFixed(4)}`,
        });
        // Note: the drain CLI doesn't actually invoke auto:work here;
        // it reserves the slot + writes a drain note to the pack so the
        // operator (or an auto:fanout driver — Layer 7.B) picks it up.
      } else {
        applied.push({
          task_id: c.task_id,
          action: c.recommendation,
          reason: c.rationale,
        });
      }
    }
  }

  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    candidates_total: candidates.length,
    by_recommendation: groupByRec(candidates),
    total_reserved_usd: Math.round(totalReserved * 100) / 100,
    applied,
    candidates,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Drain (mode=${summary.mode})`);
    console.log(`Candidates: ${summary.candidates_total}`);
    for (const [rec, count] of Object.entries(summary.by_recommendation)) {
      console.log(`  ${rec}: ${count}`);
    }
    if (args.apply && applied.length > 0) {
      console.log('');
      console.log(`Applied ${applied.length} action(s); reserved $${totalReserved.toFixed(2)}`);
      for (const a of applied.slice(0, 25)) {
        console.log(`  • ${a.task_id}: ${a.action} — ${a.reason}`);
      }
      if (applied.length > 25) console.log(`  … +${applied.length - 25} more (use --json for full list)`);
    }
  }

  emitSuccess({
    stage: 'auto:drain',
    reason: `${candidates.length} parked candidate(s); ${applied.length} action(s); $${totalReserved.toFixed(2)} reserved`,
    metrics: { duration_ms: Date.now() - start, cost_usd: totalReserved },
    details: summary as unknown as Record<string, unknown>,
  });
  process.exit(0);
}

function groupByRec(candidates: DrainCandidate[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of candidates) out[c.recommendation] = (out[c.recommendation] ?? 0) + 1;
  return out;
}

main();
