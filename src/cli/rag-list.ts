#!/usr/bin/env node
/**
 * pnpm auto:rag-list [--match "react+typescript"] [--json]
 *
 * Inspects the framework RAG registry. Lists what's registered, which
 * matchers fire for a given path/objective, and what the enrichment
 * block looks like.
 *
 * Useful for:
 *   - Verifying the JSON registry parses
 *   - Debugging "why didn't this framework get picked up for my pack?"
 *   - Showing operators what context will be injected
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

interface CliArgs { match?: string; json: boolean; }

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--match' && i + 1 < argv.length) a.match = argv[++i];
    else if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      console.log(`pnpm auto:rag-list [--match "<text>"] [--json]

List the registered framework retrievers from the RAG plugin. With --match,
shows only retrievers that fire for the given hint text (typically a
combination of file paths or objective text).

Example:
  pnpm auto:rag-list --match "src/app/page.tsx with use client"
  → react@19+, next.js@13+, typescript@5.4+`);
      process.exit(0);
    }
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Dynamic import — the RAG plugin is a sibling package with its own
  // tsconfig; we don't pull it into the main rootDir program.
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const ragPath = path.resolve(__dirname, '..', '..', 'plugins', 'rag', 'src', 'index.ts');
  const ragUrl = pathToFileURL(ragPath).toString();
  interface RagModule { enrichPromptForPack: (pack: { allowed_paths?: string[]; objective?: string; references?: { code_paths?: string[] } }) => Promise<string>; }
  interface RegistryModule { summarizeRegistry: () => { total: number; tier1: number; tier2: number; tier3: number; byCategory: Record<string, number>; byLanguage: Record<string, number> }; }
  const rag = await import(ragUrl) as unknown as RagModule;
  const summarize = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'plugins', 'rag', 'src', 'retrievers', 'registry-loader.ts')).toString()) as unknown as RegistryModule;

  const summary = summarize.summarizeRegistry();

  if (args.match) {
    const fakePack = { allowed_paths: [args.match], objective: args.match, references: { code_paths: [args.match] } };
    const block = await rag.enrichPromptForPack(fakePack);

    if (args.json) {
      console.log(JSON.stringify({ match: args.match, enrichment: block, registry_summary: summary }, null, 2));
      return;
    }

    if (!block) {
      console.log(`No framework retrievers matched: "${args.match}"`);
      return;
    }
    console.log(`Match: "${args.match}"`);
    console.log('');
    console.log(block);
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Hermes RAG plugin — framework registry');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`Total frameworks:  ${summary.total}`);
  console.log(`  Tier 1 (curated): ${summary.tier1}  (multi-paragraph patterns in retrievers/<id>.ts)`);
  console.log(`  Tier 2 (rich):    ${summary.tier2}  (single-paragraph note in registry)`);
  console.log(`  Tier 3 (stub):    ${summary.tier3}  (one-sentence note; community can promote)`);
  console.log('');
  console.log('By language:');
  for (const [lang, n] of Object.entries(summary.byLanguage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${lang.padEnd(10)} ${n}`);
  }
  console.log('');
  console.log('By category:');
  for (const [cat, n] of Object.entries(summary.byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(24)} ${n}`);
  }
  console.log('');
  console.log('Test a match: pnpm auto:rag-list --match "src/app/page.tsx use client"');
}

main().catch((e) => { console.error(`fatal: ${(e as Error).message}`); process.exit(99); });
