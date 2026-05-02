#!/usr/bin/env node
// Generates commands/*.md slash command files from a curated metadata table.
// Run: node scripts/generate-plugin-commands.mjs

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'commands');

// One row per slash command. `cli` is the harness-cli.sh subcommand
// (matches src/cli/<cli>.ts). `name` is what Claude users type after
// /harness: prefix.
const COMMANDS = [
  // --- Core dispatch ---
  { name: 'plan',           cli: 'plan',           hint: '--module MXX --version vY.Z --type frd-polish', desc: 'Author a new task pack JSON in .agent-runs/<run>/tasks/.' },
  { name: 'work',           cli: 'work',           hint: 'TP-YYYY-MM-DD-NNN [--force] [--pivot-strategy ...]', desc: 'Dispatch a worker round on a task pack: claude-code-cli (Max) | claude-agent-sdk (API) | manual.' },
  { name: 'run',            cli: 'run',            hint: 'TP-YYYY-MM-DD-NNN [--max-iterations N] [--dry-run]', desc: 'Composite per-task lifecycle: loops applyRubric() decisions until terminal state or max iterations. Replaces the manual auto:work → auto:consensus → auto:promote chain.' },
  { name: 'replay',         cli: 'replay',         hint: 'TP-YYYY-MM-DD-NNN [--json]', desc: 'Promotion-decision explainer. Reconstructs full timeline (state transitions, codex rounds, overrides, escalations, costs, pivots) + evaluates promotion predicates. Operator answer to "why did this task land in state X?".' },
  { name: 'doctor',         cli: 'doctor',         hint: '[--state] [--apply] [--json]', desc: 'State-integrity checker. Walks .agent-runs/ + flags orphan locks, parse failures, terminal-state-mismatches, missing dependencies, missing evidence. Codex-prescribed operational durability foundation.' },
  { name: 'consensus',      cli: 'consensus',      hint: 'TP-YYYY-MM-DD-NNN [--gate completion] [--apply]',  desc: 'Bundle evidence + run Codex 5.5 xhigh review; CAS-rolls task to needs-revision/promotable.' },
  { name: 'verify-claims',  cli: 'verify',         hint: 'TP-YYYY-MM-DD-NNN', desc: 'Grep-based gate that rejects worker output if claims do not match diff.' },
  { name: 'promote',        cli: 'promote',        hint: 'TP-YYYY-MM-DD-NNN [--force]', desc: 'Move task from promotable → ready-for-merge after human gate.' },
  { name: 'land',           cli: 'land',           hint: 'TP-YYYY-MM-DD-NNN [--dry-run]', desc: 'Open a PR + idempotently land work; does NOT auto-merge to protected branches in Phase 0.' },
  // --- Visibility ---
  { name: 'status',         cli: 'dashboard',      args: ['--cli'], hint: '[TP-… for task detail]', desc: 'CLI snapshot of all task packs, states, evidence counts, run age.' },
  { name: 'dashboard',      cli: 'dashboard',      hint: '[--port 3001] [--json]', desc: 'Live web/JSON dashboard of harness operational state.' },
  { name: 'tick',           cli: 'tick',           hint: '[--verbose]', desc: 'Single durability tick: flush state + cleanup + health + watchdog reap.' },
  { name: 'daemon',         cli: 'daemon',         hint: '[--interval-ms 60000]', desc: 'Loop tick on an interval; foundational orchestrator.' },
  { name: 'metrics',        cli: 'metrics',        hint: '[--textfile path] [--json]', desc: 'Emit Prometheus-textfile metrics for Grafana/Prom scraping.' },
  { name: 'ux-validate',    cli: 'ux-validate',    hint: 'TP-YYYY-MM-DD-NNN [--apply]', desc: 'Pillar 4: deterministic UX validation gate (Playwright + blank-page + console + network gates) before consensus.' },
  { name: 'cost',           cli: 'cost',           hint: '[--days 7]', desc: 'Cost-telemetry rollup (USD spend, dispatch counts, per-engine breakdown).' },
  // --- Session / handoff ---
  { name: 'flush-progress', cli: 'flush',          hint: '[--reason stop] [--quiet]', desc: 'Write durable session-handoff state to AUTONOMOUS-PROGRESS.md.' },
  { name: 'resume-session', cli: 'resume',         hint: '[--max-age-hours 24] [--quiet]', desc: 'Read prior flush + emit session-resume brief.' },
  { name: 'awareness',      cli: 'awareness',      hint: '[--refresh] [--source repo|github|vercel|aws|neon|clickhouse|obsidian]', desc: 'Refresh environmental awareness snapshots used during planning.' },
  { name: 'onboard',        cli: 'onboard',        hint: '[--target-dir /path/to/project]', desc: 'Vendor + wire the harness into a new project (settings hooks, scripts, .agent-runs scaffold).' },
  // --- Self-healing ---
  { name: 'resurrect',      cli: 'resurrect',      hint: '[--dry-run]', desc: 'Single-command recovery from crashed sessions: release dead-pid locks, rollback in-flight states.' },
  { name: 'watchdog',       cli: 'watchdog',       hint: '[--reap]', desc: 'Inspect or reap stale process registry entries; SIGTERM→SIGKILL hung workers.' },
  { name: 'cleanup',        cli: 'cleanup',        hint: '[--apply]', desc: 'Run 7 declarative cleanup policies (rate-limited; engine denylist protects audit logs).' },
  { name: 'cleanup-worktree', cli: 'cleanup-worktree', hint: '<worktree-path>', desc: 'Tear down a per-task git worktree after task terminal state.' },
  { name: 'health',         cli: 'health',         hint: '[--json]', desc: 'System health checks (disk-usage, registry-size, audit-log-size, stale-locks, open-escalations).' },
  // --- Quality gates ---
  { name: 'red-team',       cli: 'red-team',       hint: 'TP-YYYY-MM-DD-NNN', desc: 'Adversarial review pass: probe for missed-finding bias, scope creep, hidden regressions.' },
  { name: 'merge-gate',     cli: 'merge-gate',     hint: 'TP-YYYY-MM-DD-NNN', desc: 'Final pre-merge gate: re-verify all evidence, audit-log presence, SoD compliance.' },
  { name: 'security-check', cli: 'security-check', hint: 'TP-YYYY-MM-DD-NNN', desc: 'OWASP-style security scan over the task diff.' },
  { name: 'drift-check',    cli: 'drift-check',    hint: '', desc: 'Detect repo drift since base-sha (rebase-against-main signal).' },
  { name: 'conflict-detect',cli: 'conflict-detect',hint: '', desc: 'Cross-task path-overlap detection (parallel sprint safety).' },
  { name: 'test-gen',       cli: 'test-gen',       hint: 'TP-YYYY-MM-DD-NNN', desc: 'Suggest missing test coverage for the task diff.' },
  // --- Build / pipeline ---
  { name: 'build',          cli: 'build',          hint: 'TP-YYYY-MM-DD-NNN', desc: 'Run typecheck + lint + smoke tests as a build pipeline gate.' },
  { name: 'lint',           cli: 'lint',           hint: '', desc: 'Lint pass over the task diff; results audited.' },
  { name: 'release',        cli: 'release',        hint: '<version>', desc: 'Tag + bump + ship a harness release.' },
  { name: 'monitor-pr',     cli: 'monitor-pr',     hint: '<PR# or branch>', desc: 'Watch GitHub Actions checks + Vercel deploys until green/red; auto-audit failures.' },
  // --- Governance ---
  { name: 'goal',           cli: 'goal',           hint: '[--show|--update]', desc: 'Manage the goal-progress object (criteria, success measures).' },
  { name: 'escalate',       cli: 'escalate',       hint: 'TP-YYYY-MM-DD-NNN [--reason "..."]', desc: 'Open a human-escalation entry; pings notifications.' },
  { name: 'model',          cli: 'model',          hint: '<engine> [--show|--switch]', desc: 'Inspect or switch the active reviewer/worker engine (model inventory enforced).' },
  { name: 'budget',         cli: 'budget',         hint: '[--show|--set <usd>]', desc: 'Per-day cost budget with auto-pause when exceeded.' },
  { name: 'queue',          cli: 'queue',          hint: '[--show|--clear]', desc: 'Inspect tasks queued behind path-overlap blockers.' },
  { name: 'rebase-stale',   cli: 'rebase-stale',   hint: '[--apply]', desc: 'Rebase task branches that drifted ≥N commits behind base-sha.' },
  { name: 'migrate-schema', cli: 'migrate-schema', hint: '[--apply]', desc: 'Migrate task pack JSON schema across versions (v1↔v2 etc.).' },
  { name: 'start',          cli: 'start',          hint: '', desc: 'Composite "start the harness": tick + watchdog + dashboard.' },
  // --- Kill switch ---
  { name: 'kill-on',        cli: 'kill-on',        hint: '', desc: 'Engage kill-switch — auto:work / auto:land / auto:daemon refuse to run until cleared.' },
  { name: 'kill-off',       cli: 'kill-off',       hint: '', desc: 'Disengage kill-switch.' },
];

const HEADER = '# Auto-generated by scripts/generate-plugin-commands.mjs — do not edit by hand.\n# Edit COMMANDS table in that script + re-run.\n';

function renderCommand(cmd) {
  const argFwd = cmd.args && cmd.args.length > 0
    ? cmd.args.map((a) => `'${a}'`).join(' ') + ' "$@"'
    : '"$@"';
  // The slash-command markdown: a Bash invocation followed by post-run instructions.
  return `---
description: ${cmd.desc}
${cmd.hint ? `argument-hint: ${cmd.hint}` : ''}
allowed-tools:
  - Bash
---

!\`bash "\${CLAUDE_PLUGIN_ROOT}/bin/harness-cli.sh" ${cmd.cli}${cmd.args ? ' ' + cmd.args.join(' ') : ''} $ARGUMENTS\`

After the command completes, in 2-3 lines summarize:
- The resulting task state / verdict / metric (whichever is relevant).
- Any **NEXT** action the harness suggests (per its decision rubric).
- Any audit-log line worth flagging (kind=force-*, kind=sod-*, severity=critical).

Do NOT re-narrate the full output — the user already saw it.
`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let written = 0;
  for (const cmd of COMMANDS) {
    const file = path.join(OUT_DIR, `${cmd.name}.md`);
    fs.writeFileSync(file, renderCommand(cmd));
    written++;
  }
  console.log(`[generate-plugin-commands] wrote ${written} commands to ${OUT_DIR}`);
  console.log(`Slash command surface: ${COMMANDS.map((c) => '/harness:' + c.name).join(', ')}`);
}

main();
