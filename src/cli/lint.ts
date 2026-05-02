#!/usr/bin/env node
/**
 * pnpm auto:lint — run lint with structured output.
 *
 * Detects ESLint, Biome, or oxlint; runs whichever is configured.
 * Returns structured result for buildPipeline integration.
 *
 * Usage:
 *   pnpm auto:lint                # run lint (current package)
 *   pnpm auto:lint --fix          # autofix
 *   pnpm auto:lint --json         # machine-readable
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

interface Args {
  fix: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    fix: argv.includes('--fix'),
    json: argv.includes('--json'),
  };
}

interface LintResult {
  linter: 'eslint' | 'biome' | 'oxlint' | 'none';
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

function detectLinter(cwd: string): 'eslint' | 'biome' | 'oxlint' | 'none' {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return 'none';
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return 'none'; }
  const allDeps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  if ('@biomejs/biome' in allDeps || fs.existsSync(path.join(cwd, 'biome.json'))) return 'biome';
  if ('oxlint' in allDeps) return 'oxlint';
  if ('eslint' in allDeps || fs.existsSync(path.join(cwd, '.eslintrc.json')) || fs.existsSync(path.join(cwd, 'eslint.config.js')) || fs.existsSync(path.join(cwd, 'eslint.config.mjs'))) {
    return 'eslint';
  }
  return 'none';
}

function runLinter(linter: LintResult['linter'], fix: boolean, cwd: string): LintResult {
  const start = Date.now();
  if (linter === 'none') {
    return {
      linter, ok: true, exit_code: 0, stdout: '(no linter configured)', stderr: '',
      duration_ms: Date.now() - start,
    };
  }
  let cmd: string;
  let args: string[];
  switch (linter) {
    case 'eslint':
      cmd = 'pnpm';
      args = ['exec', 'eslint', 'src/', ...(fix ? ['--fix'] : [])];
      break;
    case 'biome':
      cmd = 'pnpm';
      args = ['exec', 'biome', fix ? 'check' : 'lint', 'src/', ...(fix ? ['--write'] : [])];
      break;
    case 'oxlint':
      cmd = 'pnpm';
      args = ['exec', 'oxlint', 'src/', ...(fix ? ['--fix'] : [])];
      break;
  }
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
  return {
    linter,
    ok: r.status === 0,
    exit_code: r.status,
    stdout: (r.stdout ?? '').slice(-4000),
    stderr: (r.stderr ?? '').slice(-2000),
    duration_ms: Date.now() - start,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const linter = detectLinter(PACKAGE_ROOT);
  const result = runLinter(linter, args.fix, PACKAGE_ROOT);

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const icon = result.ok ? '✓' : '✗';
    console.log(`${icon} ${result.linter} ${result.ok ? 'PASS' : 'FAIL'} (${(result.duration_ms / 1000).toFixed(1)}s, exit=${result.exit_code})`);
    if (result.stdout.trim()) console.log(result.stdout);
    if (result.stderr.trim()) console.warn(result.stderr);
  }
  process.exit(result.ok ? 0 : 1);
}

try { main(); }
catch (e) {
  console.error(`[lint] error: ${(e as Error).message}`);
  process.exit(2);
}
