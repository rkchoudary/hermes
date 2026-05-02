/**
 * registry.ts — load doc-sources.json and the indexes for queried frameworks.
 *
 * Indexes are built lazily: the first query against a framework reads
 * its chunks.jsonl and builds the BM25 inverted index in memory. Cached
 * for the process lifetime.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocSource, QueryHit, Chunk } from './types';
import { readChunks, listIndexedFrameworks } from './store';
import { buildIndex, searchBm25, type Bm25Index } from './bm25';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DOC_SOURCES_PATH = path.resolve(__dirname, '..', '..', 'refs', 'doc-sources.json');

let _cachedSources: DocSource[] | null = null;
const _indexCache = new Map<string, Bm25Index>();

export function loadDocSources(): DocSource[] {
  if (_cachedSources) return _cachedSources;
  if (!fs.existsSync(DOC_SOURCES_PATH)) {
    return [];
  }
  const raw = JSON.parse(fs.readFileSync(DOC_SOURCES_PATH, 'utf8')) as { sources: DocSource[] };
  _cachedSources = raw.sources;
  return _cachedSources;
}

export function getDocSource(framework: string): DocSource | null {
  return loadDocSources().find(s => s.framework === framework) ?? null;
}

export function indexFor(framework: string): Bm25Index | null {
  if (_indexCache.has(framework)) return _indexCache.get(framework)!;
  const chunks = readChunks(framework);
  if (chunks.length === 0) return null;
  const idx = buildIndex(chunks);
  _indexCache.set(framework, idx);
  return idx;
}

export function searchFramework(framework: string, query: string, k: number = 5): QueryHit[] {
  const idx = indexFor(framework);
  if (!idx) return [];
  return searchBm25(idx, query, k);
}

/**
 * Search across all locally-indexed frameworks. Returns top-k merged hits
 * with per-framework recency weighting.
 */
export function searchAll(query: string, k: number = 5, frameworkFilter?: string[]): QueryHit[] {
  const frameworks = frameworkFilter ?? listIndexedFrameworks();
  const all: QueryHit[] = [];
  for (const fw of frameworks) {
    const idx = indexFor(fw);
    if (!idx) continue;
    all.push(...searchBm25(idx, query, k));
  }
  return all.sort((a, b) => b.score - a.score).slice(0, k);
}

/** For diagnostic CLIs. */
export function summarizeIndexes(): { framework: string; chunks: number; ready: boolean }[] {
  const indexed = new Set(listIndexedFrameworks());
  return loadDocSources().map(s => ({
    framework: s.framework,
    chunks: indexFor(s.framework)?.totalDocs ?? 0,
    ready: indexed.has(s.framework),
  }));
}

/** Format a list of QueryHit into the prompt enrichment block. */
export function formatHits(hits: QueryHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  for (const hit of hits) {
    const c: Chunk = hit.chunk;
    lines.push(`**${c.framework}** · ${c.heading_path || '(root)'} · score=${hit.score.toFixed(2)}`);
    lines.push(`Source: ${c.url}`);
    lines.push('');
    lines.push(c.text.slice(0, 1800) + (c.text.length > 1800 ? '\n…(truncated)' : ''));
    lines.push('');
    lines.push('───');
    lines.push('');
  }
  return lines.join('\n');
}
