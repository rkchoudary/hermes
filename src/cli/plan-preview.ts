#!/usr/bin/env node
/**
 * pnpm auto:plan-preview --module M01 --version v1.0 --type code-sprint --objective "..."
 *
 * Plan-then-confirm mode (Cursor "plan mode" parallel). Generates a TaskPack
 * via auto:plan but DRY-RUN: writes the pack to a preview directory, prints
 * the human-readable plan summary, and waits for operator approval. On
 * approval, the preview pack is moved to the live tasks/ directory and is
 * dispatchable.
 *
 * Three steps:
 *   1. Same arguments as `pnpm auto:plan`. Emit the pack to a preview path.
 *   2. Pretty-print: objective, AC, allowed_paths, forbidden_paths,
 *      references, risk class, mode. Print operator menu.
 *   3. Operator chooses: approve (moves to live tasks/), edit (opens $EDITOR
 *      on the pack JSON), reject (deletes preview).
 *
 * Useful for high-risk task types (security-fix, migration, dep-upgrade)
 * where you want to inspect the plan before the worker spends compute.
 *
 * Usage:
 *   pnpm auto:plan-preview --module M21 --version v1.0 --type code-sprint --auto-fill
 *   pnpm auto:plan-preview --approve TP-2026-05-02-001     # approve a previously-generated preview
 *   pnpm auto:plan-preview --reject TP-2026-05-02-001      # discard a preview
 *   pnpm auto:plan-preview --list                          # show pending previews
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs { approve?: string; reject?: string; list: boolean; passthrough: string[]; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { list: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--approve' && i + 1 < argv.length) a.approve = argv[++i];
    else if (x === '--reject' && i + 1 < argv.length) a.reject = argv[++i];
    else if (x === '--list') a.list = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:plan-preview <plan-args>     Generate a preview TaskPack (not dispatchable yet)
pnpm auto:plan-preview --approve <task_id>      Move preview to live tasks/
pnpm auto:plan-preview --reject  <task_id>      Discard preview
pnpm auto:plan-preview --list                   List pending previews

Plan-then-confirm mode. Useful for high-risk tasks where you want to
inspect what the worker is about to do before it spends compute.

After --approve, dispatch as normal: pnpm auto:work <task_id>`);
      process.exit(0);
    }
    else a.passthrough.push(x);
  }
  return a;
}

function previewDir(): string {
  return path.join(harnessRoot(), '.agent-runs', '_previews');
}

function findRunHoldingTask(taskId: string): { runId: string; tasksDir: string } | null {
  const runsRoot = path.join(harnessRoot(), '.agent-runs');
  if (!fs.existsSync(runsRoot)) return null;
  for (const r of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r)) continue;
    const tasksDir = path.join(runsRoot, r, 'tasks');
    const livePath = path.join(tasksDir, `${taskId}.json`);
    if (fs.existsSync(livePath)) return { runId: r, tasksDir };
  }
  // Fall back to latest run
  const runs = fs.readdirSync(runsRoot).filter(d => /^\d{4}-\d{2}-\d{2}/.test(d)).sort();
  const latest = runs[runs.length - 1];
  return latest ? { runId: latest, tasksDir: path.join(runsRoot, latest, 'tasks') } : null;
}

function prettyPrint(pack: Record<string, unknown>): void {
  const get = <T>(k: string): T => pack[k] as T;
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  PREVIEW — ${get<string>('task_id')}`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Module:        ${get<string>('module_or_sprint')}`);
  console.log(`Type:          ${get<string>('type')}`);
  console.log(`Mode:          ${get<string>('mode') || 'brownfield'}`);
  console.log(`Risk class:    ${get<string>('risk_class') || 'medium'}`);
  console.log(`Version:       ${get<string>('version_target')}`);
  console.log('');
  console.log('Objective:');
  const obj = get<string>('objective') || '';
  for (const line of obj.split('\n')) console.log(`  ${line}`);
  console.log('');
  const ac = get<Array<unknown>>('acceptance_criteria') || [];
  console.log(`Acceptance criteria (${ac.length}):`);
  for (const c of ac) {
    const txt = typeof c === 'string' ? c : (c as { text?: string }).text;
    console.log(`  ${txt}`);
  }
  console.log('');
  const allowed = get<string[]>('allowed_paths') || [];
  console.log(`Allowed paths (${allowed.length}):`);
  for (const p of allowed) console.log(`  ${p}`);
  console.log('');
  const forbidden = get<string[]>('forbidden_paths') || [];
  if (forbidden.length > 0) {
    console.log(`Forbidden paths (${forbidden.length}):`);
    for (const p of forbidden) console.log(`  ${p}`);
    console.log('');
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    const dir = previewDir();
    if (!fs.existsSync(dir)) {
      console.log('No pending previews.');
      return;
    }
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      console.log('No pending previews.');
      return;
    }
    console.log('Pending previews:\n');
    for (const f of files) {
      try {
        const pack = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        console.log(`  ${pack.task_id}  ${pack.type}  ${pack.module_or_sprint}  → ${(pack.objective || '').slice(0, 60)}`);
      } catch { /* skip */ }
    }
    console.log('\nApprove with: pnpm auto:plan-preview --approve <task_id>');
    return;
  }

  if (args.approve) {
    const previewPath = path.join(previewDir(), `${args.approve}.json`);
    if (!fs.existsSync(previewPath)) {
      console.error(`Preview ${args.approve} not found at ${previewPath}.`);
      process.exit(1);
    }
    const found = findRunHoldingTask(args.approve);
    if (!found) {
      console.error(`No active run; run pnpm auto:plan first to create one.`);
      process.exit(1);
    }
    const livePath = path.join(found.tasksDir, `${args.approve}.json`);
    fs.mkdirSync(found.tasksDir, { recursive: true });
    fs.copyFileSync(previewPath, livePath);
    fs.rmSync(previewPath);
    console.log(`✓ Approved. Pack moved to ${livePath}`);
    console.log(`  Dispatch with: pnpm auto:work ${args.approve}`);
    return;
  }

  if (args.reject) {
    const previewPath = path.join(previewDir(), `${args.reject}.json`);
    if (!fs.existsSync(previewPath)) {
      console.error(`Preview ${args.reject} not found.`);
      process.exit(1);
    }
    fs.rmSync(previewPath);
    console.log(`✗ Rejected. Preview ${args.reject} discarded.`);
    return;
  }

  // Default path: dispatch auto:plan, then redirect output to preview dir
  const planArgs = ['exec', 'tsx', path.join(harnessRoot(), 'tools', 'autonomous-delivery', 'src', 'cli', 'plan.ts'), ...args.passthrough];
  // Use the source file directly so we don't depend on package layout
  const cliPath = path.resolve(import.meta.url.replace('file://', ''), '..', 'plan.ts');
  const r = spawnSync('npx', ['-y', 'tsx', cliPath, ...args.passthrough], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  // Capture the auto:plan stdout to find the generated task_id + path
  const stdout = r.stdout || '';
  process.stdout.write(stdout);
  const idMatch = stdout.match(/Task pack generated: (TP-[\w-]+)/);
  const pathMatch = stdout.match(/Path: (\.agent-runs\/[\w-]+\/tasks\/TP-[\w-]+\.json)/);
  if (!idMatch || !pathMatch) {
    console.error('\nCould not parse plan output for task_id; preview not staged.');
    console.error(`(plan-args were: ${args.passthrough.join(' ')})`);
    process.exit(r.status ?? 1);
  }
  const taskId = idMatch[1];
  const liveRelative = pathMatch[1];
  const livePath = path.join(harnessRoot(), liveRelative);

  // Move from live → preview
  if (!fs.existsSync(livePath)) {
    console.error(`Plan claimed to write ${livePath} but file is missing.`);
    process.exit(1);
  }
  const dir = previewDir();
  fs.mkdirSync(dir, { recursive: true });
  const previewPath = path.join(dir, `${taskId}.json`);
  fs.renameSync(livePath, previewPath);

  // Pretty-print
  console.log('');
  const pack = JSON.parse(fs.readFileSync(previewPath, 'utf8'));
  prettyPrint(pack);

  console.log('───────────────────────────────────────────────────────────────');
  console.log('  Plan staged as PREVIEW (not dispatchable yet).');
  console.log('───────────────────────────────────────────────────────────────');
  console.log('');
  console.log(`  Approve:  pnpm auto:plan-preview --approve ${taskId}`);
  console.log(`  Reject:   pnpm auto:plan-preview --reject  ${taskId}`);
  console.log(`  Edit:     \${EDITOR:-vi} ${previewPath}`);
  console.log(`  List:     pnpm auto:plan-preview --list`);
  console.log('');
}

main();
