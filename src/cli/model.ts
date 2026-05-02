#!/usr/bin/env node
/**
 * pnpm auto:model — model inventory + change-control CLI (PUB-10).
 *
 * Subcommands:
 *   init                       — create .agent-runs/_model-inventory.json
 *                                with defaultInventory() (refuses if exists
 *                                unless --force)
 *   list                       — print qualified models + roles + reviewer
 *   check <engine> <model_id>  — verify a specific model is qualified
 *                                (returns exit code 0 ok, 1 not qualified)
 *
 * Phase 2 will add: qualify <engine> <model_id> --by <name> --reason "…"
 *                   --roles impl-worker,codex-reviewer
 *   (deferred because qualification needs SoD enforcement per PUB-8)
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readInventory, writeInventory, isQualified, defaultInventory, inventoryPath, type ModelRole } from '../lib/modelInventory';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();

function usage(): never {
  console.error(`Usage:
  pnpm auto:model init [--force]
  pnpm auto:model list
  pnpm auto:model check <engine> <model_id> [--role impl-worker]`);
  process.exit(2);
}

function cmdInit(force: boolean): void {
  const p = inventoryPath(HARNESS_ROOT);
  if (fs.existsSync(p) && !force) {
    console.error(`[init] BLOCKED: ${p} already exists. Pass --force to overwrite.`);
    process.exit(1);
  }
  const inv = defaultInventory();
  writeInventory(HARNESS_ROOT, inv);
  console.log(`✓ wrote ${p}`);
  console.log(`  schema_version: ${inv.schema_version}`);
  console.log(`  enforce: ${inv.enforce}`);
  console.log(`  models: ${inv.models.length}`);
  for (const m of inv.models) {
    console.log(`    ${m.engine} / ${m.model_id} — roles: ${m.roles.join(', ')}`);
  }
  console.log('');
  console.log(`Next: edit the file directly to add custom qualifications, OR`);
  console.log(`use pnpm auto:model qualify (Phase 2; needs PUB-8 SoD).`);
}

function cmdList(): void {
  const inv = readInventory(HARNESS_ROOT);
  if (!inv) {
    console.error(`No inventory file at ${inventoryPath(HARNESS_ROOT)}.`);
    console.error(`Run pnpm auto:model init to create one.`);
    process.exit(1);
  }
  console.log(`Model inventory (schema=${inv.schema_version}, enforce=${inv.enforce}):`);
  console.log(`Last reviewed: ${inv.last_reviewed_at ?? '(never)'} by ${inv.last_reviewed_by ?? '(unknown)'}`);
  console.log('');
  for (const m of inv.models) {
    console.log(`  ${m.engine} / ${m.model_id}${m.model_version ? `@${m.model_version}` : ''}`);
    console.log(`    roles: ${m.roles.join(', ')}`);
    console.log(`    qualified: ${m.qualified_at} by ${m.qualified_by}`);
    console.log(`    reason: ${m.qualification_reason}`);
    console.log('');
  }
}

function cmdCheck(engine: string, modelId: string, role: ModelRole): void {
  const inv = readInventory(HARNESS_ROOT);
  const result = isQualified(inv, engine, modelId, role);
  if (result.ok) {
    console.log(`✓ qualified: ${engine}/${modelId} for role '${role}'`);
    if (result.reason) console.log(`  note: ${result.reason}`);
    if (result.matched) console.log(`  matched: qualified ${result.matched.qualified_at} by ${result.matched.qualified_by}`);
    process.exit(0);
  }
  console.error(`✗ NOT qualified: ${result.reason}`);
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub) usage();

  if (sub === 'init') {
    const force = argv.includes('--force');
    cmdInit(force);
  } else if (sub === 'list') {
    cmdList();
  } else if (sub === 'check') {
    const engine = argv[1];
    const modelId = argv[2];
    if (!engine || !modelId) usage();
    let role: ModelRole = 'impl-worker';
    const roleIdx = argv.indexOf('--role');
    if (roleIdx >= 0 && argv[roleIdx + 1]) role = argv[roleIdx + 1] as ModelRole;
    cmdCheck(engine, modelId, role);
  } else {
    usage();
  }
}

main();
