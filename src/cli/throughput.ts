#!/usr/bin/env tsx
/**
 * Layer 11 — Throughput KPIs (`pnpm auto:throughput`).
 *
 * Doctrine: metrics are first-class.
 *
 * Per-stage:   parts in/out, mean/p95 time-in-stage, defect rate, retry rate
 * Per-module:  cycle time intake → merged, # rounds, $-spend
 * Bottleneck:  stage with highest p95 time-in-stage today
 *
 * Persists to .agent-runs/_metrics/<date>.json. Dashboard / fleet view
 * surface the latest metrics; AUTONOMOUS-PROGRESS.md gets a daily
 * digest appended.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../lib/harnessRoot';
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { readReservations } from '../lib/budgetReservation';
import type { TaskPack, TaskState } from '../lib/taskPack';

interface CliArgs {
  json?: boolean;
  date?: string;  // YYYY-MM-DD; default = today
  write?: boolean;  // persist to .agent-runs/_metrics/
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--write') a.write = true;
    else if (argv[i] === '--date' && i + 1 < argv.length) a.date = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:throughput [--date YYYY-MM-DD] [--json] [--write]`);
      process.exit(0);
    }
  }
  return a;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
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

function inferPhase(pack: TaskPack): string {
  return (pack.type as string) ?? 'unknown';
}

interface StageMetrics {
  stage: string;
  in_count: number;
  out_count: number;
  parked_count: number;
  retry_count: number;
  duration_ms_p50: number;
  duration_ms_p95: number;
  defect_rate_pct: number;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date ?? todayISO();
  const reservations = readReservations();

  // Collect every TaskPack with a state-history transition on `date`.
  const stagesByName = new Map<string, {
    in: number;
    out: number;
    parked: number;
    retry: number;
    durations_ms: number[];
  }>();
  const moduleCycles = new Map<string, { intake_at?: string; merged_at?: string; rounds: number; spent_usd: number }>();

  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      let pack: TaskPack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      const phase = inferPhase(pack);
      const module = inferModule(pack);
      const transitions = pack.state_history ?? [];
      // Filter transitions to `date`
      const dayTransitions = transitions.filter((t) => t.at.startsWith(date));
      if (dayTransitions.length === 0) continue;
      const m = stagesByName.get(phase) ?? { in: 0, out: 0, parked: 0, retry: 0, durations_ms: [] };
      let prevAt: string | null = null;
      for (const t of dayTransitions) {
        // Count enters and exits per state
        if (t.to === 'in-progress') m.in++;
        if (t.to === 'awaiting-review' || t.to === 'merged') m.out++;
        if (t.to === 'abandoned') m.parked++;
        if (t.to === 'needs-revision') m.retry++;
        // Duration since prior transition
        if (prevAt) {
          const dur = new Date(t.at).getTime() - new Date(prevAt).getTime();
          if (dur >= 0 && dur < 24 * 3600 * 1000) m.durations_ms.push(dur);
        }
        prevAt = t.at;
      }
      stagesByName.set(phase, m);

      // Module-level cycle tracking
      if (module) {
        const cyc = moduleCycles.get(module) ?? { rounds: 0, spent_usd: 0 };
        if (phase === 'intake' && !cyc.intake_at) cyc.intake_at = transitions[0]?.at;
        if (pack.state === 'merged' && !cyc.merged_at) cyc.merged_at = transitions[transitions.length - 1]?.at;
        cyc.rounds += dayTransitions.filter((t) => t.to === 'in-progress').length;
        const taskSpent = reservations
          .filter((r) => r.task_id === taskId && r.status === 'spent')
          .reduce((s, r) => s + (r.actual_usd ?? 0), 0);
        cyc.spent_usd += taskSpent;
        moduleCycles.set(module, cyc);
      }
    }
  }

  const stageMetrics: StageMetrics[] = [];
  for (const [stage, m] of stagesByName.entries()) {
    const inOut = m.in + m.out;
    const defectRate = inOut > 0 ? (m.parked / inOut) * 100 : 0;
    stageMetrics.push({
      stage,
      in_count: m.in,
      out_count: m.out,
      parked_count: m.parked,
      retry_count: m.retry,
      duration_ms_p50: percentile(m.durations_ms, 0.5),
      duration_ms_p95: percentile(m.durations_ms, 0.95),
      defect_rate_pct: Math.round(defectRate * 10) / 10,
    });
  }

  // Bottleneck = stage with highest p95
  const bottleneck = stageMetrics.length > 0
    ? stageMetrics.reduce((max, s) => s.duration_ms_p95 > max.duration_ms_p95 ? s : max)
    : null;

  const moduleMetrics = Array.from(moduleCycles.entries()).map(([module, cyc]) => {
    const cycleMs = cyc.intake_at && cyc.merged_at
      ? new Date(cyc.merged_at).getTime() - new Date(cyc.intake_at).getTime()
      : null;
    return {
      module,
      cycle_ms: cycleMs,
      rounds: cyc.rounds,
      spent_usd: Math.round(cyc.spent_usd * 100) / 100,
    };
  });

  const summary = {
    date,
    generated_at: new Date().toISOString(),
    stage_metrics: stageMetrics,
    module_metrics: moduleMetrics,
    bottleneck: bottleneck
      ? { stage: bottleneck.stage, p95_minutes: Math.round(bottleneck.duration_ms_p95 / 60_000) }
      : null,
  };

  if (args.write) {
    const dir = path.join(harnessRoot(), '.agent-runs', '_metrics');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify(summary, null, 2));
    console.log(`Wrote .agent-runs/_metrics/${date}.json`);
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Throughput for ${date}`);
    console.log('Per-stage:');
    for (const s of stageMetrics) {
      console.log(`  ${s.stage.padEnd(24)} in=${s.in_count}, out=${s.out_count}, parked=${s.parked_count}, retry=${s.retry_count}, p95=${(s.duration_ms_p95 / 1000).toFixed(0)}s, defect=${s.defect_rate_pct}%`);
    }
    if (moduleMetrics.length > 0) {
      console.log('');
      console.log('Per-module:');
      for (const m of moduleMetrics) {
        const cycle = m.cycle_ms ? `${(m.cycle_ms / 3600_000).toFixed(1)}h` : '—';
        console.log(`  ${m.module.padEnd(8)} cycle=${cycle}, rounds=${m.rounds}, spent=$${m.spent_usd.toFixed(2)}`);
      }
    }
    if (bottleneck) {
      console.log('');
      console.log(`Bottleneck: ${bottleneck.stage} (p95 ${(bottleneck.duration_ms_p95 / 60_000).toFixed(1)}m)`);
    }
  }
  process.exit(0);
}

main();
