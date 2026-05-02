#!/usr/bin/env node
/**
 * pnpm auto:conflict-detect (M5 MVP) — semantic conflict detection for diffs.
 *
 * Codex SOTA-bar finding: "M5 overlap detection is under-scoped. Path overlap
 * is necessary, but not enough; you also need schema/API/event-contract impact
 * analysis."
 *
 * This is the MVP layer. It does NOT do full AST clone detection (Phase 2;
 * that needs tree-sitter + embedding similarity). It DOES:
 *
 *   1. Path overlap (already in checkPathOverlapAgainstInFlight) — verifies it
 *   2. Symbol overlap — if a worker's diff adds a function that already exists
 *      elsewhere in the repo, flag it
 *   3. Schema/API contract change detection — if a diff touches:
 *      - packages/shared-types/src/events.ts
 *      - apps/web/src/lib/db/schema.sql
 *      - any *.sql migration
 *      - any FRD AC predicate
 *      flag as HIGH-IMPACT (cross-module)
 *
 * Output: evidence/<task>/conflict-detect.json + console summary.
 *
 * Phase 2 will add: tree-sitter AST clone detection (D5 from
 * DEDUPLICATION-STRATEGY.md), embedding similarity (D6), enforced gap-analyze
 * gate (D7).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readTaskPack, evidenceDir, writeEvidence } from '../lib/runState';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();

interface Args {
  taskId: string;
  applyMode: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { taskId: '', applyMode: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.applyMode = true;
    else if (a === '--json') args.json = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (positional.length < 1) throw new Error('Required: <task_id>');
  args.taskId = positional[0];
  return args;
}

const HIGH_IMPACT_PATHS = [
  'packages/shared-types/src/events.ts',
  'packages/shared-types/src/snapshot.ts',
  'apps/web/src/lib/db/schema.sql',
  'apps/web/src/lib/db/client.ts',
  'platform/pipeline/src/index.ts',
];

const HIGH_IMPACT_GLOBS = [
  /\.sql$/,
  /platform\/auth\/src\//,
  /platform\/audit-governance\/src\//,
];

interface ConflictReport {
  task_id: string;
  detected_at: string;
  diff_path: string | null;
  /** Functions/exports added by this diff */
  added_symbols: Array<{ file: string; symbol: string; line: number }>;
  /** Same-name symbols that ALREADY exist in the repo (potential duplicate) */
  symbol_overlaps: Array<{
    new_file: string;
    new_symbol: string;
    existing_files: string[];
  }>;
  /** Files in HIGH_IMPACT paths or matching HIGH_IMPACT globs */
  high_impact_files: string[];
  /** Severity: ok | low | medium | high (any high-impact match → high) */
  severity: 'ok' | 'low' | 'medium' | 'high';
  recommendations: string[];
}

function findRunForTask(taskId: string): string {
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) throw new Error(`No .agent-runs/ at ${runsDir}`);
  for (const r of fs.readdirSync(runsDir)) {
    if (fs.existsSync(path.join(runsDir, r, 'tasks', `${taskId}.json`))) return r;
  }
  throw new Error(`Task ${taskId} not found in any run.`);
}

/**
 * R5 fail-safe: probe rg availability once. If absent, callers degrade
 * gracefully and surface the limitation in the report (instead of silently
 * returning 0 overlaps and letting severity stay 'ok').
 */
function isRgAvailable(): boolean {
  const r = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0;
}

/**
 * Parse a unified diff and extract added function/export symbols.
 * Captures lines like:
 *   +export function foo(...)
 *   +export const bar = ...
 *   +async function baz(...)
 * v0.1: regex-based; full AST parsing deferred to Phase 2 (tree-sitter).
 */
function parseAddedSymbols(diffPath: string): ConflictReport['added_symbols'] {
  if (!fs.existsSync(diffPath)) return [];
  const body = fs.readFileSync(diffPath, 'utf8');
  const result: ConflictReport['added_symbols'] = [];
  let currentFile: string | null = null;
  let lineNum = 0;
  for (const line of body.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length);
      lineNum = 0;
    } else if (line.startsWith('@@')) {
      const m = line.match(/\+(\d+)/);
      if (m) lineNum = parseInt(m[1], 10) - 1;
    } else if (line.startsWith('+') && currentFile && !line.startsWith('+++')) {
      lineNum += 1;
      // Function / export / const declarations
      const fnMatch = line.match(/^\+\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      const constMatch = line.match(/^\+\s*export\s+const\s+(\w+)/);
      const classMatch = line.match(/^\+\s*export\s+class\s+(\w+)/);
      const symbol = fnMatch?.[1] ?? constMatch?.[1] ?? classMatch?.[1];
      if (symbol) {
        result.push({ file: currentFile, symbol, line: lineNum });
      }
    } else if (line.startsWith(' ') || line.startsWith('-')) {
      lineNum += line.startsWith(' ') ? 1 : 0;
    }
  }
  return result;
}

/**
 * For each added symbol, grep the repo (excluding the new file itself) for
 * the same name as a definition. If found, record overlap.
 */
function findSymbolOverlaps(
  addedSymbols: ConflictReport['added_symbols'],
  repoRoot: string
): ConflictReport['symbol_overlaps'] {
  const overlaps: ConflictReport['symbol_overlaps'] = [];
  for (const { file: newFile, symbol } of addedSymbols) {
    const r = spawnSync(
      'rg',
      [
        '-l',
        '--type', 'ts',
        '--type', 'tsx',
        // Match a definition of the same symbol
        `(function|const|class)\\s+${symbol}\\b`,
        '-g', `!${newFile}`,
        '-g', '!node_modules',
        '-g', '!.next',
        '-g', '!dist',
      ],
      { cwd: repoRoot, encoding: 'utf8', timeout: 10_000 }
    );
    if (r.status === 0 && r.stdout.trim().length > 0) {
      const existing = r.stdout.split('\n').filter((l) => l.trim().length > 0).slice(0, 5);
      overlaps.push({ new_file: newFile, new_symbol: symbol, existing_files: existing });
    }
  }
  return overlaps;
}

function findHighImpactFiles(diffPath: string): string[] {
  if (!fs.existsSync(diffPath)) return [];
  const body = fs.readFileSync(diffPath, 'utf8');
  const touched = new Set<string>();
  for (const line of body.split('\n')) {
    if (line.startsWith('+++ b/')) {
      touched.add(line.slice('+++ b/'.length));
    } else if (line.startsWith('--- a/')) {
      touched.add(line.slice('--- a/'.length));
    }
  }
  const high: string[] = [];
  for (const file of touched) {
    if (HIGH_IMPACT_PATHS.includes(file)) {
      high.push(file);
      continue;
    }
    if (HIGH_IMPACT_GLOBS.some((re) => re.test(file))) {
      high.push(file);
    }
  }
  return [...new Set(high)];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRunForTask(args.taskId);
  const evDir = evidenceDir(runId, args.taskId);
  const diffPath = path.join(evDir, 'diff.patch');

  // Resolve repo root for grep
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const repoRoot = topLevel.status === 0 ? topLevel.stdout.trim() : HARNESS_ROOT;

  // R5 fail-safe #1: missing diff means we cannot analyze. Surface as HIGH
  // severity with explicit "diff missing" recommendation, not severity=ok.
  const diffMissing = !fs.existsSync(diffPath);
  // R5 fail-safe #2: missing rg means symbol-overlap scan is silently empty.
  // Surface as degraded (medium) with an explicit warning, not severity=ok.
  const rgMissing = !isRgAvailable();

  const addedSymbols = diffMissing ? [] : parseAddedSymbols(diffPath);
  const symbolOverlaps = rgMissing ? [] : findSymbolOverlaps(addedSymbols, repoRoot);
  const highImpactFiles = diffMissing ? [] : findHighImpactFiles(diffPath);

  let severity: ConflictReport['severity'] = 'ok';
  if (diffMissing) severity = 'high';
  else if (highImpactFiles.length > 0) severity = 'high';
  else if (symbolOverlaps.length > 0) severity = 'medium';
  else if (rgMissing) severity = 'medium'; // degraded analysis
  else if (addedSymbols.length > 5) severity = 'low'; // many additions = manual review

  const recommendations: string[] = [];
  if (diffMissing) {
    recommendations.push(
      `Diff evidence missing at ${diffPath}. Cannot detect conflicts. ` +
      `Re-run impl worker to produce diff.patch, or treat as unanalyzed (severity=HIGH).`
    );
  }
  if (rgMissing) {
    recommendations.push(
      `\`rg\` (ripgrep) not available on PATH. Symbol-overlap scan was skipped (degraded mode). ` +
      `Install ripgrep or run on a host with rg before landing.`
    );
  }
  if (highImpactFiles.length > 0) {
    recommendations.push('HIGH-IMPACT files touched (events/schema/auth/audit). Cross-module contract review required before landing.');
  }
  for (const overlap of symbolOverlaps) {
    recommendations.push(
      `Symbol '${overlap.new_symbol}' added in ${overlap.new_file} but already defined in: ${overlap.existing_files.join(', ')}. ` +
      `Consider importing existing instead of re-implementing.`
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('No conflicts detected. Diff is safe to land.');
  }

  const report: ConflictReport = {
    task_id: args.taskId,
    detected_at: new Date().toISOString(),
    diff_path: fs.existsSync(diffPath) ? diffPath : null,
    added_symbols: addedSymbols,
    symbol_overlaps: symbolOverlaps,
    high_impact_files: highImpactFiles,
    severity,
    recommendations,
  };

  if (args.applyMode) {
    writeEvidence(runId, args.taskId, 'conflict-detect.json', JSON.stringify(report, null, 2));
    console.log(`✓ wrote ${evDir}/conflict-detect.json`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Task: ${args.taskId} (run: ${runId})`);
  console.log(`Diff: ${report.diff_path ?? '(MISSING)'}`);
  if (rgMissing) console.log(`⚠ rg unavailable — symbol-overlap scan skipped (degraded mode)`);
  console.log(`Added symbols: ${addedSymbols.length}`);
  for (const s of addedSymbols.slice(0, 10)) console.log(`  + ${s.file}:${s.line} ${s.symbol}`);
  console.log('');
  console.log(`Symbol overlaps: ${symbolOverlaps.length}`);
  for (const o of symbolOverlaps) {
    console.log(`  ⚠ ${o.new_symbol} (in ${o.new_file}) — also defined in:`);
    for (const f of o.existing_files) console.log(`      ${f}`);
  }
  console.log('');
  console.log(`High-impact files: ${highImpactFiles.length}`);
  for (const f of highImpactFiles) console.log(`  ⚠ ${f}`);
  console.log('');
  console.log(`Severity: ${severity.toUpperCase()}`);
  console.log('');
  console.log(`Recommendations:`);
  for (const r of recommendations) console.log(`  - ${r}`);
}

main();
