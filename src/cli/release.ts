#!/usr/bin/env node
/**
 * pnpm auto:release — semver bump + git tag + GitHub release + CHANGELOG.
 *
 * Closes the SDLC "Release" phase. Standalone-product hygiene: every public
 * version should be a tagged commit + a GitHub release + a CHANGELOG entry.
 *
 * Usage:
 *   pnpm auto:release patch [--dry-run]    # 0.4.18-A → 0.4.19
 *   pnpm auto:release minor                 # 0.4.19 → 0.5.0
 *   pnpm auto:release major                 # 0.5.0 → 1.0.0
 *   pnpm auto:release <version>             # explicit, e.g., 0.4.18-A
 *
 * Pipeline:
 *   1. Compute next version (or use explicit)
 *   2. Update package.json version
 *   3. Generate CHANGELOG.md entry from commits since last tag
 *      (operator can edit before --apply)
 *   4. Commit "chore(release): vX.Y.Z"
 *   5. Tag vX.Y.Z
 *   6. Push commit + tag
 *   7. Create GitHub release via `gh release create` (if available)
 *
 * Idempotent: re-running with same version is a no-op past step 2.
 * Dry-run by default; --apply makes the actual changes.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const HARNESS_ROOT = harnessRoot();

interface Args {
  bump: 'patch' | 'minor' | 'major' | string;  // string = explicit version
  apply: boolean;
  json: boolean;
  no_github: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { bump: 'patch', apply: false, json: false, no_github: false };
  for (const arg of argv) {
    if (arg === '--apply') a.apply = true;
    else if (arg === '--json') a.json = true;
    else if (arg === '--no-github') a.no_github = true;
    else if (arg === '--dry-run') a.apply = false;
    else if (!arg.startsWith('--')) a.bump = arg;
  }
  return a;
}

function readPackage(): { name: string; version: string; raw: string } {
  const p = path.join(PACKAGE_ROOT, 'package.json');
  const raw = fs.readFileSync(p, 'utf8');
  const pkg = JSON.parse(raw);
  return { name: pkg.name, version: pkg.version, raw };
}

function bumpSemver(current: string, bump: Args['bump']): string {
  if (bump !== 'patch' && bump !== 'minor' && bump !== 'major') return bump;  // explicit
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)(.*)?$/);
  if (!m) throw new Error(`current version '${current}' not semver`);
  let [, maj, min, pat] = m;
  switch (bump) {
    case 'patch': pat = String(parseInt(pat, 10) + 1); break;
    case 'minor': min = String(parseInt(min, 10) + 1); pat = '0'; break;
    case 'major': maj = String(parseInt(maj, 10) + 1); min = '0'; pat = '0'; break;
  }
  return `${maj}.${min}.${pat}`;
}

function run(cmd: string, args: string[], opts: { cwd?: string; allowFailure?: boolean } = {}): { ok: boolean; stdout: string; stderr: string; status: number | null } {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? HARNESS_ROOT, encoding: 'utf8', timeout: 30_000 });
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

function lastTag(): string | null {
  const r = run('git', ['describe', '--tags', '--abbrev=0']);
  return r.ok ? r.stdout.trim() : null;
}

function commitsSinceTag(tag: string | null): string[] {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const r = run('git', ['log', '--pretty=format:%h %s', range]);
  return r.ok ? r.stdout.trim().split('\n').filter((l) => l.trim()) : [];
}

function changelogStub(version: string, commits: string[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [`## [${version}] – ${date}`, '', '### Changed', ''];
  for (const c of commits) lines.push(`- ${c}`);
  lines.push('');
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { name, version: currentVersion } = readPackage();
  const nextVersion = bumpSemver(currentVersion, args.bump);
  const tag = `v${nextVersion}`;

  if (currentVersion === nextVersion && !args.apply) {
    console.log(`[release] current=${currentVersion} next=${nextVersion} (same; nothing to do)`);
    return;
  }

  const last = lastTag();
  const commits = commitsSinceTag(last);

  if (args.json) {
    console.log(JSON.stringify({
      package: name, current: currentVersion, next: nextVersion, tag,
      apply: args.apply, last_tag: last, commits_count: commits.length, sample_commits: commits.slice(0, 5),
    }, null, 2));
    return;
  }

  console.log(`[release] ${name} ${currentVersion} → ${nextVersion} (tag=${tag}) apply=${args.apply}`);
  console.log(`  last tag: ${last ?? '(none)'}`);
  console.log(`  commits since: ${commits.length}`);
  if (commits.length > 0) console.log(`  sample:\n    ${commits.slice(0, 5).join('\n    ')}`);

  if (!args.apply) {
    console.log(`\n[release] DRY-RUN — re-run with --apply to:`);
    console.log(`  1. Update package.json version → ${nextVersion}`);
    console.log(`  2. Append CHANGELOG.md entry`);
    console.log(`  3. git commit -am "chore(release): ${tag}"`);
    console.log(`  4. git tag ${tag}`);
    console.log(`  5. git push && git push --tags`);
    console.log(`  6. gh release create ${tag} ${args.no_github ? '(SKIPPED --no-github)' : ''}`);
    return;
  }

  // 1. Update package.json
  const pkgPath = path.join(PACKAGE_ROOT, 'package.json');
  const pkgRaw = fs.readFileSync(pkgPath, 'utf8');
  const pkg = JSON.parse(pkgRaw);
  pkg.version = nextVersion;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`✓ updated package.json: ${currentVersion} → ${nextVersion}`);

  // 2. CHANGELOG entry (insert after the first heading)
  const clPath = path.join(HARNESS_ROOT, 'CHANGELOG.md');
  if (fs.existsSync(clPath)) {
    const existing = fs.readFileSync(clPath, 'utf8');
    const stub = changelogStub(nextVersion, commits);
    // Insert after the `# Changelog` heading + intro paragraph (before first `## [`)
    const m = existing.match(/^(.*?)(##\s*\[[^\]]+\][\s\S]*)$/s);
    if (m) {
      const updated = m[1] + stub + m[2];
      fs.writeFileSync(clPath, updated);
      console.log(`✓ appended CHANGELOG.md entry for ${tag}`);
    } else {
      fs.appendFileSync(clPath, '\n\n' + stub);
      console.log(`✓ appended CHANGELOG.md entry (no prior anchor; appended at end)`);
    }
  } else {
    console.log(`(no CHANGELOG.md; skipping)`);
  }

  // 3. Commit + tag
  const commit = run('git', ['commit', '-am', `chore(release): ${tag}`]);
  if (!commit.ok) {
    console.error(`✗ git commit failed: ${commit.stderr || commit.stdout}`);
    process.exit(2);
  }
  console.log(`✓ committed`);
  const tagRes = run('git', ['tag', '-a', tag, '-m', `Release ${tag}`]);
  if (!tagRes.ok) {
    console.error(`✗ git tag failed: ${tagRes.stderr || tagRes.stdout}`);
    process.exit(2);
  }
  console.log(`✓ tagged ${tag}`);

  // 4. Push
  const push = run('git', ['push']);
  if (!push.ok) console.warn(`⚠ git push failed: ${push.stderr}`);
  else console.log(`✓ pushed commit`);
  const pushTags = run('git', ['push', '--tags']);
  if (!pushTags.ok) console.warn(`⚠ git push --tags failed: ${pushTags.stderr}`);
  else console.log(`✓ pushed tags`);

  // 5. GitHub release
  if (!args.no_github) {
    const ghCheck = run('gh', ['--version']);
    if (!ghCheck.ok) {
      console.warn(`⚠ gh not installed; skipping GitHub release. Install gh + re-run, or pass --no-github to silence.`);
    } else {
      const ghRel = run('gh', ['release', 'create', tag, '--title', tag, '--notes', `See CHANGELOG.md for ${tag}.`]);
      if (!ghRel.ok) console.warn(`⚠ gh release create failed: ${ghRel.stderr}`);
      else console.log(`✓ GitHub release created`);
    }
  } else {
    console.log(`(SKIPPED GitHub release per --no-github)`);
  }

  console.log(`\n[release] ${tag} complete.`);
}

try { main(); }
catch (e) {
  console.error(`[release] error: ${(e as Error).message}`);
  process.exit(1);
}
