/**
 * Worker Memory Primer (L5 / MEM-5).
 *
 * Closes the "workers start cold every dispatch" gap from
 * AGENT-ROSTER-AUDIT.md §Section 5b + §Section 8 L5.
 *
 * Per Codex SOTA-bar correction: long-term memory must be RATIFIED, not
 * auto-appended from rejected diffs — auto-appending would fossilize
 * reviewer mistakes. So this module READS from operator-curated docs in
 * .agent-runs/_long-term/ and assembles a primer block that gets prepended
 * to every worker prompt.
 *
 * Storage layout:
 *   .agent-runs/_long-term/
 *     conventions.md            — global ratified conventions (e.g. "events emit ID-only payloads")
 *     anti-patterns.md          — global ratified anti-patterns (e.g. "never use `git diff` alone — staged + untracked needed")
 *     module-cards/MNN.md       — per-module quick-reference (e.g. M02 invariants, primitives, gotchas)
 *
 * Plus DERIVED context (computed each call, not from operator-curated files):
 *   - Recent merges in this module's git path (last 5 commits)
 *   - Recent rejected diffs for this module (last 2 NO-GO Codex rounds)
 *   - Operator's user/feedback/project memory from MEMORY.md
 *
 * Phase 1 (this commit): builds the primer assembler + storage convention.
 * Phase 2: integrates into auto:work buildWorkerPrompt() + adds
 * `auto:memory ratify` CLI for operator to add to conventions/anti-patterns.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { listTasks, readTaskPack } from './runState';

// ─── Long-term storage paths ────────────────────────────────────────────────

export function longTermDir(harnessRoot: string): string {
  return path.join(harnessRoot, '.agent-runs', '_long-term');
}

export function conventionsPath(harnessRoot: string): string {
  return path.join(longTermDir(harnessRoot), 'conventions.md');
}

export function antiPatternsPath(harnessRoot: string): string {
  return path.join(longTermDir(harnessRoot), 'anti-patterns.md');
}

export function moduleCardPath(harnessRoot: string, module: string): string {
  // Normalize module to MNN form
  const m = module.match(/^M\d+/i);
  const mod = m ? m[0].toUpperCase() : module;
  return path.join(longTermDir(harnessRoot), 'module-cards', `${mod}.md`);
}

export function operatorMemoryPath(): string {
  // ~/.claude/projects/<proj>/memory/MEMORY.md
  // Use a stable resolver based on cwd basename
  const projDir = process.cwd().replace(/\//g, '-').replace(/^-/, '');
  return path.join(process.env.HOME ?? '', '.claude', 'projects', projDir, 'memory', 'MEMORY.md');
}

// ─── Primer assembly ────────────────────────────────────────────────────────

export interface MemoryPrimer {
  module?: string;
  conventions: string[];
  anti_patterns: string[];
  module_card?: string;
  recent_merges: Array<{ sha: string; subject: string; date: string }>;
  recent_nogo: Array<{ task_id: string; round: number; reason?: string }>;
  operator_memory_excerpt?: string;
  /** True if the long-term dir is fully unpopulated (operator hasn't curated yet). */
  empty_long_term: boolean;
}

const HEADING_RE = /^##?\s+(.+)$/gm;

/**
 * Read a markdown file's H2-section body lines, returning each as a separate
 * primer entry. Empty file → empty array.
 */
function readMdBullets(p: string, maxItems = 10): string[] {
  if (!fs.existsSync(p)) return [];
  try {
    const body = fs.readFileSync(p, 'utf8');
    // Take all lines that start with `- ` (markdown bullet); each becomes one entry.
    const items = body.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
    return items.slice(0, maxItems);
  } catch {
    return [];
  }
}

/**
 * Compute recent merges via git log on paths matching the module.
 * E.g., for "M02" we look at platform/pipeline/, packages/shared-types/, apps/web/src/lib/db/ etc.
 * For now, use a generic git log (no path filter) and let operator filter later.
 */
function computeRecentMerges(repoRoot: string, count = 5): Array<{ sha: string; subject: string; date: string }> {
  try {
    const r = spawnSync('git', ['log', '--oneline', '--no-merges', '-n', String(count), '--format=%h\t%s\t%ad', '--date=short'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (r.status !== 0) return [];
    return r.stdout
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => {
        const [sha, subject, date] = l.split('\t');
        return { sha, subject: subject ?? '', date: date ?? '' };
      });
  } catch {
    return [];
  }
}

/**
 * Compute recent NO-GO transitions for this module from task pack state_history.
 * Filters by module match (e.g., "M02-impl-1" matches "M02").
 */
function computeRecentNogo(
  module: string | undefined,
  runsDir: string,
  count = 2
): Array<{ task_id: string; round: number; reason?: string }> {
  if (!fs.existsSync(runsDir) || !module) return [];
  const moduleNorm = (module.match(/^M\d+/i) ?? [module])[0].toUpperCase();
  const result: Array<{ task_id: string; round: number; reason?: string; at: string }> = [];

  for (const runId of fs.readdirSync(runsDir)) {
    const runPath = path.join(runsDir, runId);
    try {
      if (!fs.statSync(runPath).isDirectory() || runId.startsWith('_')) continue;
    } catch {
      continue;
    }
    for (const taskId of listTasks(runId)) {
      try {
        const pack = readTaskPack(runId, taskId);
        const taskMod = (pack.module_or_sprint.match(/^M\d+/i) ?? [pack.module_or_sprint])[0].toUpperCase();
        if (taskMod !== moduleNorm) continue;
        // Find NO-GO transitions in history
        const history = pack.state_history ?? [];
        for (let i = 0; i < history.length; i++) {
          const h = history[i];
          if (h.to === 'needs-revision') {
            // Round number = count of in-progress transitions before this one
            const round = history.slice(0, i).filter((x) => x.to === 'in-progress').length;
            result.push({
              task_id: taskId,
              round,
              reason: h.reason,
              at: h.at,
            });
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  // Sort by `at` descending, take last `count`
  result.sort((a, b) => b.at.localeCompare(a.at));
  return result.slice(0, count).map(({ task_id, round, reason }) => ({ task_id, round, reason }));
}

/**
 * Read operator's MEMORY.md and extract the most relevant excerpt for
 * worker context. v0.1: just take the first 800 chars (truncated). v0.2
 * could grep by module relevance.
 */
function readOperatorMemoryExcerpt(maxChars = 800): string | undefined {
  const p = operatorMemoryPath();
  if (!fs.existsSync(p)) return undefined;
  try {
    return fs.readFileSync(p, 'utf8').slice(0, maxChars);
  } catch {
    return undefined;
  }
}

/**
 * Assemble a memory primer for a worker dispatch. Pure function — does no I/O
 * other than reading from durable storage.
 */
export function assembleMemoryPrimer(
  harnessRoot: string,
  repoRoot: string,
  module?: string
): MemoryPrimer {
  const conventions = readMdBullets(conventionsPath(harnessRoot));
  const anti_patterns = readMdBullets(antiPatternsPath(harnessRoot));
  const module_card = module && fs.existsSync(moduleCardPath(harnessRoot, module))
    ? fs.readFileSync(moduleCardPath(harnessRoot, module), 'utf8').slice(0, 2000)
    : undefined;
  const recent_merges = computeRecentMerges(repoRoot);
  const recent_nogo = computeRecentNogo(module, path.join(harnessRoot, '.agent-runs'));
  const operator_memory_excerpt = readOperatorMemoryExcerpt();
  const empty_long_term = conventions.length === 0 && anti_patterns.length === 0 && !module_card;

  return {
    module,
    conventions,
    anti_patterns,
    module_card,
    recent_merges,
    recent_nogo,
    operator_memory_excerpt,
    empty_long_term,
  };
}

/**
 * Render a memory primer as the MEMORY PRIMER block for a worker prompt.
 */
export function formatPrimerForPrompt(primer: MemoryPrimer): string {
  const sections: string[] = [];
  sections.push('MEMORY PRIMER (read before doing any work)');
  sections.push('============================================');

  if (primer.empty_long_term) {
    sections.push('');
    sections.push('NOTE: Long-term memory store is unpopulated. The operator has not yet ratified conventions');
    sections.push('or anti-patterns into .agent-runs/_long-term/. Treat this primer as informational only;');
    sections.push('do not assume the absence of an entry means a behavior is allowed.');
  }

  if (primer.module) {
    sections.push('');
    sections.push(`Working on module: ${primer.module}`);
  }

  if (primer.recent_merges.length > 0) {
    sections.push('');
    sections.push('RECENT MERGES (across the repo, last 5; consult before re-implementing primitives):');
    for (const m of primer.recent_merges) {
      sections.push(`  - ${m.sha} ${m.date} ${m.subject.slice(0, 80)}`);
    }
  }

  if (primer.recent_nogo.length > 0) {
    sections.push('');
    sections.push(`RECENT REJECTED DIFFS (this module, last ${primer.recent_nogo.length}; do NOT repeat):`);
    for (const n of primer.recent_nogo) {
      sections.push(`  - ${n.task_id} round ${n.round}: ${(n.reason ?? '').slice(0, 200)}`);
    }
  }

  if (primer.conventions.length > 0) {
    sections.push('');
    sections.push('RATIFIED CONVENTIONS (operator-curated; follow these):');
    for (const c of primer.conventions) sections.push(`  - ${c}`);
  }

  if (primer.anti_patterns.length > 0) {
    sections.push('');
    sections.push('ANTI-PATTERNS (operator-ratified; do NOT produce):');
    for (const a of primer.anti_patterns) sections.push(`  - ${a}`);
  }

  if (primer.module_card) {
    sections.push('');
    sections.push(`MODULE CARD for ${primer.module}:`);
    sections.push(primer.module_card.split('\n').map((l) => '  ' + l).join('\n'));
  }

  if (primer.operator_memory_excerpt) {
    sections.push('');
    sections.push('OPERATOR PREFERENCES (from MEMORY.md):');
    sections.push(primer.operator_memory_excerpt.split('\n').map((l) => '  ' + l).join('\n'));
  }

  sections.push('');
  sections.push('============================================');
  sections.push('END MEMORY PRIMER. Begin task work below.');
  return sections.join('\n');
}
