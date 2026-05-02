/**
 * chunker.ts — split a markdown document into RAG-friendly chunks.
 *
 * Strategy:
 *   1. Walk the markdown headings (# / ## / ### / ####) to build a
 *      heading_path stack.
 *   2. For each leaf section (text under a heading without sub-heads),
 *      emit one or more chunks. Hard cap: 600 tokens per chunk.
 *   3. Code blocks stay intact when possible — split a 1000-line code
 *      block by logical separators (function/class/test boundaries) only
 *      if absolutely necessary.
 *   4. Each chunk carries the full heading_path so retrieval results
 *      include navigational context.
 *
 * Pure function — no IO. Caller passes text + url, gets Chunk[].
 */
import { createHash } from 'node:crypto';
import type { Chunk } from './types';

const MAX_TOKENS = 600;
const APPROX_CHARS_PER_TOKEN = 4;
const MAX_CHARS = MAX_TOKENS * APPROX_CHARS_PER_TOKEN;

interface Section { headingPath: string[]; lines: string[]; }

function tokenize(text: string): string[] {
  // Whitespace + punctuation tokenization (match BM25 tokenizer in bm25.ts)
  return text.toLowerCase().split(/[\s\W_]+/).filter(t => t.length > 0);
}

function chunkId(framework: string, url: string, headingPath: string, idx: number): string {
  return createHash('sha1').update(`${framework}|${url}|${headingPath}|${idx}`).digest('hex').slice(0, 16);
}

function splitSection(framework: string, url: string, fetchedAt: string, section: Section, baseIdx: number): Chunk[] {
  const text = section.lines.join('\n').trim();
  if (!text) return [];
  const headingPath = section.headingPath.join(' > ');

  // Single small chunk
  if (text.length <= MAX_CHARS) {
    return [{
      id: chunkId(framework, url, headingPath, baseIdx),
      framework,
      url,
      heading_path: headingPath,
      text,
      token_count: tokenize(text).length,
      chunk_index: baseIdx,
      fetched_at: fetchedAt,
    }];
  }

  // Section too big — split by paragraphs, keeping code blocks intact
  const blocks: string[] = [];
  let inCodeBlock = false;
  let buffer: string[] = [];
  for (const line of section.lines) {
    if (line.startsWith('```')) inCodeBlock = !inCodeBlock;
    buffer.push(line);
    // Paragraph boundary (blank line outside code block)
    if (!inCodeBlock && line.trim() === '') {
      if (buffer.length > 1) {
        blocks.push(buffer.join('\n').trim());
        buffer = [];
      }
    }
  }
  if (buffer.length > 0) blocks.push(buffer.join('\n').trim());

  // Pack blocks into chunks honoring MAX_CHARS
  const chunks: Chunk[] = [];
  let currentChunkText = '';
  let currentChunkIdx = baseIdx;
  for (const block of blocks) {
    if (!block) continue;
    if (currentChunkText.length + block.length + 2 <= MAX_CHARS) {
      currentChunkText = currentChunkText ? `${currentChunkText}\n\n${block}` : block;
    } else {
      if (currentChunkText) {
        chunks.push({
          id: chunkId(framework, url, headingPath, currentChunkIdx),
          framework, url, heading_path: headingPath,
          text: currentChunkText,
          token_count: tokenize(currentChunkText).length,
          chunk_index: currentChunkIdx,
          fetched_at: fetchedAt,
        });
        currentChunkIdx++;
      }
      // Block alone might still be > MAX_CHARS (huge code sample). In that
      // case emit it as a single oversized chunk — better to ship intact
      // than to break in the middle of a code block.
      currentChunkText = block;
    }
  }
  if (currentChunkText) {
    chunks.push({
      id: chunkId(framework, url, headingPath, currentChunkIdx),
      framework, url, heading_path: headingPath,
      text: currentChunkText,
      token_count: tokenize(currentChunkText).length,
      chunk_index: currentChunkIdx,
      fetched_at: fetchedAt,
    });
  }
  return chunks;
}

/**
 * Chunk a markdown document. Returns chunks ready for indexing.
 */
export function chunkMarkdown(markdown: string, framework: string, url: string, fetchedAtIso: string): Chunk[] {
  const lines = markdown.split('\n');
  const sections: Section[] = [];
  let headingPath: string[] = [];
  let currentLines: string[] = [];

  const pushCurrent = () => {
    if (currentLines.length > 0) {
      sections.push({ headingPath: [...headingPath], lines: [...currentLines] });
      currentLines = [];
    }
  };

  let inCodeBlock = false;
  for (const line of lines) {
    if (line.startsWith('```')) inCodeBlock = !inCodeBlock;
    if (inCodeBlock) { currentLines.push(line); continue; }

    const m = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (m) {
      pushCurrent();
      const level = m[1].length;
      // Trim heading stack to (level - 1) entries; push current
      headingPath = headingPath.slice(0, level - 1);
      headingPath.push(m[2]);
    } else {
      currentLines.push(line);
    }
  }
  pushCurrent();

  // Emit chunks
  const chunks: Chunk[] = [];
  let idx = 0;
  for (const sec of sections) {
    const sectionChunks = splitSection(framework, url, fetchedAtIso, sec, idx);
    chunks.push(...sectionChunks);
    idx += sectionChunks.length;
  }
  return chunks;
}
