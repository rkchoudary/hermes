#!/usr/bin/env node
/**
 * pnpm auto:onboard — new-project wizard.
 *
 * Sets up a fresh consumer project to use the harness:
 *   1. Detects target project root (HARNESS_PROJECT_ROOT or cwd)
 *   2. Creates .agent-runs/ directory + initial run
 *   3. Seeds default _model-inventory.json (with placeholders for operator)
 *   4. Seeds default _budget.json
 *   5. Seeds default _goal.json (optional)
 *   6. Authors a sample task pack template
 *   7. Verifies Claude Code CLI / gh / Codex CLI availability
 *   8. Prints quickstart instructions
 *
 * Usage:
 *   pnpm auto:onboard                         # interactive
 *   pnpm auto:onboard --project /path         # explicit root
 *   pnpm auto:onboard --apply                 # actually write files
 *   pnpm auto:onboard --json                  # machine-readable
 *
 * Idempotent: re-running is safe; existing files are NOT overwritten unless --force.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
void __dirname;

interface Args {
  project?: string;
  apply: boolean;
  force: boolean;
  json: boolean;
  with_goal: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { apply: false, force: false, json: false, with_goal: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--apply') a.apply = true;
    else if (x === '--force') a.force = true;
    else if (x === '--json') a.json = true;
    else if (x === '--with-goal') a.with_goal = true;
    else if (x === '--project' && i + 1 < argv.length) a.project = path.resolve(argv[++i]);
  }
  return a;
}

interface Toolcheck {
  tool: string;
  cmd: string[];
  required: boolean;
  installed: boolean;
  version?: string;
  hint?: string;
}

function checkTools(): Toolcheck[] {
  // Codex (`/Applications/Codex.app/Contents/Resources/codex`) is reachable via
  // the bundled .app on macOS even when not on PATH. Add that path explicitly
  // so first-run-experience doesn't fail prereq doctor when the user installed
  // the GUI but not a shell symlink.
  const codexCandidatePaths = [
    'codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ];
  const probes: Array<Omit<Toolcheck, 'installed' | 'version'>> = [
    { tool: 'pnpm', cmd: ['pnpm', '--version'], required: true, hint: 'Install: npm install -g pnpm' },
    { tool: 'git', cmd: ['git', '--version'], required: true, hint: 'Install: brew install git (or apt/yum)' },
    { tool: 'node (>= 20)', cmd: ['node', '--version'], required: true, hint: 'Node 20+ required' },
    { tool: 'claude (Claude Code CLI)', cmd: ['claude', '--version'], required: true, hint: 'Install: https://github.com/anthropics/claude-code' },
    { tool: 'gh (GitHub CLI)', cmd: ['gh', '--version'], required: false, hint: 'Install: brew install gh — required for auto:land + auto:monitor-pr' },
    {
      tool: 'codex (Codex CLI)',
      cmd: codexCandidatePaths,
      required: false,
      hint: 'Install: https://github.com/openai/codex — REQUIRED for auto:consensus. Without it, consensus dispatch FAILS LOUDLY at first invocation. Set AUTO_REVIEWER=manual to use prompt-paste mode in the meantime.',
    },
    { tool: 'vercel (Vercel CLI)', cmd: ['vercel', '--version'], required: false, hint: 'Install: npm install -g vercel — required for auto:monitor-pr Vercel checks' },
  ];
  return probes.map((p) => {
    try {
      // Try each candidate path in order; first one that exits 0 wins. Lets us
      // probe both `codex` (PATH) and `/Applications/Codex.app/.../codex`
      // (macOS GUI bundle) with one Toolcheck row.
      const candidates = p.cmd.length > 1 && !p.cmd[0].startsWith('--') && !p.cmd[1]?.startsWith('--')
        ? p.cmd  // Multiple candidate binaries (only used for codex above)
        : [p.cmd[0]];
      for (const candidate of candidates) {
        const r = spawnSync(candidate, p.cmd.slice(1).filter((a) => a.startsWith('--')), { encoding: 'utf8', timeout: 3000 });
        if (r.status === 0) {
          const version = (r.stdout ?? '').trim().split('\n')[0];
          // For node, also enforce ≥ 20.
          if (p.tool.startsWith('node')) {
            const m = version.match(/v(\d+)\./);
            if (m && parseInt(m[1], 10) < 20) {
              return { ...p, installed: false, version, hint: `Detected ${version} but Node 20+ required` };
            }
          }
          return { ...p, installed: true, version };
        }
      }
      return { ...p, installed: false };
    } catch {
      return { ...p, installed: false };
    }
  });
}

function defaultModelInventory(): unknown {
  return {
    schema_version: '1',
    models: [
      {
        engine: 'claude-code-cli',
        model_id: 'claude-opus-4-7',
        qualified_at: new Date().toISOString(),
        qualified_by: 'auto:onboard',
        qualification_reason: 'Default impl-worker. Routes through Claude Code Max subscription (no API billing). REPLACE this entry with project-specific qualification rationale before SR-11/7-bound use.',
        roles: ['impl-worker'],
      },
      {
        engine: 'codex-cli',
        model_id: 'gpt-5.5',
        qualified_at: new Date().toISOString(),
        qualified_by: 'auto:onboard',
        qualification_reason: 'Default consensus reviewer. xhigh reasoning effort. REPLACE before SR-11/7-bound use.',
        roles: ['codex-reviewer', 'consensus'],
      },
    ],
    enforce: true,
    last_reviewed_at: new Date().toISOString(),
    last_reviewed_by: 'auto:onboard',
  };
}

function defaultBudget(): unknown {
  return {
    schema_version: '1',
    description: 'Default budget — daily $50, weekly $250, monthly $800. Adjust per project economics.',
    windows: [
      { period: 'daily', cap_usd: 50 },
      { period: 'weekly', cap_usd: 250 },
      { period: 'monthly', cap_usd: 800 },
    ],
    cost_per_output_byte_usd: {
      'claude-cli': 0.000015,
      'claude-agent-sdk': 0.000015,
      'codex-cli': 0.000020,
    },
    actions_on_threshold: {
      warning_pct: 0.50,
      engaged_pct: 0.80,
      exhausted_pct: 1.00,
      action: 'engage-kill-switch',
    },
  };
}

function defaultGoal(projectName: string): unknown {
  return {
    schema_version: '1',
    name: `${projectName} v1`,
    description: `Top-level goal for ${projectName}. Edit to match your actual delivery target.`,
    criteria: [
      { id: 'all-tasks-merged', description: 'All planned task packs reach merged state', target: 1, current: 0, source: 'task-state' },
    ],
  };
}

function sampleTaskPack(today: string): unknown {
  return {
    schema_version: '1',
    task_id: `TP-${today}-001`,
    run_id: `${today}-batch-1`,
    type: 'code-sprint',
    module_or_sprint: 'M01-hello-world',
    version_target: 'v0.1.0',
    objective: 'First task pack — replace this with your real objective. Surgical edits only; tight scope.',
    acceptance_criteria: [
      'Replace this acceptance criterion with the actual testable outcome',
      'Codex review GO ≥ 7.0',
    ],
    allowed_paths: ['src/**/*.ts'],
    forbidden_paths: ['secrets/**', '.env*'],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: ['pnpm test'], typecheck: 'pnpm exec tsc --noEmit' },
    consensus: {
      reviewer: 'codex-5.5-xhigh',
      prompt_template: 'tools/autonomous-delivery/templates/codex-code-sprint-review.txt',
      gate_threshold: 7,
      max_rounds: 5,
    },
    state: 'planned',
    state_history: [
      { from: 'unplanned', to: 'planned', at: new Date().toISOString(), by: 'auto:onboard', reason: 'Sample task pack — REPLACE with your real task.' },
    ],
    evidence_dir: '',
    actors: { reviewers: [], approvers: [] },
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    notes: [],
  };
}

function writeIfMissing(p: string, content: string, force: boolean): { wrote: boolean; reason: string } {
  if (fs.existsSync(p) && !force) {
    return { wrote: false, reason: `exists (pass --force to overwrite)` };
  }
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, content);
  return { wrote: true, reason: 'created' };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.project ?? process.env.HARNESS_PROJECT_ROOT ?? process.cwd();
  const projectName = path.basename(projectRoot);
  const today = new Date().toISOString().slice(0, 10);
  const runId = `${today}-batch-1`;
  const agentRunsDir = path.join(projectRoot, '.agent-runs');

  const tools = checkTools();
  const missingRequired = tools.filter((t) => t.required && !t.installed);
  const missingOptional = tools.filter((t) => !t.required && !t.installed);

  const plan: Array<{ path: string; description: string; would_write: boolean }> = [
    { path: path.join(agentRunsDir, runId, 'tasks'), description: 'tasks directory', would_write: true },
    { path: path.join(agentRunsDir, runId, 'evidence'), description: 'evidence directory', would_write: true },
    { path: path.join(agentRunsDir, '_model-inventory.json'), description: 'default model inventory (PUB-10 SR-11/7)', would_write: !fs.existsSync(path.join(agentRunsDir, '_model-inventory.json')) || args.force },
    { path: path.join(agentRunsDir, '_budget.json'), description: 'default budget contract (M9)', would_write: !fs.existsSync(path.join(agentRunsDir, '_budget.json')) || args.force },
    { path: path.join(agentRunsDir, runId, 'tasks', `TP-${today}-001.json`), description: 'sample task pack', would_write: !fs.existsSync(path.join(agentRunsDir, runId, 'tasks', `TP-${today}-001.json`)) || args.force },
  ];
  if (args.with_goal) {
    plan.push({ path: path.join(agentRunsDir, '_goal.json'), description: 'default goal contract (LRA-5)', would_write: !fs.existsSync(path.join(agentRunsDir, '_goal.json')) || args.force });
  }

  if (args.json) {
    console.log(JSON.stringify({ project_root: projectRoot, project_name: projectName, run_id: runId, tools, plan, apply: args.apply, missing_required: missingRequired.length, missing_optional: missingOptional.length }, null, 2));
    return;
  }

  console.log(`══════════════════════════════════════════════════════════════════════════`);
  console.log(`  auto:onboard — ${projectName}`);
  console.log(`══════════════════════════════════════════════════════════════════════════\n`);
  console.log(`Project root: ${projectRoot}`);
  console.log(`Initial run:  ${runId}\n`);

  console.log(`1️⃣  Tool check:`);
  for (const t of tools) {
    const icon = t.installed ? '✓' : t.required ? '✗' : '⚠';
    const ver = t.version ? ` (${t.version})` : '';
    console.log(`   ${icon} ${t.tool.padEnd(28)} ${t.installed ? 'INSTALLED' + ver : 'MISSING' + (t.required ? ' (REQUIRED)' : ' (optional)')}`);
    if (!t.installed && t.hint) console.log(`     → ${t.hint}`);
  }

  if (missingRequired.length > 0) {
    console.error(`\n❌ ${missingRequired.length} required tool(s) missing — install them before re-running auto:onboard --apply.`);
    process.exit(1);
  }

  console.log(`\n2️⃣  File plan:`);
  for (const p of plan) {
    const icon = p.would_write ? '+' : '·';
    console.log(`   ${icon} ${p.path.replace(projectRoot, '$ROOT')}`);
    console.log(`     ${p.description}${p.would_write ? '' : ' (already exists; pass --force to overwrite)'}`);
  }

  if (!args.apply) {
    console.log(`\n[onboard] DRY-RUN — re-run with --apply to write files.`);
    return;
  }

  console.log(`\n3️⃣  Writing files…`);
  // Create dirs
  for (const dir of [agentRunsDir, path.join(agentRunsDir, runId), path.join(agentRunsDir, runId, 'tasks'), path.join(agentRunsDir, runId, 'evidence')]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const inv = writeIfMissing(path.join(agentRunsDir, '_model-inventory.json'), JSON.stringify(defaultModelInventory(), null, 2), args.force);
  console.log(`   ${inv.wrote ? '✓' : '·'} _model-inventory.json — ${inv.reason}`);
  const bud = writeIfMissing(path.join(agentRunsDir, '_budget.json'), JSON.stringify(defaultBudget(), null, 2), args.force);
  console.log(`   ${bud.wrote ? '✓' : '·'} _budget.json — ${bud.reason}`);
  if (args.with_goal) {
    const goal = writeIfMissing(path.join(agentRunsDir, '_goal.json'), JSON.stringify(defaultGoal(projectName), null, 2), args.force);
    console.log(`   ${goal.wrote ? '✓' : '·'} _goal.json — ${goal.reason}`);
  }
  const samplePackPath = path.join(agentRunsDir, runId, 'tasks', `TP-${today}-001.json`);
  const sample = sampleTaskPack(today) as { evidence_dir: string };
  sample.evidence_dir = path.join(agentRunsDir, runId, 'evidence', `TP-${today}-001`);
  const tp = writeIfMissing(samplePackPath, JSON.stringify(sample, null, 2), args.force);
  console.log(`   ${tp.wrote ? '✓' : '·'} TP-${today}-001.json — ${tp.reason}`);

  console.log(`\n══════════════════════════════════════════════════════════════════════════`);
  console.log(`  ✅ Onboarding complete.`);
  console.log(`══════════════════════════════════════════════════════════════════════════\n`);
  console.log(`Quickstart:`);
  console.log(`  1. Edit ${path.join(agentRunsDir, runId, 'tasks', `TP-${today}-001.json`).replace(projectRoot, '$ROOT')} to describe your real first task`);
  console.log(`  2. Edit ${path.join(agentRunsDir, '_model-inventory.json').replace(projectRoot, '$ROOT')} qualification reasons`);
  console.log(`  3. Edit ${path.join(agentRunsDir, '_budget.json').replace(projectRoot, '$ROOT')} to your actual cost ceilings`);
  console.log(`  4. Run a sanity check:`);
  console.log(`       export HARNESS_PROJECT_ROOT="${projectRoot}"`);
  console.log(`       pnpm auto:health`);
  console.log(`  5. Dispatch your first task:`);
  console.log(`       pnpm auto:work TP-${today}-001`);
  console.log(`       pnpm auto:consensus TP-${today}-001 --gate completion --apply`);
  console.log(`  6. Or use the single-entry-point:`);
  console.log(`       pnpm auto:start --dispatch-next`);
  console.log('');
  if (missingOptional.length > 0) {
    console.log(`⚠ Optional tools missing (some features unavailable):`);
    for (const t of missingOptional) console.log(`  - ${t.tool}${t.hint ? ` — ${t.hint}` : ''}`);
  }
}

try { main(); }
catch (e) {
  console.error(`[onboard] error: ${(e as Error).message}`);
  process.exit(1);
}
