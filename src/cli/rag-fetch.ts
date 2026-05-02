#!/usr/bin/env node
/**
 * pnpm auto:rag-fetch <framework_id> [--all] [--limit-mb 100] [--dry-run]
 *
 * Download official docs for a framework, chunk them, and index for BM25
 * retrieval. Run once per framework you want enriched context for, or
 * --all to ingest the full registry (~hours, ~2-5GB).
 *
 * Output: ~/.hermes/rag-docs/<framework>/{chunks.jsonl, meta.json}
 *
 * Usage:
 *   pnpm auto:rag-fetch react              # one framework
 *   pnpm auto:rag-fetch --all              # all 100+ frameworks
 *   pnpm auto:rag-fetch django --dry-run   # show URLs, don't download
 *   pnpm auto:rag-fetch --all --limit-mb 50  # cap any single framework's footprint
 *   pnpm auto:rag-fetch --list             # list what's already indexed
 *
 * License: respect each framework's docs license. Some are CC-BY-4.0,
 * MIT, BSD; a few are vendor-EULA (Apple SwiftUI, Unity, Unreal). The
 * registry records the license per source. Operators redistributing
 * indexed chunks are responsible for compliance.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface CliArgs {
  framework?: string;
  all: boolean;
  limitMb: number;
  dryRun: boolean;
  list: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { all: false, limitMb: 100, dryRun: false, list: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--all') a.all = true;
    else if (x === '--limit-mb' && i + 1 < argv.length) a.limitMb = parseInt(argv[++i], 10) || 100;
    else if (x === '--dry-run') a.dryRun = true;
    else if (x === '--list') a.list = true;
    else if (x === '--force') a.force = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:rag-fetch <framework_id> [options]

Download + chunk + index official framework docs for BM25 retrieval.

Options:
  --all              Ingest every framework in refs/doc-sources.json
  --limit-mb N       Skip frameworks whose estimated_mb exceeds N
  --dry-run          List URLs without fetching
  --list             Show locally-indexed frameworks
  --force            Re-fetch + re-index even if already present

Examples:
  pnpm auto:rag-fetch react
  pnpm auto:rag-fetch --all --limit-mb 50
  pnpm auto:rag-fetch --list

Storage: ~/.hermes/rag-docs/<framework>/{chunks.jsonl, meta.json}
Licenses: vary per framework; recorded in meta.json. Operator's
responsibility to comply when redistributing indexed chunks.`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.framework) a.framework = x;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Dynamic import — RAG plugin is a sibling package
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ragRoot = path.resolve(__dirname, '..', '..', 'plugins', 'rag', 'src', 'docs');
  interface FetcherMod { fetchUrl: (url: string, timeoutMs?: number) => Promise<{ url: string; markdown: string; bytes: number }>; }
  interface ChunkerMod { chunkMarkdown: (markdown: string, framework: string, url: string, fetchedAtIso: string) => unknown[]; }
  interface StoreMod { writeChunks: (framework: string, chunks: unknown[], meta: { fetched_at: string; source_urls: string[]; license?: string }) => void; readMeta: (framework: string) => { fetched_at?: string; chunk_count?: number; total_tokens?: number } | null; indexedFootprint: () => Array<{ framework: string; chunks: number; tokens: number; bytes: number }>; }
  interface RegistryMod { loadDocSources: () => Array<{ framework: string; name: string; urls: string[]; license?: string; estimated_mb?: number }>; getDocSource: (id: string) => { framework: string; name: string; urls: string[]; license?: string } | null; }

  const fetcher = await import(pathToFileURL(path.join(ragRoot, 'fetcher.ts')).toString()) as unknown as FetcherMod;
  const chunker = await import(pathToFileURL(path.join(ragRoot, 'chunker.ts')).toString()) as unknown as ChunkerMod;
  const store = await import(pathToFileURL(path.join(ragRoot, 'store.ts')).toString()) as unknown as StoreMod;
  const registry = await import(pathToFileURL(path.join(ragRoot, 'registry.ts')).toString()) as unknown as RegistryMod;

  if (args.list) {
    const fp = store.indexedFootprint();
    if (fp.length === 0) { console.log('No frameworks indexed yet.'); console.log('Run: pnpm auto:rag-fetch <framework> OR --all'); return; }
    console.log('Locally indexed frameworks:');
    console.log('');
    console.log('FRAMEWORK            CHUNKS    TOKENS     BYTES');
    console.log('───────────────────  ───────  ─────────  ─────────');
    for (const f of fp) {
      console.log(`${f.framework.padEnd(20)} ${String(f.chunks).padStart(7)}  ${String(f.tokens).padStart(9)}  ${String(f.bytes).padStart(9)}`);
    }
    return;
  }

  const sources = registry.loadDocSources();
  if (sources.length === 0) {
    console.error('No doc sources configured. Check plugins/rag/refs/doc-sources.json.');
    process.exit(1);
  }

  let toFetch: Array<{ framework: string; name: string; urls: string[]; license?: string }> = [];
  if (args.all) {
    toFetch = sources.filter(s => !s.estimated_mb || s.estimated_mb <= args.limitMb);
    if (toFetch.length < sources.length) {
      console.log(`Filtering by --limit-mb ${args.limitMb}: ${toFetch.length}/${sources.length} frameworks`);
    }
  } else if (args.framework) {
    const src = registry.getDocSource(args.framework);
    if (!src) {
      console.error(`Framework '${args.framework}' not in doc-sources.json.`);
      process.exit(1);
    }
    toFetch = [src];
  } else {
    console.error('Specify <framework> or --all. See --help.');
    process.exit(2);
  }

  console.log(`Fetching ${toFetch.length} framework(s)…`);
  console.log('');

  let totalChunks = 0;
  let totalBytes = 0;
  let succeeded = 0;
  let failed = 0;

  for (const src of toFetch) {
    if (!args.force) {
      const existing = store.readMeta(src.framework);
      if (existing && existing.chunk_count && existing.chunk_count > 0) {
        console.log(`  ⊙ ${src.framework} — already indexed (${existing.chunk_count} chunks, ${existing.fetched_at}); skip (--force to re-fetch)`);
        continue;
      }
    }
    if (args.dryRun) {
      console.log(`  [dry] ${src.framework}: ${src.urls.length} URL(s)`);
      for (const u of src.urls) console.log(`         ${u}`);
      continue;
    }
    process.stdout.write(`  ↓ ${src.framework} `);
    try {
      const allChunks: unknown[] = [];
      let fwBytes = 0;
      const fetchedAt = new Date().toISOString();
      for (const url of src.urls) {
        try {
          const fetched = await fetcher.fetchUrl(url, 60_000);
          fwBytes += fetched.bytes;
          const chunks = chunker.chunkMarkdown(fetched.markdown, src.framework, url, fetchedAt);
          allChunks.push(...chunks);
          process.stdout.write('.');
        } catch (e) {
          process.stdout.write('x');
          // Continue with next URL — partial index is better than nothing
        }
      }
      if (allChunks.length === 0) {
        console.log(' FAIL (no chunks)');
        failed++;
        continue;
      }
      store.writeChunks(src.framework, allChunks, { fetched_at: fetchedAt, source_urls: src.urls, license: src.license });
      console.log(` ✓ ${allChunks.length} chunks · ${(fwBytes / 1024).toFixed(0)} KB`);
      totalChunks += allChunks.length;
      totalBytes += fwBytes;
      succeeded++;
    } catch (e) {
      console.log(` FAIL: ${(e as Error).message.slice(0, 80)}`);
      failed++;
    }
  }

  console.log('');
  console.log(`Indexed: ${succeeded} ok · ${failed} failed · ${totalChunks} chunks total · ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
  if (succeeded > 0) {
    console.log('');
    console.log('Next: pnpm auto:rag-list --match "<your task hint>" to verify retrieval');
  }
}

main().catch((e) => { console.error(`fatal: ${(e as Error).message}`); process.exit(99); });
