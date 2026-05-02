/**
 * complexityRouter.ts — Sprint M v3 (item C): dynamic model routing
 * (EXARCHON-pattern). Replaces static tier-based routing with runtime
 * task-complexity analysis.
 *
 * Score factors:
 *   - AC count (more AC tokens → higher complexity)
 *   - Reference count (more regulatory citations → higher rigor required)
 *   - Reciprocity dependencies (cross-module → higher complexity)
 *   - Task type (code-sprint always tier-1)
 *   - Priors from skill memory (high patch-rate phase types → bump)
 *
 * Output: { model, complexity_score (0-100), reason }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';

interface PackLike {
  type: string;
  acceptance_criteria?: Array<unknown>;
  references?: Array<unknown>;
  reciprocity?: Array<unknown> | Record<string, unknown>;
  module_or_sprint?: string;
}

export interface ComplexityRouting {
  model: string;
  complexity_score: number;
  reason: string;
  static_tier_fallback: boolean;
}

export function routeForPack(pack: PackLike, fallbackTier: string = 'tier-2'): ComplexityRouting {
  let score = 0;
  const reasons: string[] = [];

  // Code-sprint is always Opus regardless of other factors
  if (pack.type === 'code-sprint') {
    score = 100;
    reasons.push('code-sprint→Opus');
    return {
      model: process.env.AUTO_CLAUDE_MODEL_TIER1 || '',
      complexity_score: score,
      reason: reasons.join(','),
      static_tier_fallback: false,
    };
  }

  // AC count: 0-15 points
  const acCount = (pack.acceptance_criteria?.length ?? 0);
  const acPts = Math.min(15, acCount);
  score += acPts;
  if (acPts > 8) reasons.push(`AC=${acCount}`);

  // References: 0-25 points
  const refCount = (pack.references?.length ?? 0);
  const refPts = Math.min(25, refCount * 2);
  score += refPts;
  if (refPts > 10) reasons.push(`refs=${refCount}`);

  // Reciprocity: 0-20 points
  const recip = pack.reciprocity;
  let recipCount = 0;
  if (Array.isArray(recip)) recipCount = recip.length;
  else if (recip && typeof recip === 'object') recipCount = Object.keys(recip).length;
  const recipPts = Math.min(20, recipCount * 5);
  score += recipPts;
  if (recipPts > 0) reasons.push(`reciprocity=${recipCount}`);

  // Skill memory bump: if this phase type historically needs cognitive recovery
  // >50% of the time, treat all instances as higher complexity
  try {
    const skillPath = path.join(harnessRoot(), '.agent-runs', '_skill-memory', `${pack.type}.jsonl`);
    if (fs.existsSync(skillPath)) {
      const lines = fs.readFileSync(skillPath, 'utf8').split('\n').filter(Boolean).slice(-30);
      let cog = 0;
      for (const ln of lines) {
        try { if (JSON.parse(ln).recovered_via === 'cognitive-recovery') cog++; } catch { /* skip */ }
      }
      if (lines.length >= 5 && cog / lines.length > 0.5) {
        score += 30;
        reasons.push(`prior-cog-rate=${Math.round(100 * cog / lines.length)}%`);
      }
    }
  } catch { /* skip */ }

  // Phase-type baseline
  if (pack.type.includes('frd-author') || pack.type.includes('frd-polish')) {
    // FRD: regulatory-heavy, needs higher tier
    score += 15;
    reasons.push('frd-baseline');
  } else if (pack.type.includes('trd-author') || pack.type.includes('sprint-plan-author')) {
    // TRD/SP: structured doc, can use Sonnet for tier-2/3
    score += 5;
  }

  // Map score to model
  let model = '';
  if (score >= 70) {
    model = process.env.AUTO_CLAUDE_MODEL_TIER1 || '';  // Opus
    reasons.push(`score=${score}→tier-1`);
  } else if (score >= 35) {
    model = process.env.AUTO_CLAUDE_MODEL_TIER2 || 'claude-sonnet-4-6';
    reasons.push(`score=${score}→tier-2`);
  } else {
    model = process.env.AUTO_CLAUDE_MODEL_TIER3 || 'claude-haiku-4-5';
    reasons.push(`score=${score}→tier-3`);
  }

  return { model, complexity_score: score, reason: reasons.join(','), static_tier_fallback: false };
}
