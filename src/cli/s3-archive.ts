#!/usr/bin/env node
/**
 * pnpm auto:s3-archive [--bucket nbf-harness-audit-dev] [--dry-run]
 *
 * Sprint M v3 (item F): S3 WORM audit upload. Wires the actual `aws s3 cp`
 * for the env vars that already exist (AUTO_S3_WORM_BUCKET, AUTO_S3_WORM_REGION,
 * AUTO_KMS_KEY_ALIAS). Uploads:
 *   - .agent-runs/<run>/evidence/<task>/  (per-task evidence + diffs)
 *   - .agent-runs/_audit/council/         (council sidecars)
 *   - .agent-runs/_override-audit.jsonl   (governance overrides)
 *   - .agent-runs/_parked-modules.jsonl   (parked queue)
 *   - .agent-runs/_skill-memory/          (skill memory producer log)
 *
 * To S3 path: s3://<bucket>/harness-archive/<host>/<date>/<file>
 * Server-side encryption: aws:kms with AUTO_KMS_KEY_ALIAS.
 *
 * Idempotent: tracks last-uploaded timestamp in .agent-runs/_s3-archive.lock.
 * Skipped files unchanged since last run.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs { bucket: string; region: string; kmsKey: string; dryRun: boolean; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    bucket: process.env.AUTO_S3_WORM_BUCKET || '',
    region: process.env.AUTO_S3_WORM_REGION || 'us-east-1',
    kmsKey: process.env.AUTO_KMS_KEY_ALIAS || '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--bucket' && i + 1 < argv.length) a.bucket = argv[++i];
    else if (argv[i] === '--region' && i + 1 < argv.length) a.region = argv[++i];
    else if (argv[i] === '--kms-key' && i + 1 < argv.length) a.kmsKey = argv[++i];
    else if (argv[i] === '--dry-run') a.dryRun = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:s3-archive [--bucket BUCKET] [--region us-east-1] [--kms-key alias/...] [--dry-run]

Upload harness audit artifacts to S3 with KMS encryption (WORM compliance).

  --bucket    S3 bucket (default: $AUTO_S3_WORM_BUCKET)
  --region    AWS region (default: $AUTO_S3_WORM_REGION or us-east-1)
  --kms-key   KMS key alias (default: $AUTO_KMS_KEY_ALIAS)
  --dry-run   List what would be uploaded; don't upload
`);
      process.exit(0);
    }
  }
  return a;
}

function run(cmd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bucket) {
    console.error('Bucket required (--bucket or AUTO_S3_WORM_BUCKET)');
    process.exit(1);
  }

  // Verify aws CLI
  const verify = run('aws', ['--version']);
  if (!verify.ok) {
    console.error(`aws CLI not available: ${verify.stderr.slice(0, 200)}`);
    process.exit(2);
  }

  const root = harnessRoot();
  const lockPath = path.join(root, '.agent-runs', '_s3-archive.lock');
  let lastRun = 0;
  if (fs.existsSync(lockPath)) {
    try { lastRun = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10) || 0; } catch { /* skip */ }
  }
  const host = os.hostname();
  const dateKey = new Date().toISOString().slice(0, 10);

  const targets: Array<{ src: string; rel: string }> = [];

  // Walk evidence dirs (recent runs only)
  const runsDir = path.join(root, '.agent-runs');
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_')) continue;  // skip _audit, _skill-memory, etc handled separately
    const evDir = path.join(runsDir, entry.name, 'evidence');
    if (!fs.existsSync(evDir)) continue;
    for (const taskDir of fs.readdirSync(evDir)) {
      const taskPath = path.join(evDir, taskDir);
      if (!fs.statSync(taskPath).isDirectory()) continue;
      const walk = (p: string, prefix: string) => {
        for (const e of fs.readdirSync(p, { withFileTypes: true })) {
          const fp = path.join(p, e.name);
          if (e.isDirectory()) walk(fp, `${prefix}/${e.name}`);
          else {
            const stat = fs.statSync(fp);
            if (stat.mtimeMs > lastRun) targets.push({ src: fp, rel: `runs/${entry.name}/evidence/${taskDir}${prefix.length ? prefix : ''}/${e.name}` });
          }
        }
      };
      walk(taskPath, '');
    }
  }

  // Audit/sidecars
  const auditDir = path.join(runsDir, '_audit');
  if (fs.existsSync(auditDir)) {
    const walk = (p: string, prefix: string) => {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const fp = path.join(p, e.name);
        if (e.isDirectory()) walk(fp, `${prefix}/${e.name}`);
        else {
          const stat = fs.statSync(fp);
          if (stat.mtimeMs > lastRun) targets.push({ src: fp, rel: `audit${prefix.length ? prefix : ''}/${e.name}` });
        }
      }
    };
    walk(auditDir, '');
  }

  // Override audit, parked queue, skill memory (single jsonl files)
  const singletonFiles = [
    '_override-audit.jsonl',
    '_parked-modules.jsonl',
    '_council-watchdog.jsonl',
    '_ci-fix.jsonl',
  ];
  for (const f of singletonFiles) {
    const p = path.join(runsDir, f);
    if (fs.existsSync(p) && fs.statSync(p).mtimeMs > lastRun) {
      targets.push({ src: p, rel: `state/${f}` });
    }
  }
  const skillDir = path.join(runsDir, '_skill-memory');
  if (fs.existsSync(skillDir)) {
    for (const f of fs.readdirSync(skillDir)) {
      const fp = path.join(skillDir, f);
      if (fs.statSync(fp).isFile() && fs.statSync(fp).mtimeMs > lastRun) {
        targets.push({ src: fp, rel: `skill-memory/${f}` });
      }
    }
  }

  console.log(`[s3-archive] ${targets.length} files to upload to s3://${args.bucket}/harness-archive/${host}/${dateKey}/`);
  if (args.dryRun) {
    targets.slice(0, 20).forEach(t => console.log(`  ${t.src} → ${t.rel}`));
    if (targets.length > 20) console.log(`  …and ${targets.length - 20} more`);
    return;
  }

  // Upload in batches
  let uploaded = 0;
  let failed = 0;
  for (const t of targets) {
    const dest = `s3://${args.bucket}/harness-archive/${host}/${dateKey}/${t.rel}`;
    const upArgs = ['s3', 'cp', t.src, dest, '--region', args.region];
    if (args.kmsKey) {
      upArgs.push('--sse', 'aws:kms', '--sse-kms-key-id', args.kmsKey);
    } else {
      upArgs.push('--sse', 'AES256');
    }
    const r = run('aws', upArgs);
    if (r.ok) uploaded++;
    else {
      failed++;
      if (failed <= 3) console.error(`  upload failed: ${t.src} — ${r.stderr.slice(0, 200)}`);
    }
  }

  console.log(`[s3-archive] uploaded=${uploaded} failed=${failed}`);
  if (uploaded > 0) {
    fs.writeFileSync(lockPath, String(Date.now()));
  }
}

main().catch((e) => { console.error(`[s3-archive] fatal: ${(e as Error).message}`); process.exit(99); });
