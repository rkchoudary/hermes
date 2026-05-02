#!/usr/bin/env node
/**
 * pnpm auto:consensus — dispatch Codex 5.5 xhigh against a task pack's evidence bundle.
 *
 * Usage:
 *   pnpm auto:consensus <task_id>
 *   pnpm auto:consensus <task_id> --round 2
 *
 * Process:
 *   1. Read task pack
 *   2. Verify state is awaiting-review or codex-reviewing
 *   3. Build the Codex prompt from template + bundle
 *   4. Verify bundle size against context budget
 *   5. Dispatch Codex via background bash (parent-session pattern proven 2026-04-26)
 *   6. Wait for completion notification (callers should poll or use task-notification)
 *   7. Parse verdict
 *   8. Update task pack state (codex-reviewing → promotable | needs-revision)
 *
 * v0.1 limitation: synchronous wait via foreground bash with 10-min timeout. v0.2 adds
 * proper background dispatch + state machine.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

// R12+1 fix: ESM-safe __dirname. Node 24 strict-ESM doesn't auto-provide
// __dirname; consensus.ts line 198 + 339 referenced it via tsx's CJS shim
// which silently broke under newer node. Caught the moment we ran an
// actual auto:consensus dispatch (TP-2026-04-27-102).
const __filename_consensus = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_consensus);
import {
  readTaskPack,
  writeTaskPack,
  evidenceDir,
  appendStateLog,
  writeEvidence,
  atomicWriteFile,
  withTaskPackLock,
} from '../lib/runState';
import { appendStateTransition } from '../lib/taskPack';
import { readInventory, isQualified } from '../lib/modelInventory';
import { captureIdentity, appendActor, enforceSoD, defaultSoDPolicy } from '../lib/sod';
import { appendOverrideAudit } from '../lib/overrideAudit';
import {
  registerProcess,
  unregisterProcess,
  defaultMaxDurationSec,
} from '../lib/processWatchdog';

const CODEX_BIN =
  process.env.CODEX_BIN ||
  // R12+1 fix: default to Codex.app installed binary. Old default pointed
  // to a windsurf extension path that no longer exists; caught when first
  // real auto:consensus run failed at TP-2026-04-27-102.
  '/Applications/Codex.app/Contents/Resources/codex';

type Gate = 'plan' | 'duplicate-scan' | 'completion';

interface ConsensusArgs {
  taskId: string;
  round?: number;
  gate?: Gate;
}

function parseArgs(argv: string[]): ConsensusArgs {
  const args: Partial<ConsensusArgs> = { gate: 'completion' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--round' && i + 1 < argv.length) args.round = parseInt(argv[++i], 10);
    else if (arg === '--gate' && i + 1 < argv.length) args.gate = argv[++i] as Gate;
    else if (!arg.startsWith('--')) positional.push(arg);
  }
  if (positional.length < 1) throw new Error('Required: <task_id>');
  args.taskId = positional[0];
  if (!['plan', 'duplicate-scan', 'completion'].includes(args.gate as string)) {
    throw new Error(`--gate must be: plan | duplicate-scan | completion (default: completion)`);
  }
  return args as ConsensusArgs;
}

function gateStubMessage(gate: Gate, taskId: string): void {
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`v0.1 STUB: ${gate} consensus gate (full impl in v0.2 per docs/CONSENSUS-GATES.md)`);
  console.log(`══════════════════════════════════════════════════════════════════════`);
  console.log(`Template: tools/autonomous-delivery/templates/codex-${gate}-review.txt`);
  console.log(`Task: ${taskId}`);
  console.log('');
  console.log(`v0.2 will:`);
  console.log(`  1. Build the gate-specific bundle (≤8 KB for plan; ≤16 KB for duplicate-scan)`);
  console.log(`  2. Dispatch Codex 5.5 xhigh with gate-specific template`);
  console.log(`  3. Parse + record verdict in pack.codex.gate_results.${gate}`);
  console.log(`  4. If GO: transition to next phase; if NO-GO: revise + retry or escalate`);
  console.log('');
  console.log(`For now, manually:`);
  console.log(`  1. Read template: cat tools/autonomous-delivery/templates/codex-${gate}-review.txt`);
  console.log(`  2. Substitute template variables from the task pack JSON`);
  console.log(`  3. Run Codex CLI manually with the populated prompt`);
  console.log(`  4. Update task pack codex.gate_results.${gate} with verdict`);
}

function findRunForTask(taskId: string): string {
  const repoRoot = harnessRoot();
  const runsDir = path.join(repoRoot, '.agent-runs');
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No .agent-runs/ directory at ${runsDir}; create a run first via auto:plan.`);
  }
  const runs = fs.readdirSync(runsDir);
  for (const runId of runs) {
    const taskPath = path.join(runsDir, runId, 'tasks', `${taskId}.json`);
    if (fs.existsSync(taskPath)) return runId;
  }
  throw new Error(`Task ${taskId} not found in any run under ${runsDir}.`);
}

function buildBundle(taskId: string, runId: string): string {
  const pack = readTaskPack(runId, taskId);
  const evDir = evidenceDir(runId, taskId);

  const sections: string[] = [];

  sections.push('═══════════════════════════════════════════════════════════════════════════════');
  sections.push(`CODEX REVIEW BUNDLE — ${pack.task_id}`);
  sections.push(`Module/Sprint: ${pack.module_or_sprint} (target version: ${pack.version_target})`);
  sections.push(`Round: ${pack.codex?.rounds_executed ?? 0 + 1}`);
  sections.push('═══════════════════════════════════════════════════════════════════════════════');
  sections.push('');
  sections.push('OBJECTIVE');
  sections.push(pack.objective);
  sections.push('');
  sections.push('ACCEPTANCE CRITERIA');
  pack.acceptance_criteria.forEach((ac, i) => sections.push(`${i + 1}. ${ac}`));
  sections.push('');

  // Read evidence files (compact summaries only — full logs stay on disk)
  const evidenceFiles = fs.existsSync(evDir) ? fs.readdirSync(evDir) : [];

  if (evidenceFiles.includes('diff.patch')) {
    const diffPath = path.join(evDir, 'diff.patch');
    const diffSize = fs.statSync(diffPath).size;
    if (diffSize < 16 * 1024) {
      // <16KB — include full diff
      sections.push('DIFF (full)');
      sections.push('```diff');
      sections.push(fs.readFileSync(diffPath, 'utf8'));
      sections.push('```');
    } else {
      // Larger — include only summary
      const stat = execSync(`git diff --stat ${diffPath}`, { encoding: 'utf8' }).trim();
      sections.push('DIFF (summary; full at evidence/diff.patch)');
      sections.push('```');
      sections.push(stat);
      sections.push('```');
    }
    sections.push('');
  }

  if (evidenceFiles.includes('test-summary.md')) {
    sections.push('TEST RESULTS');
    sections.push(fs.readFileSync(path.join(evDir, 'test-summary.md'), 'utf8'));
    sections.push('');
  }

  if (evidenceFiles.includes('duplicate-scan.json')) {
    const scan = JSON.parse(fs.readFileSync(path.join(evDir, 'duplicate-scan.json'), 'utf8'));
    sections.push('DUPLICATE SCAN');
    sections.push('```json');
    sections.push(JSON.stringify(scan, null, 2));
    sections.push('```');
    sections.push('');
  }

  if (evidenceFiles.includes('risk-register.md')) {
    sections.push('RISK REGISTER');
    sections.push(fs.readFileSync(path.join(evDir, 'risk-register.md'), 'utf8'));
    sections.push('');
  }

  // Reference files Codex should read directly (NOT pasted into prompt)
  sections.push('REFERENCE FILES (Codex should read these via its file tools)');
  if (pack.references.frd_path) sections.push(`- ${pack.references.frd_path}`);
  pack.references.obsidian_paths.forEach((p) => sections.push(`- ${p}`));
  pack.references.code_paths.forEach((p) => sections.push(`- ${p}`));
  if (pack.references.prior_codex_output) {
    sections.push(`- Prior Codex output: ${pack.references.prior_codex_output}`);
  }
  sections.push('');

  // Verdict format
  sections.push('VERDICT FORMAT');
  sections.push(`- Score: N.N / 10`);
  sections.push(`- Verdict: GO ≥${pack.consensus.gate_threshold} / NO-GO < ${pack.consensus.gate_threshold} / SIGNOFF-READY ≥7.5`);
  sections.push(`- For NO-GO: list 6-12 specific findings with line numbers + recommended fix`);
  sections.push(`- For GO/SIGNOFF-READY: list nice-to-have items deferred`);
  sections.push(`- Always end with: "Cross-module reciprocity status: PASS|FAIL with [evidence]"`);
  sections.push('');
  sections.push('Begin now.');

  return sections.join('\n');
}

async function dispatchCodex(taskId: string, runId: string, bundle: string): Promise<string> {
  const pack = readTaskPack(runId, taskId);
  const round = (pack.codex?.rounds_executed ?? 0) + 1;
  // Codex end-to-end consensus mandate: route Codex artifacts to durable
  // .agent-runs/<run>/_codex/ instead of /tmp (which is volatile across
  // reboots and not visible to auto:resurrect for cross-session recovery).
  const harnessRootRes = harnessRoot();

  // PUB-10: model inventory + change-control preflight for codex-reviewer role.
  // generic-model-governance requires the reviewer model to be on the qualified inventory.
  // Synchronous require via dynamic import not possible in this sync function;
  // routed through statically-imported helpers instead.
  const codexModel = process.env.CODEX_MODEL || 'gpt-5.5';
  const qual = isQualified(readInventory(harnessRootRes), 'codex-cli', codexModel, 'codex-reviewer');
  if (!qual.ok) {
    throw new Error(`[model-inventory] BLOCKED Codex dispatch: ${qual.reason}`);
  }

  const codexDir = path.join(harnessRootRes, '.agent-runs', runId, '_codex', taskId);
  if (!fs.existsSync(codexDir)) fs.mkdirSync(codexDir, { recursive: true });
  const promptPath = path.join(codexDir, `r${round}-prompt.txt`);
  const outputPath = path.join(codexDir, `r${round}-review.md`);

  // Codex R5 fix (authority-of-state): atomic write so the Codex CLI never
  // reads a truncated bundle if this process crashes mid-write.
  atomicWriteFile(promptPath, bundle);
  console.log(`Codex prompt written to ${promptPath} (${bundle.length} chars)`);

  // Verify size budget
  const bundleKb = Buffer.byteLength(bundle, 'utf8') / 1024;
  if (bundleKb > pack.context_budget.max_codex_bundle_kb) {
    throw new Error(
      `Codex bundle exceeds size budget: ${bundleKb.toFixed(2)} KB > ${pack.context_budget.max_codex_bundle_kb} KB. Trim evidence.`
    );
  }

  // v0.5.0 (Codex roadmap-review scope item #5): graceful degradation pre-flight.
  // Without the codex binary available, consensus dispatch fails opaquely several
  // hundred lines later. Detect missing-codex BEFORE we burn time bundling +
  // writing prompts, and emit a clear actionable error referencing the env
  // override + manual-reviewer fallback path.
  if (!fs.existsSync(CODEX_BIN)) {
    const tryPath = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 2000 });
    if (tryPath.status !== 0) {
      throw new Error(
        `[consensus] MissingReviewerError: Codex CLI not found.\n\n` +
        `  Probed:\n` +
        `    1. CODEX_BIN env: ${process.env.CODEX_BIN ?? '(unset)'}\n` +
        `    2. /Applications/Codex.app/Contents/Resources/codex (macOS bundle): ${fs.existsSync(CODEX_BIN) ? 'present' : 'absent'}\n` +
        `    3. \`codex\` on PATH: ${tryPath.status === 0 ? 'present' : 'absent'}\n\n` +
        `  Without codex CLI, the central consensus promise of this harness fails.\n` +
        `  Options to unblock right now:\n` +
        `    • Install Codex CLI:  https://github.com/openai/codex (then re-run this command)\n` +
        `    • Set CODEX_BIN to the absolute path of an installed binary\n` +
        `    • Use AUTO_REVIEWER=manual to fall back to prompt-paste review (v2 will support Claude-as-reviewer)\n\n` +
        `  Per docs/PREREQUISITES.md, codex CLI is REQUIRED for auto:consensus.`
      );
    }
  }

  // Codex efficiency review (2026-04-29) #5: prompt-bundle hash idempotency
  // cache. Skip re-running consensus when (task_id, prompt_hash, model,
  // codex_version, base_sha) have all been seen before — same inputs always
  // produce the same review. Codex's tweak: keys MUST include model/version
  // (and base_sha for the worker's diff) — otherwise we'd cache across
  // upgraded reviewers/changes. Single-day TTL (idempotency, not durability).
  //
  // Cache key MUST also include the round number — otherwise R2 of a
  // revise-loop reuses R1's NO-GO result even though the operator just
  // re-ran auto:work with revised evidence (test fixtures hit this; in
  // production the diff usually changes between rounds and the prompt
  // hash naturally differs). AUTO_CONSENSUS_NO_CACHE=1 disables entirely.
  const cacheBypassed = process.env.AUTO_CONSENSUS_NO_CACHE === '1';
  if (cacheBypassed) {
    console.log(`[CACHE-BYPASS] AUTO_CONSENSUS_NO_CACHE=1 — skipping idempotency cache lookup`);
  }
  try {
    if (cacheBypassed) throw new Error('cache-bypass');
    const crypto = await import('node:crypto');
    const promptHash = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 16);
    const codexVer = (() => {
      try {
        const v = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: 2000 });
        return v.status === 0 ? v.stdout.trim().slice(0, 32) : 'unknown';
      } catch { return 'unknown'; }
    })();
    const round = (pack.codex?.rounds_executed ?? 0) + 1;
    const cacheKey = `${taskId}_r${round}_${codexModel}_${codexVer.replace(/[^a-zA-Z0-9.-]/g, '_')}_${(pack.base_sha ?? 'nosha').slice(0, 7)}_${promptHash}`;
    const cacheRoot = path.join(harnessRootRes, '.agent-runs', '_codex-cache');
    const cachePath = path.join(cacheRoot, `${cacheKey}.json`);
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const ageHours = (Date.now() - new Date(cached.cached_at).getTime()) / (1000 * 60 * 60);
      if (ageHours < 24 && cached.score !== undefined && cached.verdict) {
        console.log(`[CACHE-HIT] consensus reused — same task+prompt+model+sha (age ${ageHours.toFixed(1)}h, score=${cached.score}, verdict=${cached.verdict})`);
        // Write the cached review.md so downstream readers find it
        const reviewText = cached.review_text ?? `Cached review (age ${ageHours.toFixed(1)}h):\nScore: ${cached.score} / 10\nVerdict: ${cached.verdict}`;
        fs.writeFileSync(outputPath, reviewText);
        // Skip the rest of the dispatch — return the outputPath like normal flow
        return outputPath;
      }
      console.log(`[CACHE-STALE] consensus cache hit but ${ageHours.toFixed(1)}h old — re-running`);
    }
    // Stash cache key into closure for post-dispatch write
    (globalThis as { __codex_cache_key?: string }).__codex_cache_key = cacheKey;
    (globalThis as { __codex_cache_root?: string }).__codex_cache_root = cacheRoot;
  } catch (e) {
    console.warn(`[CACHE-PROBE] skipped: ${(e as Error).message.slice(0, 100)}`);
  }

  console.log(`Dispatching Codex CLI (model=${codexModel}, xhigh; sync; this may take 5-10 min)...`);
  // R7 fix: use codexModel consistently — was hardcoded `gpt-5.5` while
  // preflight + telemetry used CODEX_MODEL env. Now a single source of truth.
  //
  // Watchdog (operator directive 2026-04-28): switched execSync → spawnSync
  // so we can register the child pid in the process registry. External
  // watchdog (`pnpm auto:watchdog --apply` or auto:tick) can SIGTERM/SIGKILL
  // the codex child if it exceeds max_duration_sec. Hardcoded 10-min timeout
  // is replaced by env-tunable AUTO_CODEX_TIMEOUT_SEC (default 15 min).
  const cmd = `${CODEX_BIN} exec -m ${codexModel} -c model_reasoning_effort=xhigh -s read-only < ${promptPath} > ${outputPath} 2>&1`;
  const codexTimeoutSec = parseInt(
    process.env.AUTO_CODEX_TIMEOUT_SEC ?? String(defaultMaxDurationSec('codex-consensus')),
    10,
  );
  const dispatchStart = Date.now();
  let exitCode: number | null = 0;
  let dispatchError: Error | null = null;
  let codexPid: number | undefined;
  try {
    // Use spawn (not spawnSync) so we can capture the pid + register before
    // blocking. We then synchronously wait via Atomics on a SAB shim.
    const { spawn } = await import('node:child_process');
    // v0.4.10 (Codex review HIGH #4): detached:true + new process group via
    // setsid, so killGracefully can SIGKILL the whole group via kill(-pid).
    // Otherwise watchdog kills only the shell wrapper and codex child can
    // outlive it.
    // v0.5.x — STREAMING CONSENSUS. Was stdio:'inherit' (operator could only
    // tail the daemon log). Now pipe stdout → progressive parser → throttled
    // writes to pack.codex.partial_progress so the dashboard SSE picks up
    // mid-flight progress instead of waiting 5-10min for completion.
    // Operator directive: "We should be working not waiting. time is money."
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    codexPid = child.pid;
    if (codexPid) {
      registerProcess(harnessRootRes, {
        pid: codexPid,
        kind: 'codex-consensus',
        task_id: taskId,
        run_id: runId,
        started_at: new Date(dispatchStart).toISOString(),
        max_duration_sec: codexTimeoutSec,
        command: cmd.slice(0, 500),
        host: os.hostname(),
        heartbeat_ttl_sec: 120,
        restart_policy: 'next-round',
      });
    }
    // Stream parser: throttled (1Hz) writes to pack.codex.partial_progress.
    // Mirror to stdout so operator can also tail the daemon log directly.
    let lastWriteAt = 0;
    let lineBuffer = '';
    let partialScore: number | null = null;
    let partialFindings = 0;
    let lastSection = '';
    const THROTTLE_MS = 1000;
    const updatePartial = (force = false): void => {
      const now = Date.now();
      if (!force && (now - lastWriteAt) < THROTTLE_MS) return;
      lastWriteAt = now;
      try {
        // Lock-free read-modify-write of just the partial_progress sub-key.
        // The final score write (after exit) is the durable signal; this is
        // best-effort progress only.
        const packPath = path.join(harnessRootRes, '.agent-runs', runId, 'tasks', `${taskId}.json`);
        if (!fs.existsSync(packPath)) return;
        const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'));
        pack.codex = pack.codex ?? {};
        pack.codex.partial_progress = {
          updated_at: new Date(now).toISOString(),
          elapsed_sec: Math.round((now - dispatchStart) / 1000),
          partial_score: partialScore,
          partial_findings_count: partialFindings,
          last_section: lastSection.slice(0, 100),
          pid: codexPid,
        };
        // Codex efficiency review (2026-04-29) #7: compact JSON on hot path.
        // 1Hz partial_progress writes; durable score writes go through
        // writeTaskPack (still pretty-printed for diff readability).
        fs.writeFileSync(packPath, JSON.stringify(pack));
      } catch { /* best-effort; final write is the source of truth */ }
    };
    const handleChunk = (buf: Buffer): void => {
      const s = buf.toString('utf8');
      process.stdout.write(s);  // mirror to daemon log
      lineBuffer += s;
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        // Heuristic parsers — Codex output formats vary, so be permissive
        const scoreMatch = line.match(/(?:score|^)[:\s]+\*{0,2}(\d+\.\d+)\s*\/\s*10/i);
        if (scoreMatch) partialScore = parseFloat(scoreMatch[1]);
        if (/^(?:###?\s+|\*\*)?(round|finding|verdict|recommend|score|p[01]\b)/i.test(line)) lastSection = line;
        if (/(?:^|\s)(?:P[01]:|finding\s+\d+|^\d+\.\s)/i.test(line)) partialFindings++;
      }
      updatePartial();
    };
    child.stdout?.on('data', handleChunk);
    child.stderr?.on('data', (buf) => { process.stderr.write(buf.toString('utf8')); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
        // hard-kill grace
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 10_000);
        reject(new Error(`[consensus] Codex dispatch timed out after ${codexTimeoutSec}s (watchdog SIGTERM→SIGKILL)`));
      }, codexTimeoutSec * 1000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        // Final partial flush so dashboard sees the last section
        updatePartial(true);
        if (code === 0) resolve();
        else reject(new Error(`[consensus] Codex exited with code ${code}`));
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch (e) {
    exitCode = 1;
    dispatchError = e as Error;
    console.error(`Codex dispatch failed: ${(e as Error).message}`);
    console.error(`Partial output may be at ${outputPath}`);
  } finally {
    if (codexPid) {
      try { unregisterProcess(harnessRootRes, codexPid); } catch { /* best-effort */ }
    }
  }
  const durationMs = Date.now() - dispatchStart;

  // Codex R3 fix: symmetric BP3 telemetry now CAS-safe via withTaskPackLock.
  // R2 just re-read before writing — could still clobber a parallel writer
  // between read + write. R3 wraps the read-modify-write in OS-level CAS
  // (same primitive as auto:work claim phase).
  try {
    const promptHash = 'sha256:' + crypto.createHash('sha256').update(bundle).digest('hex');
    let outputBytes = 0;
    try {
      if (fs.existsSync(outputPath)) outputBytes = fs.statSync(outputPath).size;
    } catch { /* best-effort */ }
    const toolVersions: Record<string, string> = {};
    try {
      const codexVer = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8', timeout: 2000 });
      if (codexVer.status === 0) toolVersions.codex = codexVer.stdout.trim();
    } catch { /* best-effort */ }
    withTaskPackLock(runId, taskId, (fresh) => {
      fresh.cost_telemetry.push({
        round,
        engine: 'codex-cli',
        duration_ms: durationMs,
        exit_code: exitCode,
        output_bytes: outputBytes,
        at: new Date().toISOString(),
        model_id: process.env.CODEX_MODEL || 'gpt-5.5',
        model_version: process.env.CODEX_MODEL_VERSION || undefined,
        prompt_hash: promptHash,
        tool_versions: Object.keys(toolVersions).length > 0 ? toolVersions : undefined,
        host: os.hostname(),
      });
      return fresh;
    });
  } catch (e) {
    console.warn(`[telemetry] consensus telemetry write skipped: ${(e as Error).message}`);
  }

  // R12+1 fix (HIGH): fail-CLOSED on dispatch failure. Throw so main() skips
  // verdict parsing + state mutation. Telemetry above is still written (audit
  // trail for the failed attempt). Caller catches at process.exit boundary.
  if (exitCode !== 0) {
    const reason = dispatchError?.message ?? 'unknown';
    throw new Error(
      `[consensus] Codex dispatch failed (exit ${exitCode}): ${reason.slice(0, 300)}\n` +
      `  See ${outputPath} for partial output. Task state preserved.\n` +
      `  Common causes: wrong CODEX_BIN path, network failure, auth issue, model not qualified per PUB-10.`
    );
  }

  // Codex efficiency review (2026-04-29) #5: write to idempotency cache.
  // Same task+prompt+model+sha → reuse on next dispatch (24h TTL).
  try {
    const cacheKey = (globalThis as { __codex_cache_key?: string }).__codex_cache_key;
    const cacheRoot = (globalThis as { __codex_cache_root?: string }).__codex_cache_root;
    if (cacheKey && cacheRoot) {
      const verdict = parseVerdict(outputPath);
      if (verdict.score !== null && verdict.verdict !== null) {
        fs.mkdirSync(cacheRoot, { recursive: true });
        const cachePath = path.join(cacheRoot, `${cacheKey}.json`);
        fs.writeFileSync(cachePath, JSON.stringify({
          cached_at: new Date().toISOString(),
          score: verdict.score,
          verdict: verdict.verdict,
          review_text: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').slice(0, 32 * 1024) : '',
        }, null, 2));
      }
      delete (globalThis as { __codex_cache_key?: string }).__codex_cache_key;
      delete (globalThis as { __codex_cache_root?: string }).__codex_cache_root;
    }
  } catch (e) {
    console.warn(`[CACHE-WRITE] skipped: ${(e as Error).message.slice(0, 100)}`);
  }

  return outputPath;
}

function parseVerdict(outputPath: string): {
  score: number | null;
  verdict: 'GO' | 'NO-GO' | 'SIGNOFF-READY' | null;
} {
  if (!fs.existsSync(outputPath)) return { score: null, verdict: null };
  const content = fs.readFileSync(outputPath, 'utf8');

  // Extract last "Score: N.N / 10" line (Codex sometimes repeats; we want the final)
  const scoreMatches = content.match(/Score:\s*(\d+\.\d+)\s*\/\s*10/g);
  const lastScore = scoreMatches?.[scoreMatches.length - 1];
  const score = lastScore ? parseFloat(lastScore.match(/\d+\.\d+/)![0]) : null;

  // Extract last "Verdict: ..." line
  const verdictMatches = content.match(/Verdict:\s*(GO|NO-GO|SIGNOFF-READY)/g);
  const lastVerdict = verdictMatches?.[verdictMatches.length - 1];
  const verdict = lastVerdict
    ? (lastVerdict.match(/(GO|NO-GO|SIGNOFF-READY)/)![0] as 'GO' | 'NO-GO' | 'SIGNOFF-READY')
    : null;

  return { score, verdict };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRunForTask(args.taskId);
  const pack = readTaskPack(runId, args.taskId);

  console.log(`Task: ${args.taskId} (run: ${runId})`);
  console.log(`Module: ${pack.module_or_sprint}, target: ${pack.version_target}`);
  console.log(`Gate: ${args.gate}`);
  console.log(`Current state: ${pack.state}`);
  console.log('');

  // v0.4.24: duplicate-dispatch guard. Caught 2026-04-28 when 5
  // back-to-back `pnpm auto:consensus TP-303` invocations all CAS-passed
  // (state had already transitioned to codex-reviewing by the 2nd one,
  // and validStatesPerGate accepts both awaiting-review AND codex-reviewing
  // for the completion gate). Result: 5 codex CLI processes burning
  // ~$15-25 of compute reviewing the same prompt. Now: when state is
  // codex-reviewing AND the watchdog registry shows an in-flight
  // codex-consensus for this task, refuse to dispatch.
  if (pack.state === 'codex-reviewing') {
    try {
      const { listRegistered } = await import('../lib/processWatchdog');
      const existing = listRegistered(harnessRoot()).filter(
        (e) => e.kind === 'codex-consensus' && e.task_id === args.taskId,
      );
      if (existing.length > 0 && process.env.AUTO_CONSENSUS_ALLOW_DUPLICATE !== 'true') {
        console.error(`[duplicate-guard] BLOCKED: ${existing.length} codex-consensus process(es) already in flight for ${args.taskId}:`);
        for (const e of existing) console.error(`  - pid=${e.pid} started=${e.started_at}`);
        console.error(`Wait for in-flight dispatch to complete, OR kill it via 'pnpm auto:watchdog --apply' if it's hung,`);
        console.error(`OR set AUTO_CONSENSUS_ALLOW_DUPLICATE=true to bypass (NOT recommended; burns compute on duplicate review).`);
        process.exit(10);
      }
    } catch (e) {
      console.warn(`[duplicate-guard] check skipped: ${(e as Error).message}`);
    }
  }

  // Gate-state validity check
  const validStatesPerGate: Record<Gate, string[]> = {
    'plan': ['planned'],
    'duplicate-scan': ['in-progress', 'claimed'],
    'completion': ['awaiting-review', 'codex-reviewing'],
  };
  if (!validStatesPerGate[args.gate!].includes(pack.state)) {
    console.warn(
      `WARN: Task state is ${pack.state}; expected ${validStatesPerGate[args.gate!].join(' OR ')} for gate ${args.gate}. Continuing anyway.`
    );
  }

  // v0.1 supports completion gate fully; plan + duplicate-scan are templated stubs (v0.2 fills in)
  if (args.gate !== 'completion') {
    gateStubMessage(args.gate!, args.taskId);
    return;
  }

  // R8 fix (HIGH): PUB-10 model inventory preflight MUST run before any state
  // mutation (bundle write + state transition to 'codex-reviewing'). Previously
  // the qual check lived inside dispatchCodex() which runs AFTER the bundle
  // is written and state has transitioned. An unqualified-model dispatch
  // would block the Codex subprocess but leave the task in 'codex-reviewing'
  // with a stale bundle on disk.
  const harnessRootPreflight = harnessRoot();
  const codexModelPreflight = process.env.CODEX_MODEL || 'gpt-5.5';
  const inventoryPreflight = readInventory(harnessRootPreflight);
  const qualPreflight = isQualified(
    inventoryPreflight,
    'codex-cli',
    codexModelPreflight,
    'codex-reviewer'
  );
  // R9 fix (HIGH #1): when isQualified returns ok=true via the bypass path,
  // write a durable audit entry. Lib stays pure; CLI sites enforce.
  if (qualPreflight.ok && qualPreflight.reason && qualPreflight.reason.startsWith('AUTO_MODEL_INVENTORY_BYPASS=1')) {
    appendOverrideAudit(harnessRootPreflight, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: captureIdentity(),
      kind: 'model-inventory-bypass',
      reason: process.env.AUTO_MODEL_INVENTORY_BYPASS_REASON ?? '(unstated)',
      task_id: args.taskId,
      run_id: runId,
      context: { engine: 'codex-cli', model_id: codexModelPreflight, inventory_present: inventoryPreflight !== null },
      pid: process.pid,
      host: os.hostname(),
    });
    console.warn(`[model-inventory-bypass] override audited at .agent-runs/_override-audit.jsonl`);
  }
  if (!qualPreflight.ok) {
    console.error(`[model-inventory-preflight] BLOCKED: ${qualPreflight.reason}`);
    console.error(`No bundle written, no state transition, no Codex dispatch.`);
    process.exit(8);
  }

  // v0.5.0 T2 core (Codex tier-plan first-sprint): auto-invoke specialized
  // reviewers BEFORE codex bundle. Each reviewer's findings go into evidence
  // (reviewer-<name>.json). Codex sees the bundle next; if any reviewer has
  // a blocking finding, codex consensus result still runs but evaluateAutoPromote
  // will refuse promotion until reviewer findings are resolved.
  if (pack.consensus.specialized_reviewers.length > 0) {
    console.log(`[specialized-reviewers] running ${pack.consensus.specialized_reviewers.length} pre-consensus reviewer(s)…`);
    for (const reviewerName of pack.consensus.specialized_reviewers) {
      try {
        if (reviewerName === 'a11y-auditor') {
          const { runA11yAuditor } = await import('../lib/a11yAuditor');
          const harnessRootMain = harnessRoot();
          const evidenceDir = path.join(harnessRootMain, '.agent-runs', runId, pack.evidence_dir);
          const out = runA11yAuditor({ taskId: args.taskId, runId, pack, evidenceDir, repoRoot: harnessRootMain });
          console.log(`  ${out.reviewer_blocks ? '✗' : '✓'} a11y-auditor: ${out.summary}`);
        } else {
          // ui-design-reviewer / interaction-test-author / visual-regressor
          // are declared in schema but not yet implemented (deferred to v2 per
          // Codex). Skip with a clear log line so operator knows.
          console.log(`  ⊘ ${reviewerName}: not yet implemented in v1; skipping`);
        }
      } catch (e) {
        console.warn(`  ✗ ${reviewerName} failed: ${(e as Error).message}`);
      }
    }
    console.log('');
  }

  // Build bundle
  const bundle = buildBundle(args.taskId, runId);
  const bundlePath = writeEvidence(runId, args.taskId, 'codex-bundle.txt', bundle);
  console.log(`Bundle written to ${bundlePath}`);

  // PUB-8 SoD: capture reviewer identity + enforce creator-vs-reviewer
  // distinctness BEFORE Codex dispatch. R7 fix: previously WARN-only by
  // default. Now THROWS by default — same posture as auto:land/promote
  // approver checks. Set AUTO_SOD_REVIEWER_OVERRIDE=1 to opt out (audit
  // trail captured in evidence). The daemon should set
  // AUTO_ACTOR_OVERRIDE to a distinct principal instead of opting out.
  const reviewerIdentity = captureIdentity();
  const sodPolicy = defaultSoDPolicy();
  const sodCheck = enforceSoD(sodPolicy, pack.actors, 'reviewer', reviewerIdentity);
  if (!sodCheck.ok) {
    if (process.env.AUTO_SOD_REVIEWER_OVERRIDE !== '1') {
      throw new Error(
        `[sod] BLOCKED: ${sodCheck.reason}\n  ${sodCheck.remediation}\n  ` +
        `To opt out (audit trail captured), set AUTO_SOD_REVIEWER_OVERRIDE=1 AND AUTO_SOD_REVIEWER_OVERRIDE_REASON=…`
      );
    }
    const overrideReason = process.env.AUTO_SOD_REVIEWER_OVERRIDE_REASON;
    if (!overrideReason || overrideReason.length < 3) {
      throw new Error(
        `[sod] BLOCKED: AUTO_SOD_REVIEWER_OVERRIDE=1 set but AUTO_SOD_REVIEWER_OVERRIDE_REASON missing or empty. ` +
        `SOX requires a stated reason for every bypass. Re-run with both env vars set.`
      );
    }
    // R8+1: durable audit record for this bypass (was: warn-only).
    appendOverrideAudit(harnessRootPreflight, {
      schema_version: '1',
      at: new Date().toISOString(),
      actor: reviewerIdentity,
      kind: 'sod-reviewer-bypass',
      reason: overrideReason,
      task_id: args.taskId,
      run_id: runId,
      context: { sod_violation_reason: sodCheck.reason },
      pid: process.pid,
      host: (() => { try { return os.hostname(); } catch { return undefined; } })(),
    });
    console.warn(`[sod] WARN (AUTO_SOD_REVIEWER_OVERRIDE=1): ${sodCheck.reason}`);
    console.warn(`[sod] override audited at ${path.join(harnessRootPreflight, '.agent-runs', '_override-audit.jsonl')}`);
  }

  // Codex R4 fix: state transition write now CAS-safe via withTaskPackLock.
  const fromState = pack.state;
  withTaskPackLock(runId, args.taskId, (fresh) => {
    fresh.actors = appendActor(fresh.actors, 'reviewer', reviewerIdentity);
    return appendStateTransition(fresh, 'codex-reviewing', 'orchestrator', 'auto:consensus');
  });
  appendStateLog(runId, {
    task_id: args.taskId,
    from: fromState,
    to: 'codex-reviewing',
    at: new Date().toISOString(),
    by: 'orchestrator',
    reason: 'auto:consensus invoked',
  });

  // Dispatch — wrapped in CAS rollback per Codex v0.4.9 review HIGH #6.
  // Without rollback, a dispatch failure left the task in 'codex-reviewing'
  // state with no path back. Now: try dispatch; on failure, restore to
  // prior state via withTaskPackLock + appendStateTransition before re-throw.
  let outputPath: string;
  try {
    outputPath = await dispatchCodex(args.taskId, runId, bundle);
  } catch (e) {
    try {
      withTaskPackLock(runId, args.taskId, (fresh) => {
        fresh.notes.push({
          at: new Date().toISOString(),
          by: 'auto:consensus-rollback',
          text: `dispatch failed: ${(e as Error).message.slice(0, 200)}; rolling back to ${fromState}`,
        });
        return appendStateTransition(fresh, fromState as never, 'orchestrator', `dispatch error rollback: ${(e as Error).message.slice(0, 100)}`);
      });
      console.error(`[consensus] dispatch failed; rolled back state to '${fromState}'`);
    } catch (rbErr) {
      console.error(`[consensus] CRITICAL: dispatch failed AND rollback also failed: ${(rbErr as Error).message}`);
      console.error(`[consensus] Task remains in 'codex-reviewing' — operator MUST manually revert via auto:resurrect or task-pack edit.`);
    }
    throw e;
  }
  console.log(`Codex output at ${outputPath}`);

  // Copy verdict to evidence
  if (fs.existsSync(outputPath)) {
    const verdictContent = fs.readFileSync(outputPath, 'utf8');
    writeEvidence(runId, args.taskId, 'codex-verdict.md', verdictContent);
  }

  // R12+1 fix: dispatchCodex now throws on non-zero exit (fail-CLOSED). If
  // we reach here, dispatch succeeded. The verdict-not-parseable check below
  // catches the lesser case where Codex returned 0 but output is malformed.

  // Parse verdict
  const { score, verdict } = parseVerdict(outputPath);
  console.log(``);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`CODEX VERDICT`);
  console.log(`═══════════════════════════════════════════════════════════════════════`);
  console.log(`Score:   ${score ?? '(unparsed)'} / 10`);
  console.log(`Verdict: ${verdict ?? '(unparsed)'}`);
  console.log(`Threshold: ≥${pack.consensus.gate_threshold}`);
  console.log(``);

  // R12+1 fix: also refuse if verdict couldn't be parsed (Codex returned
  // success but with non-standard output). Same fail-CLOSED principle.
  if (verdict === null || score === null) {
    console.error(`Codex output did not contain parseable Score: + Verdict: lines.`);
    console.error(`Refusing to write verdict; task state preserved.`);
    console.error(`Inspect ${outputPath} and retry (or update parseVerdict regex if Codex output format changed).`);
    process.exit(3);
  }

  // Codex R4 fix: final result write now CAS-safe via withTaskPackLock.
  // Determines next state INSIDE the lock callback to avoid race with
  // concurrent operators (e.g., manual revise CLI).
  let nextState: 'promotable' | 'needs-revision' | 'codex-reviewing' = 'codex-reviewing';
  let finalRound = 0;
  withTaskPackLock(runId, args.taskId, (fresh) => {
    const newRound = (fresh.codex?.rounds_executed ?? 0) + 1;
    const priorHistory = fresh.codex?.score_history ?? [];
    fresh.codex = {
      bundle_path: bundlePath,
      verdict_path: outputPath,
      score: score ?? undefined,
      verdict: verdict ?? 'pending',
      rounds_executed: newRound,
      // v0.4.4: append per-round score history for plateau detection.
      score_history: [
        ...priorHistory,
        {
          round: newRound,
          score: score ?? undefined,
          verdict: verdict ?? 'pending',
          at: new Date().toISOString(),
          verdict_path: outputPath,
        },
      ],
    };
    finalRound = fresh.codex.rounds_executed;
    if (score !== null) {
      nextState = score >= pack.consensus.gate_threshold ? 'promotable' : 'needs-revision';
    }
    appendStateTransition(
      fresh,
      nextState,
      'orchestrator',
      `Codex round ${fresh.codex.rounds_executed}: score=${score}, verdict=${verdict}`
    );
    return fresh;
  });
  appendStateLog(runId, {
    task_id: args.taskId,
    from: 'codex-reviewing',
    to: nextState,
    at: new Date().toISOString(),
    by: 'orchestrator',
    reason: `Codex score=${score}, verdict=${verdict}`,
  });

  console.log(`Next state: ${nextState}`);
  // TS narrows nextState by the let-binding's initial value; assert through
  // the typed union so the conditional branches typecheck.
  const ns: string = nextState;
  if (ns === 'promotable') {
    console.log(``);
    console.log(`✓ Task ready for promotion. Run: pnpm auto:promote ${args.taskId}`);
  } else if (ns === 'needs-revision') {
    console.log(``);
    console.log(`⚠ Task needs revision (score < threshold).`);
    console.log(`  Read findings: ${outputPath}`);
    console.log(`  Apply fix-in-place + re-run: pnpm auto:consensus ${args.taskId} (round ${finalRound + 1})`);
    console.log(`  After ${pack.consensus.max_rounds} rounds, escalate to human.`);
  }
}

main().catch((e) => {
  console.error(`[consensus] fatal: ${(e as Error).message}`);
  process.exit(1);
});
