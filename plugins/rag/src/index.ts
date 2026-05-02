/**
 * Hermes RAG plugin — framework-aware retrieval-augmented context.
 *
 * Adds a `framework_context` block to the worker prompt when the task pack's
 * allowed_paths or detected stack matches a known framework. Reduces
 * "stale knowledge" failures (worker uses old API patterns) without
 * shipping the entire framework's docs into every prompt.
 *
 * Plugin shape:
 *   - retrievers/<name>.ts implements `Retriever` interface
 *   - At dispatch time, `enrichPrompt(pack)` walks the registry, picks the
 *     best-fitting retriever, and returns a markdown block to prepend to
 *     the worker prompt.
 *
 * Reference impl: react-19.ts (a small, hand-curated index of React 19
 * server components, transition APIs, and form actions). Real plugins
 * back onto a vector store / LSP / web fetch.
 *
 * Out of scope for v0.1: vector embeddings, network fetch, cross-language
 * retrievers (Python/Rust/Go), versioned framework matrices. The plugin
 * pattern is what's shipping; the index is the community's job.
 */
export interface Retriever {
  /** Stable name; "react@19", "next@15", "django@5". */
  name: string;
  /**
   * Decide whether this retriever applies to the given pack. Read
   * `allowed_paths` (file extensions, dir names) and `objective` text.
   */
  matches(pack: { allowed_paths?: string[]; objective?: string; references?: { code_paths?: string[] } }): boolean;
  /**
   * Return the markdown block to prepend to the worker prompt, or null if
   * nothing relevant was found. Must be self-contained — no external IO at
   * dispatch time unless the implementation explicitly opts in.
   */
  enrich(pack: { objective?: string; acceptance_criteria?: Array<unknown> }): Promise<string | null>;
}

const RETRIEVERS: Retriever[] = [];

export function registerRetriever(r: Retriever): void {
  RETRIEVERS.push(r);
}

export async function enrichPromptForPack(pack: { allowed_paths?: string[]; objective?: string; references?: { code_paths?: string[] }; acceptance_criteria?: Array<unknown> }): Promise<string> {
  // Step 1: pattern-based retrievers (curated notes per framework).
  const matched: Retriever[] = [];
  for (const r of RETRIEVERS) {
    try { if (r.matches(pack)) matched.push(r); } catch { /* skip */ }
  }

  const patternBlocks: string[] = [];
  const matchedFrameworks = new Set<string>();
  for (const r of matched) {
    matchedFrameworks.add(r.name.split('@')[0]);
    try {
      const block = await r.enrich(pack);
      if (block) patternBlocks.push(`### ${r.name}\n\n${block}`);
    } catch (e) {
      patternBlocks.push(`### ${r.name}\n\n_(retriever errored: ${(e as Error).message.slice(0, 100)})_`);
    }
  }

  // Step 2: BM25 doc retrieval over indexed framework docs (if any).
  // Restricted to the frameworks the pattern matchers fired on, so we
  // don't pollute the prompt with off-topic docs.
  let docBlock = '';
  try {
    const { searchAll, formatHits } = await import('./docs/registry');
    const queryText = [
      pack.objective || '',
      ...(pack.allowed_paths || []),
      ...(pack.references?.code_paths || []),
      ...((pack.acceptance_criteria || []).map(ac => typeof ac === 'string' ? ac : ((ac as { text?: string })?.text || ''))),
    ].join(' ');
    const fwFilter = matchedFrameworks.size > 0 ? [...matchedFrameworks] : undefined;
    const hits = searchAll(queryText, 5, fwFilter);
    if (hits.length > 0) docBlock = formatHits(hits);
  } catch (e) {
    // If the docs subsystem isn't initialized (no indexed frameworks yet)
    // or fails for any reason, fall through to pattern-only enrichment.
  }

  if (patternBlocks.length === 0 && !docBlock) return '';

  const sections: string[] = [
    '',
    '═══════════════════════════════════════════════════════════════',
    '  FRAMEWORK CONTEXT (auto-retrieved)',
    '═══════════════════════════════════════════════════════════════',
    '',
    'The following framework patterns are relevant to this task. Use them',
    'as authoritative references; if they contradict your training, prefer',
    'these (your training may be stale).',
    '',
  ];
  if (patternBlocks.length > 0) {
    sections.push('## Curated patterns', '');
    sections.push(patternBlocks.join('\n\n'));
    sections.push('');
  }
  if (docBlock) {
    sections.push('## Official doc snippets (BM25 retrieval)', '');
    sections.push(docBlock);
  }
  return sections.join('\n');
}

// Tier-1: hand-curated, multi-paragraph pattern blocks
import { reactRetriever } from './retrievers/react';
import { nextjsRetriever } from './retrievers/nextjs';
import { djangoRetriever } from './retrievers/django';
import { fastapiRetriever } from './retrievers/fastapi';
import { expressRetriever } from './retrievers/express';
import { tailwindRetriever } from './retrievers/tailwind';
import { postgresRetriever } from './retrievers/postgres';
import { typescriptRetriever } from './retrievers/typescript';
import { registerAllFromRegistry } from './retrievers/registry-loader';

registerRetriever(reactRetriever);
registerRetriever(nextjsRetriever);
registerRetriever(djangoRetriever);
registerRetriever(fastapiRetriever);
registerRetriever(expressRetriever);
registerRetriever(tailwindRetriever);
registerRetriever(postgresRetriever);
registerRetriever(typescriptRetriever);

// Tier-2 + Tier-3: ~92 frameworks loaded from refs/frameworks.json. Tier-1
// IDs are skipped (handled by the dedicated TS files above). This is what
// makes the "top-100 frameworks" claim concrete — every entry in the JSON
// becomes a queryable Retriever at module load time.
registerAllFromRegistry(registerRetriever);
