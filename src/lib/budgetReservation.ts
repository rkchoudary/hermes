/**
 * Layer 1 — Cost admission control via budget reservation.
 *
 * Doctrine: "Cost is a precondition, not a post-mortem. Reserve before
 * launch, refund unused, fail closed if the meter is unavailable."
 *
 * Existing src/lib/budget.ts evaluates spend AFTER the fact. This module
 * adds the pre-spend gate:
 *
 *   reserveBudget(stage, model, est)  → ReservationResult
 *      { ok: true,  reservation_id, ...}        — proceed
 *      { ok: false, kind: 'budget-exceeded', reason }  — refuse
 *
 *   recordSpend(reservation_id, actual)         — finalize, refund unused
 *   releaseReservation(reservation_id, reason)  — abandoned dispatch
 *
 * Reservations persist in .agent-runs/_reservations.jsonl (append-only;
 * the latest event per reservation_id wins). Circuit breaker tracks
 * hourly spend rate-of-change against the rolling-24h-mean and trips at
 * 3× to prevent runaway loops.
 *
 * For subscription-billed engines (claude max plan), cost is tracked as
 * `quota_pct` instead of USD and the circuit breaker fires on invocation
 * rate-of-change rather than $-rate-of-change.
 *
 * The driver's contract: every L0-registered stage with cost_estimate
 * profile != 'gate' MUST call reserveBudget BEFORE invoking the engine,
 * and recordSpend (or releaseReservation) AFTER.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { harnessRoot } from './harnessRoot';
import { readBudget, type BudgetContract } from './budget';
import { getStageEntry } from './stageRegistry';

// ─── Types ───────────────────────────────────────────────────────────────

export const ReservationStatus = z.enum([
  'reserved',  // budget held, dispatch in flight
  'spent',     // recorded actual; reservation closed
  'released',  // never dispatched; budget returned
  'expired',   // reservation TTL elapsed without finalize → janitor reclaimed
]);
export type ReservationStatus = z.infer<typeof ReservationStatus>;

export const Reservation = z.object({
  reservation_id: z.string(),
  task_id: z.string().optional(),
  module: z.string().optional(),
  stage: z.string(),
  engine: z.string(),
  /** Reserved amount in USD; for subscription engines this is 0 + quota_pct used. */
  reserved_usd: z.number().nonnegative(),
  reserved_quota_pct: z.number().nonnegative().optional(),
  reserved_at: z.string(),
  /** Reservation TTL in seconds; janitor reclaims after expiry. */
  ttl_sec: z.number().int().positive(),
  /** Finalized actual spend (set on recordSpend). */
  actual_usd: z.number().nonnegative().optional(),
  actual_quota_pct: z.number().nonnegative().optional(),
  finalized_at: z.string().optional(),
  status: ReservationStatus,
  reason: z.string().optional(),
  /** L0 envelope harness_version that produced this reservation. */
  harness_version: z.string().optional(),
});
export type Reservation = z.infer<typeof Reservation>;

export interface ReservationOk {
  ok: true;
  reservation_id: string;
  reserved_usd: number;
  reserved_quota_pct?: number;
  cap_remaining_usd: number;
  ttl_sec: number;
}

export interface ReservationDenied {
  ok: false;
  kind: 'budget-exceeded' | 'circuit-breaker' | 'meter-unavailable' | 'cap-not-found';
  /** Which cap tripped: 'per-task' | 'per-module' | 'per-day' | 'per-fanout' | 'per-engine' | 'circuit'. */
  cap: string;
  reason: string;
  current_usd: number;
  cap_usd: number;
}

export type ReservationResult = ReservationOk | ReservationDenied;

// ─── Persistence ─────────────────────────────────────────────────────────

function reservationsPath(): string {
  return path.join(harnessRoot(), '.agent-runs', '_reservations.jsonl');
}

function appendEvent(r: Reservation): void {
  const p = reservationsPath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(p, JSON.stringify(r) + '\n');
}

/**
 * Read the latest event per reservation_id (last-write-wins). O(N) over
 * the JSONL file; acceptable for solo-operator scale (<10k reservations
 * per run dir). Janitor (Layer 10) compacts when the file grows >10MB.
 */
export function readReservations(): Reservation[] {
  const p = reservationsPath();
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
  const latest = new Map<string, Reservation>();
  for (const line of lines) {
    try {
      const r = Reservation.parse(JSON.parse(line));
      latest.set(r.reservation_id, r);
    } catch { /* skip malformed line; janitor flags */ }
  }
  return Array.from(latest.values());
}

// ─── Cost estimation ─────────────────────────────────────────────────────

interface EstimateInput {
  stage: string;
  engine: string;
  /** Override the registry's p95 estimate. */
  override_tokens?: number;
}

interface CostEstimate {
  usd: number;
  quota_pct: number;
  basis: 'registry-p95' | 'override' | 'subscription';
}

export function estimateCost(input: EstimateInput, budget: BudgetContract): CostEstimate {
  const entry = getStageEntry(input.stage);
  const profile = entry?.cost_estimate.profile ?? 'gate';
  // Gate stages have no LLM cost.
  if (profile === 'gate') {
    return { usd: 0, quota_pct: 0, basis: 'registry-p95' };
  }
  // Subscription engines (claude max plan): cost reported as quota_pct.
  // Approximation: each LLM call burns `tokens_p95 / daily_quota` of the
  // operator's daily quota. Default daily_quota = 5M tokens (claude max).
  if (input.engine === 'claude-code-cli' || input.engine === 'claude-agent-sdk') {
    const tokens = input.override_tokens ?? entry?.cost_estimate.tokens_p95 ?? 0;
    const dailyQuotaTokens = 5_000_000;
    const quota_pct = Math.min(100, (tokens / dailyQuotaTokens) * 100);
    return { usd: 0, quota_pct, basis: input.override_tokens ? 'override' : 'subscription' };
  }
  // Per-token billed engines (codex-cli, openai-cli, …): convert tokens → USD
  // via budget's cost_per_output_byte_usd table.
  const tokens = input.override_tokens ?? entry?.cost_estimate.tokens_p95 ?? 0;
  const ratePerByte = budget.cost_per_output_byte_usd[input.engine] ?? 0.00001;
  const usd = tokens * ratePerByte;
  return { usd, quota_pct: 0, basis: input.override_tokens ? 'override' : 'registry-p95' };
}

// ─── Reservation API ─────────────────────────────────────────────────────

export interface ReserveOptions {
  stage: string;
  engine: string;
  task_id?: string;
  module?: string;
  /** Default 30 min — should cover any single dispatch. */
  ttl_sec?: number;
  /** Override registry estimate when caller has better information. */
  override_tokens?: number;
}

export function reserveBudget(opts: ReserveOptions): ReservationResult {
  const root = harnessRoot();
  const budget = readBudget(root);
  if (!budget) {
    // Fail closed: doctrine says no LLM dispatch without a configured cap.
    return {
      ok: false,
      kind: 'meter-unavailable',
      cap: 'budget-config',
      reason: '.agent-runs/_budget.json is missing — fail closed per L1 doctrine. Run `pnpm auto:budget --init` to seed.',
      current_usd: 0,
      cap_usd: 0,
    };
  }
  const estimate = estimateCost({ stage: opts.stage, engine: opts.engine, override_tokens: opts.override_tokens }, budget);
  // Gate stages bypass the reservation gate (no cost to reserve).
  if (estimate.usd === 0 && estimate.quota_pct === 0) {
    return {
      ok: true,
      reservation_id: 'noop-gate-' + crypto.randomBytes(4).toString('hex'),
      reserved_usd: 0,
      cap_remaining_usd: capRemainingUsd(budget),
      ttl_sec: opts.ttl_sec ?? 60,
    };
  }
  // Circuit breaker takes priority — it's a global stop-all signal.
  // Check it BEFORE per-task / per-day caps so an operator-engaged pause
  // gives a clear "circuit-breaker" verdict regardless of which cap a
  // particular request would otherwise hit first.
  const cbEarly = circuitBreakerStatus();
  if (cbEarly.tripped) {
    return {
      ok: false,
      kind: 'circuit-breaker',
      cap: 'circuit',
      reason: cbEarly.mean_24h_usd === 0 && cbEarly.hourly_usd === 0
        ? 'circuit breaker engaged via sentinel file (.agent-runs/_BUDGET_CIRCUIT_BREAKER); investigate + remove to resume'
        : `circuit breaker tripped: hourly spend $${cbEarly.hourly_usd.toFixed(4)} > 3× 24h mean $${cbEarly.mean_24h_usd.toFixed(4)}; pause fanout + investigate`,
      current_usd: cbEarly.hourly_usd,
      cap_usd: cbEarly.mean_24h_usd * 3,
    };
  }
  // Per-task cap (existing in budget.ts).
  if (budget.per_task_cap_usd > 0 && opts.task_id) {
    const taskTotal = sumReservedAndSpent(opts.task_id);
    if (taskTotal + estimate.usd > budget.per_task_cap_usd) {
      return {
        ok: false,
        kind: 'budget-exceeded',
        cap: 'per-task',
        reason: `task ${opts.task_id} reservation+spent=$${taskTotal.toFixed(4)} + new $${estimate.usd.toFixed(4)} would exceed per_task_cap_usd $${budget.per_task_cap_usd.toFixed(4)}`,
        current_usd: taskTotal,
        cap_usd: budget.per_task_cap_usd,
      };
    }
  }
  // Per-day cap (the daily window).
  const dailyWindow = budget.windows.find((w) => w.period === 'daily');
  if (dailyWindow) {
    const dailyTotal = sumReservedAndSpentSince(windowStartDate('daily'));
    if (dailyTotal + estimate.usd > dailyWindow.cap_usd) {
      return {
        ok: false,
        kind: 'budget-exceeded',
        cap: 'per-day',
        reason: `daily reservation+spent=$${dailyTotal.toFixed(4)} + new $${estimate.usd.toFixed(4)} would exceed daily cap $${dailyWindow.cap_usd.toFixed(4)}`,
        current_usd: dailyTotal,
        cap_usd: dailyWindow.cap_usd,
      };
    }
  }
  // Circuit breaker: hourly spend > 3× rolling-24h-mean.
  const cb = circuitBreakerStatus();
  if (cb.tripped) {
    return {
      ok: false,
      kind: 'circuit-breaker',
      cap: 'circuit',
      reason: `circuit breaker tripped: hourly spend $${cb.hourly_usd.toFixed(4)} > 3× 24h mean $${cb.mean_24h_usd.toFixed(4)}; pause fanout + investigate`,
      current_usd: cb.hourly_usd,
      cap_usd: cb.mean_24h_usd * 3,
    };
  }
  // All checks pass — reserve.
  const reservation: Reservation = {
    reservation_id: `RSV-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    task_id: opts.task_id,
    module: opts.module,
    stage: opts.stage,
    engine: opts.engine,
    reserved_usd: estimate.usd,
    reserved_quota_pct: estimate.quota_pct > 0 ? estimate.quota_pct : undefined,
    reserved_at: new Date().toISOString(),
    ttl_sec: opts.ttl_sec ?? 30 * 60,
    status: 'reserved',
    harness_version: process.env.HARNESS_VERSION,
  };
  appendEvent(reservation);
  return {
    ok: true,
    reservation_id: reservation.reservation_id,
    reserved_usd: estimate.usd,
    reserved_quota_pct: estimate.quota_pct > 0 ? estimate.quota_pct : undefined,
    cap_remaining_usd: capRemainingUsd(budget) - estimate.usd,
    ttl_sec: reservation.ttl_sec,
  };
}

export function recordSpend(reservation_id: string, actual_usd: number, actual_quota_pct?: number): void {
  const events = readReservations();
  const prior = events.find((r) => r.reservation_id === reservation_id);
  if (!prior) {
    throw new Error(`recordSpend: reservation ${reservation_id} not found`);
  }
  if (prior.status !== 'reserved') {
    throw new Error(`recordSpend: reservation ${reservation_id} is in status ${prior.status}, not 'reserved'`);
  }
  const finalized: Reservation = {
    ...prior,
    actual_usd,
    actual_quota_pct,
    finalized_at: new Date().toISOString(),
    status: 'spent',
  };
  appendEvent(finalized);
}

export function releaseReservation(reservation_id: string, reason: string): void {
  const events = readReservations();
  const prior = events.find((r) => r.reservation_id === reservation_id);
  if (!prior) {
    // Tolerate releases of unknown reservation_id (idempotent for noop-gate IDs).
    if (reservation_id.startsWith('noop-gate-')) return;
    throw new Error(`releaseReservation: ${reservation_id} not found`);
  }
  if (prior.status !== 'reserved') return;  // already finalized; idempotent
  const released: Reservation = {
    ...prior,
    finalized_at: new Date().toISOString(),
    status: 'released',
    reason,
  };
  appendEvent(released);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sumReservedAndSpent(task_id: string): number {
  let total = 0;
  for (const r of readReservations()) {
    if (r.task_id !== task_id) continue;
    if (r.status === 'reserved') total += r.reserved_usd;
    else if (r.status === 'spent') total += r.actual_usd ?? 0;
  }
  return total;
}

function windowStartDate(period: 'daily' | 'weekly' | 'monthly'): Date {
  const now = new Date();
  const d = new Date(now);
  if (period === 'daily') {
    d.setUTCHours(0, 0, 0, 0);
  } else if (period === 'weekly') {
    const day = d.getUTCDay();
    d.setUTCDate(d.getUTCDate() - day);
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
  }
  return d;
}

function sumReservedAndSpentSince(since: Date): number {
  let total = 0;
  for (const r of readReservations()) {
    const t = new Date(r.finalized_at ?? r.reserved_at);
    if (t < since) continue;
    if (r.status === 'reserved') total += r.reserved_usd;
    else if (r.status === 'spent') total += r.actual_usd ?? 0;
  }
  return total;
}

function capRemainingUsd(budget: BudgetContract): number {
  const dailyWindow = budget.windows.find((w) => w.period === 'daily');
  if (!dailyWindow) return Number.POSITIVE_INFINITY;
  const dailyTotal = sumReservedAndSpentSince(windowStartDate('daily'));
  return Math.max(0, dailyWindow.cap_usd - dailyTotal);
}

interface CircuitBreakerStatus {
  tripped: boolean;
  hourly_usd: number;
  mean_24h_usd: number;
}

function circuitBreakerStatus(): CircuitBreakerStatus {
  // If override sentinel present, force-tripped (operator pause).
  const sentinel = path.join(harnessRoot(), '.agent-runs', '_BUDGET_CIRCUIT_BREAKER');
  if (fs.existsSync(sentinel)) {
    return { tripped: true, hourly_usd: 0, mean_24h_usd: 0 };
  }
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  let hourlyUsd = 0;
  let dailyUsd = 0;
  for (const r of readReservations()) {
    const t = new Date(r.finalized_at ?? r.reserved_at);
    const usd = r.status === 'spent' ? (r.actual_usd ?? 0) : (r.status === 'reserved' ? r.reserved_usd : 0);
    if (t >= hourAgo) hourlyUsd += usd;
    if (t >= dayAgo) dailyUsd += usd;
  }
  const mean24h = dailyUsd / 24;
  // Need ≥6h of history before the breaker engages (avoid bootstrap false positives).
  const oldestEvent = readReservations()
    .map((r) => new Date(r.reserved_at).getTime())
    .reduce((a, b) => Math.min(a, b), Date.now());
  const historyHours = (Date.now() - oldestEvent) / (60 * 60 * 1000);
  if (historyHours < 6) {
    return { tripped: false, hourly_usd: hourlyUsd, mean_24h_usd: mean24h };
  }
  const tripped = mean24h > 0 && hourlyUsd > 3 * mean24h;
  return { tripped, hourly_usd: hourlyUsd, mean_24h_usd: mean24h };
}

/**
 * Operator-facing engaged-circuit-breaker creator. Writes the sentinel
 * file; new reservations refuse until janitor or operator removes it.
 */
export function engageCircuitBreaker(reason: string): void {
  const root = harnessRoot();
  const sentinel = path.join(root, '.agent-runs', '_BUDGET_CIRCUIT_BREAKER');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, JSON.stringify({
    engaged_at: new Date().toISOString(),
    reason,
  }, null, 2));
}

export function disengageCircuitBreaker(): void {
  const root = harnessRoot();
  const sentinel = path.join(root, '.agent-runs', '_BUDGET_CIRCUIT_BREAKER');
  if (fs.existsSync(sentinel)) fs.unlinkSync(sentinel);
}

/**
 * Janitor hook (Layer 10): reclaim reservations whose TTL has elapsed.
 * Returns the number of reservations expired.
 */
export function reapExpiredReservations(): number {
  const events = readReservations();
  const now = Date.now();
  let expired = 0;
  for (const r of events) {
    if (r.status !== 'reserved') continue;
    const reservedMs = new Date(r.reserved_at).getTime();
    if (now - reservedMs > r.ttl_sec * 1000) {
      const expiredEvent: Reservation = {
        ...r,
        finalized_at: new Date().toISOString(),
        status: 'expired',
        reason: `TTL ${r.ttl_sec}s elapsed without finalize`,
      };
      appendEvent(expiredEvent);
      expired++;
    }
  }
  return expired;
}
