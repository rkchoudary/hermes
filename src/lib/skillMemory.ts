/**
 * skillMemory.ts — Hermes-pattern skill memory CONSUMER (Sprint K v3, 2026-05-02)
 *
 * Reads `.agent-runs/_skill-memory/<phase>.jsonl` (producer = drive_phase script)
 * and surfaces top-K patterns to inform future workers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { harnessRoot } from './harnessRoot';

export interface SkillEntry {
  at: string;
  module: string;
  phase: string;
  version: string;
  task_id: string;
  patch_rounds: number;
  recovered_via?: string;
}

function skillFile(phase: string): string {
  return path.join(harnessRoot(), '.agent-runs', '_skill-memory', `${phase}.jsonl`);
}

export function readSkillEntries(phase: string, limit = 20): SkillEntry[] {
  const f = skillFile(phase);
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const entries: SkillEntry[] = [];
  for (const line of lines.slice(-limit * 2)) {
    try { entries.push(JSON.parse(line)); } catch { /* skip */ }
  }
  return entries.slice(-limit);
}

/**
 * Compute top-3 patterns: how many succeeded first-try, how many needed
 * patches, how many needed cognitive recovery. Used to prepend hints to
 * worker prompt so subagent biases its approach toward what worked before.
 */
export function patternsForPhase(phase: string): {
  total: number;
  first_try_success: number;
  patch_recovered: number;
  cognitive_recovered: number;
  hint: string;
} {
  const entries = readSkillEntries(phase, 50);
  const total = entries.length;
  if (total === 0) {
    return { total: 0, first_try_success: 0, patch_recovered: 0, cognitive_recovered: 0, hint: '' };
  }
  let firstTry = 0, patchRec = 0, cogRec = 0;
  for (const e of entries) {
    if (e.patch_rounds === 0) firstTry++;
    else if (e.recovered_via === 'cognitive-recovery') cogRec++;
    else if (e.patch_rounds > 0) patchRec++;
  }
  const firstTryPct = Math.round((firstTry / total) * 100);
  let hint = '';
  if (firstTryPct >= 60) {
    hint = `Prior data: ${firstTry}/${total} ${phase} tasks succeeded first-try. Aim for clean single-pass authoring.`;
  } else if (patchRec >= total / 2) {
    hint = `Prior data: ${patchRec}/${total} ${phase} tasks needed patch rounds. Common postflight failures: AC token coverage. Ensure all FR/NFR IDs are referenced.`;
  } else if (cogRec >= total / 4) {
    hint = `Prior data: ${cogRec}/${total} ${phase} tasks needed cognitive recovery. Consider a simpler initial draft, expand via patches.`;
  }
  return { total, first_try_success: firstTry, patch_recovered: patchRec, cognitive_recovered: cogRec, hint };
}
