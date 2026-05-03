#!/usr/bin/env tsx
/**
 * Layer 9 — Emit evidence manifests (`pnpm auto:emit-manifests`).
 *
 * Walks every completed task across every run dir and emits
 * _manifest.json (sha256 per file + harness_version + repo_sha) where
 * one is missing. Run as a pre-step before s3-archive so the upload
 * includes durable manifests; run by the janitor before any prune so
 * local files are never deleted before being content-addressed.
 *
 * Doctrine: evidence is content-addressed at stage completion. Local
 * files are mutable; the manifest is the immutable record.
 */
import { listRuns, listTasks, readTaskPack } from '../lib/runState';
import { emitEvidenceManifest, readEvidenceManifest } from '../lib/evidenceManifest';
import { emitSuccess } from '../lib/stageOutcome';

interface CliArgs {
  json?: boolean;
  /** Force re-emit even when a manifest already exists. */
  force?: boolean;
  /** Only emit for one task. */
  task?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--force') a.force = true;
    else if (argv[i] === '--task' && i + 1 < argv.length) a.task = argv[++i];
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log('pnpm auto:emit-manifests [--force] [--task <id>] [--json]');
      process.exit(0);
    }
  }
  return a;
}

function main(): void {
  const start = Date.now();
  const args = parseArgs(process.argv.slice(2));
  // Only emit for tasks past in-progress (a manifest captures a stable
  // snapshot; emitting one mid-run would be misleading).
  const COMPLETED_LIKE = new Set([
    'awaiting-review', 'codex-reviewing', 'promotable',
    'ready-for-merge', 'merged', 'abandoned', 'needs-revision',
    'awaiting-human-approval', 'claims-verified',
  ]);

  let scanned = 0;
  let emitted = 0;
  let skippedExisting = 0;
  let skippedInflight = 0;

  for (const runId of listRuns()) {
    let taskIds: string[] = [];
    try { taskIds = listTasks(runId); } catch { continue; }
    for (const taskId of taskIds) {
      if (args.task && taskId !== args.task) continue;
      let pack;
      try { pack = readTaskPack(runId, taskId); } catch { continue; }
      scanned++;
      if (!COMPLETED_LIKE.has(pack.state)) {
        skippedInflight++;
        continue;
      }
      if (!args.force && readEvidenceManifest(runId, taskId)) {
        skippedExisting++;
        continue;
      }
      const manifest = emitEvidenceManifest({
        task_id: taskId,
        run_id: runId,
        stage: (pack.type as string) ?? 'unknown',
        harness_version: process.env.HARNESS_VERSION,
      });
      if (manifest) {
        emitted++;
      }
    }
  }

  const summary = {
    scanned,
    emitted,
    skipped_existing: skippedExisting,
    skipped_inflight: skippedInflight,
    duration_ms: Date.now() - start,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`auto:emit-manifests`);
    console.log(`  scanned: ${scanned}`);
    console.log(`  emitted: ${emitted}`);
    console.log(`  skipped (existing): ${skippedExisting}`);
    console.log(`  skipped (in-flight): ${skippedInflight}`);
    console.log(`  duration: ${summary.duration_ms}ms`);
  }

  emitSuccess({
    stage: 'auto:emit-manifests',
    reason: `emitted ${emitted}/${scanned} manifests`,
    metrics: { duration_ms: summary.duration_ms },
    details: summary as unknown as Record<string, unknown>,
  });
  process.exit(0);
}

main();
