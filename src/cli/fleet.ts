#!/usr/bin/env tsx
/**
 * Layer 3 — Fleet view (`pnpm auto:fleet`).
 *
 * Doctrine: every job is fully inventoried. One CLI, every TaskPack
 * across every run dir, joined with the processWatchdog registry and
 * the L1 reservation log.
 *
 * Usage:
 *   pnpm auto:fleet                    Default: in-flight tasks only,
 *                                      sorted by elapsed-in-state desc
 *                                      (stuck work surfaces first).
 *   pnpm auto:fleet --all              Include terminal states (merged,
 *                                      abandoned).
 *   pnpm auto:fleet --json             Machine-readable output for
 *                                      scripting + dashboard SSE feed.
 *   pnpm auto:fleet --module M07       Filter to one module.
 *   pnpm auto:fleet --state in-progress  Filter to one state.
 *   pnpm auto:fleet --orphans          Only show worker-orphan files
 *                                      (untracked output never committed —
 *                                      the M07/M08 case from L5 doctrine).
 *
 * Columns:
 *   TASK            module    phase           state              elapsed   pid    live  cost_usd  blocked_on
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../lib/harnessRoot';
import {
  listRuns,
  listTasks,
  readTaskPack,
  evidenceDir,
} from '../lib/runState';
import { listRegistered, isPidAlive } from '../lib/processWatchdog';
import { readReservations } from '../lib/budgetReservation';
import type { TaskPack, TaskState } from '../lib/taskPack';

const TERMINAL_STATES: ReadonlyArray<TaskState> = ['merged', 'abandoned'];
const IN_FLIGHT_PRIORITY: TaskState[] = [
  'in-progress',
  'codex-reviewing',
  'awaiting-review',
  'awaiting-human-approval',
  'needs-revision',
  'promotable',
  'ready-for-merge',
  'claimed',
  'planned',
  'unplanned',
];

interface FleetRow {
  task_id: string;
  module: string | null;
  phase: string;
  state: TaskState;
  state_entered_at: string;
  elapsed_in_state_sec: number;
  run_id: string;
  pid: number | null;
  pid_alive: boolean;
  reservation_usd: number;
  spent_usd: number;
  blocked_on: string;
  last_actor: string;
  has_orphan_files?: boolean;
}

interface CliArgs {
  all?: boolean;
  json?: boolean;
  module?: string;
  state?: string;
  orphans?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--all') a.all = true;
    else if (x === '--json') a.json = true;
    else if (x === '--module' && i + 1 < argv.length) a.module = argv[++i];
    else if (x === '--state' && i + 1 < argv.length) a.state = argv[++i];
    else if (x === '--orphans') a.orphans = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:fleet [--all] [--json] [--module <MID>] [--state <name>] [--orphans]`);
      process.exit(0);
    }
  }
  return a;
}

function elapsedSecSince(iso: string): number {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return 0;
  return Math.round((Date.now() - t) / 1000);
}

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d${Math.floor((sec % 86400) / 3600)}h`;
}

function inferModule(pack: TaskPack): string | null {
  // TaskPack doesn't carry an explicit module field; infer from
  // module_or_sprint (e.g., "M05-impl-v1.0" → "M05") or from the
  // wider pack shape via cast.
  const cast = pack as unknown as { module?: string; module_or_sprint?: string };
  if (cast.module) return cast.module;
  if (cast.module_or_sprint) {
    const match = cast.module_or_sprint.match(/^M\d{2,3}/);
    if (match) return match[0];
  }
  return null;
}

function lastTransition(pack: TaskPack): { at: string; by: string; from?: string; to: string; reason?: string } | null {
  const h = pack.state_history;
  if (!h || h.length === 0) return null;
  return h[h.length - 1] as { at: string; by: string; to: TaskState; from?: string; reason?: string };
}

function inferPhase(pack: TaskPack): string {
  // The pack's `type` is closest to a phase label.
  return (pack.type as string) ?? 'unknown';
}

function inferBlockedOn(pack: TaskPack): string {
  const last = lastTransition(pack);
  if (!last) return '—';
  const r = last.reason ?? '';
  // Extract the first informative chunk.
  if (r.length === 0) return '—';
  return r.length > 80 ? r.slice(0, 77) + '…' : r;
}

function buildFleet(): FleetRow[] {
  const root = harnessRoot();
  const rows: FleetRow[] = [];
  const procs = listRegistered(root);
  const reservations = readReservations();

  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      let pack: TaskPack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      const last = lastTransition(pack);
      const proc = procs.find((p) => p.task_id === taskId);
      const taskReservations = reservations.filter((r) => r.task_id === taskId);
      const reservedUsd = taskReservations
        .filter((r) => r.status === 'reserved')
        .reduce((s, r) => s + r.reserved_usd, 0);
      const spentUsd = taskReservations
        .filter((r) => r.status === 'spent')
        .reduce((s, r) => s + (r.actual_usd ?? 0), 0);
      // Orphan check: evidence dir has files but pack is in a non-terminal,
      // non-active state for >24h. Cheap heuristic.
      let hasOrphanFiles = false;
      try {
        const evDir = evidenceDir(runId, taskId);
        if (fs.existsSync(evDir)) {
          const files = fs.readdirSync(evDir).filter((f) => f !== '_progress.jsonl');
          hasOrphanFiles = files.length > 0
            && pack.state !== 'merged'
            && pack.state !== 'abandoned'
            && pack.state !== 'in-progress'
            && elapsedSecSince(last?.at ?? new Date().toISOString()) > 24 * 3600;
        }
      } catch { /* best-effort */ }

      const row: FleetRow = {
        task_id: taskId,
        module: inferModule(pack),
        phase: inferPhase(pack),
        state: pack.state,
        state_entered_at: last?.at ?? new Date().toISOString(),
        elapsed_in_state_sec: last ? elapsedSecSince(last.at) : 0,
        run_id: runId,
        pid: proc?.pid ?? null,
        pid_alive: proc ? isPidAlive(proc.pid) : false,
        reservation_usd: reservedUsd,
        spent_usd: spentUsd,
        blocked_on: inferBlockedOn(pack),
        last_actor: last?.by ?? '—',
        has_orphan_files: hasOrphanFiles,
      };
      rows.push(row);
    }
  }
  return rows;
}

function applyFilters(rows: FleetRow[], args: CliArgs): FleetRow[] {
  let out = rows;
  if (!args.all) {
    out = out.filter((r) => !TERMINAL_STATES.includes(r.state));
  }
  if (args.module) {
    out = out.filter((r) => r.module === args.module);
  }
  if (args.state) {
    out = out.filter((r) => r.state === args.state);
  }
  if (args.orphans) {
    out = out.filter((r) => r.has_orphan_files);
  }
  return out;
}

function sortRows(rows: FleetRow[]): FleetRow[] {
  // Primary: by state priority (in-progress first), secondary: by elapsed desc.
  const stateRank = new Map(IN_FLIGHT_PRIORITY.map((s, i) => [s, i]));
  return [...rows].sort((a, b) => {
    const ra = stateRank.get(a.state) ?? 99;
    const rb = stateRank.get(b.state) ?? 99;
    if (ra !== rb) return ra - rb;
    return b.elapsed_in_state_sec - a.elapsed_in_state_sec;
  });
}

function printTable(rows: FleetRow[]): void {
  if (rows.length === 0) {
    console.log('(no matching tasks)');
    return;
  }
  // Column widths
  const COLS = [
    { name: 'TASK', width: 22 },
    { name: 'MOD', width: 5 },
    { name: 'PHASE', width: 18 },
    { name: 'STATE', width: 22 },
    { name: 'ELAPSED', width: 9 },
    { name: 'PID', width: 6 },
    { name: 'LIVE', width: 4 },
    { name: 'COST_USD', width: 9 },
    { name: 'BLOCKED ON', width: 60 },
  ];
  console.log(COLS.map((c) => c.name.padEnd(c.width)).join('  '));
  console.log(COLS.map((c) => '─'.repeat(c.width)).join('  '));
  for (const r of rows) {
    const cost = r.spent_usd > 0 ? r.spent_usd : r.reservation_usd;
    const cells = [
      r.task_id.padEnd(COLS[0].width),
      (r.module ?? '—').padEnd(COLS[1].width),
      r.phase.slice(0, COLS[2].width).padEnd(COLS[2].width),
      r.state.padEnd(COLS[3].width),
      fmtElapsed(r.elapsed_in_state_sec).padEnd(COLS[4].width),
      (r.pid ? String(r.pid) : '—').padEnd(COLS[5].width),
      (r.pid && r.pid_alive ? '●' : '—').padEnd(COLS[6].width),
      (cost > 0 ? `$${cost.toFixed(2)}` : '—').padEnd(COLS[7].width),
      r.blocked_on.slice(0, COLS[8].width),
    ];
    console.log(cells.join('  '));
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const rows = sortRows(applyFilters(buildFleet(), args));
  if (args.json) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    printTable(rows);
    console.log('');
    console.log(`${rows.length} task(s) shown. Use --all to include merged/abandoned, --json for scripting.`);
  }
  process.exit(0);
}

main();
