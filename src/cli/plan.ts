#!/usr/bin/env node
/**
 * pnpm auto:plan — generate a task pack from a known module/sprint.
 *
 * Usage:
 *   pnpm auto:plan --module M02 --version v0.8 --type frd-polish [--run-id <id>]
 *   pnpm auto:plan --sprint AA-2 --version round-1 --type audit-log-route
 *
 * v0.1 supports:
 *   - frd-polish: takes a module + version, generates task pack from CODEX-REVIEW R{N-1} fold-in plan
 *   - frd-author: takes a module, generates task pack from skeleton FRD
 *   - audit-log-route: takes a sprint number, generates task pack from C29 inventory
 *
 * Future versions:
 *   - frd-reconcile: FRD vs shipped-impl reconciliation
 *   - code-sprint: from sprint backlog
 *   - test-coverage: from untested-module inventory
 *   - platform-doc: from NBF-* inventory
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TaskPack,
  TaskType,
  ContextBudget,
  References,
  Commands,
  Consensus,
  nextTaskId,
  checkSizeBudget,
} from '../lib/taskPack';
import {
  createRun,
  writeTaskPack,
  evidenceDir,
  listRuns,
  readManifest,
  tasksDir as tasksDirAbs,
} from '../lib/runState';

interface PlanArgs {
  module?: string;
  sprint?: string;
  version: string;
  type: TaskType;
  runId?: string;
}

function parseArgs(argv: string[]): PlanArgs {
  const args: Partial<PlanArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--module' && i + 1 < argv.length) args.module = argv[++i];
    else if (arg === '--sprint' && i + 1 < argv.length) args.sprint = argv[++i];
    else if (arg === '--version' && i + 1 < argv.length) args.version = argv[++i];
    else if (arg === '--type' && i + 1 < argv.length) args.type = argv[++i] as TaskType;
    else if (arg === '--run-id' && i + 1 < argv.length) args.runId = argv[++i];
  }
  if (!args.version || !args.type) {
    throw new Error(
      'Required: --version <v> --type <frd-polish|frd-author|audit-log-route>; one of --module <MXX> or --sprint <SS-N>'
    );
  }
  if (!args.module && !args.sprint) {
    throw new Error('Required: --module <MXX> or --sprint <SS-N>');
  }
  return args as PlanArgs;
}

function todayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function ensureRun(runId?: string): string {
  if (runId) {
    // Verify it exists
    try {
      readManifest(runId);
      return runId;
    } catch {
      console.warn(`Run ${runId} does not exist; creating it.`);
    }
  }
  const finalRunId = runId || `${todayUtc().toISOString().slice(0, 10)}-batch-1`;
  try {
    createRun({
      run_id: finalRunId,
      created_at: new Date().toISOString(),
      owner: process.env.USER || 'orchestrator',
      scope: 'FRD authoring + code sprints (general purpose)',
      budget: { max_concurrent_workers: 3, target_task_count: 10 },
    });
    console.log(`Created run: ${finalRunId}`);
  } catch {
    // Already exists
  }
  return finalRunId;
}

function nextSequence(runId: string): number {
  const dir = tasksDirAbs(runId); // absolute path resolved against REPO_ROOT
  if (!fs.existsSync(dir)) return 1;
  const today = todayUtc().toISOString().slice(0, 10);
  const todayTasks = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`TP-${today}-`));
  return todayTasks.length + 1;
}

function buildFrdPolishPack(args: PlanArgs, runId: string, taskId: string): TaskPack {
  if (!args.module) throw new Error('frd-polish requires --module');
  const moduleSlug = args.module.toLowerCase();

  // Note: paths use ~ for the user-readable docs. Worker resolves to absolute.
  return TaskPack.parse({
    task_id: taskId,
    run_id: runId,
    type: 'frd-polish' as TaskType,
    module_or_sprint: `${args.module}-${args.version}`,
    version_target: args.version,
    objective: `Apply Codex R{N-1} fold-in plan items to ${args.module}; target Codex GO ≥ gate threshold. Surgical edits only; no scope creep beyond the documented fold-in plan.`,
    acceptance_criteria: [
      `Each fold-in item from CODEX-REVIEW R{N-1} fold-in plan is addressed (LANDED or explicitly DEFERRED with reason)`,
      `frontmatter status field bumped to next version (e.g., v0.7 → v0.8)`,
      `frontmatter codex_score_r{N} + codex_verdict_r{N} populated after Codex review`,
      `CODEX-REVIEW.md appended with Round {N} section (verdict text + per-item assessment + fold-in plan for next round)`,
      `Cross-module reciprocity status confirmed PASS by Codex`,
      `Empty marker commit on docs/frd-${moduleSlug}-auth branch with summary commit message`,
    ],
    allowed_paths: [
      `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/FRD-${args.module}.md`,
      `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/CODEX-REVIEW.md`,
      `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/SIGNOFFS.md`,
      `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/GAP.md`,
    ],
    forbidden_paths: [
      'NEXT-SESSION.md',
      'ROADMAP.md',
      `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-M0[1-9]-*/FRD-M*.md`, // sibling FRDs
    ],
    context_budget: ContextBudget.parse({
      max_task_pack_kb: 8,
      max_log_summary_kb: 4,
      max_codex_bundle_kb: 32,
    }),
    references: References.parse({
      frd_path: `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/FRD-${args.module}.md`,
      obsidian_paths: [
        `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/CODEX-REVIEW.md`,
        `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/SIGNOFFS.md`,
        `${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-${args.module}-*/GAP.md`,
      ],
      code_paths: [],
    }),
    commands: Commands.parse({
      duplicate_scan: `# FRD-polish tasks don't typically need code-duplicate scan; verify FR citations against repo if FRs claim shipped`,
      test: ['# No tests required for FRD-polish task type — verification is via Codex consensus'],
      typecheck: 'pnpm -w typecheck', // sanity only; doc changes don't break typecheck
    }),
    consensus: Consensus.parse({
      reviewer: 'codex-5.5-xhigh',
      prompt_template: 'tools/autonomous-delivery/templates/codex-frd-polish-review.txt',
      gate_threshold: 7.0,
      max_rounds: 2,
    }),
    state: 'planned',
    state_history: [
      {
        from: 'unplanned',
        to: 'planned',
        at: new Date().toISOString(),
        by: 'orchestrator',
        reason: `auto:plan generated frd-polish pack for ${args.module} ${args.version}`,
      },
    ],
    evidence_dir: evidenceDir(runId, taskId),
    notes: [],
  });
}

function buildAuditLogRoutePack(args: PlanArgs, runId: string, taskId: string): TaskPack {
  if (!args.sprint) throw new Error('audit-log-route requires --sprint');
  // Sprint AA-N pattern: each sprint covers ~3 mutation routes
  return TaskPack.parse({
    task_id: taskId,
    run_id: runId,
    type: 'audit-log-route' as TaskType,
    module_or_sprint: `Sprint-${args.sprint}`,
    version_target: args.version,
    objective: `Add BCBS 239 appendAuditLog calls to 3 mutation routes per Sprint AA-${args.sprint} scope. Pattern is established from Sprint AA-1 (commit fd9deac); each route gets try/catch audit on success + failure paths.`,
    acceptance_criteria: [
      `Each route imports appendAuditLog from @nbf/security`,
      `Each mutation route awaits appendAuditLog before returning success response`,
      `Each error path also awaits appendAuditLog with error reason`,
      `Per-route unit test covers audit log call (mock the audit function; assert called with correct shape)`,
      `pnpm -F @nbf/web test passes (existing 2058 + new tests)`,
      `pnpm -F @nbf/web lint passes`,
      `pnpm -w typecheck passes`,
    ],
    allowed_paths: [
      'apps/web/src/app/api/**/route.ts',
      'apps/web/src/app/api/**/__tests__/*.test.ts',
    ],
    forbidden_paths: [
      'NEXT-SESSION.md',
      'ROADMAP.md',
      'apps/web/src/lib/**', // shared libs untouched
    ],
    context_budget: ContextBudget.parse({
      max_task_pack_kb: 8,
      max_log_summary_kb: 4,
      max_codex_bundle_kb: 32,
    }),
    references: References.parse({
      code_paths: [
        'apps/web/src/lib/security/audit.ts', // appendAuditLog source
        'apps/web/src/app/api/cube/write/route.ts', // Sprint AA-1 reference impl
        '/tmp/codex-c29-aa-bb.md', // C29 corrected route inventory
      ],
      obsidian_paths: [],
      prior_codex_output: '/tmp/codex-c29-aa-bb.md',
    }),
    commands: Commands.parse({
      duplicate_scan:
        'grep -rn "appendAuditLog" apps/web/src/app/api/ | head -20  # surface existing audit-logged routes to avoid double-instrumenting',
      test: ['pnpm -F @nbf/web test --run apps/web/src/app/api'],
      typecheck: 'pnpm -F @nbf/web typecheck',
      lint: 'pnpm -F @nbf/web lint',
    }),
    consensus: Consensus.parse({
      reviewer: 'codex-5.5-xhigh',
      prompt_template: 'tools/autonomous-delivery/templates/codex-audit-log-review.txt',
      gate_threshold: 7.5, // higher bar — production code, not docs
      max_rounds: 2,
    }),
    state: 'planned',
    state_history: [
      {
        from: 'unplanned',
        to: 'planned',
        at: new Date().toISOString(),
        by: 'orchestrator',
        reason: `auto:plan generated audit-log-route pack for Sprint ${args.sprint}`,
      },
    ],
    evidence_dir: evidenceDir(runId, taskId),
    notes: [],
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = ensureRun(args.runId);
  const seq = nextSequence(runId);
  const taskId = nextTaskId(todayUtc(), seq);

  let pack: TaskPack;
  switch (args.type) {
    case 'frd-polish':
    case 'frd-author':
      pack = buildFrdPolishPack(args, runId, taskId);
      break;
    case 'audit-log-route':
      pack = buildAuditLogRoutePack(args, runId, taskId);
      break;
    default:
      throw new Error(
        `Task type ${args.type} not yet implemented in v0.1. Supported: frd-polish, frd-author, audit-log-route. Extend src/cli/plan.ts to add more.`
      );
  }

  // Validate size budget
  const sizeError = checkSizeBudget(pack);
  if (sizeError) {
    console.error(`ERROR: ${sizeError}`);
    process.exit(1);
  }

  // Persist
  writeTaskPack(pack);

  console.log(`✓ Task pack generated: ${taskId}`);
  console.log(`  Run: ${runId}`);
  console.log(`  Type: ${args.type}`);
  console.log(`  Module/Sprint: ${pack.module_or_sprint}`);
  console.log(`  Path: .agent-runs/${runId}/tasks/${taskId}.json`);
  console.log(`  Evidence dir: ${pack.evidence_dir}`);
  console.log(``);
  console.log(`Next: pnpm auto:claim ${taskId}`);
}

main();
