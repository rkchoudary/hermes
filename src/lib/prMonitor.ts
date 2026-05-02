/**
 * PR monitor — watches GitHub CI checks + Vercel deployments after auto:land
 * creates a PR. Surfaces errors that would otherwise be invisible.
 *
 * Operator directive 2026-04-28: "when submitting the code it needs to
 * monitor for errors for example github and vercel. the testing needs to
 * be end to end"
 *
 * Composes:
 *   - GitHub Actions / external CI status via `gh pr checks <PR>`
 *   - Vercel deployment status via `vercel inspect <url>` or `vercel ls`
 *
 * Output: structured PrStatus with per-check + per-deploy state.
 * On failure: extracts a tail of logs to evidence dir for the worker
 * to consume on next-round dispatch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';

export const PrCheckStatus = z.object({
  name: z.string(),
  /** GitHub buckets: pending | success | failure | cancelled | skipped | timed_out | action_required */
  bucket: z.string(),
  conclusion: z.string().optional(),
  url: z.string().optional(),
  workflow: z.string().optional(),
});
export type PrCheckStatus = z.infer<typeof PrCheckStatus>;

export const VercelDeployStatus = z.object({
  url: z.string(),
  /** READY | BUILDING | ERROR | QUEUED | CANCELED | INITIALIZING */
  state: z.string(),
  created_at: z.string().optional(),
  /** Tail of build logs if state=ERROR. */
  error_tail: z.string().optional(),
});
export type VercelDeployStatus = z.infer<typeof VercelDeployStatus>;

export interface PrStatus {
  pr_number: number;
  pr_url: string;
  branch: string;
  head_sha: string;
  /** Aggregate over all checks: pending | passing | failing. */
  ci_overall: 'pending' | 'passing' | 'failing' | 'unknown';
  ci_checks: PrCheckStatus[];
  /** Aggregate over all deployments: pending | ready | error. */
  vercel_overall: 'pending' | 'ready' | 'error' | 'unknown' | 'none';
  vercel_deploys: VercelDeployStatus[];
  /** True if BOTH ci + vercel are terminal (no pending) AND all green. */
  ready_to_promote: boolean;
  /** Free-form summary for log + slack. */
  summary: string;
}

// ─── GitHub ────────────────────────────────────────────────────────────────

function ghAvailable(): boolean {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0;
}

export function getPrChecks(prNumber: number, opts: { repo?: string } = {}): PrCheckStatus[] {
  if (!ghAvailable()) return [];
  const args = ['pr', 'checks', String(prNumber), '--json', 'name,bucket,state,workflow,link'];
  if (opts.repo) args.push('--repo', opts.repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 15_000 });
  if (r.status !== 0) return [];
  try {
    const raw = JSON.parse(r.stdout) as Array<{ name: string; bucket: string; state?: string; workflow?: string; link?: string }>;
    return raw.map((c) => ({
      name: c.name,
      bucket: c.bucket,
      conclusion: c.state,
      url: c.link,
      workflow: c.workflow,
    }));
  } catch { return []; }
}

export function getPrInfo(prNumber: number, opts: { repo?: string } = {}): { branch: string; head_sha: string; url: string } | null {
  if (!ghAvailable()) return null;
  const args = ['pr', 'view', String(prNumber), '--json', 'headRefName,headRefOid,url'];
  if (opts.repo) args.push('--repo', opts.repo);
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: 10_000 });
  if (r.status !== 0) return null;
  try {
    const j = JSON.parse(r.stdout) as { headRefName: string; headRefOid: string; url: string };
    return { branch: j.headRefName, head_sha: j.headRefOid, url: j.url };
  } catch { return null; }
}

// ─── Vercel ────────────────────────────────────────────────────────────────

function vercelAvailable(): boolean {
  const r = spawnSync('vercel', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0;
}

export function getVercelDeploysForBranch(branch: string, opts: { project?: string; cwd?: string; limit?: number } = {}): VercelDeployStatus[] {
  if (!vercelAvailable()) return [];
  const args = ['ls', '--meta', `githubCommitRef=${branch}`, '--limit', String(opts.limit ?? 10)];
  if (opts.project) { args.push('--scope', opts.project); }
  // `vercel ls` doesn't have great --json support across versions; fall back to text parse.
  const r = spawnSync('vercel', args, { encoding: 'utf8', timeout: 15_000, cwd: opts.cwd });
  if (r.status !== 0) return [];
  // Minimal text parser — vercel ls output has columns separated by whitespace.
  const lines = (r.stdout ?? '').split('\n').filter((l) => l.includes('http'));
  const out: VercelDeployStatus[] = [];
  for (const line of lines) {
    const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    let state = 'unknown';
    if (line.includes('● Ready')) state = 'READY';
    else if (line.includes('● Building')) state = 'BUILDING';
    else if (line.includes('● Error')) state = 'ERROR';
    else if (line.includes('● Queued')) state = 'QUEUED';
    else if (line.includes('● Canceled')) state = 'CANCELED';
    out.push({ url, state });
  }
  return out;
}

export function getVercelDeployErrorTail(url: string, opts: { project?: string; cwd?: string } = {}): string {
  if (!vercelAvailable()) return '';
  const args = ['inspect', url, '--logs'];
  if (opts.project) { args.push('--scope', opts.project); }
  const r = spawnSync('vercel', args, { encoding: 'utf8', timeout: 30_000, cwd: opts.cwd });
  if (r.status !== 0) return '';
  return (r.stdout ?? '').slice(-4000);
}

// ─── Aggregate + summarize ─────────────────────────────────────────────────

function aggregateCi(checks: PrCheckStatus[]): PrStatus['ci_overall'] {
  if (checks.length === 0) return 'unknown';
  if (checks.some((c) => c.bucket === 'pending' || c.bucket === 'unknown')) return 'pending';
  if (checks.some((c) => c.bucket === 'fail' || c.bucket === 'failure' || c.bucket === 'cancel')) return 'failing';
  return 'passing';
}

function aggregateVercel(deploys: VercelDeployStatus[]): PrStatus['vercel_overall'] {
  if (deploys.length === 0) return 'none';
  // Use the most recent (first in vercel ls output)
  const latest = deploys[0];
  if (latest.state === 'READY') return 'ready';
  if (latest.state === 'ERROR') return 'error';
  if (latest.state === 'BUILDING' || latest.state === 'QUEUED' || latest.state === 'INITIALIZING') return 'pending';
  return 'unknown';
}

function summarize(s: PrStatus): string {
  const lines: string[] = [];
  lines.push(`PR #${s.pr_number} (${s.branch}) — CI: ${s.ci_overall}, Vercel: ${s.vercel_overall}`);
  if (s.ci_checks.length > 0) {
    const failing = s.ci_checks.filter((c) => c.bucket === 'fail' || c.bucket === 'failure');
    const pending = s.ci_checks.filter((c) => c.bucket === 'pending');
    if (failing.length > 0) lines.push(`  ❌ ${failing.length} CI failing: ${failing.map((c) => c.name).join(', ')}`);
    if (pending.length > 0) lines.push(`  ⏳ ${pending.length} CI pending: ${pending.map((c) => c.name).join(', ')}`);
  }
  if (s.vercel_deploys.length > 0) {
    const errors = s.vercel_deploys.filter((d) => d.state === 'ERROR');
    if (errors.length > 0) lines.push(`  ❌ ${errors.length} Vercel ERROR: ${errors.map((e) => e.url).join(', ')}`);
  }
  if (s.ready_to_promote) lines.push(`  ✅ Ready to promote.`);
  return lines.join('\n');
}

export interface MonitorOpts {
  repo?: string;
  vercel_project?: string;
  vercel_cwd?: string;
  /** When true and a vercel deploy is ERROR, fetch its build log tail (slower). */
  fetch_error_logs?: boolean;
  /** Optional path to write evidence (logs, tails) for downstream worker rounds. */
  evidence_dir?: string;
}

export function checkPrStatus(prNumber: number, opts: MonitorOpts = {}): PrStatus | null {
  const info = getPrInfo(prNumber, { repo: opts.repo });
  if (!info) return null;
  const ci = getPrChecks(prNumber, { repo: opts.repo });
  const deploys = getVercelDeploysForBranch(info.branch, {
    project: opts.vercel_project,
    cwd: opts.vercel_cwd,
  });

  // Optionally fetch error logs for failed deploys
  if (opts.fetch_error_logs) {
    for (const d of deploys) {
      if (d.state === 'ERROR') {
        d.error_tail = getVercelDeployErrorTail(d.url, { project: opts.vercel_project, cwd: opts.vercel_cwd });
      }
    }
  }

  const ci_overall = aggregateCi(ci);
  const vercel_overall = aggregateVercel(deploys);
  const ready_to_promote =
    ci_overall === 'passing' &&
    (vercel_overall === 'ready' || vercel_overall === 'none');

  const status: PrStatus = {
    pr_number: prNumber,
    pr_url: info.url,
    branch: info.branch,
    head_sha: info.head_sha,
    ci_overall,
    ci_checks: ci,
    vercel_overall,
    vercel_deploys: deploys,
    ready_to_promote,
    summary: '',
  };
  status.summary = summarize(status);

  // Write evidence on failure for downstream worker context
  if (opts.evidence_dir && (ci_overall === 'failing' || vercel_overall === 'error')) {
    try {
      if (!fs.existsSync(opts.evidence_dir)) fs.mkdirSync(opts.evidence_dir, { recursive: true });
      fs.writeFileSync(
        path.join(opts.evidence_dir, `pr-${prNumber}-failure.json`),
        JSON.stringify(status, null, 2),
      );
    } catch { /* best-effort */ }
  }

  return status;
}
