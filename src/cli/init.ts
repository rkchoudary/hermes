#!/usr/bin/env node
/**
 * pnpm hermes:init  (or: npx hermes init)
 *
 * Onboarding wizard for new users. Detects whether the calling repo is
 * greenfield (no commits beyond initial) or brownfield (has source code),
 * generates .hermes/config.yaml, scaffolds .hermes/modules/ and
 * .hermes/prompts/, writes a starter task pack the user can dispatch
 * immediately, and prints the next-step menu.
 *
 * Idempotent: safe to re-run; existing files are preserved unless --force.
 *
 * Flags:
 *   --force          Overwrite existing .hermes/ files
 *   --quiet          Suppress prose; print only the next-step block
 *   --no-task        Don't scaffold the starter task pack
 *   --mode <m>       Force mode (greenfield | brownfield); skips detection
 *   --module <id>    Use this module ID for the starter pack (default M01)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

interface InitArgs {
  force: boolean;
  quiet: boolean;
  noTask: boolean;
  mode: 'greenfield' | 'brownfield' | 'auto';
  module: string;
  scan: boolean;
}

function parseArgs(argv: string[]): InitArgs {
  const a: InitArgs = { force: false, quiet: false, noTask: false, mode: 'auto', module: 'M01', scan: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--force') a.force = true;
    else if (x === '--quiet') a.quiet = true;
    else if (x === '--no-task') a.noTask = true;
    else if (x === '--scan') a.scan = true;
    else if (x === '--mode' && i + 1 < argv.length) {
      const v = argv[++i];
      if (v === 'greenfield' || v === 'brownfield') a.mode = v;
    }
    else if (x === '--module' && i + 1 < argv.length) a.module = argv[++i];
    else if (x === '-h' || x === '--help') {
      console.log(`hermes init [--force] [--quiet] [--no-task] [--scan] [--mode greenfield|brownfield] [--module M01]

Bootstrap a Hermes setup in the current directory. Detects greenfield vs
brownfield, writes .hermes/config.yaml + module structure, and scaffolds
a starter task pack you can dispatch immediately.

  --scan    For brownfield repos: scan existing source tree and propose
            a multi-module breakdown (one .hermes/modules/<MID>.yaml per
            top-level subsystem detected). Operator can edit before use.

Idempotent. Re-running without --force is safe.`);
      process.exit(0);
    }
  }
  return a;
}

interface ScanProposal {
  modules: Array<{ id: string; name: string; allowed_paths: string[]; risk_class: 'low' | 'medium' | 'high' | 'critical'; rationale: string }>;
  warnings: string[];
}

function scanRepo(cwd: string): ScanProposal {
  const proposal: ScanProposal = { modules: [], warnings: [] };

  // Identify top-level subsystems by directory structure + common conventions
  const candidates: Array<{ dir: string; idHint: string; rationale: string; pathGlob: string; risk: 'low' | 'medium' | 'high' | 'critical' }> = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(cwd, { withFileTypes: true }); }
  catch { proposal.warnings.push('cannot read repo root'); return proposal; }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build' || e.name === 'tmp' || e.name === 'docs') continue;

    // Recognize common monorepo conventions
    if (e.name === 'apps' || e.name === 'packages' || e.name === 'services' || e.name === 'modules' || e.name === 'crates') {
      try {
        for (const sub of fs.readdirSync(path.join(cwd, e.name), { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          if (sub.name.startsWith('.')) continue;
          const idHint = sub.name.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 30);
          candidates.push({
            dir: path.join(e.name, sub.name),
            idHint,
            rationale: `top-level ${e.name}/ subsystem`,
            pathGlob: `${e.name}/${sub.name}/**`,
            risk: e.name === 'services' || sub.name.match(/auth|payment|checkout|billing|crypto/i) ? 'high' : 'medium',
          });
        }
      } catch { /* skip */ }
    } else if (e.name === 'src' || e.name === 'lib') {
      // Single-package layout: don't subdivide; one module covers it
      candidates.push({
        dir: e.name,
        idHint: 'core',
        rationale: 'main source tree',
        pathGlob: `${e.name}/**`,
        risk: 'medium',
      });
    } else if (['app', 'web', 'api', 'server', 'client', 'mobile', 'cli', 'workers', 'jobs', 'cron'].includes(e.name)) {
      candidates.push({
        dir: e.name,
        idHint: e.name,
        rationale: `top-level ${e.name}/ subsystem`,
        pathGlob: `${e.name}/**`,
        risk: e.name === 'api' || e.name === 'server' ? 'high' : 'medium',
      });
    }
  }

  if (candidates.length === 0) {
    proposal.warnings.push('no recognizable subsystems detected; defaulting to single-module M01 covering src/**');
    return proposal;
  }

  // Cap at 20 modules (reasonable upper bound for an init scan)
  if (candidates.length > 20) {
    proposal.warnings.push(`scan found ${candidates.length} subsystems; capping at first 20 — edit .hermes/modules/ to add more`);
    candidates.splice(20);
  }

  candidates.forEach((c, idx) => {
    const id = `M${String(idx + 1).padStart(2, '0')}-${c.idHint}`.slice(0, 30);
    proposal.modules.push({
      id,
      name: `${id} — ${c.rationale}`,
      allowed_paths: [c.pathGlob, c.pathGlob.replace('/**', '/__tests__/**')],
      risk_class: c.risk,
      rationale: c.rationale,
    });
  });

  return proposal;
}

function detectMode(cwd: string): { mode: 'greenfield' | 'brownfield'; signals: string[] } {
  const signals: string[] = [];
  let codeFiles = 0;
  const codeExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.cs', '.rb', '.php', '.cpp', '.c', '.h'];

  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === 'build') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (codeExts.includes(path.extname(e.name).toLowerCase())) codeFiles++;
    }
  };
  walk(cwd, 0);

  // Git history signal
  let commitCount = 0;
  try {
    const r = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' });
    if (r.status === 0) commitCount = parseInt(r.stdout.trim(), 10) || 0;
  } catch { /* skip */ }

  signals.push(`code-files-found=${codeFiles}`);
  signals.push(`git-commits=${commitCount}`);

  // Heuristic: brownfield if >5 source files OR >3 commits
  const isBrownfield = codeFiles > 5 || commitCount > 3;
  return { mode: isBrownfield ? 'brownfield' : 'greenfield', signals };
}

function configYaml(mode: string): string {
  return `# Hermes configuration
# Generated by hermes init at ${new Date().toISOString()}
# Edit freely; this file ships as YAML for human review-friendliness.

version: 1
mode: ${mode}     # greenfield | brownfield | hybrid

# Operator identity (used in audit log + signoff records).
# Override per-run via env: HERMES_OPERATOR=alice
operator:
  name: \${HERMES_OPERATOR:-operator}
  email: \${HERMES_OPERATOR_EMAIL:-}

# Engine routing — first available is picked unless task pack overrides.
# Run \`pnpm auto:engine-list\` to see what's installed locally.
engines:
  default:
    - claude-code-cli
    - claude-agent-sdk
    - openai-cli
    - ollama
  reviewer:
    # Use a different vendor than impl-engine for SoD (multi-vendor consensus).
    - codex-cli
    - gemini-cli
    - openai-cli

# Module list. Edit to add your own modules. Each module is a unit of work.
# .hermes/modules/<MID>.yaml carries per-module config (allowed_paths, refs).
modules:
  - M01

# Compliance gates. Defaults are conservative.
gates:
  lint: blocking
  test: blocking
  coverage_pct: 70        # 0 disables; 70 is a sensible default
  dep_audit: blocking     # block on HIGH/CRITICAL CVEs in prod deps
  security_check: blocking
  branch_hygiene: 10      # max commits ahead of base

# CVE allow-list. Operator must add entries; auto:land --force +
# AUTO_FORCE_REASON also bypasses (audited).
cve_allow_list: []

# Solo-operator mode (single human filling all roles via SoD override).
# Set accepts_full_autonomy: true once you understand the audit-trail
# implications. Bypasses are still recorded in _override-audit.jsonl.
solo_operator:
  accepts_full_autonomy: false
  customer_facing: false

# Stage 29 (staging deploy). Wires to deploy/staging.sh or
# pnpm deploy:staging if either exists. Set false to skip entirely.
staging_deploy: auto      # auto | always | never
`;
}

function moduleYaml(moduleId: string, mode: string): string {
  return `# ${moduleId} — module config
# Hermes uses this to know what files this module owns and what specs to
# read. Edit allowed_paths to scope the agent's reach.

name: ${moduleId} — describe what this module does
mode: ${mode}                # greenfield | brownfield | hybrid

# Paths the worker is allowed to edit (glob patterns).
# Tighter scope = safer agent. Use 'src/**' for whole-repo greenfield.
allowed_paths:
  - 'src/**'
  - 'tests/**'

# Paths the worker MUST NOT touch.
forbidden_paths:
  - '.hermes/**'
  - '.github/**'
  - 'node_modules/**'
  - 'dist/**'

# Reference docs the worker should read before authoring.
references:
  spec: 'docs/specs/${moduleId}/SPEC.md'   # if it exists; agent will create it otherwise

# Risk class drives default merge policy (low | medium | high | critical).
risk_class: medium
`;
}

function starterSpecMd(moduleId: string): string {
  return `# ${moduleId} — Starter spec

Replace this with the actual specification for ${moduleId}.

## Goal

What does success look like in one paragraph?

## Acceptance criteria

- [ ] Criterion 1 (testable)
- [ ] Criterion 2 (testable)
- [ ] Criterion 3 (testable)

## Out of scope

- What this work does NOT include
`;
}

function gitignoreAddition(): string {
  return `
# Hermes
.agent-runs/
/tmp/harness-runs/
`;
}

function writeNextSteps(args: InitArgs, log: (msg: string) => void): void {
  log('');
  log('───────────────────────────────────────────────────────────────');
  log('  Next steps');
  log('───────────────────────────────────────────────────────────────');
  log('');
  log(`  1. Edit your spec:        docs/specs/${args.module}/SPEC.md`);
  log(`  2. Set the operator env:  export HERMES_OPERATOR="$(git config user.name)"`);
  log(`  3. Set driver flag:       export AUTO_HARNESS_DRIVER=1`);
  log(`  4. Plan the first task:   pnpm auto:plan --module ${args.module} --version v0.1 --type frd-author --auto-fill`);
  log(`  5. Dispatch the worker:   pnpm auto:work`);
  log(`  6. Land it:               pnpm auto:land`);
  log('');
  log('  Live observability:');
  log(`    pnpm auto:dashboard-live   # http://localhost:7777`);
  log(`    pnpm auto:metrics-daemon   # http://localhost:9090/metrics (Prometheus)`);
  log(`    pnpm auto:mcp-server       # stdio JSON-RPC for MCP clients`);
  log('');
  log('  Or drive an end-to-end multi-module run:');
  log(`    bash scripts/serial-by-module.sh         # one-at-a-time, auditable`);
  log(`    bash scripts/parallel-by-module.sh 2     # 2 drivers in parallel`);
  log('');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const log = (msg: string): void => { if (!args.quiet) console.log(msg); };

  log('');
  log('═══════════════════════════════════════════════════════════════');
  log('  Hermes — autonomous delivery harness');
  log('═══════════════════════════════════════════════════════════════');
  log('');

  // Detect mode
  let detectedMode: 'greenfield' | 'brownfield';
  if (args.mode === 'auto') {
    const det = detectMode(cwd);
    detectedMode = det.mode;
    log(`✓ Detected mode: ${detectedMode}  (${det.signals.join(', ')})`);
  } else {
    detectedMode = args.mode;
    log(`✓ Mode (forced): ${detectedMode}`);
  }

  // Create .hermes/ structure
  const hermesDir = path.join(cwd, '.hermes');
  const modulesDir = path.join(hermesDir, 'modules');
  if (!fs.existsSync(hermesDir)) fs.mkdirSync(hermesDir, { recursive: true });
  if (!fs.existsSync(modulesDir)) fs.mkdirSync(modulesDir, { recursive: true });

  // Write config.yaml
  const configPath = path.join(hermesDir, 'config.yaml');
  if (fs.existsSync(configPath) && !args.force) {
    log(`  .hermes/config.yaml exists, leaving as-is (--force to overwrite)`);
  } else {
    fs.writeFileSync(configPath, configYaml(detectedMode));
    log(`✓ Wrote .hermes/config.yaml`);
  }

  // Brownfield --scan: propose a multi-module breakdown
  if (args.scan && detectedMode === 'brownfield') {
    log('');
    log('Scanning repo structure for module candidates…');
    const proposal = scanRepo(cwd);
    for (const w of proposal.warnings) log(`  ⚠ ${w}`);
    if (proposal.modules.length === 0) {
      log('  (no clear subsystems found; falling back to single-module starter)');
    } else {
      log(`✓ Proposing ${proposal.modules.length} modules from source structure:`);
      for (const m of proposal.modules) {
        const p = path.join(modulesDir, `${m.id}.yaml`);
        const content = `# ${m.name}
# Auto-proposed by hermes init --scan. Edit before dispatching.

name: ${m.name}
mode: brownfield
risk_class: ${m.risk_class}

allowed_paths:
${m.allowed_paths.map(ap => `  - '${ap}'`).join('\n')}

forbidden_paths:
  - '.hermes/**'
  - '.github/**'
  - 'node_modules/**'
  - 'dist/**'

references:
  spec: 'docs/specs/${m.id}/SPEC.md'

# Rationale (auto-generated): ${m.rationale}
`;
        if (fs.existsSync(p) && !args.force) {
          log(`    ${m.id}: exists, skipping`);
        } else {
          fs.writeFileSync(p, content);
          log(`    ${m.id}: ${m.allowed_paths[0]} (risk=${m.risk_class})`);
        }
      }
      log('');
      log('Edit .hermes/modules/<MID>.yaml to refine paths, risk, and references.');
      log('');
      // Skip writing the starter M01 if we wrote scanned modules
      if (proposal.modules.length > 0 && !args.force) {
        log('  (skipping default M01 starter — using scanned modules)');
        // Skip the default-module write below
        writeNextSteps(args, log);
        return;
      }
    }
  }

  // Write starter module
  const moduleYamlPath = path.join(modulesDir, `${args.module}.yaml`);
  if (fs.existsSync(moduleYamlPath) && !args.force) {
    log(`  .hermes/modules/${args.module}.yaml exists, leaving as-is`);
  } else {
    fs.writeFileSync(moduleYamlPath, moduleYaml(args.module, detectedMode));
    log(`✓ Wrote .hermes/modules/${args.module}.yaml`);
  }

  // Write starter spec
  const specDir = path.join(cwd, 'docs', 'specs', args.module);
  const specPath = path.join(specDir, 'SPEC.md');
  if (!fs.existsSync(specPath)) {
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(specPath, starterSpecMd(args.module));
    log(`✓ Wrote docs/specs/${args.module}/SPEC.md  (edit this with your actual spec)`);
  } else {
    log(`  docs/specs/${args.module}/SPEC.md exists, leaving as-is`);
  }

  // Append to .gitignore
  const gitignorePath = path.join(cwd, '.gitignore');
  let gi = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (!gi.includes('.agent-runs/')) {
    fs.writeFileSync(gitignorePath, gi + gitignoreAddition());
    log(`✓ Added .agent-runs/ to .gitignore`);
  } else {
    log(`  .gitignore already excludes .agent-runs/`);
  }

  writeNextSteps(args, log);
}

main();
