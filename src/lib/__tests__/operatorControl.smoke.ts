#!/usr/bin/env tsx
/**
 * Smoke test for the operator control plane (Codex tier-plan first sprint):
 * auto:run composite, auto:replay timeline + predicates, auto:doctor.
 *
 * The composite/replay/doctor CLIs interact with .agent-runs/ on disk. Tests
 * use a tmp HARNESS_PROJECT_ROOT + scaffold synthetic state, then invoke
 * the libraries that back the CLIs.
 *
 * Asserts:
 *   1. doctor on empty .agent-runs → "info: empty" only
 *   2. doctor finds orphan lock sentinel
 *   3. doctor finds terminal state with non-null lock
 *   4. doctor finds missing depends_on pointer
 *   5. doctor finds corrupt audit-log line
 *   6. replay timeline includes state-transition events from state-log.jsonl
 *   7. replay timeline includes codex-round events from r{N}-review.md files
 *   8. replay predicates correctly identify failing predicate when ux_validation enabled but ux-verdict missing
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

function makePack(taskId: string, state: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: '1',
    task_id: taskId,
    run_id: '2026-04-29-test',
    type: 'frd-polish',
    module_or_sprint: 'M99-test',
    version_target: 'v1.0',
    objective: 'test',
    acceptance_criteria: ['x'],
    allowed_paths: ['*'],
    forbidden_paths: [],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: 'x', gate_threshold: 7.0, max_rounds: 5, specialized_reviewers: [] },
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
    state,
    state_history: [],
    evidence_dir: `evidence/${taskId}`,
    depends_on: [],
    lock: null,
    cost_telemetry: [],
    actors: { reviewers: [], approvers: [] },
    notes: [],
    ...overrides,
  };
}

function setupTmpHarness(): { tmp: string; runId: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'op-ctl-'));
  const runId = '2026-04-29-test';
  fs.mkdirSync(path.join(tmp, '.agent-runs', runId, 'tasks'), { recursive: true });
  return { tmp, runId };
}

function runCli(cli: string, env: Record<string, string>, args: string[]): { exit: number; stdout: string; stderr: string } {
  const tsx = path.join(HARNESS_REPO, 'node_modules', '.bin', 'tsx');
  const r = spawnSync(tsx, [path.join(HARNESS_REPO, 'src', 'cli', `${cli}.ts`), ...args], {
    cwd: HARNESS_REPO,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { exit: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

console.log('— operatorControl.smoke');

// 1. doctor on empty .agent-runs — should produce "info: empty"
{
  const { tmp } = setupTmpHarness();
  // Strip the empty run dir; should produce empty
  fs.rmSync(path.join(tmp, '.agent-runs'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.agent-runs'), { recursive: true });
  const r = runCli('doctor', { HARNESS_PROJECT_ROOT: tmp }, ['--json']);
  assert(r.exit === 0, '1a. doctor on empty .agent-runs returns 0');
  const out = JSON.parse(r.stdout);
  assert(out.runs_scanned === 0, '1b. runs_scanned=0');
  assert(out.severities.error === 0, '1c. zero errors');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 2. orphan lock sentinel
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-001.json'), JSON.stringify(makePack('TP-2026-04-29-001', 'planned')));
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', '.TP-2026-04-29-001.lock'), 'stale');
  const r = runCli('doctor', { HARNESS_PROJECT_ROOT: tmp }, ['--json']);
  const out = JSON.parse(r.stdout);
  assert(out.issues.some((i: { category: string }) => i.category === 'orphan-sentinel'), '2. doctor flags orphan-sentinel');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. terminal state + non-null lock = warning
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-002.json'),
    JSON.stringify(makePack('TP-2026-04-29-002', 'merged', {
      lock: { holder: 'leftover', pid: 99999, acquired_at: '2026-04-29T10:00:00Z', expires_at: '2026-04-29T11:00:00Z', last_heartbeat_at: '2026-04-29T10:00:00Z' },
    }))
  );
  const r = runCli('doctor', { HARNESS_PROJECT_ROOT: tmp }, ['--json']);
  const out = JSON.parse(r.stdout);
  assert(out.issues.some((i: { category: string }) => i.category === 'terminal-with-lock'), '3. doctor flags terminal-with-lock');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 4. depends_on missing pointer
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-003.json'),
    JSON.stringify(makePack('TP-2026-04-29-003', 'planned', { depends_on: ['TP-2026-04-29-999'] }))
  );
  const r = runCli('doctor', { HARNESS_PROJECT_ROOT: tmp }, ['--json']);
  const out = JSON.parse(r.stdout);
  assert(out.issues.some((i: { category: string }) => i.category === 'missing-dependency'), '4. doctor flags missing-dependency');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 5. corrupt audit-log line
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-004.json'), JSON.stringify(makePack('TP-2026-04-29-004', 'planned')));
  fs.writeFileSync(path.join(tmp, '.agent-runs', '_override-audit.jsonl'), '{"valid":1}\nNOT-JSON\n{"valid":2}\n');
  const r = runCli('doctor', { HARNESS_PROJECT_ROOT: tmp }, ['--json']);
  const out = JSON.parse(r.stdout);
  assert(out.issues.some((i: { category: string }) => i.category === 'audit-log-corrupt'), '5. doctor flags audit-log-corrupt');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 6. replay timeline includes state-transition events
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-005.json'), JSON.stringify(makePack('TP-2026-04-29-005', 'awaiting-review')));
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'state-log.jsonl'), JSON.stringify({
    task_id: 'TP-2026-04-29-005', from: 'planned', to: 'in-progress', at: '2026-04-29T10:00:00Z', by: 'orchestrator', reason: 'auto:work R1',
  }) + '\n' + JSON.stringify({
    task_id: 'TP-2026-04-29-005', from: 'in-progress', to: 'awaiting-review', at: '2026-04-29T10:10:00Z', by: 'orchestrator', reason: 'evidence sealed',
  }) + '\n');
  const r = runCli('replay', { HARNESS_PROJECT_ROOT: tmp }, ['TP-2026-04-29-005', '--json']);
  const out = JSON.parse(r.stdout);
  assert(out.summary.state_transitions === 2, '6a. replay finds 2 state-transition events');
  assert(out.timeline[0].kind === 'state-transition', '6b. timeline[0] is state-transition');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 7. replay timeline includes codex rounds
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-006.json'), JSON.stringify(makePack('TP-2026-04-29-006', 'needs-revision')));
  const codexDir = path.join(tmp, '.agent-runs', runId, '_codex', 'TP-2026-04-29-006');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'r1-review.md'), 'Score: 6.4 / 10\nVerdict: NO-GO\nfinding: x');
  fs.writeFileSync(path.join(codexDir, 'r2-review.md'), 'Score: 7.2 / 10\nVerdict: GO\n');
  const r = runCli('replay', { HARNESS_PROJECT_ROOT: tmp }, ['TP-2026-04-29-006', '--json']);
  const out = JSON.parse(r.stdout);
  assert(out.summary.codex_rounds === 2, '7a. replay finds 2 codex-round events');
  const rounds = out.timeline.filter((e: { kind: string }) => e.kind === 'codex-round');
  assert(rounds[0].detail.score === 6.4, '7b. r1 score parsed');
  assert(rounds[1].detail.verdict === 'GO', '7c. r2 verdict parsed');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 8. replay predicate fails when ux_validation enabled but ux-verdict missing
{
  const { tmp, runId } = setupTmpHarness();
  fs.writeFileSync(path.join(tmp, '.agent-runs', runId, 'tasks', 'TP-2026-04-29-007.json'),
    JSON.stringify(makePack('TP-2026-04-29-007', 'awaiting-review', {
      ux_validation: {
        enabled: true,
        preview_url: 'http://test/',
        pages_to_capture: ['/'],
        viewports: [{ name: 'desktop', width: 1280, height: 800 }],
        browsers: ['chromium'],
        console_gate: { fail_on: ['error'], ignore_patterns: [] },
        network: { fail_on_failed_requests: true, block_patterns: [], ignore_patterns: [] },
        visual_regression: { enabled: false, max_diff_ratio: 0.01 },
        vision_review: { enabled: false, advisory_only: true },
      },
    }))
  );
  const r = runCli('replay', { HARNESS_PROJECT_ROOT: tmp }, ['TP-2026-04-29-007', '--json']);
  const out = JSON.parse(r.stdout);
  const uxPred = out.promotion_predicates.find((p: { name: string }) => p.name === 'ux-validation-passed');
  assert(uxPred !== undefined, '8a. ux-validation-passed predicate present');
  assert(uxPred.passed === false, '8b. predicate fails (no ux-verdict.json)');
  assert(uxPred.reason.includes('no ux-verdict.json'), '8c. reason cites missing verdict');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n✓ all operatorControl.smoke assertions passed');
