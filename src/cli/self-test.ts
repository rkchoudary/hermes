#!/usr/bin/env tsx
/**
 * Layer 2 — Contract self-tests (`pnpm auto:self-test`).
 *
 * Doctrine: the driver refuses to call any stage whose self-test isn't
 * green in the last 24h. This forces stages to stay healthy.
 *
 * What this CLI does:
 *
 *   pnpm auto:self-test --all
 *     Run static contract validation for every registered stage:
 *       1. Stage's registry entry is internally consistent
 *       2. Every fixture for that stage parses + matches the registry contract
 *       3. Coverage check: every stage has ≥1 fixture (warns if not)
 *
 *   pnpm auto:self-test --stage <name>
 *     Run static validation for one stage. Exits 0 on green, 1 on fail.
 *     Writes result to .agent-runs/_self-tests/<stage>-<timestamp>.json
 *
 *   pnpm auto:self-test --check-driver-precall <stage>
 *     For driver use: returns exit 0 iff <stage> has a green self-test
 *     within the last 24h. Exit 1 means "DO NOT CALL THIS STAGE; run
 *     pnpm auto:self-test --stage <name> first".
 *
 * The CLI itself emits a Layer 0 outcome envelope on stdout so the
 * driver can route on it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from '../lib/harnessRoot';
import { STAGE_REGISTRY, getStageEntry } from '../lib/stageRegistry';
import {
  loadFixtures,
  staticallyValidateFixtures,
  analyzeCoverage,
  type ReplayFixture,
} from '../lib/replay';
import {
  emitStageOutcome,
  emitPreconditionFail,
  emitSuccess,
} from '../lib/stageOutcome';

interface CliArgs {
  mode: 'all' | 'one-stage' | 'check-precall';
  stage?: string;
  json?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: Partial<CliArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--all') a.mode = 'all';
    else if (x === '--stage' && i + 1 < argv.length) {
      a.mode = 'one-stage';
      a.stage = argv[++i];
    } else if (x === '--check-driver-precall' && i + 1 < argv.length) {
      a.mode = 'check-precall';
      a.stage = argv[++i];
    } else if (x === '--json') a.json = true;
    else if (x === '-h' || x === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  if (!a.mode) {
    printHelp();
    process.exit(1);
  }
  return a as CliArgs;
}

function printHelp(): void {
  console.log(`pnpm auto:self-test [--all | --stage <name> | --check-driver-precall <name>] [--json]`);
}

function selfTestsDir(): string {
  const d = path.join(harnessRoot(), '.agent-runs', '_self-tests');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeResult(stage: string, result: object): string {
  const fname = `${stage.replace(':', '_')}-${Date.now()}.json`;
  const p = path.join(selfTestsDir(), fname);
  fs.writeFileSync(p, JSON.stringify(result, null, 2));
  return p;
}

interface StageSelfTestResult {
  stage: string;
  ok: boolean;
  fixture_count: number;
  fixtures_passed: number;
  fixtures_failed: { fixture_id: string; failures: string[] }[];
  coverage_warning?: string;
  ran_at: string;
}

function selfTestOne(stage: string, allFixtures: ReplayFixture[]): StageSelfTestResult {
  const entry = getStageEntry(stage);
  const ran_at = new Date().toISOString();
  if (!entry) {
    return {
      stage,
      ok: false,
      fixture_count: 0,
      fixtures_passed: 0,
      fixtures_failed: [{ fixture_id: '(registry)', failures: [`stage "${stage}" not in registry`] }],
      ran_at,
    };
  }
  const stageFixtures = allFixtures.filter((f) => f.stage === stage);
  const checks = staticallyValidateFixtures(stageFixtures);
  const failed = checks.filter((c) => !c.ok).map((c) => ({
    fixture_id: c.fixture_id,
    failures: c.failures,
  }));
  return {
    stage,
    ok: failed.length === 0,
    fixture_count: stageFixtures.length,
    fixtures_passed: checks.filter((c) => c.ok).length,
    fixtures_failed: failed,
    coverage_warning: stageFixtures.length === 0
      ? `stage ${stage} has no fixtures — driver pre-call check will fail until at least one fixture is added`
      : undefined,
    ran_at,
  };
}

function main(): void {
  const start = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const fixtures = loadFixtures();

  if (args.mode === 'check-precall') {
    if (!args.stage) {
      emitPreconditionFail({
        stage: 'auto:self-test',
        reason: '--check-driver-precall requires <stage> argument',
      });
      process.exit(1);
    }
    const dir = selfTestsDir();
    const stagePrefix = args.stage.replace(':', '_');
    const candidates = fs.readdirSync(dir).filter((f) => f.startsWith(stagePrefix + '-') && f.endsWith('.json'));
    if (candidates.length === 0) {
      console.error(`[self-test] no prior self-test result for ${args.stage}; run \`pnpm auto:self-test --stage ${args.stage}\``);
      emitPreconditionFail({
        stage: 'auto:self-test',
        reason: `no prior self-test result for ${args.stage}`,
        details: { stage_under_test: args.stage, lookup_dir: dir },
      });
      process.exit(1);
    }
    candidates.sort();
    const latest = candidates[candidates.length - 1];
    const latestPath = path.join(dir, latest);
    const result = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as StageSelfTestResult;
    const ageMs = Date.now() - new Date(result.ran_at).getTime();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    if (ageMs > TWENTY_FOUR_HOURS) {
      console.error(`[self-test] last result for ${args.stage} is ${(ageMs / 60_000).toFixed(0)}m old (>24h); refusing pre-call. Re-run \`pnpm auto:self-test --stage ${args.stage}\``);
      emitPreconditionFail({
        stage: 'auto:self-test',
        reason: `self-test result for ${args.stage} is stale (>24h old)`,
        details: { stage_under_test: args.stage, age_minutes: Math.round(ageMs / 60_000) },
      });
      process.exit(1);
    }
    if (!result.ok) {
      console.error(`[self-test] ${args.stage} last run FAILED at ${result.ran_at}; refusing pre-call`);
      emitPreconditionFail({
        stage: 'auto:self-test',
        reason: `self-test for ${args.stage} last reported FAIL at ${result.ran_at}`,
        details: { stage_under_test: args.stage, fixtures_failed: result.fixtures_failed },
      });
      process.exit(1);
    }
    console.log(`[self-test] ${args.stage} green ${(ageMs / 60_000).toFixed(0)}m ago — driver may proceed`);
    emitSuccess({
      stage: 'auto:self-test',
      reason: `self-test for ${args.stage} green ${(ageMs / 60_000).toFixed(0)}m ago`,
      metrics: { duration_ms: Date.now() - start },
      details: { stage_under_test: args.stage, age_minutes: Math.round(ageMs / 60_000) },
    });
    process.exit(0);
  }

  if (args.mode === 'one-stage') {
    if (!args.stage) {
      printHelp();
      process.exit(1);
    }
    const result = selfTestOne(args.stage, fixtures);
    const resultPath = writeResult(args.stage, result);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printOneResult(result, resultPath);
    }
    if (result.ok) {
      emitSuccess({
        stage: 'auto:self-test',
        reason: `self-test for ${args.stage} passed (${result.fixtures_passed}/${result.fixture_count} fixtures)`,
        metrics: { duration_ms: Date.now() - start },
        evidence: [{ kind: 'self-test-result', path: resultPath }],
        details: { stage_under_test: args.stage },
      });
    } else {
      emitStageOutcome({
        stage: 'auto:self-test',
        ok: false,
        kind: 'gate-fail',
        retryable: false,
        driver_action: 'mark-gate-broken',
        reason: `self-test for ${args.stage} FAILED (${result.fixtures_failed.length} fixture(s) failed)`,
        evidence: [{ kind: 'self-test-result', path: resultPath }],
        metrics: { duration_ms: Date.now() - start },
        details: { stage_under_test: args.stage, fixtures_failed: result.fixtures_failed },
      });
    }
    process.exit(result.ok ? 0 : 1);
  }

  // mode === 'all'
  const results: StageSelfTestResult[] = [];
  let allOk = true;
  for (const entry of STAGE_REGISTRY) {
    const r = selfTestOne(entry.stage, fixtures);
    results.push(r);
    writeResult(entry.stage, r);
    if (!r.ok) allOk = false;
  }
  const coverage = analyzeCoverage(fixtures);
  if (args.json) {
    console.log(JSON.stringify({ ok: allOk, results, coverage }, null, 2));
  } else {
    printAllResults(results, coverage);
  }
  emitStageOutcome({
    stage: 'auto:self-test',
    ok: allOk,
    kind: allOk ? 'gate-pass' : 'gate-fail',
    retryable: false,
    driver_action: allOk ? 'advance' : 'mark-gate-broken',
    reason: allOk
      ? `all ${STAGE_REGISTRY.length} stages green; coverage=${coverage.covered.length}/${STAGE_REGISTRY.length}`
      : `${results.filter((r) => !r.ok).length} stages failed self-test; coverage=${coverage.covered.length}/${STAGE_REGISTRY.length}`,
    evidence: [],
    metrics: { duration_ms: Date.now() - start },
    details: {
      stages: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      coverage_pct: Math.round((coverage.covered.length / STAGE_REGISTRY.length) * 100),
      uncovered: coverage.uncovered,
    },
  });
  process.exit(allOk ? 0 : 1);
}

function printOneResult(r: StageSelfTestResult, p: string): void {
  const icon = r.ok ? '✓' : '✗';
  console.log(`${icon} ${r.stage}: ${r.fixtures_passed}/${r.fixture_count} fixtures pass`);
  if (r.coverage_warning) console.log(`  ⚠ ${r.coverage_warning}`);
  for (const f of r.fixtures_failed) {
    console.log(`  ✗ ${f.fixture_id}`);
    for (const reason of f.failures) console.log(`     - ${reason}`);
  }
  console.log(`  result: ${p}`);
}

function printAllResults(results: StageSelfTestResult[], coverage: { covered: string[]; uncovered: string[] }): void {
  console.log('');
  console.log('═══════════════════════════════════════');
  console.log('Layer 2 — Contract Self-Tests');
  console.log('═══════════════════════════════════════');
  for (const r of results) {
    const icon = r.ok ? '✓' : '✗';
    const cov = r.fixture_count === 0 ? ' (NO FIXTURES)' : '';
    console.log(`${icon} ${r.stage.padEnd(28)} ${r.fixtures_passed}/${r.fixture_count} fixtures${cov}`);
  }
  console.log('');
  console.log(`Coverage: ${coverage.covered.length}/${STAGE_REGISTRY.length} stages with ≥1 fixture`);
  if (coverage.uncovered.length > 0) {
    console.log(`Uncovered: ${coverage.uncovered.join(', ')}`);
  }
}

main();
