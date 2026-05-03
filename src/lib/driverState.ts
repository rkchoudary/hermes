/**
 * Layer 8 — Driver state file for crash-resumable fan-out.
 *
 * Doctrine: driver writes state every 30s. On crash, next invocation
 * either resumes (heartbeat <5min old) or marks orphan modules
 * driver-orphan-recovered.
 *
 * Eliminates the "driver crashed at hour 2 of 6, what did I get"
 * failure mode of the old serial-by-module.sh.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';
import type { SchedulerState } from './fanoutScheduler';

export interface DriverState {
  driver_state_version: 1;
  fanout_id: string;
  pid: number;
  hostname: string;
  started_at: string;
  last_heartbeat_at: string;
  scheduler_state: SchedulerState;
  harness_version?: string;
  /** Operator-supplied label for this fan-out. */
  label?: string;
}

const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function driverStatePath(): string {
  return path.join(harnessRoot(), '.agent-runs', '_driver-state.json');
}

export function readDriverState(): DriverState | null {
  const p = driverStatePath();
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as DriverState;
  } catch {
    return null;
  }
}

export function writeDriverState(state: DriverState): void {
  const p = driverStatePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Atomic via tmp+rename so a crash mid-write doesn't leave a partial.
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

export function clearDriverState(): void {
  const p = driverStatePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

export interface ResumeDecision {
  decision: 'fresh-start' | 'resume' | 'orphaned-recover';
  reason: string;
  prior_state?: DriverState;
  age_minutes?: number;
}

/**
 * Called by `auto:fanout` at startup. Decides whether to:
 *   - 'fresh-start' — no prior state, or prior state is post-completion
 *   - 'resume' — prior state heartbeat <5min old; the driver may pick up
 *   - 'orphaned-recover' — prior state heartbeat >5min old; the driver
 *     was killed mid-flight and modules need to be marked orphan
 */
export function decideResume(): ResumeDecision {
  const prior = readDriverState();
  if (!prior) {
    return { decision: 'fresh-start', reason: 'no driver-state file' };
  }
  const ageMs = Date.now() - new Date(prior.last_heartbeat_at).getTime();
  if (ageMs < HEARTBEAT_STALE_MS) {
    return {
      decision: 'resume',
      reason: `heartbeat ${Math.round(ageMs / 1000)}s old (under 5 min stale window)`,
      prior_state: prior,
      age_minutes: Math.round(ageMs / 60_000),
    };
  }
  return {
    decision: 'orphaned-recover',
    reason: `heartbeat ${Math.round(ageMs / 60_000)}m old (>5 min stale window) — driver was killed mid-flight`,
    prior_state: prior,
    age_minutes: Math.round(ageMs / 60_000),
  };
}

/**
 * Heartbeat helper — caller runs this every 30s while the driver is
 * active. Updates last_heartbeat_at without touching scheduler_state.
 */
export function heartbeat(state: DriverState): DriverState {
  const next = { ...state, last_heartbeat_at: new Date().toISOString() };
  writeDriverState(next);
  return next;
}
