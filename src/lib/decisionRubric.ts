/**
 * Decision rubric — autonomous next-action selection.
 *
 * Operator directive (2026-04-28 06:00Z): "do not wait on these decisions.
 * you are meant to be autonomous. build this into the system and have a
 * rubric. you have wasted time on the blocker vs you could have finished
 * the task."
 *
 * This module codifies the autonomous decision logic the harness should
 * apply when a task hits a state-pivot point (NO-GO consensus, max-rounds
 * exhaustion, missing evidence, governance refusal). The auto:daemon and
 * any future autonomous orchestrator must consult this rubric instead of
 * stopping for operator instruction.
 *
 * The rubric is deliberately conservative — it picks the SAFEST forward
 * action that maintains audit trail integrity. It NEVER auto-merges; it
 * NEVER bypasses governance. But it does pick the next dispatch step
 * (worker round N+1, pivot to a different planned task, escalation) so
 * the loop produces continuous progress without blocking on operator
 * input that the rubric can supply.
 */
import type { TaskPack, CodexRoundScore } from './taskPack';

// ─── Plateau detection (v0.4.4) ──────────────────────────────────────────────

/**
 * Window size for plateau detection. We need at least 3 rounds of history to
 * detect a non-improving trend; smaller windows produce too many false
 * positives on early rounds where worker is still ramping up.
 */
const PLATEAU_MIN_ROUNDS = 3;

/**
 * Detect whether the consensus rounds have plateaued — defined as: the
 * GLOBAL best score was achieved ≥ (PLATEAU_MIN_ROUNDS - 1) rounds ago AND
 * is still below threshold. This catches the canonical "best score
 * achieved early, subsequent rounds bounce below it" pattern (TP-101
 * R1=6.4 R2=6.6 R3=6.2 R4=6.6 — best is R2's 6.6, last 2 rounds didn't
 * exceed it).
 *
 * Without this, the rubric mechanically dispatches R5..R10 burning hours
 * of compute on a non-converging task.
 *
 * Exported for testing.
 */
export function detectPlateau(
  history: CodexRoundScore[],
  threshold: number,
): { isPlateau: boolean; reason: string } {
  if (history.length < PLATEAU_MIN_ROUNDS) {
    return { isPlateau: false, reason: `only ${history.length} round(s); need ≥${PLATEAU_MIN_ROUNDS}` };
  }
  const sortedByRound = [...history].sort((a, b) => a.round - b.round);
  const last = sortedByRound[sortedByRound.length - 1];
  if (last.score === undefined) {
    return { isPlateau: false, reason: 'latest score unknown' };
  }
  if (last.score >= threshold) {
    return { isPlateau: false, reason: `latest ${last.score} ≥ threshold ${threshold}` };
  }
  // Find the round where the global best score was first achieved.
  let bestScore = -1;
  let bestRoundIndex = 0;  // 0-indexed in sortedByRound
  for (let i = 0; i < sortedByRound.length; i++) {
    const s = sortedByRound[i].score;
    if (s !== undefined && s > bestScore) {
      bestScore = s;
      bestRoundIndex = i;
    }
  }
  if (bestScore < 0) {
    return { isPlateau: false, reason: 'no scored rounds yet' };
  }
  if (bestScore >= threshold) {
    return { isPlateau: false, reason: `best ${bestScore} ≥ threshold ${threshold}; not really stuck` };
  }
  // Rounds since (and including) best: how stale is our peak?
  const roundsSinceBest = sortedByRound.length - 1 - bestRoundIndex;
  if (roundsSinceBest >= PLATEAU_MIN_ROUNDS - 1) {
    const trail = sortedByRound.map((r) => `R${r.round}=${r.score ?? '?'}`).join(' → ');
    return {
      isPlateau: true,
      reason: `best ${bestScore} (R${sortedByRound[bestRoundIndex].round}) below threshold ${threshold}; ${roundsSinceBest} rounds since with no improvement (${trail})`,
    };
  }
  return { isPlateau: false, reason: `best ${bestScore} achieved ${roundsSinceBest} round(s) ago; not yet stale` };
}

/**
 * Count prior plateau pivots from pack.notes. A pivot is recorded by
 * the dispatch path appending a note with `by: 'plateau-pivot'` and
 * a pivot_round in the text. Returns the highest pivot_round seen
 * (0 if none).
 */
export function countPriorPivots(pack: TaskPack): number {
  if (!pack.notes || pack.notes.length === 0) return 0;
  let maxPivot = 0;
  for (const note of pack.notes) {
    if (note.by !== 'plateau-pivot') continue;
    const m = note.text.match(/pivot[_ -]?round[:\s]+(\d+)/i);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxPivot) maxPivot = n;
    }
  }
  return maxPivot;
}

export type DecisionAction =
  | { kind: 'dispatch-worker-revise'; reason: string; round: number }
  | { kind: 'dispatch-worker-fresh'; reason: string }
  | { kind: 'dispatch-consensus'; reason: string }
  | { kind: 'auto-promote'; reason: string }
  | { kind: 'escalate'; reason: string; severity: 'high' | 'critical' }
  | { kind: 'skip-task'; reason: string }
  | { kind: 'idle'; reason: string }
  // v0.4.17: smart plateau pivots before escalation (operator directive
  // 2026-04-28: "We need have a better path when Plateau is detected
  // and rubric to follow"). Each strategy is a non-escalation forward
  // motion the rubric can recommend BEFORE giving up to a human.
  | {
      kind: 'plateau-pivot';
      reason: string;
      strategy:
        | 'apply-foldin-plan'         // 1st pivot: re-dispatch worker with explicit fold-in directive
        | 'try-different-reviewer'    // 2nd pivot: switch consensus reviewer model (gpt-5.5 → claude-opus, e.g.)
        | 'tighten-scope'             // 3rd pivot: split task into smaller subtasks
        | 'human-escalate';           // last resort: escalate (after all pivots tried)
      pivot_round: number;            // 1, 2, 3, … for forensic traceability
      details: Record<string, unknown>;
    };

export interface RubricDecision {
  task_id: string;
  action: DecisionAction;
  precedence: number;  // higher = more urgent; daemon picks max
}

/**
 * Apply the rubric to a single task pack. Returns the recommended
 * autonomous next-action.
 *
 * Decision tree (top-to-bottom; first match wins):
 *
 * 1. KILL_SWITCH active OR escalation pending → SKIP (don't act).
 * 2. State='promotable' AND codex.verdict='GO' AND score>=threshold →
 *    AUTO-PROMOTE (M2 still operator-deferred, but rubric's recommendation
 *    is "promote"; daemon decides whether to actually invoke or queue).
 * 3. State='needs-revision':
 *    a. rounds_executed < max_rounds → DISPATCH-WORKER-REVISE round N+1
 *       (worker reads codex.verdict_path = r{N}-review.md and addresses
 *       findings)
 *    b. rounds_executed >= max_rounds → ESCALATE (high — manual review
 *       required; auto-revise budget exhausted)
 * 4. State='awaiting-review' AND evidence complete → DISPATCH-CONSENSUS
 *    (let Codex score the impl)
 * 5. State='awaiting-review' AND evidence incomplete → DISPATCH-WORKER-REVISE
 *    (need more evidence files before consensus can run)
 * 6. State='planned' → DISPATCH-WORKER-FRESH round 1
 * 7. State='in-progress' (lock held) → IDLE (worker is already running)
 * 8. State='codex-reviewing' → IDLE (consensus in flight)
 * 9. State='ready-for-merge' → IDLE (operator decision required for actual merge)
 * 10. State='merged' → SKIP (terminal; no further action)
 * 11. State='abandoned' → SKIP (terminal; manual intervention if needed)
 */
export function applyRubric(pack: TaskPack): RubricDecision {
  const taskId = pack.task_id;

  // Rule 10/11: terminal states — skip
  if (pack.state === 'merged' || pack.state === 'abandoned') {
    return {
      task_id: taskId,
      action: { kind: 'skip-task', reason: `terminal state: ${pack.state}` },
      precedence: 0,
    };
  }

  // Rule 7/8/9: in-flight — idle (don't double-dispatch)
  if (pack.state === 'in-progress') {
    return {
      task_id: taskId,
      action: { kind: 'idle', reason: 'worker dispatch in flight (lock held)' },
      precedence: 0,
    };
  }
  if (pack.state === 'codex-reviewing') {
    return {
      task_id: taskId,
      action: { kind: 'idle', reason: 'Codex consensus in flight' },
      precedence: 0,
    };
  }
  if (pack.state === 'ready-for-merge') {
    return {
      task_id: taskId,
      action: { kind: 'idle', reason: 'awaiting operator merge to protected main' },
      precedence: 0,
    };
  }

  // Rule 2: promotable → auto-promote
  if (pack.state === 'promotable') {
    return {
      task_id: taskId,
      action: { kind: 'auto-promote', reason: `Codex verdict=${pack.codex?.verdict} score=${pack.codex?.score}` },
      precedence: 100,
    };
  }

  // Rule 3: needs-revision
  if (pack.state === 'needs-revision') {
    const rounds = pack.codex?.rounds_executed ?? 0;
    const maxRounds = pack.consensus.max_rounds ?? 3;
    const threshold = pack.consensus.gate_threshold ?? 7;

    // v0.4.4 + v0.4.17 PLATEAU DETECTION + STAGED PIVOTS.
    //
    // Operator directives 2026-04-28:
    //   "do not waste time on the blocker"
    //   "We need have a better path when Plateau is detected and rubric to follow"
    //
    // When plateau detected (best score N rounds stale + below threshold):
    //   Pivot 1 → APPLY-FOLDIN-PLAN: re-dispatch worker with explicit
    //     directive to address the latest review's fold-in items
    //   Pivot 2 → TRY-DIFFERENT-REVIEWER: switch consensus model
    //     (e.g., gpt-5.5 → claude-opus) — different model catches
    //     different things
    //   Pivot 3 → TIGHTEN-SCOPE: rubric recommends task decomposition
    //     (operator-driven; rubric flags + sets context for split)
    //   Pivot 4 (terminal) → HUMAN-ESCALATE: stop autonomous attempts,
    //     hand off to operator with consolidated diagnosis
    //
    // Pivots are tracked in pack.notes by 'plateau-pivot:N' tags so
    // re-running rubric increments the pivot counter idempotently.
    const history = pack.codex?.score_history ?? [];
    const plateauResult = detectPlateau(history, threshold);
    if (plateauResult.isPlateau && rounds < maxRounds) {
      const pivotsSoFar = countPriorPivots(pack);
      const pivotRound = pivotsSoFar + 1;
      const latestVerdict = history.length > 0 ? history[history.length - 1] : undefined;
      switch (pivotsSoFar) {
        case 0:
          return {
            task_id: taskId,
            action: {
              kind: 'plateau-pivot',
              reason: `plateau detected (${plateauResult.reason}); pivot 1: extract latest review's fold-in plan + re-dispatch worker with explicit directive`,
              strategy: 'apply-foldin-plan',
              pivot_round: pivotRound,
              details: {
                latest_score: latestVerdict?.score,
                latest_verdict_path: latestVerdict?.verdict_path,
                rounds_available: maxRounds - rounds,
              },
            },
            precedence: 92,  // above normal worker-revise (80) but below auto-promote (100)
          };
        case 1:
          return {
            task_id: taskId,
            action: {
              kind: 'plateau-pivot',
              reason: `plateau persists after fold-in pivot (${plateauResult.reason}); pivot 2: switch reviewer model`,
              strategy: 'try-different-reviewer',
              pivot_round: pivotRound,
              details: {
                current_reviewer: pack.consensus.reviewer,
                suggested_alt: pack.consensus.reviewer.includes('gpt-') ? 'claude-opus-4-7' : 'gpt-5.5-xhigh',
                latest_score: latestVerdict?.score,
              },
            },
            precedence: 93,
          };
        case 2:
          return {
            task_id: taskId,
            action: {
              kind: 'plateau-pivot',
              reason: `plateau persists after 2 pivots (${plateauResult.reason}); pivot 3: tighten scope (operator should split task into smaller subtasks)`,
              strategy: 'tighten-scope',
              pivot_round: pivotRound,
              details: {
                latest_score: latestVerdict?.score,
                acceptance_criteria_count: pack.acceptance_criteria.length,
                allowed_paths_count: pack.allowed_paths.length,
              },
            },
            precedence: 94,
          };
        default:
          // ≥3 pivots tried — true plateau, escalate
          return {
            task_id: taskId,
            action: {
              kind: 'plateau-pivot',
              reason: `plateau persists after ${pivotsSoFar} pivots; human escalation required`,
              strategy: 'human-escalate',
              pivot_round: pivotRound,
              details: {
                pivots_tried: pivotsSoFar,
                latest_score: latestVerdict?.score,
                trail: history.map((h) => `R${h.round}=${h.score ?? '?'}`).join(' → '),
              },
            },
            precedence: 95,
          };
      }
    }

    if (rounds < maxRounds) {
      return {
        task_id: taskId,
        action: {
          kind: 'dispatch-worker-revise',
          reason: `Codex round ${rounds} NO-GO (score=${pack.codex?.score}); auto-revise round ${rounds + 1} of ${maxRounds}`,
          round: rounds + 1,
        },
        precedence: 80,
      };
    }
    return {
      task_id: taskId,
      action: {
        kind: 'escalate',
        reason: `auto-revise budget exhausted (${rounds}/${maxRounds} rounds); manual review required`,
        severity: 'high',
      },
      precedence: 90,
    };
  }

  // Rule 4/5: awaiting-review
  if (pack.state === 'awaiting-review') {
    const hasEvidence = pack.evidence_dir !== undefined;
    if (hasEvidence) {
      return {
        task_id: taskId,
        action: { kind: 'dispatch-consensus', reason: 'evidence complete; ready for Codex score' },
        precedence: 70,
      };
    }
    return {
      task_id: taskId,
      action: { kind: 'dispatch-worker-revise', reason: 'evidence dir missing; re-dispatch worker', round: (pack.codex?.rounds_executed ?? 0) + 1 },
      precedence: 60,
    };
  }

  // Rule 6: planned → dispatch worker round 1
  if (pack.state === 'planned') {
    return {
      task_id: taskId,
      action: { kind: 'dispatch-worker-fresh', reason: 'fresh task; dispatch worker round 1' },
      precedence: 50,
    };
  }

  // Default — claimed/awaiting-human-approval/etc. — be conservative
  return {
    task_id: taskId,
    action: { kind: 'idle', reason: `state '${pack.state}' has no autonomous action; await operator` },
    precedence: 10,
  };
}

/**
 * Apply the rubric to a SET of tasks; return the highest-precedence action.
 * Used by auto:daemon to pick the next thing to do across all in-flight runs.
 */
export function pickNextAction(packs: TaskPack[]): RubricDecision | null {
  if (packs.length === 0) return null;
  const decisions = packs.map(applyRubric);
  decisions.sort((a, b) => b.precedence - a.precedence);
  // Skip 'skip-task' / 'idle' decisions — they're not actionable
  for (const d of decisions) {
    if (d.action.kind !== 'skip-task' && d.action.kind !== 'idle') return d;
  }
  return decisions[0]; // all idle/skip — return the first (caller decides whether to act)
}
