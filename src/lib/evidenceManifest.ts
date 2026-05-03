/**
 * Layer 9 — Content-addressed evidence durability.
 *
 * Doctrine: evidence is content-addressed at stage completion. Local
 * files are mutable; the manifest is the immutable record.
 *
 * At stage completion, every file in evidence/<task_id>/ gets sha256-d
 * and rolled into a manifest with the harness_version, repo SHA, and
 * stage outcome envelope reference. Janitor (Layer 10) refuses to prune
 * local files until the manifest is confirmed durable in S3.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { harnessRoot } from './harnessRoot';
import { evidenceDir } from './runState';

export interface ManifestFile {
  path: string;        // relative to evidence_dir
  sha256: string;
  bytes: number;
  modified_at: string;
}

export interface EvidenceManifest {
  manifest_version: 1;
  task_id: string;
  run_id: string;
  stage: string;
  emitted_at: string;
  harness_version?: string;
  repo_sha?: string;
  worktree_path?: string;
  files: ManifestFile[];
  manifest_sha256: string;  // hash over the (sorted file list) — self-describing root
}

function sha256File(p: string): string {
  const buf = fs.readFileSync(p);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function getRepoSha(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { cwd: harnessRoot(), encoding: 'utf8', timeout: 1000 }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Build the manifest for a task's evidence dir + write _manifest.json.
 * Skip files that begin with '_' (already harness-managed: _progress.jsonl,
 * _manifest.json) so we don't manifest the manifest.
 */
export function emitEvidenceManifest(opts: {
  task_id: string;
  run_id: string;
  stage: string;
  harness_version?: string;
  worktree_path?: string;
}): EvidenceManifest | null {
  const dir = evidenceDir(opts.run_id, opts.task_id);
  if (!fs.existsSync(dir)) return null;
  const fileNames = fs.readdirSync(dir).filter((f) => !f.startsWith('_'));
  fileNames.sort();
  const files: ManifestFile[] = [];
  for (const name of fileNames) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (!stat.isFile()) continue;
    files.push({
      path: name,
      sha256: sha256File(p),
      bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }
  const manifestRoot = crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
  const manifest: EvidenceManifest = {
    manifest_version: 1,
    task_id: opts.task_id,
    run_id: opts.run_id,
    stage: opts.stage,
    emitted_at: new Date().toISOString(),
    harness_version: opts.harness_version,
    repo_sha: getRepoSha(),
    worktree_path: opts.worktree_path,
    files,
    manifest_sha256: manifestRoot,
  };
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

export function readEvidenceManifest(runId: string, taskId: string): EvidenceManifest | null {
  const p = path.join(evidenceDir(runId, taskId), '_manifest.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as EvidenceManifest; }
  catch { return null; }
}

/**
 * Verify a manifest matches the current state of evidence files.
 * Used by L10 janitor before pruning + by drains to detect tampering.
 */
export function verifyManifest(runId: string, taskId: string): { ok: boolean; mismatches: string[] } {
  const manifest = readEvidenceManifest(runId, taskId);
  if (!manifest) return { ok: false, mismatches: ['no _manifest.json'] };
  const dir = evidenceDir(runId, taskId);
  const mismatches: string[] = [];
  for (const f of manifest.files) {
    const p = path.join(dir, f.path);
    if (!fs.existsSync(p)) {
      mismatches.push(`${f.path}: missing`);
      continue;
    }
    const actualSha = sha256File(p);
    if (actualSha !== f.sha256) {
      mismatches.push(`${f.path}: sha mismatch (manifest=${f.sha256.slice(0, 8)}…, actual=${actualSha.slice(0, 8)}…)`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
