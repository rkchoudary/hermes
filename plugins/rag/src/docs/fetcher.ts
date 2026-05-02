/**
 * fetcher.ts — HTTP fetch + HTML→markdown for doc sources.
 *
 * Strategy:
 *   - If the URL ends in .md / .markdown, fetch and return as-is.
 *   - Otherwise, fetch HTML and convert to markdown via a minimal
 *     hand-written extractor (headings, paragraphs, code blocks, lists,
 *     links). Avoids dependency on turndown / readability.
 *
 * The conversion is good-enough — not a 1:1 fidelity restoration of the
 * source HTML. Code blocks, headings, paragraphs, lists, and tables are
 * preserved; styling (bold, italics, links) is preserved as markdown
 * markers; non-essential elements (nav, footer, scripts) are stripped.
 *
 * For frameworks whose docs we know are markdown-native (often hosted on
 * GitHub raw or docs.rs / pkg.go.dev), the fetch is direct. For HTML-only
 * docs, we apply the converter.
 */
import * as https from 'node:https';
import * as http from 'node:http';

export interface FetchResult { url: string; markdown: string; bytes: number; }

export async function fetchUrl(url: string, timeoutMs: number = 30_000): Promise<FetchResult> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`Unsupported scheme: ${u.protocol}`);

  const lib = u.protocol === 'https:' ? https : http;
  const body = await new Promise<Buffer>((resolve, reject) => {
    const req = lib.get(u, {
      headers: {
        'User-Agent': 'Hermes-RAG-Fetcher/0.1 (+https://github.com/rkchoudary/hermes)',
        'Accept': 'text/markdown, text/html, text/plain, */*;q=0.1',
        'Accept-Encoding': 'identity',
      },
      timeout: timeoutMs,
    }, (res) => {
      // Follow redirects (one hop)
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = new URL(res.headers.location, u).toString();
        fetchUrl(next, timeoutMs).then(r => resolve(Buffer.from(r.markdown))).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode} on ${url}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`fetch timeout: ${url}`)));
    req.on('error', reject);
  });

  const text = body.toString('utf8');
  const isMarkdown = /\.(md|markdown)(\?|#|$)/i.test(url) || /^\s*#\s/.test(text.slice(0, 500));
  const markdown = isMarkdown ? text : htmlToMarkdown(text);
  return { url, markdown, bytes: body.length };
}

/**
 * Minimal HTML → markdown converter. Hand-written; avoids the
 * jsdom + turndown dep tree. Imperfect but adequate for doc pages.
 */
export function htmlToMarkdown(html: string): string {
  let s = html;
  // Strip <!-- comments --> and <!DOCTYPE>
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  // Strip script + style + nav + header + footer + aside
  s = s.replace(/<(script|style|nav|header|footer|aside|noscript|iframe|form|button|svg)[^>]*>[\s\S]*?<\/\1>/gi, '');
  // <pre><code> → fenced code block (preserve language hint)
  s = s.replace(/<pre[^>]*>\s*<code(?:\s+class="[^"]*language-(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, lang, code) => {
    return `\n\n\`\`\`${lang || ''}\n${decodeEntities(code).replace(/<[^>]+>/g, '')}\n\`\`\`\n\n`;
  });
  // <code>...</code> inline → `...`
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, c) => `\`${decodeEntities(c).replace(/<[^>]+>/g, '')}\``);
  // Headings
  for (let level = 6; level >= 1; level--) {
    const re = new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
    s = s.replace(re, (_m, h) => `\n\n${'#'.repeat(level)} ${stripTags(h)}\n\n`);
  }
  // Paragraphs
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_m, p) => `\n\n${stripTags(p)}\n\n`);
  // Lists
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, li) => `- ${stripTags(li)}\n`);
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n');
  // Links → [text](url)
  s = s.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${stripTags(txt)}](${href})`);
  // Bold / italic
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/(strong|b)>/gi, (_m, _t, c) => `**${stripTags(c)}**`);
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/(em|i)>/gi, (_m, _t, c) => `*${stripTags(c)}*`);
  // Tables — flatten cells with " | " separators (loses some structure)
  s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_m, row) => {
    const cells: string[] = [];
    row.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, (_mm: string, c: string) => { cells.push(stripTags(c)); return ''; });
    return `| ${cells.join(' | ')} |\n`;
  });
  // Strip remaining tags
  s = stripTags(s);
  // Decode entities
  s = decodeEntities(s);
  // Collapse 3+ blank lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function stripTags(s: string): string { return s.replace(/<[^>]+>/g, ''); }

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCharCode(parseInt(n, 16)));
}
