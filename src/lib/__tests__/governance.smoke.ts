/**
 * Smoke tests for Phase 1 governance libs (PUB-8 SoD + PUB-9 merge gate).
 * Run: tsx src/lib/__tests__/governance.smoke.ts
 *
 * No test framework dep added — uses node:assert. Pattern matches the
 * existing taskPackGuards.smoke.ts.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  Identity,
  defaultSoDPolicy,
  enforceSoD,
  appendActor,
  identitiesMatch,
  identityKey,
  type Actors,
} from '../sod';
import {
  defaultMergePolicy,
  evaluateMergePolicy,
} from '../mergePolicy';
import {
  appendOverrideAudit,
  readOverrideAudit,
  auditPath,
  OverrideAuditEntry,
} from '../overrideAudit';
import { parseTaskPack, type TaskPack } from '../taskPack';

let passed = 0;
let failed = 0;

function it(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

function suite(name: string, fn: () => void): void {
  console.log(`\n${name}`);
  fn();
}

function id(name: string, email?: string): Identity {
  return Identity.parse({
    name,
    email,
    source: 'manual',
    captured_at: new Date().toISOString(),
  });
}

function emptyActors(): Actors {
  return { creator: undefined, reviewers: [], approvers: [] };
}

function fixture(overrides: Partial<TaskPack> = {}): TaskPack {
  return parseTaskPack({
    task_id: 'TP-2026-04-27-999',
    run_id: '2026-04-27-test',
    type: 'code-sprint',
    module_or_sprint: 'M00-test',
    version_target: 'v0.0',
    objective: 'governance smoke test',
    acceptance_criteria: ['ac1'],
    allowed_paths: ['src/'],
    forbidden_paths: ['NEXT-SESSION.md'],
    context_budget: { max_task_pack_kb: 8, max_log_summary_kb: 4, max_codex_bundle_kb: 32 },
    references: { code_paths: [], obsidian_paths: [] },
    commands: { implement: [], test: [] },
    consensus: { reviewer: 'codex-5.5-xhigh', prompt_template: '/tmp/x.txt', gate_threshold: 7, max_rounds: 2 },
    state: 'planned',
    state_history: [],
    evidence_dir: '/tmp/test',
    depends_on: [],
    cost_telemetry: [],
    lock: null,
    notes: [],
    ...overrides,
  });
}

// ─── PUB-8 SoD ───────────────────────────────────────────────────────────

suite('PUB-8 SoD: identityKey + identitiesMatch', () => {
  it('matches by email when present (case insensitive)', () => {
    const a = id('Alice', 'Alice@bank.com');
    const b = id('a different name', 'alice@bank.com');
    assert.equal(identitiesMatch(a, b), true);
  });
  it('matches by name when no email', () => {
    const a = id('alice');
    const b = id('  ALICE  ');
    assert.equal(identitiesMatch(a, b), true);
  });
  it('does not match different identities', () => {
    assert.equal(identitiesMatch(id('alice'), id('bob')), false);
  });
});

suite('PUB-8 SoD: enforceSoD reviewer rule', () => {
  const policy = defaultSoDPolicy();
  it('blocks creator-as-reviewer', () => {
    const actors = appendActor(emptyActors(), 'creator', id('alice'));
    const r = enforceSoD(policy, actors, 'reviewer', id('alice'));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /reviewer.*creator/i);
  });
  it('allows distinct reviewer', () => {
    const actors = appendActor(emptyActors(), 'creator', id('alice'));
    const r = enforceSoD(policy, actors, 'reviewer', id('bob'));
    assert.equal(r.ok, true);
  });
});

suite('PUB-8 SoD: enforceSoD approver rule', () => {
  const policy = defaultSoDPolicy();
  it('blocks creator-as-approver', () => {
    const actors = appendActor(emptyActors(), 'creator', id('alice'));
    const r = enforceSoD(policy, actors, 'approver', id('alice'));
    assert.equal(r.ok, false);
  });
  it('blocks reviewer-as-approver', () => {
    let actors = appendActor(emptyActors(), 'creator', id('alice'));
    actors = appendActor(actors, 'reviewer', id('bob'));
    const r = enforceSoD(policy, actors, 'approver', id('bob'));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /reviewer/i);
  });
  it('allows distinct approver', () => {
    let actors = appendActor(emptyActors(), 'creator', id('alice'));
    actors = appendActor(actors, 'reviewer', id('bob'));
    const r = enforceSoD(policy, actors, 'approver', id('carol'));
    assert.equal(r.ok, true);
  });
  it('blocks when min_reviewers not met', () => {
    const policyStrict = { ...defaultSoDPolicy(), min_reviewers: 1 };
    const actors = appendActor(emptyActors(), 'creator', id('alice'));
    // No reviewers → approver attempt should fail
    const r = enforceSoD(policyStrict, actors, 'approver', id('carol'));
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /reviewer/i);
  });
});

suite('PUB-8 SoD: appendActor idempotency', () => {
  it('does not duplicate same-email reviewer', () => {
    let actors = emptyActors();
    actors = appendActor(actors, 'reviewer', id('alice', 'alice@bank.com'));
    actors = appendActor(actors, 'reviewer', id('alice', 'alice@bank.com'));
    assert.equal(actors.reviewers.length, 1);
  });
  it('replaces creator (last write wins)', () => {
    let actors = appendActor(emptyActors(), 'creator', id('alice'));
    actors = appendActor(actors, 'creator', id('bob'));
    assert.equal(actors.creator?.name, 'bob');
  });
});

// ─── PUB-9 merge gate ────────────────────────────────────────────────────

suite('PUB-9 merge gate: rules fire correctly', () => {
  const policy = defaultMergePolicy();
  it('blocks when 0 approvers', () => {
    const pack = fixture();
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp', policy);
    assert.equal(r.ok, false);
    const ruleNames = r.violations.map((v) => v.rule);
    assert.ok(ruleNames.includes('min_approvers'), `expected min_approvers in ${ruleNames.join(',')}`);
  });
  it('blocks when codex.verdict missing', () => {
    const pack = fixture();
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp', policy);
    assert.ok(r.violations.some((v) => v.rule === 'require_codex_go'));
  });
  it('blocks when codex.score below threshold', () => {
    const pack = fixture({
      codex: {
        rounds_executed: 1,
        verdict: 'GO',
        score: 6.0,
        score_history: [],
      },
    });
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp', policy);
    assert.ok(r.violations.some((v) => v.rule === 'min_codex_score'));
  });
  it('flags missing security/conflict/red-team evidence', () => {
    const pack = fixture();
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp', policy);
    const ruleNames = r.violations.map((v) => v.rule);
    assert.ok(ruleNames.includes('max_security_severity'));
    assert.ok(ruleNames.includes('max_conflict_severity'));
    assert.ok(ruleNames.includes('min_red_team_catch_rate'));
  });
  it('detects creator==reviewer chain via SoD rule (R7+1)', () => {
    let actors = appendActor(emptyActors(), 'creator', id('alice'));
    actors = appendActor(actors, 'reviewer', id('alice'));  // SoD violation
    actors = appendActor(actors, 'approver', id('carol'));
    const pack = fixture({ actors });
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp', policy);
    const sodViolation = r.violations.find((v) => v.rule === 'require_sod_satisfied');
    assert.ok(sodViolation, 'expected require_sod_satisfied to fire');
    assert.match(sodViolation!.reason, /reviewer chain/);
  });
  it('detects creator==approver chain via SoD rule', () => {
    let actors = appendActor(emptyActors(), 'creator', id('alice'));
    actors = appendActor(actors, 'reviewer', id('bob'));
    actors = appendActor(actors, 'approver', id('alice'));  // SoD violation
    const pack = fixture({ actors });
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp', policy);
    const sodViolation = r.violations.find((v) => v.rule === 'require_sod_satisfied');
    assert.ok(sodViolation, 'expected require_sod_satisfied to fire');
    assert.match(sodViolation!.reason, /approver chain/);
  });
});

// ─── Override audit log ──────────────────────────────────────────────────

suite('Override audit: appendOverrideAudit + readOverrideAudit', () => {
  // Use a temp harness root per-suite to avoid polluting real .agent-runs/
  const tmpHarness = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-smoke-'));
  fs.mkdirSync(path.join(tmpHarness, '.agent-runs'), { recursive: true });

  it('writes audit entry to .agent-runs/_override-audit.jsonl', () => {
    appendOverrideAudit(tmpHarness, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: id('alice'),
      kind: 'force-land',
      reason: 'emergency hotfix per ops directive',
      task_id: 'TP-2026-04-27-test',
      pid: process.pid,
    });
    const auditFile = auditPath(tmpHarness);
    assert.equal(fs.existsSync(auditFile), true);
    const body = fs.readFileSync(auditFile, 'utf8');
    assert.match(body, /TP-2026-04-27-test/);
    assert.match(body, /force-land/);
  });

  it('appends multiple entries (line-atomic, JSONL)', () => {
    appendOverrideAudit(tmpHarness, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: id('bob'),
      kind: 'sod-reviewer-bypass',
      reason: 'daemon ran consensus on creator-authored task',
      pid: process.pid,
    });
    const all = readOverrideAudit(tmpHarness);
    assert.equal(all.length, 2);
    assert.equal(all[0].kind, 'force-land');
    assert.equal(all[1].kind, 'sod-reviewer-bypass');
  });

  it('rejects entries with empty/missing reason at schema layer', () => {
    assert.throws(() => {
      OverrideAuditEntry.parse({
        schema_version: '1',
        at: new Date().toISOString(),
        actor: id('alice'),
        kind: 'force-land',
        reason: '',
        pid: process.pid,
      });
    });
  });

  it('skips malformed lines on read (forensic robustness)', () => {
    const auditFile = auditPath(tmpHarness);
    fs.appendFileSync(auditFile, 'not json\n{"partial":');
    const all = readOverrideAudit(tmpHarness);
    // Still returns the 2 valid entries from earlier; corrupted lines silently skipped
    assert.equal(all.length, 2);
  });
});

// ─── PUB-9 new rules: require_ci_green + require_operator_overrides_logged ──

suite('PUB-9 require_ci_green: skip behavior', () => {
  // Cannot test with real gh CLI in unit tests (network + auth state varies).
  // Integration test is "pnpm auto:merge-gate" against a real branch.
  // Here we verify the rule can be DISABLED via policy.require_ci_green=false.
  it('skips when policy.require_ci_green=false', () => {
    const policy = { ...defaultMergePolicy(), require_ci_green: false };
    const pack = fixture({});
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp/no-such-harness', policy);
    const ruleNames = r.violations.map((v) => v.rule);
    assert.equal(ruleNames.includes('require_ci_green'), false,
      `require_ci_green should not fire when policy disabled; got: ${ruleNames.join(', ')}`);
  });

  // R10+1: phase-split. ruleCiGreen MUST skip in pre-land phase even when
  // policy.require_ci_green=true, because branch doesn't exist yet.
  it('skips when phase=pre-land (R10 fix)', () => {
    const policy = defaultMergePolicy();  // require_ci_green=true (default)
    const pack = fixture({ notes: [] });   // no branch= marker
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp/no-such-harness', policy, { phase: 'pre-land' });
    const ruleNames = r.violations.map((v) => v.rule);
    assert.equal(ruleNames.includes('require_ci_green'), false,
      `require_ci_green should skip in pre-land phase; got: ${ruleNames.join(', ')}`);
    assert.equal(r.phase, 'pre-land', `result.phase should be 'pre-land', got '${r.phase}'`);
    assert.match(r.summary, /\(pre-land\)/, `summary should mention phase: ${r.summary}`);
  });

  it('default phase is pre-merge (strict)', () => {
    const policy = defaultMergePolicy();
    const pack = fixture({});
    const r = evaluateMergePolicy(pack, '/nonexistent', '/tmp/no-such-harness', policy);
    assert.equal(r.phase, 'pre-merge', `default phase should be 'pre-merge', got '${r.phase}'`);
  });
});

suite('PUB-9 require_operator_overrides_logged', () => {
  const tmpHarness = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-smoke-overrides-'));
  fs.mkdirSync(path.join(tmpHarness, '.agent-runs'), { recursive: true });

  it('passes when pack.notes has no bypass markers', () => {
    const policy = defaultMergePolicy();
    const pack = fixture({ notes: [] });
    const r = evaluateMergePolicy(pack, '/nonexistent', tmpHarness, policy);
    assert.equal(r.violations.some((v) => v.rule === 'require_operator_overrides_logged'), false);
  });

  it('blocks when pack.notes claims --force but no audit entry exists', () => {
    const policy = defaultMergePolicy();
    const pack = fixture({
      task_id: 'TP-2026-04-27-901',
      notes: [{ at: new Date().toISOString(), by: 'op', text: 'auto:land --force passed because CI was flaky' }],
    });
    const r = evaluateMergePolicy(pack, '/nonexistent', tmpHarness, policy);
    assert.ok(
      r.violations.some((v) => v.rule === 'require_operator_overrides_logged'),
      `expected require_operator_overrides_logged to fire on bypass-without-audit`
    );
  });

  it('passes when bypass-claim has matching audit entry', () => {
    appendOverrideAudit(tmpHarness, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: id('alice'),
      kind: 'force-land',
      reason: 'CI infrastructure outage; verified manually',
      task_id: 'TP-2026-04-27-902',
      pid: process.pid,
    });
    const policy = defaultMergePolicy();
    const pack = fixture({
      task_id: 'TP-2026-04-27-902',
      notes: [{ at: new Date().toISOString(), by: 'op', text: 'auto:land --force passed' }],
    });
    const r = evaluateMergePolicy(pack, '/nonexistent', tmpHarness, policy);
    assert.equal(r.violations.some((v) => v.rule === 'require_operator_overrides_logged'), false,
      `require_operator_overrides_logged should pass with matching audit entry`);
  });
});

console.log('\n────────────────────────────────────────');
console.log(`  governance smoke: ${passed} passed, ${failed} failed`);
console.log('────────────────────────────────────────');
process.exit(failed === 0 ? 0 : 1);
