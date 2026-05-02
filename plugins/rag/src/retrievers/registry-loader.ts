/**
 * registry-loader.ts — turn refs/frameworks.json into actual queryable
 * retrievers. Each entry in the JSON whose `tier` is 2 or 3 (and isn't
 * shadowed by a hand-curated retriever in retrievers/<id>.ts) becomes a
 * Retriever at startup.
 *
 * Tier-1 entries are skipped here because they're handled by their own
 * dedicated TS files (which have richer, multi-paragraph patterns). The
 * JSON's tier-1 entries function as documentation in the registry.
 *
 * This is what makes the 100-framework claim real, not aspirational.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Retriever } from '../index';

interface FrameworkEntry {
  id: string;
  language: string;
  category: string;
  match: string;
  tier: 1 | 2 | 3;
  release?: string;
  note?: string;
}

interface FrameworksFile {
  version: string;
  frameworks: FrameworkEntry[];
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_PATH = path.resolve(__dirname, '..', '..', 'refs', 'frameworks.json');

// Tier-1 IDs are loaded from dedicated TS files. The registry skips these
// to avoid double-registration.
const TIER_1_IDS = new Set([
  'react', 'nextjs', 'django', 'fastapi', 'express-fastify',
  'tailwind', 'postgres', 'typescript',
]);

let _cachedRegistry: FrameworksFile | null = null;

export function loadRegistry(): FrameworksFile {
  if (_cachedRegistry) return _cachedRegistry;
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { version: '0.0.0', frameworks: [] };
  }
  _cachedRegistry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as FrameworksFile;
  return _cachedRegistry;
}

/**
 * Build a Retriever from a JSON registry entry. Pattern matching uses the
 * `match` regex against allowed_paths + objective + reference paths. Enrich
 * returns the `note` field formatted with release tag if present.
 */
function entryToRetriever(entry: FrameworkEntry): Retriever {
  const re = new RegExp(entry.match, 'i');
  const releaseSuffix = entry.release ? `@${entry.release}` : '';
  return {
    name: `${entry.id}${releaseSuffix}`,
    matches(pack) {
      const hints = [
        ...(pack.allowed_paths || []),
        ...(pack.references?.code_paths || []),
        pack.objective || '',
      ].join(' ');
      return re.test(hints);
    },
    async enrich(_pack) {
      if (!entry.note) return null;
      // Tier-2 entries get a richer presentation than tier-3 stubs
      const header = entry.tier === 2 ? `**${entry.id}${releaseSuffix} (${entry.category}):**` : `**${entry.id}${releaseSuffix}:**`;
      return `${header}\n\n${entry.note}`;
    },
  };
}

/**
 * Register all tier-2 + tier-3 entries from the JSON registry. Caller passes
 * in the registerRetriever function (avoids circular import).
 */
export function registerAllFromRegistry(register: (r: Retriever) => void): { registered: number; skipped: number } {
  const reg = loadRegistry();
  let registered = 0;
  let skipped = 0;
  for (const entry of reg.frameworks) {
    if (TIER_1_IDS.has(entry.id)) { skipped++; continue; }
    register(entryToRetriever(entry));
    registered++;
  }
  return { registered, skipped };
}

/** For diagnostics / `auto:rag-list`. */
export function summarizeRegistry(): { total: number; tier1: number; tier2: number; tier3: number; byCategory: Record<string, number>; byLanguage: Record<string, number> } {
  const reg = loadRegistry();
  const summary = { total: reg.frameworks.length, tier1: 0, tier2: 0, tier3: 0, byCategory: {} as Record<string, number>, byLanguage: {} as Record<string, number> };
  for (const e of reg.frameworks) {
    if (e.tier === 1) summary.tier1++;
    else if (e.tier === 2) summary.tier2++;
    else summary.tier3++;
    summary.byCategory[e.category] = (summary.byCategory[e.category] || 0) + 1;
    summary.byLanguage[e.language] = (summary.byLanguage[e.language] || 0) + 1;
  }
  return summary;
}
