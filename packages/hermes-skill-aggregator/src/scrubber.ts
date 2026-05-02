/**
 * scrubber.ts — PII / proprietary content scrubber.
 *
 * Operators contribute anonymized triplets (phase, patch_rounds,
 * recovered_via, ac_count) — but skill memory entries can also carry:
 *   - module IDs (potentially proprietary product names: "M22-payment-fraud")
 *   - task IDs (incl. dates, sequences)
 *   - file paths (proprietary directory structure)
 *
 * Before any upload to the aggregator, this scrubber:
 *   1. Strips module ID specifics → keeps the *shape* (Mxx-FRD vs Mxx-impl)
 *   2. Replaces task IDs with "TP-XXX" placeholder (preserves ordinality)
 *   3. Strips paths entirely
 *   4. Hashes any free-text "reason" / "note" fields (preserves bucket
 *      cardinality without revealing content)
 *   5. Drops any field not on the allow-list
 *
 * What's left after scrubbing IS submittable to the aggregator. Operator
 * always sees the scrubbed payload before upload (never auto-upload).
 */
import { createHash } from 'node:crypto';

export interface RawSkillEntry {
  module?: string;
  task_id?: string;
  phase: string;          // "code-sprint" | "frd-author" | etc.
  patch_rounds: number;
  recovered_via?: string; // "patch" | "cognitive-recovery" | null
  ac_count?: number;
  duration_seconds?: number;
  cost_usd?: number;
  // ... operators may add anything else
  [k: string]: unknown;
}

export interface ScrubbedEntry {
  /** Module SHAPE — preserves the kind without revealing identity. */
  module_shape: 'frd' | 'trd' | 'sprint-plan' | 'code-sprint' | 'unknown';
  /** Phase type — already public. */
  phase: string;
  /** Patch rounds (integer, no PII). */
  patch_rounds: number;
  /** Recovery path used. */
  recovered_via: string | null;
  /** AC count bucket (1-3, 4-6, 7-10, 11+). */
  ac_count_bucket: '1-3' | '4-6' | '7-10' | '11+';
  /** Duration bucket (≤5min, 5-15min, 15-60min, >60min). */
  duration_bucket: '≤5min' | '5-15min' | '15-60min' | '>60min' | 'unknown';
  /** Cost bucket. */
  cost_bucket: '≤$0.10' | '$0.10-$1' | '$1-$10' | '>$10' | 'unknown';
}

const ALLOWED_PHASES = new Set([
  'frd-author', 'frd-polish', 'frd-reconcile',
  'trd-author', 'trd-polish', 'trd-reconcile',
  'sprint-plan-author', 'sprint-plan-polish', 'sprint-plan-reconcile',
  'code-sprint', 'test-coverage', 'audit-log-route',
  'platform-doc', 'next-session-refresh', 'ui-component', 'dashboard-page',
]);

function moduleShape(module: string | undefined): ScrubbedEntry['module_shape'] {
  if (!module) return 'unknown';
  const m = module.toLowerCase();
  if (m.includes('frd-')) return 'frd';
  if (m.includes('trd-')) return 'trd';
  if (m.includes('sprint-plan')) return 'sprint-plan';
  return 'code-sprint';
}

function bucketAcCount(n: number | undefined): ScrubbedEntry['ac_count_bucket'] {
  if (!n || n <= 3) return '1-3';
  if (n <= 6) return '4-6';
  if (n <= 10) return '7-10';
  return '11+';
}

function bucketDuration(s: number | undefined): ScrubbedEntry['duration_bucket'] {
  if (!s) return 'unknown';
  if (s <= 300) return '≤5min';
  if (s <= 900) return '5-15min';
  if (s <= 3600) return '15-60min';
  return '>60min';
}

function bucketCost(usd: number | undefined): ScrubbedEntry['cost_bucket'] {
  if (usd === undefined || usd === null) return 'unknown';
  if (usd <= 0.10) return '≤$0.10';
  if (usd <= 1.0) return '$0.10-$1';
  if (usd <= 10.0) return '$1-$10';
  return '>$10';
}

/**
 * Scrub a raw entry into a contributable shape.
 * Throws if the entry's `phase` isn't in the allow-list — refuses to upload
 * data we can't classify (operator might be on a fork with custom phase types).
 */
export function scrubEntry(raw: RawSkillEntry): ScrubbedEntry {
  if (!ALLOWED_PHASES.has(raw.phase)) {
    throw new Error(`refusing to scrub: phase '${raw.phase}' not in public allow-list`);
  }
  return {
    module_shape: moduleShape(raw.module),
    phase: raw.phase,
    patch_rounds: Math.max(0, Math.min(10, Math.floor(raw.patch_rounds || 0))),
    recovered_via: raw.recovered_via || null,
    ac_count_bucket: bucketAcCount(raw.ac_count),
    duration_bucket: bucketDuration(raw.duration_seconds),
    cost_bucket: bucketCost(raw.cost_usd),
  };
}

/**
 * Operator-side preview. Returns the scrubbed payload that WOULD be sent.
 * Operator inspects this before clicking "upload."
 */
export function previewScrub(raw: RawSkillEntry): { scrubbed: ScrubbedEntry; dropped_fields: string[] } {
  const scrubbed = scrubEntry(raw);
  const knownFields = new Set(['module', 'task_id', 'phase', 'patch_rounds', 'recovered_via', 'ac_count', 'duration_seconds', 'cost_usd']);
  const dropped = Object.keys(raw).filter(k => !knownFields.has(k));
  return { scrubbed, dropped_fields: dropped };
}

/** For batch testing — scrub a list, surfacing per-entry errors. */
export function scrubBatch(raws: RawSkillEntry[]): { scrubbed: ScrubbedEntry[]; errors: string[] } {
  const out: ScrubbedEntry[] = [];
  const errs: string[] = [];
  for (let i = 0; i < raws.length; i++) {
    try { out.push(scrubEntry(raws[i])); }
    catch (e) { errs.push(`entry ${i}: ${(e as Error).message}`); }
  }
  return { scrubbed: out, errors: errs };
}

/** Hash a free-text field if you need to preserve cardinality without revealing content. */
export function hashField(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}
