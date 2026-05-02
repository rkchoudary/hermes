#!/usr/bin/env node
/**
 * pnpm auto:approve <candidate-id> [--non-goals "<extra>"] [--evidence-dir <override>]
 *                  [--from-json <auto:gap-output.json>] [--all] [--dry-run]
 *
 * Operator-gated approval of gap candidates. Writes to
 * .agent-runs/_approved-candidates.jsonl. Daemon picks them up + materializes
 * as real TaskPacks on disk via the synthesizer.
 *
 * Codex final review (bvw1dczxm): authority boundary remains with the
 * operator. The daemon writes ONLY what the operator approves; it never
 * synthesizes from raw gap output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { harnessRoot } from '../lib/harnessRoot';
import { readGoal } from '../lib/goal';
import { buildInventoryFromFs, rankCandidates, type GapCandidate } from '../lib/gapAnalysis';
import { captureIdentity } from '../lib/sod';
import * as os from 'node:os';
import { getLogger } from '../lib/logger';

const __filename = fileURLToPath(import.meta.url);
void __filename;
const HARNESS_ROOT = harnessRoot();
const log = getLogger('cli:approve');

interface Args {
  candidateIds: string[];
  fromJson?: string;
  approveAll: boolean;
  extraNonGoals: string[];
  evidenceDirOverride?: string;
  dryRun: boolean;
  /** When false, skip the inline materialization step (default true). */
  materialize: boolean;
}

function parseArgs(argv: string[]): Args {
  const candidateIds: string[] = [];
  let fromJson: string | undefined;
  let approveAll = false;
  const extraNonGoals: string[] = [];
  let evidenceDirOverride: string | undefined;
  let dryRun = false;
  let materialize = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') approveAll = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--no-materialize') materialize = false;
    else if (a === '--from-json' && i + 1 < argv.length) fromJson = argv[++i];
    else if (a === '--non-goals' && i + 1 < argv.length) extraNonGoals.push(argv[++i]);
    else if (a === '--evidence-dir' && i + 1 < argv.length) evidenceDirOverride = argv[++i];
    else if (!a.startsWith('--')) candidateIds.push(a);
  }
  return { candidateIds, fromJson, approveAll, extraNonGoals, evidenceDirOverride, dryRun, materialize };
}

function approvedCandidatesPath(): string {
  return path.join(HARNESS_ROOT, '.agent-runs', '_approved-candidates.jsonl');
}

function loadCandidatesFromGapAnalysis(): GapCandidate[] {
  const goal = readGoal(HARNESS_ROOT);
  if (!goal) {
    throw new Error(`No active goal at ${HARNESS_ROOT}/.agent-runs/_goal.json. Run pnpm auto:goal init first.`);
  }
  const obsidianFrdsRoot = process.env.AUTO_OBSIDIAN_FRDS_ROOT
    ?? path.join(os.homedir(), process.env.HERMES_DOCS_ROOT || './docs/specs');
  const inventory = buildInventoryFromFs({
    obsidianFrdsRoot,
    repoRoot: HARNESS_ROOT,
    agentRunsRoot: path.join(HARNESS_ROOT, '.agent-runs'),
  });
  const result = rankCandidates({ goal, inventory });
  return result.candidates;
}

function loadCandidatesFromJson(jsonPath: string): GapCandidate[] {
  const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (Array.isArray(raw)) return raw as GapCandidate[];
  if (raw.candidates && Array.isArray(raw.candidates)) return raw.candidates as GapCandidate[];
  throw new Error(`Could not extract candidates from ${jsonPath}`);
}

function alreadyApproved(): Set<string> {
  const p = approvedCandidatesPath();
  if (!fs.existsSync(p)) return new Set();
  const ids = new Set<string>();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.candidate_id) ids.add(String(e.candidate_id));
    } catch { /* skip */ }
  }
  return ids;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const allCandidates = args.fromJson ? loadCandidatesFromJson(args.fromJson) : loadCandidatesFromGapAnalysis();

  let toApprove: GapCandidate[];
  if (args.approveAll) {
    toApprove = allCandidates;
  } else if (args.candidateIds.length > 0) {
    const idSet = new Set(args.candidateIds);
    toApprove = allCandidates.filter((c) => idSet.has(c.candidate_id));
    const missing = args.candidateIds.filter((id) => !allCandidates.some((c) => c.candidate_id === id));
    if (missing.length > 0) {
      console.error(`Candidate(s) not found in current gap output: ${missing.join(', ')}`);
      console.error(`Re-run pnpm auto:gap to refresh the candidate list.`);
      process.exit(2);
    }
  } else {
    console.error('usage: pnpm auto:approve <candidate-id> [--all] [--from-json X] [--non-goals "..."]');
    process.exit(64);
  }

  // Filter out already-approved
  const seen = alreadyApproved();
  const fresh = toApprove.filter((c) => !seen.has(c.candidate_id));
  const skipped = toApprove.length - fresh.length;

  if (fresh.length === 0) {
    console.log(`No new approvals — all ${toApprove.length} candidate(s) already approved.`);
    return;
  }

  const approver = captureIdentity().name;
  const approvedAt = new Date().toISOString();
  const batchId = `batch-${approvedAt.replace(/[:.]/g, '-')}`;

  const lines: string[] = [];
  for (const c of fresh) {
    const entry = {
      schema_version: '1' as const,
      candidate_id: c.candidate_id,
      approver,
      approved_at: approvedAt,
      candidate: c,
      extra_non_goals: args.extraNonGoals,
      evidence_dir_override: args.evidenceDirOverride,
      approval_batch_id: batchId,
    };
    lines.push(JSON.stringify(entry));
  }

  if (args.dryRun) {
    console.log(`[dry-run] would append ${fresh.length} approval(s) to ${approvedCandidatesPath()}`);
    if (skipped > 0) console.log(`[dry-run] would skip ${skipped} already-approved candidate(s)`);
    for (const c of fresh) console.log(`  ${c.candidate_id}  ${c.module_or_sprint.padEnd(8)}  ${c.type.padEnd(15)}  ${c.rationale.slice(0, 60)}`);
    return;
  }

  fs.mkdirSync(path.dirname(approvedCandidatesPath()), { recursive: true });
  fs.appendFileSync(approvedCandidatesPath(), lines.join('\n') + '\n');

  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  auto:approve — ${fresh.length} new approval(s) recorded`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`Approver:        ${approver}`);
  console.log(`Approved at:     ${approvedAt}`);
  console.log(`Batch:           ${batchId}`);
  if (skipped > 0) console.log(`Already-approved: ${skipped} (skipped)`);
  console.log('');
  console.log('Approved candidates:');
  for (const c of fresh) {
    console.log(`  ${c.candidate_id}  ${c.module_or_sprint.padEnd(8)}  ${c.type.padEnd(15)}  ${c.rationale.slice(0, 60)}`);
  }
  console.log('');

  // Codex efficiency review (2026-04-29) Ship-First: inline materialization.
  // Was: operator had to run `pnpm auto:tick --materialize-approvals` as a
  // separate step, with up to 30s of dead air before daemon picked them up.
  // Now: approve writes the JSONL THEN materializes immediately so the next
  // daemon tick (or operator's next status check) sees real TaskPacks.
  // --no-materialize disables this for tests / staged rollouts.
  if (args.materialize !== false) {
    try {
      const { materializeApprovals } = await import('../lib/materializeApprovals');
      const r = await materializeApprovals({
        harnessRoot: HARNESS_ROOT,
        dryRun: false,
        log: (m) => console.log(`[approve→materialize] ${m}`),
      });
      console.log('');
      console.log(`Inline materialize: ${r.materialized}/${r.pending_before} approvals → TaskPacks${r.pending_after > 0 ? ` (${r.pending_after} still pending — see errors above)` : ''}`);
    } catch (e) {
      console.warn(`[approve→materialize] failed: ${(e as Error).message.slice(0, 200)}`);
      console.warn('Approvals were saved; run `pnpm auto:tick --materialize-approvals` manually OR let the next daemon tick handle it.');
    }
  } else {
    console.log('Materialization deferred (--no-materialize). Run `pnpm auto:tick --materialize-approvals` to convert to TaskPacks.');
  }
  log.info('approvals recorded', { count: fresh.length, approver, batch: batchId });
}

main().catch((e) => { console.error(e); process.exit(1); });
