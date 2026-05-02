/**
 * Operator Escalation (M10 / LRA-6).
 *
 * When the harness gets stuck (3 consecutive NO-GO Codex rounds on the same
 * task, dead-locked task with no progress, budget exhausted >7 days, etc.),
 * escalate cleanly: engage kill switch with [escalation] marker, log to
 * durable escalation log, optionally PushNotification operator, wait for
 * operator to clear.
 *
 * Reuses the kill-switch primitive (same file as M9 cost guardian) but
 * with a different marker prefix so auto:work knows which subsystem
 * engaged it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { TaskPack } from './taskPack';
import { listTasks, readTaskPack } from './runState';

// ─── Schema ─────────────────────────────────────────────────────────────────

export const EscalationReason = z.enum([
  'consecutive-nogo',           // N consecutive NO-GO Codex rounds on same task
  'stuck-heartbeat',            // worker PID alive but no heartbeat for >2h
  'goal-infeasible',            // dep cycle / goal can't be reached
  'budget-stranded',            // budget kill switch >7 days without operator action
  'operator-silent',            // no operator activity for >7 days (defensive throttle)
  'manual',                     // operator-triggered via auto:escalate CLI
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const EscalationEntry = z.object({
  at: z.string(),
  task_id: z.string().optional(),
  reason: EscalationReason,
  detail: z.string(),
  /** Hostname + pid that detected the escalation (for cross-runner provenance). */
  detector: z.object({
    host: z.string().optional(),
    pid: z.number().int().optional(),
  }).default({}),
  /** Operator who cleared it (set when kill switch is removed). */
  cleared_by: z.string().optional(),
  cleared_at: z.string().optional(),
});
export type EscalationEntry = z.infer<typeof EscalationEntry>;

// ─── Persistence ────────────────────────────────────────────────────────────

export function escalationLogPath(harnessRoot: string): string {
  return path.join(harnessRoot, '.agent-runs', '_escalation-log.jsonl');
}

export function appendEscalation(harnessRoot: string, entry: EscalationEntry): void {
  const p = escalationLogPath(harnessRoot);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, JSON.stringify(entry) + '\n');
}

export function readEscalationLog(harnessRoot: string): EscalationEntry[] {
  const p = escalationLogPath(harnessRoot);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const entries: EscalationEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(EscalationEntry.parse(JSON.parse(line)));
    } catch {
      /* skip malformed */
    }
  }
  return entries;
}

// ─── Kill-switch integration ────────────────────────────────────────────────

/**
 * Engage the kill switch with an [escalation] marker, append to escalation
 * log, and optionally notify operator. Idempotent — repeated calls update
 * the log but don't double-engage.
 */
export function engageEscalation(
  harnessRoot: string,
  reason: EscalationReason,
  detail: string,
  taskId?: string
): void {
  const killFile = path.join(harnessRoot, '.agent-runs', '_KILL_SWITCH');
  const at = new Date().toISOString();
  const entry: EscalationEntry = EscalationEntry.parse({
    at,
    task_id: taskId,
    reason,
    detail,
    detector: {
      host: tryGetHostname(),
      pid: process.pid,
    },
  });
  appendEscalation(harnessRoot, entry);
  if (!fs.existsSync(killFile)) {
    fs.writeFileSync(killFile, `[escalation] ${reason}: ${detail.slice(0, 200)} at ${at}\n`);
  }
}

function tryGetHostname(): string | undefined {
  try {
    return os.hostname();
  } catch {
    return undefined;
  }
}

// ─── Detection ──────────────────────────────────────────────────────────────

export interface EscalationDetectionResult {
  triggered: EscalationEntry[];
  /** Per-task counters for diagnosis. */
  per_task_consecutive_nogo: Record<string, number>;
}

/**
 * Scan all task packs for escalation conditions. Pure function — caller is
 * responsible for calling engageEscalation() on each triggered item.
 *
 * Conditions checked:
 *   1. consecutive-nogo: state_history shows >=3 transitions to needs-revision
 *      with consensus failures, since the last successful state advancement.
 *   2. stuck-heartbeat: lock holder host == current host AND lock.last_heartbeat_at
 *      is older than threshold (default 120 minutes). Cross-host stale-heartbeat
 *      detection deferred to Phase 2.
 *
 * Other conditions (goal-infeasible, budget-stranded, operator-silent) are
 * triggered by separate callers (auto:goal eval, auto:tick + budget check,
 * cloud-cron beacon).
 */
export interface DetectionConfig {
  consecutive_nogo_threshold: number;
  stuck_heartbeat_minutes: number;
  runs_dir: string;
}

export const DEFAULT_DETECTION: Omit<DetectionConfig, 'runs_dir'> = {
  consecutive_nogo_threshold: 3,
  stuck_heartbeat_minutes: 120,
};

export function detectEscalations(config: DetectionConfig): EscalationDetectionResult {
  const result: EscalationDetectionResult = {
    triggered: [],
    per_task_consecutive_nogo: {},
  };
  if (!fs.existsSync(config.runs_dir)) return result;

  const currentHost = tryGetHostname();
  const now = new Date();

  for (const runId of fs.readdirSync(config.runs_dir)) {
    const runPath = path.join(config.runs_dir, runId);
    if (!fs.statSync(runPath).isDirectory() || runId.startsWith('_')) continue;
    for (const taskId of listTasks(runId)) {
      let pack: TaskPack;
      try {
        pack = readTaskPack(runId, taskId);
      } catch {
        continue;
      }

      // (1) consecutive-nogo: count transitions ending at needs-revision
      // since the most recent transition that wasn't to needs-revision
      // (i.e., consecutive failures in a row).
      const history = pack.state_history ?? [];
      let consecutive = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].to === 'needs-revision') {
          consecutive++;
        } else {
          break;
        }
      }
      result.per_task_consecutive_nogo[taskId] = consecutive;
      if (consecutive >= config.consecutive_nogo_threshold) {
        result.triggered.push(
          EscalationEntry.parse({
            at: now.toISOString(),
            task_id: taskId,
            reason: 'consecutive-nogo',
            detail: `${consecutive} consecutive NO-GO transitions on ${taskId}; halting auto-dispatch until operator intervenes`,
            detector: { host: currentHost, pid: process.pid },
          })
        );
      }

      // (2) stuck-heartbeat: lock held but heartbeat stale, on this host.
      if (
        pack.lock &&
        pack.lock.host &&
        pack.lock.host === currentHost
      ) {
        const lastHeartbeat = new Date(pack.lock.last_heartbeat_at);
        const ageMinutes = (now.getTime() - lastHeartbeat.getTime()) / 60_000;
        if (ageMinutes > config.stuck_heartbeat_minutes) {
          result.triggered.push(
            EscalationEntry.parse({
              at: now.toISOString(),
              task_id: taskId,
              reason: 'stuck-heartbeat',
              detail:
                `Lock heartbeat stale by ${ageMinutes.toFixed(1)}min on ${taskId} (host=${currentHost}); ` +
                `worker pid ${pack.lock.pid} may be stuck or dead`,
              detector: { host: currentHost, pid: process.pid },
            })
          );
        }
      }
    }
  }

  return result;
}

/**
 * Check if a recently-triggered escalation has already been logged within
 * the last `dedupMinutes` to avoid re-escalating the same condition every
 * tick. Returns true if the entry is a duplicate.
 */
export function isDuplicateEscalation(
  harnessRoot: string,
  candidate: EscalationEntry,
  dedupMinutes = 30
): boolean {
  const log = readEscalationLog(harnessRoot);
  const cutoff = Date.now() - dedupMinutes * 60_000;
  for (const e of log) {
    if (
      e.task_id === candidate.task_id &&
      e.reason === candidate.reason &&
      new Date(e.at).getTime() >= cutoff &&
      !e.cleared_at
    ) {
      return true;
    }
  }
  return false;
}
