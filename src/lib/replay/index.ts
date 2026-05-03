/**
 * Layer 0.B+C — Replay fixture loader + contract test harness.
 *
 * Each fixture in this directory describes a known scenario from the
 * harness's recent operational history (a real bug we fixed, or a class
 * of failure we want to never regress). Fixtures encode:
 *
 *   - The stage being exercised
 *   - The input state (TaskPack snapshot, evidence file shapes, identity, …)
 *   - The expected StageOutcome envelope (kind, driver_action, key fields)
 *
 * The contract test harness loads every fixture and validates:
 *
 *   1. The fixture itself is well-formed (parses against the loader schema)
 *   2. The stage being referenced exists in the central registry
 *   3. The expected outcome kind is in the registry's `expected_outcomes`
 *      list for that stage (catches "wrote a fixture for an outcome the
 *      stage isn't even allowed to emit" bugs)
 *   4. The expected `driver_action` is in the registry's
 *      `allowed_driver_actions`
 *
 * Once Day 4 (L2 contract self-tests) ships, this same harness will run
 * each fixture against the actual stage CLI in dry-run mode and assert
 * the emitted envelope matches.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  STAGE_REGISTRY,
  getStageEntry,
  type ExpectedOutcomeKind,
} from '../stageRegistry';

const ExpectedOutcomeSchema = z.object({
  ok: z.boolean(),
  kind: z.string(),                 // validated against registry separately
  retryable: z.boolean().optional(),
  driver_action: z.string(),        // validated against registry separately
  reason_substring: z.string().optional(),
  evidence_must_include: z.array(z.string()).optional(),
  details_must_include: z.array(z.string()).optional(),
  must_NOT_be: z.string().optional(),
  must_NOT_run_round_3: z.boolean().optional(),
}).passthrough();

const FixtureSchema = z.object({
  fixture_id: z.string(),
  purpose: z.string(),
  stage: z.string(),
  harness_version_at_capture: z.string(),
  captured_at: z.string(),
  regression_against: z.string().optional(),
  input: z.record(z.unknown()),
  expected_outcome: ExpectedOutcomeSchema,
  anti_pattern_being_tested: z.string().optional(),
}).passthrough();
export type ReplayFixture = z.infer<typeof FixtureSchema>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPLAY_DIR = path.join(HERE, 'fixtures');

export function loadFixtures(): ReplayFixture[] {
  const fixtures: ReplayFixture[] = [];
  for (const f of fs.readdirSync(REPLAY_DIR)) {
    if (!f.endsWith('.json')) continue;
    const raw = fs.readFileSync(path.join(REPLAY_DIR, f), 'utf8');
    const parsed = FixtureSchema.parse(JSON.parse(raw));
    fixtures.push(parsed);
  }
  return fixtures.sort((a, b) => a.fixture_id.localeCompare(b.fixture_id));
}

export interface ContractCheck {
  fixture_id: string;
  stage: string;
  ok: boolean;
  failures: string[];
}

/**
 * Static contract validation — checks fixture coherence against the
 * registry without invoking real CLIs. Runs in <100ms; CI-eligible.
 */
export function staticallyValidateFixtures(fixtures: ReplayFixture[]): ContractCheck[] {
  const out: ContractCheck[] = [];
  for (const fx of fixtures) {
    const failures: string[] = [];
    const entry = getStageEntry(fx.stage);
    if (!entry) {
      failures.push(`stage "${fx.stage}" is not in the stage registry`);
      out.push({ fixture_id: fx.fixture_id, stage: fx.stage, ok: false, failures });
      continue;
    }
    const expectedKind = fx.expected_outcome.kind as ExpectedOutcomeKind;
    if (!entry.expected_outcomes.includes(expectedKind)) {
      failures.push(
        `expected_outcome.kind "${expectedKind}" is not in registry's expected_outcomes for ${fx.stage}: [${entry.expected_outcomes.join(', ')}]`,
      );
    }
    const expectedAction = fx.expected_outcome.driver_action;
    if (!entry.allowed_driver_actions.includes(expectedAction)) {
      failures.push(
        `expected_outcome.driver_action "${expectedAction}" is not in registry's allowed_driver_actions for ${fx.stage}: [${entry.allowed_driver_actions.join(', ')}]`,
      );
    }
    out.push({
      fixture_id: fx.fixture_id,
      stage: fx.stage,
      ok: failures.length === 0,
      failures,
    });
  }
  return out;
}

/**
 * Coverage analysis — ensures every stage in the registry has at least
 * one fixture (positive or negative). New stages without fixtures fail
 * this check.
 */
export function analyzeCoverage(fixtures: ReplayFixture[]): {
  covered: string[];
  uncovered: string[];
} {
  const seen = new Set(fixtures.map((f) => f.stage));
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const entry of STAGE_REGISTRY) {
    if (seen.has(entry.stage)) covered.push(entry.stage);
    else uncovered.push(entry.stage);
  }
  return { covered, uncovered };
}
