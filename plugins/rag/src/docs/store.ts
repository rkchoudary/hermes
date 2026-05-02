/**
 * store.ts — disk-backed JSONL chunk store.
 *
 * Layout: <root>/.hermes/rag-docs/<framework>/
 *   chunks.jsonl   — one JSON-encoded Chunk per line
 *   meta.json      — {fetched_at, source_urls, license, chunk_count}
 *
 * Append-only writes; full re-fetch overwrites. No locking — single-writer
 * by convention (operator runs auto:rag-fetch / auto:rag-index manually,
 * not concurrently).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Chunk } from './types';

export interface FrameworkMeta {
  framework: string;
  fetched_at: string;
  source_urls: string[];
  license?: string;
  chunk_count: number;
  total_tokens: number;
}

function rootDir(): string {
  const home = process.env.HERMES_RAG_ROOT || process.env.HOME || '.';
  return path.join(home, '.hermes', 'rag-docs');
}

export function frameworkDir(framework: string): string {
  return path.join(rootDir(), framework);
}

export function chunksPath(framework: string): string {
  return path.join(frameworkDir(framework), 'chunks.jsonl');
}

export function metaPath(framework: string): string {
  return path.join(frameworkDir(framework), 'meta.json');
}

export function writeChunks(framework: string, chunks: Chunk[], meta: Omit<FrameworkMeta, 'chunk_count' | 'total_tokens' | 'framework'>): void {
  const dir = frameworkDir(framework);
  fs.mkdirSync(dir, { recursive: true });
  const cp = chunksPath(framework);
  fs.writeFileSync(cp, chunks.map(c => JSON.stringify(c)).join('\n') + '\n');
  const totalTokens = chunks.reduce((s, c) => s + c.token_count, 0);
  const fullMeta: FrameworkMeta = { framework, ...meta, chunk_count: chunks.length, total_tokens: totalTokens };
  fs.writeFileSync(metaPath(framework), JSON.stringify(fullMeta, null, 2));
}

export function readChunks(framework: string): Chunk[] {
  const cp = chunksPath(framework);
  if (!fs.existsSync(cp)) return [];
  const out: Chunk[] = [];
  for (const line of fs.readFileSync(cp, 'utf8').split('\n').filter(Boolean)) {
    try { out.push(JSON.parse(line) as Chunk); } catch { /* skip bad line */ }
  }
  return out;
}

export function readMeta(framework: string): FrameworkMeta | null {
  const mp = metaPath(framework);
  if (!fs.existsSync(mp)) return null;
  try { return JSON.parse(fs.readFileSync(mp, 'utf8')) as FrameworkMeta; }
  catch { return null; }
}

export function listIndexedFrameworks(): string[] {
  const root = rootDir();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
}

export function indexedFootprint(): { framework: string; chunks: number; tokens: number; bytes: number }[] {
  return listIndexedFrameworks().map(framework => {
    const meta = readMeta(framework);
    let bytes = 0;
    try {
      const cp = chunksPath(framework);
      if (fs.existsSync(cp)) bytes = fs.statSync(cp).size;
    } catch { /* skip */ }
    return {
      framework,
      chunks: meta?.chunk_count ?? 0,
      tokens: meta?.total_tokens ?? 0,
      bytes,
    };
  });
}
