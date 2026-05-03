/**
 * Layer 0.B+C — Contract test harness smoke.
 *
 * Validates:
 *   - Replay fixtures parse cleanly
 *   - Every fixture references a registered stage
 *   - Every fixture's expected_outcome.kind is allowed by that stage's registry entry
 *   - Every fixture's expected_outcome.driver_action is allowed by that entry
 *   - StageOutcome envelope can be emitted + parsed round-trip
 *   - Synthetic infrastructure-error envelope is well-formed
 *   - Registry topological sort produces a valid order
 *   - Registry self-consistency: every depends_on edge points to a registered stage
 *
 * Future (Day 4 / L2): this same harness will run each fixture against
 * the actual stage CLI in dry-run mode and assert the emitted envelope
 * matches expected_outcome.
 *
 * Note: this file deliberately uses the same plain-assert style as the
 * other *.smoke.ts files in this directory rather than vitest. The smoke
 * runner shells these out via tsx.
 */
import {
  STAGE_REGISTRY,
  getStageEntry,
  isStageRegistered,
  topologicalStages,
  validateOutcomeAgainstRegistry,
} from '../stageRegistry';
import {
  StageOutcome,
  emitStageOutcome,
  parseLastStageOutcome,
  synthesizeInfrastructureError,
  STAGE_OUTCOME_MAGIC,
  ENVELOPE_VERSION,
} from '../stageOutcome';
import {
  loadFixtures,
  staticallyValidateFixtures,
  analyzeCoverage,
} from '../replay';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

console.log('contracts.smoke — Layer 0 contract test harness');

// ─── 1. Registry self-consistency ─────────────────────────────────────
console.log('\n1. Registry self-consistency');
assert(STAGE_REGISTRY.length >= 12, `registry has ≥12 stages (got ${STAGE_REGISTRY.length})`);
const stageNames = new Set(STAGE_REGISTRY.map((e) => e.stage));
let depEdgesValid = true;
for (const e of STAGE_REGISTRY) {
  for (const dep of e.depends_on) {
    if (!stageNames.has(dep)) {
      console.error(`    ${e.stage} depends_on ${dep} which is NOT registered`);
      depEdgesValid = false;
    }
  }
}
assert(depEdgesValid, 'every depends_on edge points to a registered stage');

const topo = topologicalStages();
assert(topo.length === STAGE_REGISTRY.length, `topo sort returns all ${STAGE_REGISTRY.length} stages`);
let topoOrderValid = true;
const topoIndex = new Map(topo.map((s, i) => [s, i]));
for (const e of STAGE_REGISTRY) {
  const myIdx = topoIndex.get(e.stage)!;
  for (const dep of e.depends_on) {
    const depIdx = topoIndex.get(dep)!;
    if (depIdx >= myIdx) {
      console.error(`    topo violation: ${e.stage} (#${myIdx}) requires ${dep} (#${depIdx})`);
      topoOrderValid = false;
    }
  }
}
assert(topoOrderValid, 'topo order respects dependency edges');

// ─── 2. Outcome envelope round-trip ───────────────────────────────────
console.log('\n2. Outcome envelope round-trip');
const beforeCapture = process.stdout.write.bind(process.stdout);
let captured = '';
process.stdout.write = ((chunk: Buffer | string) => {
  captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return true;
}) as typeof process.stdout.write;
emitStageOutcome({
  stage: 'auto:postflight',
  task_id: 'TP-test',
  ok: true,
  kind: 'gate-pass',
  retryable: false,
  driver_action: 'advance',
  reason: 'all 3 evidence-gate checks passed',
  evidence: [{ kind: 'diff-patch', path: 'diff.patch' }],
  metrics: { duration_ms: 12 },
});
process.stdout.write = beforeCapture;
assert(captured.includes(STAGE_OUTCOME_MAGIC), 'emitted envelope contains magic prefix');
const parsed = parseLastStageOutcome(captured);
assert(parsed !== null, 'envelope parses back from stdout');
assert(parsed?.envelope_version === ENVELOPE_VERSION, `envelope_version is ${ENVELOPE_VERSION}`);
assert(parsed?.ok === true && parsed?.kind === 'gate-pass', 'kind+ok preserved');
assert(parsed?.harness_version !== undefined, 'envelope carries harness_version');

// ─── 3. Synthetic infrastructure error ────────────────────────────────
console.log('\n3. Synthetic infrastructure error');
const synth = synthesizeInfrastructureError({
  stage: 'auto:work',
  task_id: 'TP-crashed',
  exit_code: 137,
  reason: 'process killed by OS (likely OOM)',
  duration_ms: 8400,
});
const synthValidated = StageOutcome.safeParse(synth);
assert(synthValidated.success, 'synthetic envelope passes schema validation');
assert(synth.kind === 'infrastructure-error' && synth.driver_action === 'requeue',
  'synthetic envelope has correct kind + driver_action');

// ─── 4. Registry outcome validation ───────────────────────────────────
console.log('\n4. Registry outcome validation');
assert(
  validateOutcomeAgainstRegistry('auto:postflight', 'gate-pass', 'advance') === null,
  'gate-pass + advance is allowed for auto:postflight',
);
assert(
  validateOutcomeAgainstRegistry('auto:postflight', 'success', 'advance') !== null,
  'kind=success is REJECTED for auto:postflight (gate stage; emits gate-pass not success)',
);
assert(
  validateOutcomeAgainstRegistry('auto:work', 'worker-error', 'requeue') === null,
  'worker-error + requeue is allowed for auto:work',
);
assert(
  validateOutcomeAgainstRegistry('auto:bogus', 'success', 'advance') !== null,
  'unregistered stage is REJECTED',
);

// ─── 5. Replay fixture loader ─────────────────────────────────────────
console.log('\n5. Replay fixture loader');
const fixtures = loadFixtures();
assert(fixtures.length >= 5, `loaded ≥5 replay fixtures (got ${fixtures.length})`);
const fixtureIds = fixtures.map((f) => f.fixture_id);
const expected = ['B1-worker-progress-timeout', 'F1-intake-rbac-denial', 'F2-postflight-broken-resolver', 'L4-plateau-identical-rounds', 'M05-postflight-codeshape-green'];
for (const id of expected) {
  assert(fixtureIds.includes(id), `loaded fixture ${id}`);
}

// ─── 6. Static fixture validation ─────────────────────────────────────
console.log('\n6. Static fixture validation');
const checks = staticallyValidateFixtures(fixtures);
let allOk = true;
for (const c of checks) {
  if (!c.ok) {
    console.error(`    ${c.fixture_id} FAILED: ${c.failures.join('; ')}`);
    allOk = false;
  }
}
assert(allOk, 'every fixture passes static contract validation against registry');

// ─── 7. Coverage analysis ─────────────────────────────────────────────
console.log('\n7. Coverage analysis');
const coverage = analyzeCoverage(fixtures);
console.log(`    covered stages: ${coverage.covered.length}/${STAGE_REGISTRY.length}`);
console.log(`    uncovered: ${coverage.uncovered.join(', ') || '(none)'}`);
// Day 2 seeds fixtures for the 3 representative bug classes (auto:work
// for B1, auto:intake for F1, auto:postflight for F2/L4/green). Coverage
// requirement starts at 3; future days backfill toward full registry.
assert(coverage.covered.length >= 3, '≥3 stages have at least one fixture');

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
