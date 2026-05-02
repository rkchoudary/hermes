#!/usr/bin/env node
/**
 * pnpm auto:vision-loop <task_id> [--max-rounds 3] [--threshold 7.0]
 *
 * Vision self-review loop (MI5). For tasks where the deliverable is UI/UX
 * (a page, a component, a dashboard), run the screenshot → vision-LLM
 * critique → patch → re-screenshot loop. Stops when:
 *   - Vision verdict score >= threshold (default 7.0/10)
 *   - --max-rounds exceeded (default 3)
 *   - No more actionable findings
 *
 * Builds on top of:
 *   - auto:ux-validate (Playwright-based screenshot + console / network
 *     gates that already exists in src/cli/ux-validate.ts)
 *   - claude-code-cli vision capability (claude --print with image attached)
 *
 * Each iteration:
 *   1. Run auto:ux-validate to capture screenshots + console + network state.
 *   2. Read the captured screenshots from evidence/<task>/ux/.
 *   3. Dispatch a vision-LLM with: "Review these screenshots vs the task
 *      objective. Score 0-10. List blocking findings (broken layout,
 *      missing copy, contrast violations, etc.) and non-blocking findings."
 *   4. If score >= threshold, exit success.
 *   5. Otherwise: write findings to evidence/<task>/ux/vision-r<N>.md,
 *      dispatch auto:work --force --vision-feedback to fix.
 *   6. Repeat.
 *
 * Output: evidence/<task>/ux/vision-loop.json with the full iteration
 * history (scores, findings, dispatch results).
 *
 * Note: vision dispatch requires claude-code-cli with vision-capable model.
 * Workers without vision (codex, ollama) will receive a text-only summary
 * of the screenshots' filenames and won't actually see the pixels.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs {
  taskId?: string;
  maxRounds: number;
  threshold: number;
  dryRun: boolean;
  visionEngine: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { maxRounds: 3, threshold: 7.0, dryRun: false, visionEngine: 'claude-code-cli' };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--max-rounds' && i + 1 < argv.length) a.maxRounds = parseInt(argv[++i], 10) || a.maxRounds;
    else if (x === '--threshold' && i + 1 < argv.length) a.threshold = parseFloat(argv[++i]) || a.threshold;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--engine' && i + 1 < argv.length) a.visionEngine = argv[++i];
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:vision-loop <task_id> [options]

Iterate screenshot → vision-critique → patch until UI passes vision review.

Options:
  --max-rounds N   Cap on iteration count (default 3)
  --threshold S    Min score 0-10 to accept (default 7.0)
  --dry-run        Run validation + vision review but skip the patch dispatch
  --engine ENG     Vision engine (default claude-code-cli; needs vision-model)

Output: evidence/<task>/ux/vision-loop.json with iteration history.

Prerequisite: pack.ux_validation.enabled=true and pack.type in
{ui-component, dashboard-page, code-sprint}.`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.taskId) a.taskId = x;
  }
  return a;
}

interface VisionRound {
  round: number;
  at: string;
  screenshots: string[];
  vision_score: number;
  vision_verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  blocking_findings: string[];
  non_blocking_findings: string[];
  patch_dispatched: boolean;
  patch_exit?: number;
}

function findEvidenceDir(taskId: string): { runId: string; evDir: string } | null {
  const runsRoot = path.join(harnessRoot(), '.agent-runs');
  if (!fs.existsSync(runsRoot)) return null;
  for (const r of fs.readdirSync(runsRoot)) {
    if (!/^\d{4}-\d{2}-\d{2}/.test(r)) continue;
    const evDir = path.join(runsRoot, r, 'evidence', taskId);
    if (fs.existsSync(evDir)) return { runId: r, evDir };
  }
  return null;
}

function listScreenshots(uxDir: string): string[] {
  if (!fs.existsSync(uxDir)) return [];
  const out: string[] = [];
  for (const f of fs.readdirSync(uxDir)) {
    if (/\.(png|jpe?g|webp)$/i.test(f)) out.push(path.join(uxDir, f));
  }
  return out.sort();
}

function dispatchVisionReview(screenshots: string[], objective: string, engine: string): { score: number; verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; blocking: string[]; nonBlocking: string[]; raw: string } {
  if (screenshots.length === 0) {
    return { score: 0, verdict: 'INCONCLUSIVE', blocking: ['no screenshots captured'], nonBlocking: [], raw: '' };
  }

  const prompt = `You are a UX reviewer evaluating screenshots of a delivered UI feature.

Objective: ${objective}

Below are ${screenshots.length} screenshot(s) attached. Review each carefully.
Score the UI from 0-10 against the objective. 7.0+ is acceptable.

Output format (exact, machine-parsed):

Score: <0-10>
Verdict: <PASS|FAIL|INCONCLUSIVE>

Blocking findings (must-fix):
- ...

Non-blocking findings (nice-to-have):
- ...

Be specific. Reference visual elements by location ("the header on screenshot 2", "the table on screenshot 3").`;

  const tmpPrompt = `/tmp/vision-prompt-${Date.now()}.txt`;
  fs.writeFileSync(tmpPrompt, prompt);

  // Build claude --print invocation with attachments
  if (engine === 'claude-code-cli') {
    const claudeBin = process.env.AUTO_CLAUDE_BIN || 'claude';
    const args: string[] = ['--print', '--dangerously-skip-permissions'];
    for (const s of screenshots) {
      args.push('--add-attachment');
      args.push(s);
    }
    const r = spawnSync('sh', ['-c', `${claudeBin} ${args.map(a => `"${a}"`).join(' ')} < "${tmpPrompt}" 2>&1`], { encoding: 'utf8', timeout: 5 * 60_000, maxBuffer: 1024 * 1024 });
    return parseVisionOutput(r.stdout || '');
  }

  // Fallback for non-vision engines: text-only summary
  return { score: 0, verdict: 'INCONCLUSIVE', blocking: [`engine ${engine} does not support vision; cannot evaluate screenshots`], nonBlocking: [], raw: '' };
}

function parseVisionOutput(text: string): { score: number; verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE'; blocking: string[]; nonBlocking: string[]; raw: string } {
  const score = (() => {
    const m = text.match(/Score:\s*(\d+(?:\.\d+)?)/i);
    return m ? parseFloat(m[1]) : 0;
  })();
  const verdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = (() => {
    const m = text.match(/Verdict:\s*(PASS|FAIL|INCONCLUSIVE)/i);
    return (m ? m[1].toUpperCase() : 'INCONCLUSIVE') as 'PASS' | 'FAIL' | 'INCONCLUSIVE';
  })();
  const blocking: string[] = [];
  const nonBlocking: string[] = [];
  const blockMatch = text.match(/Blocking findings[^\n]*\n((?:.|\n)*?)(?=Non-blocking|$)/i);
  if (blockMatch) {
    for (const line of blockMatch[1].split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.+)/);
      if (m) blocking.push(m[1].trim());
    }
  }
  const nonBlockMatch = text.match(/Non-blocking findings[^\n]*\n((?:.|\n)*)/i);
  if (nonBlockMatch) {
    for (const line of nonBlockMatch[1].split('\n')) {
      const m = line.match(/^\s*[-*]\s+(.+)/);
      if (m) nonBlocking.push(m[1].trim());
    }
  }
  return { score, verdict, blocking, nonBlocking, raw: text };
}

function dispatchPatchWorker(taskId: string, findings: string[], runId: string): { exit: number } {
  const harnessHome = path.join(harnessRoot(), 'tools', 'autonomous-delivery');
  const fbPath = path.join(harnessRoot(), '.agent-runs', runId, 'evidence', taskId, 'vision-feedback.md');
  const fbContent = ['# Vision review feedback (auto-generated)', '', 'The following blocking findings must be addressed in this round:', '', ...findings.map(f => `- ${f}`), '', 'Maintain backward compatibility with existing UX-validate gates.'].join('\n');
  fs.writeFileSync(fbPath, fbContent);

  const env = { ...process.env, AUTO_FORCE_REASON: 'vision-loop patch round', AUTO_HARNESS_DRIVER: '1' };
  const r = spawnSync('pnpm', ['auto:work', taskId, '--force', '--patch'], { cwd: harnessHome, encoding: 'utf8', stdio: 'inherit', env });
  return { exit: r.status ?? 1 };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.taskId) {
    console.error('Usage: pnpm auto:vision-loop <task_id> [options]');
    process.exit(2);
  }

  const found = findEvidenceDir(args.taskId);
  if (!found) {
    console.error(`Task ${args.taskId} not found.`);
    process.exit(1);
  }
  const uxDir = path.join(found.evDir, 'ux');
  const loopRecord = path.join(uxDir, 'vision-loop.json');

  // Load pack to get objective
  const packPath = path.join(harnessRoot(), '.agent-runs', found.runId, 'tasks', `${args.taskId}.json`);
  const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  const objective = pack.objective || '';

  const rounds: VisionRound[] = [];
  let finalVerdict: 'PASS' | 'FAIL' | 'INCONCLUSIVE' = 'INCONCLUSIVE';

  for (let round = 1; round <= args.maxRounds; round++) {
    console.log(`\n═══ Vision loop round ${round}/${args.maxRounds} ═══`);

    // Step 1: ensure latest screenshots
    if (round > 1) {
      console.log(`  Re-running auto:ux-validate to capture fresh screenshots…`);
      const harnessHome = path.join(harnessRoot(), 'tools', 'autonomous-delivery');
      spawnSync('pnpm', ['auto:ux-validate', args.taskId], { cwd: harnessHome, stdio: 'inherit' });
    }

    const screenshots = listScreenshots(uxDir);
    console.log(`  ${screenshots.length} screenshot(s) captured`);

    // Step 2: dispatch vision review
    if (args.dryRun) {
      console.log(`  [dry-run] would dispatch vision review on ${screenshots.length} screenshots`);
      rounds.push({ round, at: new Date().toISOString(), screenshots, vision_score: -1, vision_verdict: 'INCONCLUSIVE', blocking_findings: ['dry-run'], non_blocking_findings: [], patch_dispatched: false });
      break;
    }

    const review = dispatchVisionReview(screenshots, objective, args.visionEngine);
    console.log(`  Vision: score=${review.score}/10 verdict=${review.verdict}`);
    console.log(`  Blocking: ${review.blocking.length}, non-blocking: ${review.nonBlocking.length}`);

    // Save raw output
    const rawPath = path.join(uxDir, `vision-r${round}.md`);
    fs.writeFileSync(rawPath, review.raw);

    const roundRecord: VisionRound = {
      round, at: new Date().toISOString(),
      screenshots, vision_score: review.score, vision_verdict: review.verdict,
      blocking_findings: review.blocking, non_blocking_findings: review.nonBlocking,
      patch_dispatched: false,
    };

    // Step 3: stop if accepted
    if (review.score >= args.threshold && review.verdict !== 'FAIL') {
      console.log(`  ✓ Threshold met (${review.score} >= ${args.threshold}); accepting.`);
      rounds.push(roundRecord);
      finalVerdict = 'PASS';
      break;
    }

    // Step 4: stop if no actionable findings
    if (review.blocking.length === 0) {
      console.log(`  ✓ No blocking findings; accepting despite low score.`);
      rounds.push(roundRecord);
      finalVerdict = 'PASS';
      break;
    }

    // Step 5: dispatch patch
    if (round < args.maxRounds) {
      console.log(`  Dispatching patch worker with ${review.blocking.length} blocking findings…`);
      const dispatch = dispatchPatchWorker(args.taskId, review.blocking, found.runId);
      roundRecord.patch_dispatched = true;
      roundRecord.patch_exit = dispatch.exit;
      rounds.push(roundRecord);
    } else {
      console.log(`  ✗ Max rounds reached without acceptance.`);
      rounds.push(roundRecord);
      finalVerdict = 'FAIL';
    }
  }

  // Persist loop record
  fs.mkdirSync(uxDir, { recursive: true });
  fs.writeFileSync(loopRecord, JSON.stringify({ task_id: args.taskId, run_id: found.runId, threshold: args.threshold, max_rounds: args.maxRounds, final_verdict: finalVerdict, rounds }, null, 2));

  console.log(`\n═══ Vision loop complete ═══`);
  console.log(`  Final verdict: ${finalVerdict}`);
  console.log(`  Rounds: ${rounds.length}`);
  console.log(`  Record: ${loopRecord}`);
  process.exit(finalVerdict === 'PASS' ? 0 : 1);
}

main();
