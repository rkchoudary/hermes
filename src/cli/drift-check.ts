#!/usr/bin/env node
/**
 * pnpm auto:drift-check (M7 MVP) — FRD↔code drift detector.
 *
 * Per AGENT-ROSTER-AUDIT.md M7: 'When code lands, FRDs may go stale. Detect
 * divergence.' Phase 2/3 needs L7 continuous-eval + AST/embedding similarity
 * to be fully effective.
 *
 * THIS MVP: for a given module, scans:
 *   1. The FRD file (${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/FRD-MNN-<dir>/FRD-MNN.md) for
 *      acceptance criteria and FR-IDs (e.g., FR-M02-028)
 *   2. The codebase for matching FR-ID references in code comments
 *   3. Reports FR-IDs that exist in the FRD but NOT in the codebase
 *      (potential drift: FRD says feature exists; code doesn't reference it)
 *
 * Phase 2/3 will add:
 *   - AST-level semantic match (does the code actually IMPLEMENT the AC?)
 *   - Embedding similarity between FRD AC text and code comments/docstrings
 *   - L7 continuous-eval to track drift over time per merge
 *   - Reverse drift: code references FR-IDs not in current FRD version
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();

interface Args {
  module: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { module: '', json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--module' && i + 1 < argv.length) args.module = argv[++i];
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (!args.module && positional.length > 0) args.module = positional[0];
  if (!args.module) throw new Error('Required: --module M02 (or just M02)');
  return args;
}

interface DriftReport {
  module: string;
  detected_at: string;
  frd_path: string | null;
  fr_ids_in_frd: string[];
  fr_ids_in_code: string[];
  drift_only_in_frd: string[];   // exists in FRD but no code reference (potential undelivered)
  drift_only_in_code: string[];  // exists in code but not in FRD (potential stale FRD or stale code reference)
  severity: 'ok' | 'low' | 'medium' | 'high';
  recommendations: string[];
  /** R5 fail-safe: surfaces when rg is unavailable so operator knows the code-side scan was skipped. */
  degraded?: { rg_available: boolean; reason?: string };
}

/**
 * R5 fail-safe: probe rg availability once. If absent, the code-side FR-ID
 * extraction is skipped and the report is marked degraded. Without this,
 * a missing rg silently returns 0 code-side FR-IDs and inflates drift.
 */
function isRgAvailable(): boolean {
  const r = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  return r.status === 0;
}

function findFrdPath(module: string): string | null {
  const obsidianDir = path.join(process.env.HOME ?? '', process.env.HERMES_DOCS_ROOT || './docs/specs');
  if (!fs.existsSync(obsidianDir)) return null;
  for (const dir of fs.readdirSync(obsidianDir)) {
    if (dir.startsWith(`FRD-${module.toUpperCase()}-`)) {
      const frdFile = path.join(obsidianDir, dir, `FRD-${module.toUpperCase()}.md`);
      if (fs.existsSync(frdFile)) return frdFile;
    }
  }
  return null;
}

function extractFrIds(text: string, modulePrefix: string): string[] {
  // Match FR-M02-028 pattern (case-insensitive on M)
  const re = new RegExp(`FR-${modulePrefix.toUpperCase()}-\\d+`, 'gi');
  const matches = text.match(re) ?? [];
  return [...new Set(matches.map((m) => m.toUpperCase()))];
}

function extractFrIdsFromCode(modulePrefix: string, repoRoot: string): string[] {
  const r = spawnSync(
    'rg',
    [
      '-o',
      '-I',
      '--no-filename',
      `FR-${modulePrefix.toUpperCase()}-\\d+`,
      '-g', '!node_modules',
      '-g', '!dist',
      '-g', '!.next',
      '-g', '!.agent-runs',
      '-g', '!session-history',
    ],
    { cwd: repoRoot, encoding: 'utf8', timeout: 30_000 }
  );
  if (r.status !== 0 && r.status !== 1) return [];
  return [...new Set(r.stdout.split('\n').filter((l) => l.trim().length > 0).map((l) => l.toUpperCase()))];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const moduleNorm = args.module.toUpperCase().match(/^M\d+/)?.[0] ?? args.module.toUpperCase();

  const frdPath = findFrdPath(moduleNorm);
  let frIdsInFrd: string[] = [];
  if (frdPath && fs.existsSync(frdPath)) {
    const body = fs.readFileSync(frdPath, 'utf8');
    frIdsInFrd = extractFrIds(body, moduleNorm);
  }

  // Resolve repo root for grep
  const topLevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const repoRoot = topLevel.status === 0 ? topLevel.stdout.trim() : HARNESS_ROOT;

  // R5 fail-safe: if rg isn't available, skip the code-side extraction
  // entirely and mark the report degraded — instead of silently returning 0
  // code-side FR-IDs and falsely reporting all FRD FR-IDs as drift.
  const rgAvailable = isRgAvailable();
  const frIdsInCode = rgAvailable ? extractFrIdsFromCode(moduleNorm, repoRoot) : [];

  const driftOnlyInFrd = rgAvailable ? frIdsInFrd.filter((id) => !frIdsInCode.includes(id)) : [];
  const driftOnlyInCode = rgAvailable ? frIdsInCode.filter((id) => !frIdsInFrd.includes(id)) : [];

  let severity: DriftReport['severity'] = 'ok';
  if (!frdPath) severity = 'high';
  else if (!rgAvailable) severity = 'medium'; // degraded: cannot detect code-side drift
  else if (driftOnlyInFrd.length > 5 || driftOnlyInCode.length > 5) severity = 'high';
  else if (driftOnlyInFrd.length > 0 || driftOnlyInCode.length > 0) severity = 'medium';

  const recommendations: string[] = [];
  if (!frdPath) {
    recommendations.push(`FRD file for ${moduleNorm} NOT FOUND in ${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/. Authoring incomplete.`);
  } else if (!rgAvailable) {
    recommendations.push(
      `\`rg\` (ripgrep) not available on PATH. Code-side FR-ID extraction skipped (degraded mode). ` +
      `Install ripgrep or run on a host with rg before trusting drift conclusions.`
    );
  } else {
    if (driftOnlyInFrd.length > 0) {
      recommendations.push(
        `${driftOnlyInFrd.length} FR-IDs in FRD but NOT referenced in code (potential undelivered): ` +
        driftOnlyInFrd.slice(0, 10).join(', ') + (driftOnlyInFrd.length > 10 ? `, ... ${driftOnlyInFrd.length - 10} more` : '')
      );
    }
    if (driftOnlyInCode.length > 0) {
      recommendations.push(
        `${driftOnlyInCode.length} FR-IDs in code but NOT in FRD (potential stale FRD or stale code refs): ` +
        driftOnlyInCode.slice(0, 10).join(', ') + (driftOnlyInCode.length > 10 ? `, ... ${driftOnlyInCode.length - 10} more` : '')
      );
    }
  }
  if (recommendations.length === 0) {
    recommendations.push(`No drift detected at MVP scope. Phase 2 will add semantic match (does code actually implement the AC?).`);
  }

  const report: DriftReport = {
    module: moduleNorm,
    detected_at: new Date().toISOString(),
    frd_path: frdPath,
    fr_ids_in_frd: frIdsInFrd,
    fr_ids_in_code: frIdsInCode,
    drift_only_in_frd: driftOnlyInFrd,
    drift_only_in_code: driftOnlyInCode,
    severity,
    recommendations,
    degraded: rgAvailable ? undefined : { rg_available: false, reason: 'rg not on PATH' },
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Module: ${moduleNorm}`);
  console.log(`FRD: ${report.frd_path ?? '(NOT FOUND)'}`);
  if (!rgAvailable) console.log(`⚠ rg unavailable — code-side scan skipped (degraded mode)`);
  console.log(`FR-IDs in FRD: ${frIdsInFrd.length}`);
  console.log(`FR-IDs in code: ${rgAvailable ? frIdsInCode.length : '(SKIPPED)'}`);
  console.log('');
  console.log(`Drift (in FRD, not in code): ${driftOnlyInFrd.length}`);
  for (const id of driftOnlyInFrd.slice(0, 10)) console.log(`  ⚠ ${id}`);
  if (driftOnlyInFrd.length > 10) console.log(`  ... ${driftOnlyInFrd.length - 10} more`);
  console.log('');
  console.log(`Drift (in code, not in FRD): ${driftOnlyInCode.length}`);
  for (const id of driftOnlyInCode.slice(0, 10)) console.log(`  ⚠ ${id}`);
  if (driftOnlyInCode.length > 10) console.log(`  ... ${driftOnlyInCode.length - 10} more`);
  console.log('');
  console.log(`Severity: ${severity.toUpperCase()}`);
  console.log(`Recommendations:`);
  for (const r of recommendations) console.log(`  - ${r}`);
}

main();
