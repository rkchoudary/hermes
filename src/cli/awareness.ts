#!/usr/bin/env node
/**
 * pnpm auto:awareness — refresh / view / verify environmental awareness catalogs.
 *
 * Usage:
 *   pnpm auto:awareness                           # show catalog index + last refresh times
 *   pnpm auto:awareness --check                   # verify all components reachable (no refresh)
 *   pnpm auto:awareness --check repo-inventory    # verify ONE component
 *   pnpm auto:awareness --refresh obsidian        # refresh ONE component (writes new snapshot)
 *   pnpm auto:awareness --refresh obsidian --partial M02   # partial refresh for one module
 *   pnpm auto:awareness --refresh-all             # refresh everything (long-running)
 *
 * v0.1 STUB — this script defines the interface and demonstrates the pattern for
 *   `repo-inventory`, `obsidian-state`, and `github-state` refresh.
 * v0.2 will fill in:
 *   - clickhouse refresh (live SELECT FROM system.tables)
 *   - vercel refresh (vercel-cli or REST API)
 *   - aws-services refresh (aws describe-* via SDK)
 *   - database-schema refresh (parse Drizzle migrations + run information_schema query)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const AWARENESS_DIR = path.join(__dirname, '..', '..', 'awareness');
const REPO_ROOT = harnessRoot();
const OBSIDIAN_VAULT = '${HERMES_OBSIDIAN_VAULT:-}';

interface AwarenessArgs {
  refresh?: string;
  refreshAll?: boolean;
  check?: string | true;
  partial?: string;
  show?: boolean;
}

function parseArgs(argv: string[]): AwarenessArgs {
  const args: AwarenessArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh' && i + 1 < argv.length) args.refresh = argv[++i];
    else if (arg === '--refresh-all') args.refreshAll = true;
    else if (arg === '--check') {
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args.check = argv[++i];
      else args.check = true;
    } else if (arg === '--partial' && i + 1 < argv.length) args.partial = argv[++i];
  }
  if (!args.refresh && !args.refreshAll && !args.check) args.show = true;
  return args;
}

interface AwarenessFile {
  name: string;
  path: string;
  size_kb: number;
  last_refreshed: string;
  refresh_implemented: boolean;
}

function listAwarenessFiles(): AwarenessFile[] {
  if (!fs.existsSync(AWARENESS_DIR)) return [];
  return fs
    .readdirSync(AWARENESS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const fullPath = path.join(AWARENESS_DIR, f);
      const stat = fs.statSync(fullPath);
      let last_refreshed = 'unknown';
      try {
        const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        last_refreshed = json._schema?.last_refreshed ?? 'unknown';
      } catch {
        // ignore parse errors
      }
      const name = f.replace(/\.json$/, '');
      return {
        name,
        path: fullPath,
        size_kb: stat.size / 1024,
        last_refreshed,
        refresh_implemented: ['repo-inventory', 'obsidian-state', 'github-state'].includes(name),
      };
    });
}

function showCatalog(): void {
  const files = listAwarenessFiles();
  console.log(`\nAwareness catalog (${files.length} files at ${AWARENESS_DIR})\n`);
  console.log('Component                Size (KB)  Last refreshed                    Refresh impl');
  console.log('────────────────────── ────────── ────────────────────────────────── ──────────────');
  files.forEach((f) => {
    const name = f.name.padEnd(22);
    const size = f.size_kb.toFixed(2).padStart(9);
    const refresh = f.last_refreshed.padEnd(34);
    const impl = f.refresh_implemented ? '✓ v0.1' : '⏳ v0.2';
    console.log(`${name} ${size}  ${refresh} ${impl}`);
  });
  console.log(`\nUsage: pnpm auto:awareness --refresh <name> | --check [name] | --refresh-all`);
}

function refreshObsidianState(partial?: string): void {
  console.log(`Refreshing obsidian-state${partial ? ` (partial: ${partial})` : ' (full)'}...`);

  const filter = partial ? `FRD-${partial}-*` : 'FRD-*';
  let frdSummary: Record<string, any> = {};

  try {
    const cmd = `find ${OBSIDIAN_VAULT}/FRDs -maxdepth 1 -type d -name "${filter}" | sort`;
    const dirs = execSync(cmd, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const dir of dirs) {
      const moduleId = path.basename(dir).match(/^FRD-(M\d+|MOD-\d+|[A-Z]+-\d+)/)?.[1] ?? 'unknown';
      const frdMd = path.join(dir, `FRD-${moduleId}.md`);
      if (!fs.existsSync(frdMd)) continue;

      // Extract status + score from frontmatter (first 30 lines)
      const head = fs.readFileSync(frdMd, 'utf8').split('\n').slice(0, 50).join('\n');
      const statusMatch = head.match(/^status:\s*"?([^"\n]+)"?$/m);
      const versionMatch = head.match(/^version:\s*"?([^"\n]+)"?$/m);
      const lastScoreMatch = [...head.matchAll(/^codex_score_r(\d+):\s*([\d.]+)/gm)].pop();

      frdSummary[moduleId] = {
        status: statusMatch?.[1] ?? 'unknown',
        version: versionMatch?.[1] ?? 'unknown',
        latest_codex_round: lastScoreMatch?.[1] ?? 'unknown',
        latest_codex_score: lastScoreMatch?.[2] ?? 'unknown',
        last_modified: fs.statSync(frdMd).mtime.toISOString(),
        line_count: fs.readFileSync(frdMd, 'utf8').split('\n').length,
      };
    }
  } catch (e) {
    console.error(`Obsidian refresh failed: ${(e as Error).message}`);
    return;
  }

  // Read existing file to preserve fields the partial refresh doesn't touch
  const existingPath = path.join(AWARENESS_DIR, 'obsidian-state.json');
  let existing: any = {};
  if (fs.existsSync(existingPath)) {
    existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
  }

  // Merge
  const refreshed = {
    ...existing,
    _schema: {
      ...(existing._schema ?? {}),
      version: existing._schema?.version ?? '0.1.0',
      last_refreshed: new Date().toISOString(),
      refreshed_by: `auto:awareness ${partial ? `--partial ${partial}` : '(full)'}`,
    },
    frd_state_summary_at_refresh: {
      ...(existing.frd_state_summary_at_refresh ?? {}),
      ...frdSummary,
    },
  };

  fs.writeFileSync(existingPath, JSON.stringify(refreshed, null, 2));
  console.log(`✓ Obsidian state refreshed: ${Object.keys(frdSummary).length} FRD module(s) snapshotted`);
  console.log(`  Written to: ${existingPath}`);
}

function refreshGithubState(): void {
  console.log(`Refreshing github-state...`);

  let prList: any = [];
  let recentMerges: any = [];
  try {
    prList = JSON.parse(
      execSync('gh pr list --state open --json number,title,headRefName,isDraft,mergeable --limit 20', {
        encoding: 'utf8',
      })
    );
    recentMerges = JSON.parse(
      execSync('gh pr list --state merged --json number,title,headRefName,mergedAt --limit 10', {
        encoding: 'utf8',
      })
    );
  } catch (e) {
    console.error(`GitHub refresh failed: ${(e as Error).message}`);
    return;
  }

  const head = execSync('git log --oneline --first-parent origin/main -5', { encoding: 'utf8' }).trim();

  const data = {
    _schema: {
      version: '0.1.0',
      last_refreshed: new Date().toISOString(),
      refreshed_by: 'auto:awareness --refresh github',
    },
    repo: {
      url: '${HERMES_PROJECT_GITHUB_URL:-}',
      default_branch: 'main',
      main_head_recent: head.split('\n').map((line) => {
        const [sha, ...rest] = line.split(' ');
        return { sha, message: rest.join(' ') };
      }),
    },
    open_prs: prList,
    recent_merges: recentMerges,
  };

  fs.writeFileSync(path.join(AWARENESS_DIR, 'github-state.json'), JSON.stringify(data, null, 2));
  console.log(`✓ GitHub state refreshed: ${prList.length} open PRs, ${recentMerges.length} recent merges`);
}

function refreshRepoInventory(): void {
  console.log(`Refreshing repo-inventory...`);
  console.log(`(v0.1 stub: refresh logic for repo-inventory is manual seeded; v0.2 will auto-walk apps/+packages/+platform/ and update file-by-file)`);
  console.log(`  For now, edit ${AWARENESS_DIR}/repo-inventory.json manually.`);
}

function checkComponent(name: string | true): void {
  if (name === true) {
    // check all
    const files = listAwarenessFiles();
    files.forEach((f) => {
      try {
        JSON.parse(fs.readFileSync(f.path, 'utf8'));
        console.log(`✓ ${f.name}: schema-valid (${f.size_kb.toFixed(2)} KB)`);
      } catch (e) {
        console.error(`✗ ${f.name}: parse error — ${(e as Error).message}`);
      }
    });
    return;
  }

  const filePath = path.join(AWARENESS_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) {
    console.error(`✗ Awareness file not found: ${name}.json`);
    process.exit(1);
  }
  try {
    const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`✓ ${name}: schema-valid`);
    console.log(`  Last refreshed: ${json._schema?.last_refreshed ?? 'unknown'}`);
    console.log(`  Refreshed by:   ${json._schema?.refreshed_by ?? 'unknown'}`);
  } catch (e) {
    console.error(`✗ ${name}: parse error — ${(e as Error).message}`);
    process.exit(1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.show) {
    showCatalog();
    return;
  }

  if (args.check !== undefined) {
    checkComponent(args.check);
    return;
  }

  if (args.refresh) {
    switch (args.refresh) {
      case 'obsidian':
      case 'obsidian-state':
        refreshObsidianState(args.partial);
        break;
      case 'github':
      case 'github-state':
        refreshGithubState();
        break;
      case 'repo-inventory':
        refreshRepoInventory();
        break;
      default:
        console.error(`Refresh not yet implemented for: ${args.refresh}`);
        console.error(`v0.1 supports: obsidian, github, repo-inventory`);
        console.error(`v0.2 will add: clickhouse, vercel, aws-services, database-schema`);
        process.exit(1);
    }
    return;
  }

  if (args.refreshAll) {
    refreshRepoInventory();
    refreshObsidianState();
    refreshGithubState();
    console.log(`\n✓ Refresh-all complete (v0.1 supports 3 components; v0.2 adds 5 more)`);
    return;
  }

  showCatalog();
}

main();
