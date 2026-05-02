#!/usr/bin/env node
/**
 * pnpm auto:resurrect
 *
 * Single-command end-to-end recovery after a reboot, crash, or session loss.
 * "Brings everything back to life from where we left off."
 *
 * What it does (read-only first; mutations only with --apply):
 *   1. Re-fetches origin/main so local repo is current
 *   2. Reads AUTONOMOUS-PROGRESS.md (last flush)
 *   3. Scans all task packs in .agent-runs/<run>/tasks/
 *      - Finds tasks stuck `in-progress` with dead/stale locks
 *      - Finds tasks `awaiting-review` with valid evidence (ready for auto:land)
 *      - Finds tasks with missing evidence files
 *   4. Scans Codex review state:
 *      - Lists committed reviews (CODEX-REVIEW-H1-RN.md) — durable
 *      - Lists in-flight prompts in /tmp/codex-*-prompt.txt
 *      - Lists volatile reviews in /tmp/codex-*-review.md (lost on reboot)
 *   5. Lists open PRs related to harness branches
 *   6. Lists branches with unmerged work
 *   7. Prints structured RECOVERY-READY summary with exact next-action commands
 *
 * Modes:
 *   pnpm auto:resurrect             — read-only diagnosis (default; safe)
 *   pnpm auto:resurrect --apply     — also: release stale locks, archive volatile reviews
 *   pnpm auto:resurrect --json      — machine-readable output for the daemon
 *
 * This is the operator's one-stop "what state am I in?" + "what should I do next?"
 * tool after any disruption. Closes M_REBOOT_1 from SOTA-COMPLIANCE-MATRIX.md.
 *
 * Sprint: H1 R5 (added in response to operator directive 2026-04-27).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  readTaskPack,
  writeTaskPack,
  evidenceDir,
  listTasks,
  tasksDir,
  appendStateLog,
  withTaskPackLock,
} from '../lib/runState';
import { releaseTaskLock, appendStateTransition, type TaskPack, type TaskState } from '../lib/taskPack';
import { readGoal, evaluateGoal, buildGoalSnapshot } from '../lib/goal';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const RUNS_DIR = path.join(HARNESS_ROOT, '.agent-runs');

interface ResurrectArgs {
  apply: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): ResurrectArgs {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
}

interface StuckTask {
  task_id: string;
  run_id: string;
  state: TaskState;
  reason: string;
  recommendation: string;
}

interface LostReview {
  filename: string;
  age_min: number;
  prompt_path?: string;       // companion prompt file (durable input)
  recommendation: string;
}

interface OpenPr {
  number: number;
  title: string;
  branch: string;
  age_hours: number;
}

interface ResurrectReport {
  timestamp: string;
  apply_mode: boolean;
  last_flush: { path: string; age_hours: number; exists: boolean };
  git_sync: { ok: boolean; main_sha?: string; behind?: number };
  stuck_tasks: StuckTask[];
  ready_to_land: Array<{ task_id: string; run_id: string }>;
  lost_codex_reviews: LostReview[];
  durable_codex_reviews: string[];
  open_prs: OpenPr[];
  branches_with_unmerged_work: Array<{ name: string; head_sha: string; ahead: number }>;
  recommended_actions: string[];
  applied_fixes: string[];
}

const STALE_LOCK_THRESHOLD_MIN = 15;

function findRuns(): string[] {
  if (!fs.existsSync(RUNS_DIR)) return [];
  return fs
    .readdirSync(RUNS_DIR)
    .filter((name) => fs.statSync(path.join(RUNS_DIR, name)).isDirectory())
    .filter((name) => !name.startsWith('_'));
}

function checkLastFlush(): ResurrectReport['last_flush'] {
  const pPath = path.join(process.env.HOME ?? '', process.env.HERMES_PROGRESS_PATH || './PROGRESS.md');
  if (!fs.existsSync(pPath)) {
    return { path: pPath, age_hours: -1, exists: false };
  }
  const stat = fs.statSync(pPath);
  return {
    path: pPath,
    age_hours: (Date.now() - stat.mtimeMs) / 3_600_000,
    exists: true,
  };
}

function checkGitSync(): ResurrectReport['git_sync'] {
  const fetch = spawnSync('git', ['fetch', 'origin', 'main', '--quiet'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (fetch.status !== 0) {
    return { ok: false };
  }
  const head = spawnSync('git', ['rev-parse', 'origin/main'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });
  const main_sha = head.stdout.trim().slice(0, 8);
  const behind = spawnSync('git', ['rev-list', '--count', 'HEAD..origin/main'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 5_000,
  });
  return {
    ok: true,
    main_sha,
    behind: parseInt(behind.stdout.trim() || '0', 10),
  };
}

function scanStuckTasks(applyMode: boolean): {
  stuck: StuckTask[];
  ready: Array<{ task_id: string; run_id: string }>;
  fixes: string[];
} {
  const stuck: StuckTask[] = [];
  const ready: Array<{ task_id: string; run_id: string }> = [];
  const fixes: string[] = [];

  for (const runId of findRuns()) {
    const taskIds = listTasks(runId);
    for (const taskId of taskIds) {
      let pack: TaskPack;
      try {
        pack = readTaskPack(runId, taskId);
      } catch {
        continue;
      }

      // Codex R5 fix: ALSO surface in-progress tasks with NO lock (orphaned —
      // can happen when --apply previously released the lock but didn't
      // transition state, or when a worker died after writing in-progress
      // but before completing the in-pack lock acquisition).
      if (pack.state === 'in-progress' && !pack.lock) {
        stuck.push({
          task_id: taskId,
          run_id: runId,
          state: pack.state,
          reason: `state=in-progress but pack.lock=null — orphaned (worker died, or prior --apply was incomplete)`,
          recommendation: applyMode
            ? `(handled by --apply: transitioning to needs-revision)`
            : `Re-run: pnpm auto:resurrect --apply  to transition this back to needs-revision`,
        });

        if (applyMode) {
          // Codex R5 fix: use withTaskPackLock for the mutation, transition
          // state to needs-revision (so auto:work will accept it), and emit
          // state-log entry. This is the "actually recover" path that R5
          // identified as missing.
          try {
            const recovered = withTaskPackLock(runId, taskId, (fresh) => {
              if (fresh.state !== 'in-progress') return fresh; // race: another worker claimed it
              releaseTaskLock(fresh); // belt-and-suspenders even if already null
              fresh.notes.push({
                at: new Date().toISOString(),
                by: 'auto:resurrect',
                text: 'recovered orphaned in-progress task (no lock + no active worker)',
              });
              return appendStateTransition(
                fresh,
                'needs-revision',
                'auto:resurrect',
                'orphaned recovery: in-progress with no lock; transitioned to needs-revision so auto:work can re-dispatch'
              );
            });
            appendStateLog(runId, {
              task_id: taskId,
              from: 'in-progress',
              to: recovered.state as string,
              at: new Date().toISOString(),
              by: 'auto:resurrect',
              reason: 'orphaned recovery (state==in-progress, lock==null)',
            });
            fixes.push(`recovered orphaned ${taskId} → state=${recovered.state}`);
          } catch (e) {
            fixes.push(`failed to recover ${taskId}: ${(e as Error).message}`);
          }
        }
        continue; // already handled
      }

      // 1. Stuck in-progress with stale lock
      if (pack.state === 'in-progress' && pack.lock) {
        const acquiredAt = new Date(pack.lock.acquired_at);
        const ageMin = (Date.now() - acquiredAt.getTime()) / 60_000;
        const expiresAt = new Date(pack.lock.expires_at);
        const expired = expiresAt < new Date();

        if (expired || ageMin > STALE_LOCK_THRESHOLD_MIN) {
          // Worker process likely dead — verify PID
          let pidAlive = false;
          try {
            process.kill(pack.lock.pid, 0); // signal 0 = liveness check
            pidAlive = true;
          } catch {
            pidAlive = false;
          }

          const lockPid = pack.lock.pid;
          stuck.push({
            task_id: taskId,
            run_id: runId,
            state: pack.state,
            reason:
              `lock acquired ${ageMin.toFixed(1)}min ago by pid ${lockPid} ` +
              `(${pidAlive ? 'still alive' : 'DEAD'}), expires=${pack.lock.expires_at}` +
              (expired ? ' [EXPIRED]' : ''),
            recommendation: pidAlive
              ? `Worker pid ${lockPid} is still alive — DO NOT clobber. Wait for it to finish, OR kill it explicitly first.`
              : applyMode
                ? `(handled by --apply: releasing dead lock + transitioning to needs-revision)`
                : `Worker pid ${lockPid} is dead. Re-run: pnpm auto:resurrect --apply (releases lock + transitions state)`,
          });

          if (applyMode && !pidAlive) {
            // Codex R5 fix: use withTaskPackLock for atomic CAS, transition
            // state from in-progress to needs-revision (so auto:work will
            // accept it next round), AND release lock, AND write state-log.
            try {
              const recovered = withTaskPackLock(runId, taskId, (fresh) => {
                releaseTaskLock(fresh);
                fresh.notes.push({
                  at: new Date().toISOString(),
                  by: 'auto:resurrect',
                  text: `released stale lock from dead pid ${lockPid} (${ageMin.toFixed(1)}min stale) + transitioned to needs-revision`,
                });
                return appendStateTransition(
                  fresh,
                  'needs-revision',
                  'auto:resurrect',
                  `dead-lock recovery: pid ${lockPid} dead, lock ${ageMin.toFixed(1)}min stale; transitioned to needs-revision so auto:work can re-dispatch`
                );
              });
              appendStateLog(runId, {
                task_id: taskId,
                from: 'in-progress',
                to: recovered.state as string,
                at: new Date().toISOString(),
                by: 'auto:resurrect',
                reason: `dead-lock recovery (pid ${lockPid} dead, ${ageMin.toFixed(1)}min stale)`,
              });
              fixes.push(`recovered ${taskId}: released dead lock + state → ${recovered.state}`);
            } catch (e) {
              fixes.push(`failed to recover ${taskId}: ${(e as Error).message}`);
            }
          }
        }
      }

      // 2. Awaiting-review with full evidence → ready for auto:land
      if (pack.state === 'awaiting-review') {
        const evDir = evidenceDir(runId, taskId);
        const required = ['diff.patch', 'test-summary.md', 'duplicate-scan.json', 'risk-register.md', 'worker-handoff.json'];
        const hasAll = required.every((f) => fs.existsSync(path.join(evDir, f)));
        if (hasAll) {
          ready.push({ task_id: taskId, run_id: runId });
        }
      }
    }
  }

  return { stuck, ready, fixes };
}

function scanCodexReviews(applyMode: boolean): {
  lost: LostReview[];
  durable: string[];
  fixes: string[];
} {
  const lost: LostReview[] = [];
  const fixes: string[] = [];

  // Durable reviews (committed in repo)
  const durable: string[] = [];
  if (fs.existsSync(PACKAGE_ROOT)) {
    for (const f of fs.readdirSync(PACKAGE_ROOT)) {
      if (/^CODEX-(REVIEW|SOTA)/.test(f) && f.endsWith('.md')) {
        durable.push(path.join(PACKAGE_ROOT, f));
      }
    }
  }

  // Volatile reviews (in /tmp; lost on reboot)
  const tmpDir = '/tmp';
  if (fs.existsSync(tmpDir)) {
    for (const f of fs.readdirSync(tmpDir)) {
      if (/^codex-.*-(review|prompt)\.(md|txt)$/.test(f)) {
        const fpath = path.join(tmpDir, f);
        try {
          const stat = fs.statSync(fpath);
          const ageMin = (Date.now() - stat.mtimeMs) / 60_000;
          // Only surface review files (not prompt files) as "lost" — prompts are inputs.
          if (f.endsWith('-review.md')) {
            const promptPath = fpath.replace('-review.md', '-prompt.txt');
            lost.push({
              filename: fpath,
              age_min: ageMin,
              prompt_path: fs.existsSync(promptPath) ? promptPath : undefined,
              recommendation: fs.existsSync(promptPath)
                ? `Review file is volatile (/tmp). Re-dispatch using prompt: codex exec ... "$(cat ${promptPath})"`
                : `Review file is volatile and prompt is missing — recover from session-history snapshot or re-construct prompt manually`,
            });

            // --apply mode: archive volatile reviews into .agent-runs/_codex/
            if (applyMode) {
              const archiveDir = path.join(RUNS_DIR, '_codex');
              if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
              const archivePath = path.join(archiveDir, f);
              try {
                fs.copyFileSync(fpath, archivePath);
                fixes.push(`archived ${f} → ${archivePath}`);
              } catch (e) {
                fixes.push(`failed to archive ${f}: ${(e as Error).message}`);
              }
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  return { lost, durable, fixes };
}

function scanOpenPrs(): OpenPr[] {
  const r = spawnSync('gh', ['pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,headRefName,createdAt'], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) return [];
  try {
    const list = JSON.parse(r.stdout) as Array<{ number: number; title: string; headRefName: string; createdAt: string }>;
    return list.map((p) => ({
      number: p.number,
      title: p.title,
      branch: p.headRefName,
      age_hours: (Date.now() - new Date(p.createdAt).getTime()) / 3_600_000,
    }));
  } catch {
    return [];
  }
}

function scanBranches(): Array<{ name: string; head_sha: string; ahead: number }> {
  const r = spawnSync(
    'git',
    ['for-each-ref', '--format=%(refname:short) %(objectname:short)', 'refs/heads/'],
    { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 15_000 }
  );
  if (r.status !== 0) return [];
  const out: Array<{ name: string; head_sha: string; ahead: number }> = [];
  for (const line of (r.stdout ?? '').split('\n')) {
    const [name, sha] = line.split(' ');
    if (!name || name === 'main' || !sha) continue;
    const ahead = spawnSync('git', ['rev-list', '--count', `origin/main..${name}`], {
      cwd: HARNESS_ROOT,
      encoding: 'utf8',
      timeout: 5_000,
    });
    const n = parseInt(ahead.stdout.trim() || '0', 10);
    if (n > 0) {
      out.push({ name, head_sha: sha, ahead: n });
    }
  }
  return out.sort((a, b) => b.ahead - a.ahead).slice(0, 20);
}

function buildRecommendations(report: ResurrectReport): string[] {
  const recs: string[] = [];

  if (report.last_flush.age_hours < 0) {
    recs.push(`⚠ AUTONOMOUS-PROGRESS.md not found at ${report.last_flush.path} — run \`pnpm auto:flush-progress\` after recovery`);
  } else if (report.last_flush.age_hours > 24) {
    recs.push(`⚠ Last flush is ${report.last_flush.age_hours.toFixed(1)}h old — read with caution; state may have drifted`);
  } else {
    recs.push(`✓ AUTONOMOUS-PROGRESS.md is fresh (${report.last_flush.age_hours.toFixed(1)}h old) — read for context: ${report.last_flush.path}`);
  }

  if (!report.git_sync.ok) {
    recs.push(`⚠ git fetch failed — check network/auth before any landing operation`);
  } else if ((report.git_sync.behind ?? 0) > 0) {
    recs.push(`Local main is ${report.git_sync.behind} commits behind origin/main — \`git pull\` if you intend to work on main directly`);
  }

  if (report.stuck_tasks.length > 0) {
    recs.push(`${report.stuck_tasks.length} task(s) stuck in-progress with stale lock:`);
    for (const s of report.stuck_tasks.slice(0, 5)) {
      recs.push(`  - ${s.task_id}: ${s.recommendation}`);
    }
  }

  if (report.ready_to_land.length > 0) {
    recs.push(`${report.ready_to_land.length} task(s) ready for auto:land (awaiting-review with full evidence):`);
    for (const r of report.ready_to_land) {
      recs.push(`  - pnpm auto:land ${r.task_id}`);
    }
  }

  if (report.lost_codex_reviews.length > 0) {
    recs.push(`${report.lost_codex_reviews.length} Codex review(s) in volatile /tmp:`);
    for (const l of report.lost_codex_reviews.slice(0, 5)) {
      recs.push(`  - ${path.basename(l.filename)} (${l.age_min.toFixed(1)}min old): ${l.recommendation}`);
    }
  }

  if (report.open_prs.length > 0) {
    recs.push(`${report.open_prs.length} open PR(s) — check status:`);
    for (const p of report.open_prs.slice(0, 5)) {
      recs.push(`  - #${p.number} ${p.title} [${p.branch}, ${p.age_hours.toFixed(1)}h old]`);
    }
  }

  if (report.branches_with_unmerged_work.length > 0) {
    recs.push(`${report.branches_with_unmerged_work.length} branch(es) ahead of origin/main — review for landing or cleanup:`);
    for (const b of report.branches_with_unmerged_work.slice(0, 5)) {
      recs.push(`  - ${b.name} (${b.ahead} commits ahead, HEAD ${b.head_sha})`);
    }
  }

  if (recs.length === 0 || (report.stuck_tasks.length === 0 && report.lost_codex_reviews.length === 0 && report.ready_to_land.length === 0)) {
    recs.push(`✓ No outstanding recovery actions detected. System is at a clean checkpoint.`);
  }

  return recs;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const report: ResurrectReport = {
    timestamp: new Date().toISOString(),
    apply_mode: args.apply,
    last_flush: checkLastFlush(),
    git_sync: checkGitSync(),
    stuck_tasks: [],
    ready_to_land: [],
    lost_codex_reviews: [],
    durable_codex_reviews: [],
    open_prs: [],
    branches_with_unmerged_work: [],
    recommended_actions: [],
    applied_fixes: [],
  };

  const stuckResult = scanStuckTasks(args.apply);
  report.stuck_tasks = stuckResult.stuck;
  report.ready_to_land = stuckResult.ready;
  report.applied_fixes.push(...stuckResult.fixes);

  const codexResult = scanCodexReviews(args.apply);
  report.lost_codex_reviews = codexResult.lost;
  report.durable_codex_reviews = codexResult.durable;
  report.applied_fixes.push(...codexResult.fixes);

  report.open_prs = scanOpenPrs();
  report.branches_with_unmerged_work = scanBranches();
  report.recommended_actions = buildRecommendations(report);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  // Human-readable output
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  pnpm auto:resurrect — end-to-end recovery diagnostic');
  console.log(`  ${report.timestamp}  ${args.apply ? '[APPLY MODE]' : '[READ-ONLY]'}`);
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('');

  console.log(`Last flush: ${report.last_flush.exists ? `${report.last_flush.age_hours.toFixed(1)}h ago` : 'NOT FOUND'} (${report.last_flush.path})`);
  console.log(`Git sync:   ${report.git_sync.ok ? `OK; origin/main = ${report.git_sync.main_sha}; HEAD is ${report.git_sync.behind} commits behind` : 'FAILED'}`);
  console.log('');

  console.log(`Stuck tasks (in-progress with stale/dead lock): ${report.stuck_tasks.length}`);
  for (const s of report.stuck_tasks) {
    console.log(`  - ${s.task_id} [${s.run_id}]: ${s.reason}`);
  }
  console.log('');

  console.log(`Ready to land (awaiting-review + full evidence): ${report.ready_to_land.length}`);
  for (const r of report.ready_to_land) {
    console.log(`  - ${r.task_id}`);
  }
  console.log('');

  console.log(`Codex reviews: ${report.durable_codex_reviews.length} durable (committed), ${report.lost_codex_reviews.length} volatile in /tmp`);
  for (const l of report.lost_codex_reviews) {
    console.log(`  - ${path.basename(l.filename)} (${l.age_min.toFixed(1)}min old)${l.prompt_path ? ` [prompt: ${path.basename(l.prompt_path)}]` : ' [PROMPT MISSING]'}`);
  }
  console.log('');

  console.log(`Open PRs: ${report.open_prs.length}`);
  for (const p of report.open_prs) {
    console.log(`  - #${p.number} ${p.title.slice(0, 70)} [${p.branch}, ${p.age_hours.toFixed(1)}h]`);
  }
  console.log('');

  console.log(`Branches ahead of origin/main: ${report.branches_with_unmerged_work.length}`);
  for (const b of report.branches_with_unmerged_work.slice(0, 10)) {
    console.log(`  - ${b.name} (${b.ahead} ahead, HEAD ${b.head_sha})`);
  }
  console.log('');

  if (report.applied_fixes.length > 0) {
    console.log(`Applied fixes (${report.applied_fixes.length}):`);
    for (const f of report.applied_fixes) {
      console.log(`  ✓ ${f}`);
    }
    console.log('');
  }

  // Codex R2 mandate: surface goal progress in auto:resurrect (was only in
  // auto:tick; now visible in the canonical recovery diagnostic too).
  try {
    const goal = readGoal(HARNESS_ROOT);
    if (goal) {
      // Codex R4 fix: centralized buildGoalSnapshot helper (was 13 LOC duplicated).
      const snapshot = buildGoalSnapshot(HARNESS_ROOT, PACKAGE_ROOT);
      const evalResult = evaluateGoal(goal, snapshot);
      console.log(`Goal progress: ${evalResult.complete ? '🎉 MISSION COMPLETE' : 'in progress'} — ${evalResult.criteria_met}/${evalResult.total_criteria} criteria met${evalResult.criteria_overridden > 0 ? ` (${evalResult.criteria_overridden} overridden)` : ''}`);
      for (const c of evalResult.per_criterion) {
        const m = c.met ? '✓' : c.override_active ? '⚠' : ' ';
        console.log(`  ${m} ${c.id}: ${c.current}/${c.target}${c.override_reason ? ` [override: ${c.override_reason}]` : ''}`);
      }
      console.log('');
    }
  } catch (e) { console.warn(`[goal] evaluation skipped: ${(e as Error).message}`); }

  console.log('───────────────────────────────────────────────────────────────────');
  console.log('  RECOMMENDED NEXT ACTIONS');
  console.log('───────────────────────────────────────────────────────────────────');
  for (const r of report.recommended_actions) {
    console.log(r);
  }
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════');
  if (!args.apply) {
    console.log('  This was a READ-ONLY diagnosis. To release stale locks + archive');
    console.log('  volatile Codex reviews, re-run with --apply.');
  } else {
    console.log('  --apply mode complete. Stale locks released; volatile reviews archived.');
  }
  console.log('═══════════════════════════════════════════════════════════════════');
}

main();
