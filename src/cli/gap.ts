#!/usr/bin/env node
/**
 * pnpm auto:gap [--obsidian-frds-root <path>] [--top-k N] [--json]
 *
 * Goal-aware gap analysis (Codex Sprint 2 prescription bdjec7m74):
 *   "Make `auto:gap` an evidence compiler, not an autonomous planner. The
 *   output should be a ranked backlog with citations, proposed allowed_paths,
 *   and explicit uncertainty. The operator's approvals become the training
 *   signal for later decomposition and scheduling."
 *
 * READ-ONLY. NO FILESYSTEM WRITES. Outputs structured JSON candidate list
 * for operator approval. Operator manually decides which candidates become
 * real TaskPacks (Codex deferred autonomous candidate→TaskPack conversion).
 *
 * Inputs:
 *   - Active GoalContract from .agent-runs/_goal.json
 *   - FRD inventory from --obsidian-frds-root (default: ${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs)
 *   - Existing TaskPacks from .agent-runs/<run>/tasks/*.json
 *   - Cost history from existing TaskPacks' cost_telemetry
 *
 * Output: GapAnalysisResult JSON with top-K candidates, ranked by transparent
 *   tuple (dependency_readiness, operator_priority, criterion_impact,
 *   estimated_cost_usd, freshness_days).
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { readGoal } from '../lib/goal';
import { buildInventoryFromFs, rankCandidates, classifyPrBranch, type OpenPrRecord } from '../lib/gapAnalysis';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();

interface Args {
  obsidianFrdsRoot: string;
  topK?: number;
  json: boolean;
  noPrCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  let obsidianFrdsRoot = process.env.AUTO_OBSIDIAN_FRDS_ROOT
    ?? path.join(os.homedir(), process.env.HERMES_DOCS_ROOT || './docs/specs');
  let topK: number | undefined;
  let json = false;
  let noPrCheck = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') json = true;
    else if (a === '--no-pr-check') noPrCheck = true;
    else if (a === '--obsidian-frds-root' && i + 1 < argv.length) obsidianFrdsRoot = argv[++i];
    else if (a === '--top-k' && i + 1 < argv.length) topK = parseInt(argv[++i], 10);
  }
  return { obsidianFrdsRoot, topK, json, noPrCheck };
}

/**
 * Fetch open PRs via `gh pr list`. Returns [] on any failure (no gh, no auth,
 * detached repo) — gap analysis still works without PR awareness; it just
 * reverts to the green-field view.
 */
function fetchOpenPrs(cwd: string): OpenPrRecord[] {
  try {
    const out = execSync(
      'gh pr list --state open --json number,title,headRefName --limit 100',
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10_000 },
    );
    const parsed = JSON.parse(out) as Array<{ number: number; title: string; headRefName: string }>;
    return parsed.map((p) => ({ number: p.number, branch: p.headRefName, title: p.title }));
  } catch {
    return [];
  }
}

/**
 * Fetch merged PRs (last N) via `gh pr list --state merged`. Same fail-soft
 * behavior. Capped at 100 to keep gap analysis fast.
 */
function fetchMergedPrs(cwd: string): OpenPrRecord[] {
  try {
    const out = execSync(
      'gh pr list --state merged --json number,title,headRefName --limit 100',
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 15_000 },
    );
    const parsed = JSON.parse(out) as Array<{ number: number; title: string; headRefName: string }>;
    return parsed.map((p) => ({ number: p.number, branch: p.headRefName, title: p.title }));
  } catch {
    return [];
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const goal = readGoal(HARNESS_ROOT);
  if (!goal) {
    console.error('No active goal at .agent-runs/_goal.json. Run `pnpm auto:goal init` to bootstrap.');
    process.exit(2);
  }
  if (goal.status !== 'active' && goal.status !== undefined) {
    console.error(`Goal '${goal.goal_id}' status is '${goal.status}'. Set to 'active' to run gap analysis.`);
    process.exit(3);
  }

  const openPrs = args.noPrCheck ? [] : fetchOpenPrs(HARNESS_ROOT);
  const mergedPrs = args.noPrCheck ? [] : fetchMergedPrs(HARNESS_ROOT);
  const inventory = buildInventoryFromFs({
    obsidianFrdsRoot: args.obsidianFrdsRoot,
    repoRoot: HARNESS_ROOT,
    agentRunsRoot: path.join(HARNESS_ROOT, '.agent-runs'),
    openPrs,
    mergedPrs,
  });

  // Allow CLI --top-k to override planning_hints.max_candidates_per_run.
  if (args.topK !== undefined) {
    goal.planning_hints.max_candidates_per_run = args.topK;
  }

  const result = rankCandidates({ goal, inventory });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Build PR-exclusion roster for operator visibility (modules where an open
  // PR pre-empted candidate emission for that work-kind).
  const prExclusions: Array<{ module: string; pr: string; title: string }> = [];
  for (const mod of inventory.modules) {
    if (mod.open_prs.length === 0) continue;
    for (const pr of mod.open_prs) {
      prExclusions.push({ module: mod.module_id, pr: `#${pr.number} (${pr.branch})`, title: pr.title.slice(0, 70) });
    }
  }

  // Build merged-PR roster (ships state for operator visibility).
  const modulesWithMergedImpl = inventory.modules
    .filter((m) => m.merged_prs.some((pr) => pr.kind === 'impl'))
    .map((m) => ({ module: m.module_id, count: m.merged_prs.filter((pr) => pr.kind === 'impl').length }));
  const modulesWithMergedFrd = inventory.modules
    .filter((m) => m.merged_prs.some((pr) => pr.kind === 'frd'))
    .map((m) => ({ module: m.module_id, count: m.merged_prs.filter((pr) => pr.kind === 'frd').length }));

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:gap  goal=${result.goal_id}  generated=${result.generated_at}`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Modules scanned:         ${result.inventory_summary.modules_scanned}`);
  console.log(`Tasks already in-flight: ${result.inventory_summary.existing_tasks_in_flight}`);
  console.log(`Open PRs (gh):           ${openPrs.length}${args.noPrCheck ? ' (--no-pr-check enabled)' : ''}`);
  console.log(`Merged PRs (gh):         ${mergedPrs.length}${args.noPrCheck ? '' : ` (${modulesWithMergedImpl.length} modules with shipped impl, ${modulesWithMergedFrd.length} with merged FRD authoring)`}`);
  console.log(`Candidates emitted:      ${result.inventory_summary.candidates_capped_to}/${result.inventory_summary.candidates_before_cap}`);
  if (prExclusions.length > 0) {
    console.log('');
    console.log('Modules with open PR work-in-flight (excluded from re-suggestion):');
    for (const ex of prExclusions) console.log(`  • ${ex.module}: PR ${ex.pr} — ${ex.title}`);
  }
  if (modulesWithMergedImpl.length > 0) {
    console.log('');
    console.log(`Modules with shipped impl (merged PRs — has_impl=true):`);
    console.log(`  ${modulesWithMergedImpl.map((m) => `${m.module}(${m.count})`).join(', ')}`);
  }
  console.log('');

  if (result.candidates.length === 0) {
    console.log('No gap candidates found. Either every eligible module is already in flight, or all are cold-listed in goal.planning_hints.cold_modules.');
    return;
  }

  console.log('Top candidates (operator approval required before TaskPack creation):');
  console.log('');
  for (const [i, c] of result.candidates.entries()) {
    console.log(`  ${(i + 1).toString().padStart(2)}. ${c.candidate_id}`);
    console.log(`      Type:       ${c.type}`);
    console.log(`      Module:     ${c.module_or_sprint}`);
    console.log(`      Rationale:  ${c.rationale}`);
    console.log(`      Effort:     ${c.estimated_effort_hours}h estimated`);
    console.log(`      Cost:       $${c.ranking.estimated_cost_usd.toFixed(2)} estimated`);
    console.log(`      Priority:   ${c.ranking.operator_priority.toFixed(1)}  Impact: ${c.ranking.criterion_impact.toFixed(1)}  Freshness: ${c.ranking.freshness_days}d`);
    console.log(`      Allowed:    ${c.proposed_allowed_paths.slice(0, 2).join(', ')}${c.proposed_allowed_paths.length > 2 ? ` (+${c.proposed_allowed_paths.length - 2} more)` : ''}`);
    if (c.uncertainty.length > 0) {
      console.log(`      ⚠ Uncertainty: ${c.uncertainty.join('; ')}`);
    }
    console.log('');
  }
  console.log('To approve a candidate: `pnpm auto:approve <candidate_id> --approver <name>`');
  console.log('Then materialize: `pnpm auto:tick --materialize-approvals --verbose`');
}

void classifyPrBranch;  // re-export consumer; ensure tree-shaker keeps it

main();
