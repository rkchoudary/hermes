#!/usr/bin/env tsx
/**
 * Layer 3 — Per-module status (`pnpm auto:module-status M07`).
 *
 * One module's full pipeline state in one screen:
 *   - which stages are complete / in-flight / not-started
 *   - last 3 transitions per task
 *   - evidence files present per task
 *   - reservation/spent dollars
 *   - parked-reason if applicable
 *   - orphan-file warning when worker output sits uncommitted
 *
 * Distinct from `auto:fleet` (which is the cross-module one-liner view).
 * This is the deep-dive on a single module the operator is investigating.
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
import { readReservations } from '../lib/budgetReservation';
import { STAGE_REGISTRY } from '../lib/stageRegistry';
import type { TaskPack } from '../lib/taskPack';

interface CliArgs {
  module: string;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    console.log(`pnpm auto:module-status <MID> [--json]`);
    process.exit(argv.length === 0 ? 1 : 0);
  }
  return {
    module: argv[0],
    json: argv.includes('--json'),
  };
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

interface PerStageStatus {
  stage: string;
  state: 'complete' | 'in-flight' | 'parked' | 'not-started';
  task_ids: string[];
  last_state?: string;
  last_actor?: string;
  last_at?: string;
  parked_reason?: string;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const moduleId = args.module;
  const reservations = readReservations();

  // Collect every TaskPack for this module across runs.
  const packs: { runId: string; pack: TaskPack }[] = [];
  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      let pack: TaskPack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      if (inferModule(pack) === moduleId) packs.push({ runId, pack });
    }
  }

  if (packs.length === 0) {
    console.log(`(no tasks found for ${moduleId})`);
    process.exit(0);
  }

  // Group by phase (== pack.type).
  const byPhase = new Map<string, typeof packs>();
  for (const p of packs) {
    const ph = (p.pack.type as string) ?? 'unknown';
    const list = byPhase.get(ph) ?? [];
    list.push(p);
    byPhase.set(ph, list);
  }

  // Per-stage status using the registry as the canonical pipeline order.
  // Some stages map cleanly to phase (auto:work → code-sprint), others
  // are gates without their own phase.
  const stageStatus: PerStageStatus[] = [];
  // Walk task packs grouped by type and synthesize per-stage rows.
  for (const phase of byPhase.keys()) {
    const phasePacks = byPhase.get(phase)!;
    let state: PerStageStatus['state'] = 'not-started';
    if (phasePacks.some((p) => p.pack.state === 'merged')) state = 'complete';
    else if (phasePacks.some((p) => ['in-progress', 'awaiting-review', 'codex-reviewing', 'awaiting-human-approval', 'promotable', 'ready-for-merge'].includes(p.pack.state))) state = 'in-flight';
    else if (phasePacks.some((p) => p.pack.state === 'abandoned')) state = 'parked';
    else state = 'in-flight';
    const last = phasePacks
      .map((p) => p.pack.state_history?.[p.pack.state_history.length - 1])
      .filter(Boolean)
      .sort((a, b) => new Date(b!.at).getTime() - new Date(a!.at).getTime())[0];
    stageStatus.push({
      stage: phase,
      state,
      task_ids: phasePacks.map((p) => p.pack.task_id),
      last_state: last?.to,
      last_actor: last?.by,
      last_at: last?.at,
    });
  }

  // Cost rollup for module
  let moduleSpent = 0;
  let moduleReserved = 0;
  for (const r of reservations) {
    if (r.module === moduleId || (r.task_id && packs.some((p) => p.pack.task_id === r.task_id))) {
      if (r.status === 'spent') moduleSpent += r.actual_usd ?? 0;
      if (r.status === 'reserved') moduleReserved += r.reserved_usd;
    }
  }

  // Orphan files: evidence dirs with content for tasks not merged/abandoned + >24h old
  const orphans: { task_id: string; evidence_files: number }[] = [];
  for (const { runId, pack } of packs) {
    if (pack.state === 'merged' || pack.state === 'abandoned' || pack.state === 'in-progress') continue;
    try {
      const evDir = evidenceDir(runId, pack.task_id);
      if (!fs.existsSync(evDir)) continue;
      const files = fs.readdirSync(evDir).filter((f) => f !== '_progress.jsonl');
      const last = pack.state_history?.[pack.state_history.length - 1];
      const lastTime = last ? new Date(last.at).getTime() : Date.now();
      const ageHours = (Date.now() - lastTime) / (3600 * 1000);
      if (files.length > 0 && ageHours > 24) {
        orphans.push({ task_id: pack.task_id, evidence_files: files.length });
      }
    } catch { /* best-effort */ }
  }

  const out = {
    module: moduleId,
    task_count: packs.length,
    stage_status: stageStatus,
    cost_summary: { spent_usd: moduleSpent, reserved_usd: moduleReserved },
    orphan_evidence: orphans,
    pipeline_completion_pct: stageStatus.length > 0
      ? Math.round((stageStatus.filter((s) => s.state === 'complete').length / stageStatus.length) * 100)
      : 0,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  // Human-readable report
  console.log('');
  console.log(`═══════════════════════════════════════`);
  console.log(`Module ${moduleId} — pipeline status`);
  console.log(`═══════════════════════════════════════`);
  console.log(`tasks: ${out.task_count}, completion: ${out.pipeline_completion_pct}%, spent: $${out.cost_summary.spent_usd.toFixed(2)}, reserved: $${out.cost_summary.reserved_usd.toFixed(2)}`);
  console.log('');
  for (const s of stageStatus) {
    const icon = s.state === 'complete' ? '✓'
      : s.state === 'in-flight' ? '●'
      : s.state === 'parked' ? '⛔'
      : '·';
    const tasks = s.task_ids.length === 1 ? s.task_ids[0] : `${s.task_ids.length} tasks`;
    console.log(`${icon} ${s.stage.padEnd(20)} ${s.state.padEnd(12)} (${tasks})`);
    if (s.last_state && s.last_actor && s.last_at) {
      console.log(`     last: ${s.last_state} by ${s.last_actor} at ${s.last_at}`);
    }
  }
  if (orphans.length > 0) {
    console.log('');
    console.log(`⚠ ${orphans.length} task(s) with orphan evidence files (>24h, not merged/abandoned):`);
    for (const o of orphans) console.log(`    ${o.task_id}: ${o.evidence_files} file(s)`);
    console.log(`Run \`pnpm auto:reconcile-orphans ${moduleId}\` to commit-or-drop (Layer 10 janitor).`);
  }
  console.log('');
  process.exit(0);
}

main();
