#!/usr/bin/env node
/**
 * pnpm auto:skill-reflect [--phase code-sprint] [--cache-hours 6]
 *
 * Sprint M v3 (item D): skill memory LLM reflection (Hermes-Agent full
 * pattern). Beyond the heuristic counters in skillMemory.ts, this CLI
 * dispatches an LLM to READ the producer log and synthesize qualitative
 * insights ("modules with >3 references AND tier-1 always need cognitive
 * recovery", etc).
 *
 * Output: cached summary at .agent-runs/_skill-memory/<phase>.reflect.md
 * which buildWorkerPrompt then prepends as additional context.
 *
 * Cached for 6h to avoid repeated LLM calls.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs { phase: string; cacheHours: number; force: boolean; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { phase: 'code-sprint', cacheHours: 6, force: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--phase' && i + 1 < argv.length) a.phase = argv[++i];
    else if (argv[i] === '--cache-hours' && i + 1 < argv.length) a.cacheHours = parseInt(argv[++i], 10);
    else if (argv[i] === '--force') a.force = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:skill-reflect [--phase code-sprint] [--cache-hours 6] [--force]

LLM-driven reflection on skill memory producer log. Synthesizes qualitative
patterns to seed worker prompts.`);
      process.exit(0);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const memDir = path.join(harnessRoot(), '.agent-runs', '_skill-memory');
  const memFile = path.join(memDir, `${args.phase}.jsonl`);
  const reflectFile = path.join(memDir, `${args.phase}.reflect.md`);

  if (!fs.existsSync(memFile)) {
    console.log(`No skill memory for phase=${args.phase}; skipping reflection`);
    return;
  }

  // Cache check
  if (!args.force && fs.existsSync(reflectFile)) {
    const ageHours = (Date.now() - fs.statSync(reflectFile).mtimeMs) / 3600 / 1000;
    if (ageHours < args.cacheHours) {
      console.log(`Reflection cached (${ageHours.toFixed(1)}h old < ${args.cacheHours}h); --force to regen`);
      return;
    }
  }

  const lines = fs.readFileSync(memFile, 'utf8').split('\n').filter(Boolean);
  if (lines.length < 5) {
    console.log(`Only ${lines.length} entries; need ≥5 for meaningful reflection`);
    return;
  }

  const entries = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const promptText = `You are an LLM analyst reflecting on past harness work for phase=${args.phase}.

Below are the last ${entries.length} run records (JSON-per-line). Each entry has: module, task_id, patch_rounds, recovered_via.

DATA:
${entries.map(e => JSON.stringify(e)).join('\n')}

TASK: Identify 2-4 actionable patterns that future workers could use to AVOID the failure modes seen here. Output as a markdown list, ≤200 words total. Examples:
  - "Modules referencing >3 compliance citations need 2 patches on average — don't truncate AC token coverage"
  - "Tier-1 modules with reciprocity to M02 always need cognitive recovery — scope reciprocity §13 first"

Be concrete and brief. Output ONLY the markdown list.`;

  const tmpPrompt = `/tmp/skill-reflect-${args.phase}-${Date.now()}.txt`;
  fs.writeFileSync(tmpPrompt, promptText);

  console.log(`Dispatching reflection LLM for phase=${args.phase} (${entries.length} entries)…`);
  const r = spawnSync('sh', ['-c', `claude --print --dangerously-skip-permissions < "${tmpPrompt}" 2>&1`], { encoding: 'utf8', timeout: 3 * 60_000, maxBuffer: 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`LLM call failed: ${r.stderr.slice(0, 300)}`);
    return;
  }
  const out = (r.stdout || '').trim();
  if (out.length < 50) {
    console.error(`Output too short (${out.length} chars); not caching`);
    return;
  }
  fs.writeFileSync(reflectFile, `# Skill memory reflection — ${args.phase}\n\nGenerated: ${new Date().toISOString()}\nEntries: ${entries.length}\n\n---\n\n${out}\n`);
  console.log(`✓ Reflection cached: ${reflectFile}`);
}

main().catch((e) => { console.error(`[skill-reflect] fatal: ${(e as Error).message}`); process.exit(99); });
