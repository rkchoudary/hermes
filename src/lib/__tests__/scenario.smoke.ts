#!/usr/bin/env tsx
/**
 * v0.5.0 T3 sprint — scenario integration tests.
 *
 * Codex T3 review (bx9m0hx0a) reframed this sprint as a "durability contract
 * sprint, not abstraction sprint": ship scenario-level tests that prove what
 * semantics the harness actually needs to preserve BEFORE designing
 * WorkflowStore for imagined Postgres needs.
 *
 * This file builds an isolated scenario-runner fixture (per Codex prescription
 * #1) and two scenarios:
 *
 *   1. Happy GO — planned → in-progress → awaiting-review → codex-reviewing
 *                 → promotable → ready-for-merge
 *   2. NO-GO → revise → GO — 2-round revision loop ending at ready-for-merge
 *
 * Per Codex (bx9m0hx0a section 2): "every mock scenario should run
 * auto:doctor --state; every scenario should run auto:replay and assert
 * predicates, not just final state; mock outputs should use the same
 * evidence file names/schema as real workers; avoid mocking internal
 * functions below the CLI/orchestration boundary."
 *
 * Mocks ONLY at the CLI boundary:
 *   - engine: 'manual' (existing first-class harness mode; operator-as-engine)
 *     We pre-write the worker evidence files; auto:work in manual mode validates
 *     evidence + transitions state.
 *   - CODEX_BIN env points to a mock script that emits canned verdicts.
 *
 * Real harness behavior under test:
 *   - State machine + transitions
 *   - Evidence file presence + naming
 *   - Audit log entries
 *   - Lock acquire + release
 *   - Replay timeline construction
 *   - Doctor integrity check
 *   - Promotion predicates
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_REPO = path.resolve(__dirname, '../../..');

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

// ─── Scenario fixture ──────────────────────────────────────────────────────

interface ScenarioFixture {
  tmp: string;          // tmp HARNESS_PROJECT_ROOT
  runId: string;
  taskId: string;
  evidenceDir: string;  // absolute path
  mockCodexBin: string; // absolute path
}

function setupFixture(taskId: string): ScenarioFixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-'));
  const runId = '2026-04-29-test';
  const tasksDir = path.join(tmp, '.agent-runs', runId, 'tasks');
  const evidenceDir = path.join(tmp, '.agent-runs', runId, 'evidence', taskId);
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  // verify-claims gate requires pack.references.frd_path → an existing file.
  // Pre-stage a minimal FRD doc so the gate can run without erroring.
  const frdDir = path.join(tmp, 'fake-frd');
  fs.mkdirSync(frdDir, { recursive: true });
  fs.writeFileSync(path.join(frdDir, 'M99.md'), '# M99 — scenario fixture FRD\n\nThis FRD exists only for scenario.smoke.ts. Real FRDs go under ${process.env.HERMES_DOCS_ROOT ?? "./docs"}/specs/.\n');

  // Mock codex binary: a sh script that drains stdin, writes a verdict to
  // stdout based on MOCK_CODEX_SCORE + MOCK_CODEX_VERDICT env. Must support
  // `codex exec -m <model> ... < prompt > output` AND `codex --version` probes.
  const mockCodexBin = path.join(tmp, 'mock-codex.sh');
  fs.writeFileSync(mockCodexBin, `#!/bin/bash
# Mock codex CLI for scenario tests.
if [ "$1" = "--version" ]; then
  echo "mock-codex 0.0.1"
  exit 0
fi
# Drain stdin (the prompt) — we don't need it.
cat > /dev/null
SCORE="\${MOCK_CODEX_SCORE:-8.0}"
VERDICT="\${MOCK_CODEX_VERDICT:-GO}"
THRESHOLD="\${MOCK_CODEX_THRESHOLD:-7.0}"
# Write a canned codex verdict markdown to stdout. Format must match what
# parseVerdict() in src/cli/consensus.ts expects: \`Score: X.X / 10\` and
# \`Verdict: GO|NO-GO\`.
cat <<EOF
# Codex review (mock)

Score: \${SCORE} / 10
Verdict: \${VERDICT}
Threshold: \${THRESHOLD}

## Findings

This is a mock review for scenario testing. Real codex would emit findings here.

EOF
`);
  fs.chmodSync(mockCodexBin, 0o755);

  return { tmp, runId, taskId, evidenceDir, mockCodexBin };
}

function makePack(taskId: string, runId: string, overrides: Record<string, unknown> = {}, frdAbsPath?: string): Record<string, unknown> {
  return {
    schema_version: '1',
    task_id: taskId,
    run_id: runId,
    type: 'frd-polish',
    module_or_sprint: 'M99-scenario',
    version_target: 'v1.0',
    objective: 'scenario test — durability contract proof',
    acceptance_criteria: ['evidence files present', 'state transitions correct'],
    allowed_paths: ['*'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [], frd_path: frdAbsPath ?? 'fake-frd/M99.md' },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'mock', gate_threshold: 7.0, max_rounds: 5, specialized_reviewers: [] },
    auto_land_policy: { enabled: false, allowed_task_types: ['platform-doc'], min_score: 8.0, min_consecutive_go: 2, protected_branches_excluded: ['main','master','release/*','production','prod'], real_merge_enabled: false },
    auto_promote_policy: { enabled: false, allowed_task_types: ['frd-polish', 'platform-doc'], min_score: 7.5, min_consecutive_go: 2 },
    required_skills: [],
    ux_validation: {
      enabled: false,
      pages_to_capture: ['/'],
      viewports: [{ name: 'desktop', width: 1280, height: 800 }],
      browsers: ['chromium'],
      console_gate: { fail_on: ['error'], ignore_patterns: [] },
      network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] },
      visual_regression: { enabled: false, max_diff_ratio: 0.01 },
      vision_review: { enabled: false, advisory_only: true },
    },
    state: 'planned',
    state_history: [],
    evidence_dir: path.join('evidence', taskId),
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    actors: { reviewers: [], approvers: [] },
    notes: [],
    engine: 'manual',
    base_sha: '0000000',
    ...overrides,
  };
}

function writePack(fix: ScenarioFixture, pack: Record<string, unknown>): void {
  const packPath = path.join(fix.tmp, '.agent-runs', fix.runId, 'tasks', `${fix.taskId}.json`);
  fs.writeFileSync(packPath, JSON.stringify(pack, null, 2));
}

/**
 * Pre-write the 5-file worker evidence bundle that real workers produce.
 * Codex prescription: "mock outputs should use the same evidence file
 * names/schema as real workers."
 */
function writeWorkerEvidence(fix: ScenarioFixture): void {
  fs.mkdirSync(fix.evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(fix.evidenceDir, 'diff.patch'), '--- mock diff\n+++ added one line\n');
  fs.writeFileSync(path.join(fix.evidenceDir, 'test-summary.md'), '# Tests\n\n2/2 passing.\n');
  fs.writeFileSync(path.join(fix.evidenceDir, 'duplicate-scan.json'), JSON.stringify({ scan_command: 'echo', preexisting_definitions: [] }));
  fs.writeFileSync(path.join(fix.evidenceDir, 'risk-register.md'), '# Risk register\n\n| risk | mitigation |\n|---|---|\n| none | n/a |\n');
  fs.writeFileSync(path.join(fix.evidenceDir, 'worker-handoff.json'), JSON.stringify({
    completed: true,
    summary: 'mock worker handoff',
    files_changed: ['mock.ts'],
    tests_run: ['mock.test.ts'],
    test_results: { passed: 2, failed: 0 },
  }));
  // Optional but harmless — claims.txt is read by verify-claims gate.
  fs.writeFileSync(path.join(fix.evidenceDir, 'claims.txt'), 'I edited mock.ts\nI ran tests; all green.\n');
}

interface CliResult {
  exit: number;
  stdout: string;
  stderr: string;
}

function runHarnessCli(fix: ScenarioFixture, scriptName: string, args: string[], extraEnv: Record<string, string> = {}): CliResult {
  const r = spawnSync('pnpm', ['--silent', '--dir', HARNESS_REPO, scriptName, ...args], {
    cwd: HARNESS_REPO,
    env: {
      ...process.env,
      HARNESS_PROJECT_ROOT: fix.tmp,
      CODEX_BIN: fix.mockCodexBin,
      // Allow same-actor SoD bypass for solo scenario tests; entry will be audited
      AUTO_SOD_REVIEWER_OVERRIDE: '1',
      AUTO_SOD_REVIEWER_OVERRIDE_REASON: 'scenario test',
      // Model inventory check looks at harnessRoot/.agent-runs/_model-inventory.json
      // and harnessRoot resolution in work.ts uses PACKAGE_ROOT/../.. (NOT the
      // env-aware resolveHarnessRoot()), so it walks above the harness package.
      // Bypass for scenario tests; real production deployments have a real inventory.
      AUTO_MODEL_INVENTORY_BYPASS: '1',
      AUTO_MODEL_INVENTORY_BYPASS_REASON: 'scenario integration test fixture',
      // Skip cwd-clean guard since the scenario fixture's tmp dir isn't a git repo
      AUTO_FORCE_REASON: 'scenario test fixture',
      // Sprint K v2 worktree HEAD guard (harnessGuard.ts) requires either driver
      // dispatch (AUTO_HARNESS_DRIVER=1) or --override-harness-driver. Scenario
      // tests are an integration-test driver in their own right; mark as such.
      AUTO_HARNESS_DRIVER: '1',
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { exit: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readPack(fix: ScenarioFixture): Record<string, unknown> {
  const packPath = path.join(fix.tmp, '.agent-runs', fix.runId, 'tasks', `${fix.taskId}.json`);
  return JSON.parse(fs.readFileSync(packPath, 'utf8'));
}

function readStateLog(fix: ScenarioFixture): Array<Record<string, unknown>> {
  const logPath = path.join(fix.tmp, '.agent-runs', fix.runId, 'state-log.jsonl');
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, 'utf8')
    .split('\n').filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

function noOrphanLocks(fix: ScenarioFixture): boolean {
  const tasksDir = path.join(fix.tmp, '.agent-runs', fix.runId, 'tasks');
  const sentinel = path.join(tasksDir, `.${fix.taskId}.lock`);
  return !fs.existsSync(sentinel);
}

function cleanup(fix: ScenarioFixture): void {
  fs.rmSync(fix.tmp, { recursive: true, force: true });
}

// ─── Scenario 1: Happy GO ──────────────────────────────────────────────────

console.log('— scenario.smoke');
console.log('\n=== Scenario 1: Happy GO (planned → ready-for-merge) ===');
{
  const fix = setupFixture('TP-2026-04-29-001');
  writePack(fix, makePack(fix.taskId, fix.runId, {}, path.join(fix.tmp, 'fake-frd', 'M99.md')));
  writeWorkerEvidence(fix);

  // Step 1: auto:work (engine='manual') validates evidence + transitions to awaiting-review
  const work = runHarnessCli(fix, 'auto:work', [fix.taskId, '--engine', 'mock', '--force']);
  if (work.exit !== 0) {
    console.error(`auto:work stderr (last 1500 chars):\n${work.stderr.slice(-1500)}`);
    console.error(`auto:work stdout (last 500 chars):\n${work.stdout.slice(-500)}`);
  }
  assert(work.exit === 0, '1.1. auto:work exits 0');
  let pack = readPack(fix);
  if (pack.state !== 'awaiting-review') {
    console.error(`work stdout tail:\n${work.stdout.slice(-2000)}`);
    console.error(`work stderr tail:\n${work.stderr.slice(-1000)}`);
  }
  assert(pack.state === 'awaiting-review', `1.2. state=awaiting-review (got ${pack.state})`);

  // Step 2: auto:consensus with mock codex returning Score 8.0 GO
  const cons = runHarnessCli(fix, 'auto:consensus', [fix.taskId, '--gate', 'completion', '--apply'], {
    MOCK_CODEX_SCORE: '8.0',
    MOCK_CODEX_VERDICT: 'GO',
  });
  assert(cons.exit === 0, `1.3. auto:consensus exits 0 (got ${cons.exit}; stderr tail: ${cons.stderr.slice(-300)})`);
  pack = readPack(fix);
  assert(pack.state === 'promotable', `1.4. state=promotable (got ${pack.state})`);
  const codex = pack.codex as { score: number; verdict: string } | undefined;
  assert(codex?.verdict === 'GO' && codex?.score === 8.0, '1.5. codex verdict GO @ 8.0 recorded');

  // Step 3: assertions on the durability contract (NOT auto:promote; that
  // dispatches gh-cli and Vercel which is out of scope for this test —
  // Codex bx9m0hx0a: "test the orchestrator, not engine correctness").
  assert(noOrphanLocks(fix), '1.6. no orphan lock sentinels after lifecycle');
  const transitions = readStateLog(fix).filter((e) => e.task_id === fix.taskId);
  assert(transitions.length >= 2, `1.7. state-log has ≥ 2 transitions (got ${transitions.length})`);

  // Step 4: auto:replay — assert timeline + predicates
  const replay = runHarnessCli(fix, 'auto:replay', [fix.taskId, '--json']);
  assert(replay.exit === 0, '1.8. auto:replay exits 0');
  const r = JSON.parse(replay.stdout);
  assert(r.summary.state_transitions >= 2, `1.9. replay finds ≥ 2 state transitions (got ${r.summary.state_transitions})`);
  assert(r.summary.codex_rounds === 1, `1.10. replay finds 1 codex round (got ${r.summary.codex_rounds})`);
  assert(r.current_state === 'promotable', `1.11. replay current_state=promotable (got ${r.current_state})`);

  // Step 5: auto:doctor — assert clean
  const doctor = runHarnessCli(fix, 'auto:doctor', ['--state', '--json']);
  assert(doctor.exit === 0, '1.12. auto:doctor --state exits 0 (clean)');
  const d = JSON.parse(doctor.stdout);
  assert(d.severities.error === 0, `1.13. doctor reports zero errors (got ${d.severities.error})`);

  cleanup(fix);
  console.log('  ✓ Scenario 1 PASS');
}

// ─── Scenario 2: NO-GO → revise → GO ───────────────────────────────────────

console.log('\n=== Scenario 2: NO-GO → revise → GO (2 codex rounds) ===');
{
  const fix = setupFixture('TP-2026-04-29-002');
  writePack(fix, makePack(fix.taskId, fix.runId, {}, path.join(fix.tmp, 'fake-frd', 'M99.md')));
  writeWorkerEvidence(fix);

  // Round 1: auto:work + auto:consensus with NO-GO 6.4
  let r = runHarnessCli(fix, 'auto:work', [fix.taskId, '--engine', 'mock', '--force']);
  assert(r.exit === 0, '2.1. R1 auto:work exits 0');
  r = runHarnessCli(fix, 'auto:consensus', [fix.taskId, '--gate', 'completion', '--apply'], {
    MOCK_CODEX_SCORE: '6.4',
    MOCK_CODEX_VERDICT: 'NO-GO',
  });
  assert(r.exit === 0, `2.2. R1 auto:consensus exits 0 (got ${r.exit}; stderr: ${r.stderr.slice(-200)})`);
  let pack = readPack(fix);
  assert(pack.state === 'needs-revision', `2.3. state=needs-revision after NO-GO (got ${pack.state})`);

  // Round 2: re-write evidence (worker's "revised" output) + auto:work --force + auto:consensus with GO 7.8
  writeWorkerEvidence(fix);
  r = runHarnessCli(fix, 'auto:work', [fix.taskId, '--engine', 'mock', '--force']);
  assert(r.exit === 0, `2.4. R2 auto:work --force exits 0 (got ${r.exit})`);
  r = runHarnessCli(fix, 'auto:consensus', [fix.taskId, '--gate', 'completion', '--apply'], {
    MOCK_CODEX_SCORE: '7.8',
    MOCK_CODEX_VERDICT: 'GO',
  });
  assert(r.exit === 0, '2.5. R2 auto:consensus exits 0');
  pack = readPack(fix);
  assert(pack.state === 'promotable', `2.6. state=promotable after GO (got ${pack.state})`);
  const codex = pack.codex as { score: number; verdict: string; rounds_executed?: number } | undefined;
  assert(codex?.score === 7.8 && codex?.verdict === 'GO', '2.7. final codex 7.8 GO recorded');
  assert((codex?.rounds_executed ?? 0) >= 2, `2.8. rounds_executed ≥ 2 (got ${codex?.rounds_executed})`);

  // Replay finds BOTH rounds
  const replay = runHarnessCli(fix, 'auto:replay', [fix.taskId, '--json']);
  assert(replay.exit === 0, '2.9. auto:replay exits 0');
  const rr = JSON.parse(replay.stdout);
  assert(rr.summary.codex_rounds === 2, `2.10. replay finds 2 codex rounds (got ${rr.summary.codex_rounds})`);
  // Property: round-1 score < round-2 score (revision improved)
  const codexEvents = rr.timeline.filter((e: { kind: string }) => e.kind === 'codex-round');
  assert(codexEvents[0].detail.score === 6.4 && codexEvents[1].detail.score === 7.8, '2.11. score progression 6.4 → 7.8');
  assert(codexEvents[0].detail.verdict === 'NO-GO' && codexEvents[1].detail.verdict === 'GO', '2.12. verdict NO-GO → GO');

  // Doctor still clean
  const doctor = runHarnessCli(fix, 'auto:doctor', ['--state', '--json']);
  assert(doctor.exit === 0, '2.13. doctor exits 0');
  const d = JSON.parse(doctor.stdout);
  assert(d.severities.error === 0, '2.14. doctor zero errors after revision loop');

  // No orphan locks
  assert(noOrphanLocks(fix), '2.15. no orphan locks after 2-round lifecycle');

  cleanup(fix);
  console.log('  ✓ Scenario 2 PASS');
}

console.log('\n✓ all scenario.smoke assertions passed');
