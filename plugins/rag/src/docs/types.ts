/**
 * RAG document pipeline — type definitions.
 *
 * Pipeline:
 *   refs/doc-sources.json (URLs)
 *     → fetcher.ts (HTTP fetch + sanitize)
 *     → chunker.ts (split to ~500-token chunks)
 *     → store.ts (write JSONL to .hermes/rag-docs/<framework>/chunks.jsonl)
 *     → bm25.ts (build inverted index in memory on demand)
 *     → query at retrieval time, top-K chunks prepended to worker prompt
 *
 * Why BM25 not vector embeddings: BM25 is competitive for code/framework
 * queries (token overlap with framework names + API symbols is high), needs
 * no API keys, works offline, deterministic + auditable. The Embedder
 * interface below is pluggable so operators can swap in OpenAI / local
 * models / Voyage if desired — same retrieval surface, different scoring.
 */

export interface DocSource {
  /** Framework id matching frameworks.json. */
  framework: string;
  /** Display name. */
  name: string;
  /** Official doc URL(s). Fetcher dispatches on URL pattern (markdown raw,
   * HTML→markdown via Readability, or known-shape sitemaps). */
  urls: string[];
  /** Optional sitemap URL for crawl-based fetchers. */
  sitemap?: string;
  /** Patterns inside the doc to *exclude* (release notes, deprecation
   * archives, language toggles). Regex strings. */
  exclude?: string[];
  /** License of the docs (Apache-2.0, MIT, CC-BY-4.0, etc.). Operators
   * who redistribute must comply. */
  license?: string;
  /** Estimated total size in MB (for budgeting fetch-all runs). */
  estimated_mb?: number;
}

export interface Chunk {
  /** Stable ID = sha1(framework + url + heading_path + chunk_index). */
  id: string;
  framework: string;
  /** Source URL the chunk was extracted from. */
  url: string;
  /** Heading hierarchy joined by " > " (e.g., "Hooks > useState > Examples"). */
  heading_path: string;
  /** Chunk text (≤ ~600 tokens / ~2400 chars typical). */
  text: string;
  /** Approx token count (whitespace + punctuation tokenization). */
  token_count: number;
  /** Sequence index inside the source page. */
  chunk_index: number;
  /** ISO timestamp when fetched. */
  fetched_at: string;
}

export interface QueryHit {
  chunk: Chunk;
  /** BM25 score (or embedding cosine if Embedder is wired). */
  score: number;
  /** Per-term breakdown for debugging. */
  matched_terms?: string[];
}

/**
 * Pluggable embedder. Default impl returns null and BM25 is used.
 * Operators wire in OpenAI / local SentenceTransformers via this.
 */
export interface Embedder {
  /** Embed a list of texts; returns float32 vectors of equal dimension. */
  embed(texts: string[]): Promise<number[][]>;
  /** Cosine similarity between two vectors. */
  similarity(a: number[], b: number[]): number;
}

/** Default Embedder = no-op; signals "use BM25 instead". */
export const NULL_EMBEDDER: Embedder = {
  async embed() { return []; },
  similarity() { return 0; },
};
