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
  objective?: string;
  mode?: 'greenfield' | 'brownfield' | 'hybrid';
  riskClass?: 'low' | 'medium' | 'high' | 'critical';
  autoFill?: boolean;
  template?: string;
  allowedPaths?: string[];
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
    else if (arg === '--objective' && i + 1 < argv.length) args.objective = argv[++i];
    else if (arg === '--mode' && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === 'greenfield' || v === 'brownfield' || v === 'hybrid') args.mode = v;
    }
    else if (arg === '--risk-class' && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === 'low' || v === 'medium' || v === 'high' || v === 'critical') args.riskClass = v;
    }
    else if (arg === '--auto-fill') args.autoFill = true;
    else if (arg === '--template' && i + 1 < argv.length) args.template = argv[++i];
    else if (arg === '--allowed-paths' && i + 1 < argv.length) args.allowedPaths = argv[++i].split(',');
  }
  if (!args.version || !args.type) {
    throw new Error(
      'Required: --version <v> --type <code-sprint|frd-polish|frd-author|test-coverage|audit-log-route>; one of --module <MXX> or --sprint <SS-N>'
    );
  }
  if (!args.module && !args.sprint) {
    throw new Error('Required: --module <MXX> or --sprint <SS-N>');
  }
  return args as PlanArgs;
}

/**
 * Read .hermes/modules/<MID>.yaml from the calling project (if present)
 * and extract allowed_paths / forbidden_paths / references / risk_class.
 *
 * Minimal YAML reader — handles the keys the init wizard writes. For
 * complex YAML, operators can pass --allowed-paths directly on the CLI.
 */
interface ModuleConfig {
  name?: string;
  mode?: string;
  risk_class?: string;
  allowed_paths?: string[];
  forbidden_paths?: string[];
  references?: { spec?: string; code_paths?: string[]; obsidian_paths?: string[] };
}

function loadModuleConfig(moduleId: string): ModuleConfig | null {
  const projectRoot = process.env.HERMES_PROJECT_ROOT || process.env.HARNESS_PROJECT_ROOT || process.cwd();
  const cfgPath = path.join(projectRoot, '.hermes', 'modules', `${moduleId}.yaml`);
  if (!fs.existsSync(cfgPath)) return null;
  try {
    const text = fs.readFileSync(cfgPath, 'utf8');
    const cfg: ModuleConfig = {};
    type Section = 'allowed_paths' | 'forbidden_paths' | 'references' | 'references.code_paths' | 'references.obsidian_paths' | null;
    let section: Section = null;
    const stripQuotes = (s: string): string => s.replace(/^['"]|['"]$/g, '');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;

      if (trimmed.startsWith('- ')) {
        const item = stripQuotes(trimmed.replace(/^-\s+/, ''));
        if (section === 'allowed_paths') (cfg.allowed_paths ??= []).push(item);
        else if (section === 'forbidden_paths') (cfg.forbidden_paths ??= []).push(item);
        else if (section === 'references.code_paths') {
          (cfg.references ??= {}).code_paths ??= []; cfg.references.code_paths!.push(item);
        }
        else if (section === 'references.obsidian_paths') {
          (cfg.references ??= {}).obsidian_paths ??= []; cfg.references.obsidian_paths!.push(item);
        }
        continue;
      }

      if (indent === 0) {
        const m = trimmed.match(/^(\w+):\s*(.*)$/);
        if (!m) { section = null; continue; }
        const [, key, value] = m;
        if (key === 'references' && !value) { section = 'references'; continue; }
        if (key === 'allowed_paths' && !value) { section = 'allowed_paths'; continue; }
        if (key === 'forbidden_paths' && !value) { section = 'forbidden_paths'; continue; }
        section = null;
        if (key === 'name') cfg.name = stripQuotes(value);
        else if (key === 'mode') cfg.mode = stripQuotes(value);
        else if (key === 'risk_class') cfg.risk_class = stripQuotes(value);
        continue;
      }

      if (section === 'references' || section === 'references.code_paths' || section === 'references.obsidian_paths') {
        const m = trimmed.match(/^(\w+):\s*(.*)$/);
        if (!m) continue;
        const [, key, value] = m;
        if (key === 'spec' && value) (cfg.references ??= {}).spec = stripQuotes(value);
        else if (key === 'code_paths' && !value) section = 'references.code_paths';
        else if (key === 'obsidian_paths' && !value) section = 'references.obsidian_paths';
      }
    }
    return cfg;
  } catch { return null; }
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

/**
 * Generic code-sprint builder. Reads `.hermes/modules/<MID>.yaml` if present
 * for allowed_paths / risk_class, otherwise falls back to sensible defaults
 * (src/<module>/**, tests/<module>/**). Works for greenfield (empty repo)
 * and brownfield (existing codebase) both.
 *
 * Operator can override key fields via CLI:
 *   --objective "<one-paragraph what to build>"
 *   --mode greenfield|brownfield|hybrid
 *   --risk-class low|medium|high|critical
 *   --allowed-paths "src/auth/**,tests/auth/**"
 */
function buildCodeSprintPack(args: PlanArgs, runId: string, taskId: string): TaskPack {
  if (!args.module) throw new Error('code-sprint requires --module');
  const moduleSlug = args.module.toLowerCase();
  const cfg = loadModuleConfig(args.module);

  const objective = args.objective ?? `Implement ${args.module} per its spec at docs/specs/${args.module}/SPEC.md. Every acceptance criterion testable; coverage on changed files ≥70%; lint + typecheck pass; no new HIGH/CRITICAL CVEs.`;
  const mode = args.mode ?? (cfg?.mode === 'greenfield' || cfg?.mode === 'brownfield' || cfg?.mode === 'hybrid' ? cfg.mode : 'brownfield');
  const riskClass = args.riskClass ?? (cfg?.risk_class === 'low' || cfg?.risk_class === 'medium' || cfg?.risk_class === 'high' || cfg?.risk_class === 'critical' ? cfg.risk_class : 'medium');

  const allowedPaths = args.allowedPaths
    ?? cfg?.allowed_paths
    ?? [
      `src/${moduleSlug}/**`,
      `src/**/${moduleSlug}/**`,
      `tests/${moduleSlug}/**`,
      `tests/**/${moduleSlug}/**`,
      `__tests__/${moduleSlug}/**`,
    ];

  const forbiddenPaths = cfg?.forbidden_paths ?? [
    '.hermes/**',
    '.github/**',
    'node_modules/**',
    'dist/**',
    'package.json',     // deps changes need separate review
    'package-lock.json',
    'pnpm-lock.yaml',
  ];

  const specPath = cfg?.references?.spec ?? `docs/specs/${args.module}/SPEC.md`;

  return TaskPack.parse({
    task_id: taskId,
    run_id: runId,
    type: 'code-sprint' as TaskType,
    module_or_sprint: `${args.module}-impl-${args.version}`,
    version_target: args.version,
    mode,
    risk_class: riskClass,
    role: 'feature-add',
    objective,
    acceptance_criteria: [
      `Every requirement in ${specPath} has corresponding code (function, type, route, test)`,
      `Lint passes: pnpm lint (or project's lint command)`,
      `Tests pass: pnpm test (or project's test command)`,
      `Coverage on changed files ≥70%`,
      `No new HIGH/CRITICAL CVEs introduced (pnpm audit --audit-level=high)`,
      `No files outside allowed_paths modified`,
      `Diff is reviewable — break large changes into commits ≤200 lines each`,
    ],
    allowed_paths: allowedPaths,
    forbidden_paths: forbiddenPaths,
    context_budget: ContextBudget.parse({
      max_task_pack_kb: 12,
      max_log_summary_kb: 8,
      max_codex_bundle_kb: 64,
    }),
    references: References.parse({
      frd_path: specPath,
      code_paths: cfg?.references?.code_paths ?? [],
      obsidian_paths: cfg?.references?.obsidian_paths ?? [],
    }),
    commands: Commands.parse({
      duplicate_scan: `grep -rn "${moduleSlug}" src/ 2>/dev/null | head -10`,
      implement: [
        `# Worker reads ${specPath} (or asks operator for the spec)`,
        `# Worker implements within allowed_paths`,
        `# Worker writes tests in __tests__ or tests/ alongside source`,
      ],
      test: ['pnpm test', 'npm test'],
      typecheck: 'pnpm exec tsc --noEmit',
      lint: 'pnpm lint',
    }),
    consensus: Consensus.parse({
      reviewer: 'codex-5.5-xhigh',
      prompt_template: 'templates/prompts/feature-add.yaml',
      gate_threshold: riskClass === 'critical' ? 8.0 : riskClass === 'high' ? 7.5 : 7.0,
      max_rounds: 3,
    }),
    state: 'planned',
    state_history: [
      {
        from: 'unplanned',
        to: 'planned',
        at: new Date().toISOString(),
        by: 'orchestrator',
        reason: `auto:plan generated code-sprint pack for ${args.module} ${args.version} (mode=${mode}, risk=${riskClass})`,
      },
    ],
    evidence_dir: evidenceDir(runId, taskId),
    notes: cfg ? [{ at: new Date().toISOString(), by: 'auto:plan', text: `Loaded config from .hermes/modules/${args.module}.yaml` }] : [],
  });
}

/**
 * Generic test-coverage builder — adds tests for an existing module without
 * changing source. Mirrors the bug-fix template's "tests only" constraint.
 */
function buildTestCoveragePack(args: PlanArgs, runId: string, taskId: string): TaskPack {
  if (!args.module) throw new Error('test-coverage requires --module');
  const moduleSlug = args.module.toLowerCase();
  const cfg = loadModuleConfig(args.module);
  const allowedPaths = args.allowedPaths
    ?? [
      `tests/${moduleSlug}/**`,
      `tests/**/${moduleSlug}/**`,
      `__tests__/${moduleSlug}/**`,
      `src/${moduleSlug}/**/__tests__/**`,
      `src/${moduleSlug}/**/*.test.ts`,
      `src/${moduleSlug}/**/*.spec.ts`,
    ];

  return TaskPack.parse({
    task_id: taskId,
    run_id: runId,
    type: 'test-coverage' as TaskType,
    module_or_sprint: `${args.module}-tests-${args.version}`,
    version_target: args.version,
    mode: args.mode ?? 'brownfield',
    risk_class: args.riskClass ?? 'low',
    role: 'test-coverage',
    objective: args.objective ?? `Add Vitest/Jest tests for ${args.module} module to bring coverage to ≥80%. Tests only — production source MUST NOT change. Discovered bugs documented in risk-register.md, not fixed.`,
    acceptance_criteria: [
      `Coverage on ${moduleSlug} ≥80% (statements, branches, lines)`,
      `No production source files modified (git diff --stat src/ | grep -v test)`,
      `All new tests deterministic (run 3× without flake)`,
      `Discovered bugs documented in risk-register.md`,
    ],
    allowed_paths: allowedPaths,
    forbidden_paths: [
      '.hermes/**',
      '.github/**',
      'package.json',
      `src/${moduleSlug}/**/!(*.test.ts|*.spec.ts|__tests__/**)`,  // production source forbidden
    ],
    context_budget: ContextBudget.parse({ max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 }),
    references: References.parse({ frd_path: cfg?.references?.spec ?? `docs/specs/${args.module}/SPEC.md`, code_paths: cfg?.references?.code_paths ?? [], obsidian_paths: [] }),
    commands: Commands.parse({
      duplicate_scan: `grep -rn "${moduleSlug}" tests/ 2>/dev/null | head -10`,
      test: ['pnpm test', 'npm test'],
      typecheck: 'pnpm exec tsc --noEmit',
      lint: 'pnpm lint',
    }),
    consensus: Consensus.parse({ reviewer: 'codex-5.5-xhigh', prompt_template: 'templates/prompts/test-coverage.yaml', gate_threshold: 7.0, max_rounds: 2 }),
    state: 'planned',
    state_history: [{ from: 'unplanned', to: 'planned', at: new Date().toISOString(), by: 'orchestrator', reason: `auto:plan generated test-coverage pack for ${args.module} ${args.version}` }],
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
    case 'code-sprint':
      pack = buildCodeSprintPack(args, runId, taskId);
      break;
    case 'test-coverage':
      pack = buildTestCoveragePack(args, runId, taskId);
      break;
    default:
      throw new Error(
        `Task type ${args.type} not yet implemented in v0.1. Supported: frd-polish, frd-author, code-sprint, test-coverage, audit-log-route. Extend src/cli/plan.ts to add more.`
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
