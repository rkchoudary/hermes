#!/usr/bin/env node
/**
 * pnpm auto:migrate-schema — one-shot backfill of TaskPack.schema_version
 * across all existing task packs on disk.
 *
 * Codex R2 finding: 'TaskPack.schema_version is real in taskPack.ts but
 * existing task packs on disk are not backfilled — the field is only
 * present after the next read+write cycle.' This CLI does the cycle for
 * every pack in every run, so on-disk state matches the schema claim.
 *
 * Idempotent: running multiple times is safe (writes only when needed).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTasks, readTaskPack, writeTaskPack } from '../lib/runState';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();
const RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');

function main(): void {
  if (!fs.existsSync(RUNS_DIR)) {
    console.log(`No .agent-runs/ directory at ${RUNS_DIR}; nothing to migrate.`);
    return;
  }
  let migrated = 0;
  let alreadyOk = 0;
  let failed = 0;
  for (const runId of fs.readdirSync(RUNS_DIR)) {
    if (runId.startsWith('_')) continue;
    if (!fs.statSync(path.join(RUNS_DIR, runId)).isDirectory()) continue;
    for (const taskId of listTasks(runId)) {
      const taskPath = path.join(RUNS_DIR, runId, 'tasks', `${taskId}.json`);
      let raw: string;
      try {
        raw = fs.readFileSync(taskPath, 'utf8');
      } catch {
        failed++;
        continue;
      }
      // Check if schema_version is already on disk before parsing
      const hasSchemaVersion = /"schema_version"\s*:/.test(raw);
      if (hasSchemaVersion) {
        alreadyOk++;
        continue;
      }
      // Parse + write back (Zod default fills schema_version='1')
      try {
        const pack = readTaskPack(runId, taskId);
        writeTaskPack(pack);
        migrated++;
        console.log(`✓ migrated ${runId}/${taskId}: schema_version='1' written`);
      } catch (e) {
        failed++;
        console.error(`✗ ${runId}/${taskId}: ${(e as Error).message}`);
      }
    }
  }
  console.log(``);
  console.log(`Summary: ${migrated} migrated, ${alreadyOk} already had schema_version, ${failed} failed`);
}

main();
