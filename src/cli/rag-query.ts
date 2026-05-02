#!/usr/bin/env node
/**
 * pnpm auto:rag-query "<text>" [--framework FW] [--k 5]
 *
 * Query the indexed framework docs via BM25. Useful to:
 *   - Test what context will be injected for a given task hint
 *   - Spot-check chunk quality
 *   - Drill into a specific framework
 *
 * If no docs are indexed, falls back to the curated pattern notes from
 * the registry — same surface as enrichPromptForPack at runtime.
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface CliArgs { query?: string; framework?: string; k: number; allHits: boolean; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { k: 5, allHits: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--framework' && i + 1 < argv.length) a.framework = argv[++i];
    else if (x === '--k' && i + 1 < argv.length) a.k = parseInt(argv[++i], 10) || 5;
    else if (x === '--all-hits') a.allHits = true;
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:rag-query "<text>" [--framework FW] [--k N]

Query the indexed framework docs via BM25.

Options:
  --framework FW   Restrict to one framework (default: search all indexed)
  --k N            Number of hits to return (default 5)
  --all-hits       Show all hits regardless of score (default: top-k only)

If no docs are indexed for the matched frameworks, the registry's
pattern notes are returned instead (same surface as runtime enrichment).`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.query) a.query = x;
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: pnpm auto:rag-query "<text>" [--framework FW] [--k N]');
    process.exit(2);
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ragRoot = path.resolve(__dirname, '..', '..', 'plugins', 'rag', 'src', 'docs');
  interface RegistryMod {
    searchAll: (q: string, k: number, fwFilter?: string[]) => Array<{ chunk: { framework: string; url: string; heading_path: string; text: string }; score: number; matched_terms?: string[] }>;
    searchFramework: (fw: string, q: string, k: number) => Array<{ chunk: { framework: string; url: string; heading_path: string; text: string }; score: number; matched_terms?: string[] }>;
    summarizeIndexes: () => Array<{ framework: string; chunks: number; ready: boolean }>;
    formatHits: (hits: Array<unknown>) => string;
  }
  const registry = await import(pathToFileURL(path.join(ragRoot, 'registry.ts')).toString()) as unknown as RegistryMod;

  const indexes = registry.summarizeIndexes();
  const ready = indexes.filter(i => i.ready);
  if (ready.length === 0) {
    console.log('No frameworks indexed yet. Run: pnpm auto:rag-fetch <framework>');
    console.log('');
    console.log('Falling back to curated pattern notes via auto:rag-list:');
    console.log('  pnpm auto:rag-list --match "' + args.query + '"');
    return;
  }

  console.log(`Indexed: ${ready.length} framework(s); searching${args.framework ? ' ' + args.framework : ' all'}…`);
  console.log('');

  const hits = args.framework
    ? registry.searchFramework(args.framework, args.query, args.k)
    : registry.searchAll(args.query, args.k);

  if (hits.length === 0) {
    console.log('No hits.');
    return;
  }

  console.log(`Top ${hits.length} hit(s) for: "${args.query}"`);
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    console.log(`${i + 1}. [${h.chunk.framework}] ${h.chunk.heading_path || '(root)'}  score=${h.score.toFixed(3)}`);
    console.log(`   Source: ${h.chunk.url}`);
    if (h.matched_terms && h.matched_terms.length > 0) {
      console.log(`   Matched: ${h.matched_terms.join(', ')}`);
    }
    console.log('');
    console.log(h.chunk.text.slice(0, 1200) + (h.chunk.text.length > 1200 ? '\n   …(truncated)' : ''));
    console.log('');
    console.log('───');
    console.log('');
  }
}

main().catch((e) => { console.error(`fatal: ${(e as Error).message}`); process.exit(99); });
