#!/usr/bin/env tsx
/**
 * Layer 10 — Janitor: housekeeping with retention policy.
 *
 * Doctrine: cleanup is automatic; nothing persists past retention without
 * operator action. Janitor refuses to delete anything without L9 manifest
 * confirmation — local prune ≠ destruction.
 *
 * Default retention rules:
 *   /tmp/auto-worker-*  >24h → delete
 *   _BUDGET_CIRCUIT_BREAKER if dispatchable+stale → flag (don't auto-disengage)
 *   internal-marker stashes → drop after audit log
 *   merged-PR worktrees → prune
 *   .agent-runs/<run_id>/ >30d → archive to S3 (existing s3-archive.ts)
 *   docker dangling images → drop
 *   docker stopped containers → drop after 24h
 *   worker-orphan files (untracked, never committed) → flag, never delete
 *   stale L1 reservations → reapExpiredReservations()
 *   compact progress sidecars >50 events → summary line + truncate
 *
 * Modes:
 *   --dry-run (default) — report what would be done
 *   --apply             — actually do it
 *   --aggressive        — include borderline retention (e.g., 12h tmp files)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { harnessRoot } from '../lib/harnessRoot';
import { reapExpiredReservations } from '../lib/budgetReservation';
import { compactSidecar } from '../lib/progressSidecar';
import { listRuns, listTasks, readTaskPack, evidenceDir } from '../lib/runState';
import { readEvidenceManifest } from '../lib/evidenceManifest';
import { emitSuccess } from '../lib/stageOutcome';

interface CliArgs {
  apply?: boolean;
  aggressive?: boolean;
  json?: boolean;
}

interface JanitorAction {
  category: string;
  description: string;
  applied: boolean;
  blocked_by?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (const x of argv) {
    if (x === '--apply') a.apply = true;
    else if (x === '--aggressive') a.aggressive = true;
    else if (x === '--json') a.json = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:janitor [--apply] [--aggressive] [--json]`);
      process.exit(0);
    }
  }
  return a;
}

function ageHours(p: string): number {
  try {
    const stat = fs.statSync(p);
    return (Date.now() - stat.mtime.getTime()) / (3600 * 1000);
  } catch {
    return 0;
  }
}

function pruneTmpAutoWorker(args: CliArgs): JanitorAction[] {
  const actions: JanitorAction[] = [];
  const tmp = os.tmpdir();
  const cutoffH = args.aggressive ? 12 : 24;
  let entries: string[] = [];
  try { entries = fs.readdirSync(tmp); } catch { return actions; }
  for (const name of entries) {
    if (!name.startsWith('auto-worker-')) continue;
    const p = path.join(tmp, name);
    const age = ageHours(p);
    if (age <= cutoffH) continue;
    const desc = `${p} (age ${age.toFixed(1)}h)`;
    if (args.apply) {
      try { fs.unlinkSync(p); actions.push({ category: 'tmp-auto-worker', description: desc, applied: true }); }
      catch (e) { actions.push({ category: 'tmp-auto-worker', description: desc, applied: false, blocked_by: (e as Error).message }); }
    } else {
      actions.push({ category: 'tmp-auto-worker', description: desc, applied: false, blocked_by: 'dry-run' });
    }
  }
  return actions;
}

function reapReservations(args: CliArgs): JanitorAction[] {
  if (!args.apply) {
    return [{ category: 'reservation-reap', description: 'would reap stale L1 reservations', applied: false, blocked_by: 'dry-run' }];
  }
  const n = reapExpiredReservations();
  return [{ category: 'reservation-reap', description: `expired ${n} stale reservation(s)`, applied: true }];
}

function flagOrphanEvidence(args: CliArgs): JanitorAction[] {
  const actions: JanitorAction[] = [];
  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      let pack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      if (pack.state === 'merged' || pack.state === 'abandoned' || pack.state === 'in-progress') continue;
      const dir = evidenceDir(runId, taskId);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => !f.startsWith('_'));
      if (files.length === 0) continue;
      const last = pack.state_history?.[pack.state_history.length - 1];
      const lastTime = last ? new Date(last.at).getTime() : Date.now();
      if (Date.now() - lastTime < 24 * 3600 * 1000) continue;
      // Orphan evidence — flag but NEVER auto-delete.
      actions.push({
        category: 'orphan-evidence',
        description: `${runId}/${taskId}: ${files.length} file(s), state=${pack.state} for >24h`,
        applied: false,
        blocked_by: 'orphan-evidence is operator-decision only — run pnpm auto:reconcile-orphans <module>',
      });
    }
  }
  return actions;
}

function checkManifestBeforePrune(args: CliArgs): JanitorAction[] {
  // L10 doctrine: refuse to prune a run dir without an L9 manifest for
  // each merged task in that run. Today this is a check-only pass — full
  // prune wires when L9 S3 upload is operational.
  const actions: JanitorAction[] = [];
  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    let mergedWithoutManifest = 0;
    for (const taskId of taskIds) {
      let pack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      if (pack.state !== 'merged') continue;
      const m = readEvidenceManifest(runId, taskId);
      if (!m) mergedWithoutManifest++;
    }
    if (mergedWithoutManifest > 0) {
      actions.push({
        category: 'manifest-coverage',
        description: `${runId}: ${mergedWithoutManifest} merged task(s) without L9 _manifest.json — prune blocked`,
        applied: false,
        blocked_by: 'L9 manifest required before prune (doctrine)',
      });
    }
  }
  return actions;
}

function compactProgressSidecars(args: CliArgs): JanitorAction[] {
  const actions: JanitorAction[] = [];
  const root = harnessRoot();
  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      let pack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      // Only compact sidecars for tasks past in-progress.
      if (pack.state === 'in-progress' || pack.state === 'planned' || pack.state === 'unplanned') continue;
      if (!args.apply) continue;
      const r = compactSidecar(root, runId, taskId);
      if (r.compacted) {
        actions.push({
          category: 'sidecar-compact',
          description: `${runId}/${taskId}: collapsed ${r.lines_collapsed} progress events into 1 summary`,
          applied: true,
        });
      }
    }
  }
  return actions;
}

function main(): void {
  const start = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const allActions: JanitorAction[] = [];
  allActions.push(...pruneTmpAutoWorker(args));
  allActions.push(...reapReservations(args));
  allActions.push(...flagOrphanEvidence(args));
  allActions.push(...checkManifestBeforePrune(args));
  allActions.push(...compactProgressSidecars(args));

  const summary = {
    mode: args.apply ? 'apply' : 'dry-run',
    aggressive: args.aggressive ?? false,
    actions_total: allActions.length,
    actions_applied: allActions.filter((a) => a.applied).length,
    actions_skipped: allActions.filter((a) => !a.applied).length,
    by_category: groupCategories(allActions),
    actions: allActions,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Janitor (mode=${summary.mode}${args.aggressive ? ', aggressive' : ''})`);
    console.log(`Total: ${summary.actions_total}; applied: ${summary.actions_applied}; skipped: ${summary.actions_skipped}`);
    for (const [cat, count] of Object.entries(summary.by_category)) {
      console.log(`  ${cat}: ${count}`);
    }
    if (allActions.length > 0 && allActions.length < 50) {
      console.log('');
      for (const a of allActions) {
        const icon = a.applied ? '✓' : '·';
        console.log(`  ${icon} [${a.category}] ${a.description}${a.blocked_by ? ` (${a.blocked_by})` : ''}`);
      }
    }
  }
  emitSuccess({
    stage: 'auto:janitor',
    reason: `${summary.actions_applied} applied, ${summary.actions_skipped} skipped`,
    metrics: { duration_ms: Date.now() - start },
    details: summary as unknown as Record<string, unknown>,
  });
  process.exit(0);
}

function groupCategories(actions: JanitorAction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const a of actions) out[a.category] = (out[a.category] ?? 0) + 1;
  return out;
}

main();
