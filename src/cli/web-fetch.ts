#!/usr/bin/env node
/**
 * pnpm auto:web-fetch <url> [--out <file>] [--max-bytes N] [--timeout S]
 *
 * Out-of-band web fetch for workers that need to read upstream docs / API
 * specs / changelogs as part of their task. Workers shell out to this CLI
 * (or its env-routable equivalent), get the body as text, and feed it
 * back into their prompt.
 *
 * Why a CLI rather than an in-process HTTP client: keeps the engine
 * adapter surface uniform (workers always shell-out for tools), preserves
 * the audit trail (fetched URLs are logged), and lets operators replace
 * this with curl / a local proxy / a content-negotiating shim.
 *
 * Output:
 *   - Default: prints body to stdout (UTF-8, BOM-stripped)
 *   - --out <file>: writes to file, prints path
 *
 * Audit: each fetch appends a line to .agent-runs/_web-fetch.jsonl
 * { at, url, status, bytes, by_pid }.
 *
 * Safety:
 *   - HEAD-then-GET to short-circuit binary content (configurable via
 *     --binary-ok)
 *   - Default 30s timeout, 1MB cap (configurable)
 *   - HTTPS only by default (--allow-http to override)
 *   - User-Agent identifies as Hermes worker (helps upstream rate-limit)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import * as http from 'node:http';
import { harnessRoot } from '../lib/harnessRoot';

interface CliArgs {
  url?: string;
  out?: string;
  maxBytes: number;
  timeout: number;
  allowHttp: boolean;
  binaryOk: boolean;
  userAgent: string;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    maxBytes: 1024 * 1024,
    timeout: 30,
    allowHttp: false,
    binaryOk: false,
    userAgent: 'Hermes/0.1 (+https://github.com/rkchoudary/hermes)',
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--out' && i + 1 < argv.length) a.out = argv[++i];
    else if (x === '--max-bytes' && i + 1 < argv.length) a.maxBytes = parseInt(argv[++i], 10) || a.maxBytes;
    else if (x === '--timeout' && i + 1 < argv.length) a.timeout = parseInt(argv[++i], 10) || a.timeout;
    else if (x === '--allow-http') a.allowHttp = true;
    else if (x === '--binary-ok') a.binaryOk = true;
    else if (x === '--user-agent' && i + 1 < argv.length) a.userAgent = argv[++i];
    else if (x === '-h' || x === '--help') {
      console.log(`pnpm auto:web-fetch <url> [options]

Fetch a URL as text. Audit-logged to .agent-runs/_web-fetch.jsonl.

Options:
  --out <file>      Write body to file instead of stdout
  --max-bytes N     Body size cap (default 1048576 = 1MB)
  --timeout S       Request timeout in seconds (default 30)
  --allow-http      Allow http:// URLs (default https only)
  --binary-ok       Don't reject non-text Content-Type responses
  --user-agent UA   Override the User-Agent header
`);
      process.exit(0);
    }
    else if (!x.startsWith('-') && !a.url) a.url = x;
  }
  return a;
}

interface FetchResult { status: number; body: Buffer; headers: Record<string, string>; }

function fetchOnce(url: URL, args: CliArgs): Promise<FetchResult> {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, {
      headers: {
        'User-Agent': args.userAgent,
        'Accept': 'text/html, text/plain, application/json, application/xml, */*;q=0.1',
        'Accept-Encoding': 'identity',  // no decompression in this minimal impl
      },
      timeout: args.timeout * 1000,
    }, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > args.maxBytes) {
          req.destroy(new Error(`body exceeded --max-bytes (${args.maxBytes})`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = String(v ?? '');
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks), headers });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`request timed out after ${args.timeout}s`)));
    req.on('error', reject);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: pnpm auto:web-fetch <url> [options]');
    process.exit(2);
  }

  let url: URL;
  try { url = new URL(args.url); }
  catch { console.error(`Invalid URL: ${args.url}`); process.exit(2); }

  if (url.protocol === 'http:' && !args.allowHttp) {
    console.error(`http:// URLs require --allow-http (use https or pass --allow-http if you trust the source)`);
    process.exit(3);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    console.error(`Unsupported scheme: ${url.protocol}`);
    process.exit(3);
  }

  let result: FetchResult;
  try { result = await fetchOnce(url, args); }
  catch (e) {
    console.error(`fetch failed: ${(e as Error).message}`);
    auditLog(args.url, 0, 0, (e as Error).message);
    process.exit(4);
  }

  // Audit log
  auditLog(args.url, result.status, result.body.length);

  // Status check
  if (result.status >= 400) {
    console.error(`HTTP ${result.status}`);
    process.stderr.write(result.body.subarray(0, 2048).toString('utf8'));
    process.exit(5);
  }

  // Content-type check
  const ct = (result.headers['content-type'] || '').toLowerCase();
  const isBinary = ct && !/text\/|application\/(json|xml|x-yaml|x-toml|javascript|ecmascript|x-www-form-urlencoded)/.test(ct);
  if (isBinary && !args.binaryOk) {
    console.error(`Non-text Content-Type: ${ct} — pass --binary-ok if you want it anyway`);
    process.exit(6);
  }

  // Strip BOM if present
  let body = result.body;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    body = body.subarray(3);
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body);
    console.log(outPath);
  } else {
    process.stdout.write(body);
  }
}

function auditLog(url: string, status: number, bytes: number, error?: string): void {
  try {
    const root = harnessRoot();
    const auditPath = path.join(root, '.agent-runs', '_web-fetch.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      url,
      status,
      bytes,
      by_pid: process.pid,
      error,
    };
    fs.appendFileSync(auditPath, JSON.stringify(entry) + '\n');
  } catch { /* never block on audit failure */ }
}

main().catch((e) => { console.error(`fatal: ${(e as Error).message}`); process.exit(99); });
