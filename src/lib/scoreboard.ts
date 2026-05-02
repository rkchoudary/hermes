/**
 * Module Scoreboard — derives FRD-GO scores per module by scanning
 * durable Codex review archives.
 *
 * Closes Codex R2 finding: 'auto:tick passes no module_scores into the
 * goal snapshot, so module_at_score remains 0 by construction.' Now real
 * Codex review outputs feed the goal evaluation.
 *
 * Phase 1 baseline: scans .agent-runs/<run>/_codex/<task>/r<N>-review.md
 * (durable per the /tmp removal commit) + harness package
 * CODEX-REVIEW-*.md files. Parses 'Score: N.N' regex and maps to module
 * via task pack lookup (or filename when the file is harness-internal).
 *
 * Phase 2 will add embedding-based module ↔ review-content matching for
 * cross-module reviews and richer score aggregation (latest-only vs
 * average-of-last-K).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listTasks, readTaskPack } from './runState';

// ─── Score parsing ──────────────────────────────────────────────────────────

const SCORE_REGEXES = [
  /Score:\s*\*?\*?`?(\d+\.?\d*)\s*\/\s*10/i,
  /^\s*\*?\*?(?:Final )?Score\*?\*?[:=]\s*`?(\d+\.?\d*)/im,
  /\b(\d+\.\d)\s*\/\s*10\s*(?:and|—|--)?\s*(?:GO|NO-GO)/i,
];

/**
 * Extract a score from review-file text. Returns the LAST score found
 * (final verdicts come last in Codex output). Returns null if no match.
 */
export function extractScore(reviewText: string): number | null {
  let lastMatch: number | null = null;
  for (const re of SCORE_REGEXES) {
    const matches = [...reviewText.matchAll(new RegExp(re, 'g' + (re.flags.includes('i') ? 'i' : '')))];
    for (const m of matches) {
      const v = parseFloat(m[1]);
      if (!isNaN(v) && v >= 0 && v <= 10) lastMatch = v;
    }
  }
  return lastMatch;
}

/**
 * Extract a module identifier from a Codex review filename or content.
 * Filename patterns we know about:
 *   codex-frd-m05-r3-refresh.md         → M05
 *   codex-framework-h1-r6-review.md    → harness (NOT a module)
 *   r1-review.md (in _codex/<task>/)   → look up task → module
 *   CODEX-REVIEW-H1-R6-GO.md            → harness
 */
export function extractModuleFromFilename(filename: string): string | null {
  const m = filename.match(/(?:^|[-/_])(M\d+)(?:[-/_._]|$)/i);
  return m ? m[1].toUpperCase() : null;
}

// ─── Score loading ──────────────────────────────────────────────────────────

export interface ScoreSource {
  module: string;
  score: number;
  source_path: string;
  task_id?: string;
  round?: number;
}

/**
 * Load all per-module scores from durable Codex review archives.
 * Returns a map: module → LATEST score (sorted by round descending; mtime fallback).
 * Codex R3 fix: was 'highest score seen' which let one-off GO mask regressions.
 *
 * Searches:
 *   1. .agent-runs/<run>/_codex/<task>/r<N>-review.md
 *      (mapped to module via task pack lookup)
 *   2. tools/autonomous-delivery/CODEX-*-*.md
 *      (mapped to module via filename regex)
 */
export function loadModuleScores(harnessRoot: string, packageRoot: string): Record<string, number> {
  const allSources: ScoreSource[] = [];

  // Source 1: .agent-runs/<run>/_codex/<task>/r<N>-review.md
  const runsDir = path.join(harnessRoot, '.agent-runs');
  if (fs.existsSync(runsDir)) {
    for (const runId of fs.readdirSync(runsDir)) {
      if (runId.startsWith('_')) continue;
      const codexDir = path.join(runsDir, runId, '_codex');
      if (!fs.existsSync(codexDir)) continue;
      for (const taskId of fs.readdirSync(codexDir)) {
        const taskCodexDir = path.join(codexDir, taskId);
        try {
          if (!fs.statSync(taskCodexDir).isDirectory()) continue;
        } catch {
          continue;
        }
        // Look up task pack to find module
        let module: string | null = null;
        try {
          const pack = readTaskPack(runId, taskId);
          const m = pack.module_or_sprint.match(/^M\d+/i);
          if (m) module = m[0].toUpperCase();
        } catch {
          /* continue with filename fallback */
        }
        for (const reviewFile of fs.readdirSync(taskCodexDir)) {
          if (!reviewFile.match(/^r\d+-review\.md$/) && !reviewFile.endsWith('-review.md')) continue;
          const fullPath = path.join(taskCodexDir, reviewFile);
          let body = '';
          try {
            body = fs.readFileSync(fullPath, 'utf8');
          } catch {
            continue;
          }
          const score = extractScore(body);
          if (score === null) continue;
          const finalModule = module ?? extractModuleFromFilename(reviewFile) ?? extractModuleFromFilename(taskId);
          if (!finalModule) continue;
          const roundMatch = reviewFile.match(/^r(\d+)/);
          allSources.push({
            module: finalModule,
            score,
            source_path: fullPath,
            task_id: taskId,
            round: roundMatch ? parseInt(roundMatch[1], 10) : undefined,
          });
        }
      }
    }
  }

  // Source 2: harness package CODEX-*-*.md (FRD-specific reviews; harness internal reviews skipped)
  if (fs.existsSync(packageRoot)) {
    for (const f of fs.readdirSync(packageRoot)) {
      if (!/^CODEX-.*\.md$/.test(f)) continue;
      const module = extractModuleFromFilename(f);
      if (!module) continue; // skip harness-internal reviews (CODEX-REVIEW-H1-*, CODEX-PUBLISHABILITY-*, CODEX-END-TO-END-*, CODEX-SOTA-BAR-*)
      const fullPath = path.join(packageRoot, f);
      let body = '';
      try {
        body = fs.readFileSync(fullPath, 'utf8');
      } catch {
        continue;
      }
      const score = extractScore(body);
      if (score === null) continue;
      allSources.push({ module, score, source_path: fullPath });
    }
  }

  // Codex R3 fix: roll up = LATEST score per module (sustained-not-cherry-picked
  // semantics). Previously we used highest-ever which let a one-off GO score
  // mask later regressions. Now we sort sources by round number (descending)
  // within each module and take the latest. For sources without a round number
  // (harness-internal CODEX-* files), fall back to file mtime via stat.
  const byModule = new Map<string, ScoreSource[]>();
  for (const s of allSources) {
    if (!byModule.has(s.module)) byModule.set(s.module, []);
    byModule.get(s.module)!.push(s);
  }
  const result: Record<string, number> = {};
  for (const [module, sources] of byModule) {
    sources.sort((a, b) => {
      // Higher round number first (latest review)
      if (a.round !== undefined && b.round !== undefined) return b.round - a.round;
      // Fall back to mtime
      let mtA = 0, mtB = 0;
      try { mtA = fs.statSync(a.source_path).mtimeMs; } catch { /* ignore */ }
      try { mtB = fs.statSync(b.source_path).mtimeMs; } catch { /* ignore */ }
      return mtB - mtA;
    });
    result[module] = sources[0].score;
  }
  return result;
}

// ─── CI-green streak (Phase 1 baseline) ─────────────────────────────────────

/**
 * Compute days since last CI-red on protected branch.
 * Codex R3 fix: was run-count bounded (last 30 runs). Now date-windowed:
 * fetches runs over the last 30 DAYS, finds most recent failure, returns
 * days since. Falls back to 0 if gh is unavailable.
 */
export function computeCiGreenStreakDays(repoRoot: string): number {
  // Use a date filter: list runs since (now - 30 days)
  const thirtyDaysAgoIso = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const r = spawnSync(
    'gh',
    [
      'run', 'list',
      '--branch', 'main',
      '--created', `>=${thirtyDaysAgoIso}`,
      '--limit', '200',
      '--json', 'conclusion,createdAt',
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
  );
  if (r.status !== 0) {
    // Fall back to limit-based query (older gh CLI versions don't support --created)
    const fallback = spawnSync(
      'gh',
      ['run', 'list', '--branch', 'main', '--limit', '50', '--json', 'conclusion,createdAt'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
    );
    if (fallback.status !== 0) return 0;
    return parseRunsAndComputeStreak(fallback.stdout);
  }
  return parseRunsAndComputeStreak(r.stdout);
}

function parseRunsAndComputeStreak(json: string): number {
  let runs: Array<{ conclusion: string | null; createdAt: string }>;
  try { runs = JSON.parse(json); } catch { return 0; }
  // Find the most recent failure within the date window
  const failures = runs.filter((run) => run.conclusion === 'failure' || run.conclusion === 'cancelled');
  if (failures.length === 0) {
    // No failure in the 30-day window — return the age of the OLDEST run we
    // see (effectively, "at least N days CI-green where N = window age cap").
    // If no runs at all, return 0 (can't claim streak without evidence).
    if (runs.length === 0) return 0;
    const oldest = runs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return Math.floor((Date.now() - new Date(oldest.createdAt).getTime()) / (24 * 3600 * 1000));
  }
  const lastFailure = failures.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return Math.floor((Date.now() - new Date(lastFailure.createdAt).getTime()) / (24 * 3600 * 1000));
}
