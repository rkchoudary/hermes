/**
 * Single source of truth for resolving the harness root directory.
 *
 * Codex v0.4.9 review found CRITICAL: every CLI and lib used
 *   path.resolve(__dirname, '..', '..', '..', '..')
 * which is correct for the VENDORED layout
 *   <project>/tools/autonomous-delivery/src/cli/*.ts → <project>
 * but in the STANDALONE repo
 *   claude-delivery-harness/src/cli/*.ts → /Users/<user>
 * the same path walks 4 levels above the package root, ending up OUTSIDE
 * the repo. `.agent-runs/`, audit logs, queue, registry — everything
 * written to the wrong place.
 *
 * Resolution rules (first match wins):
 *
 *   1. process.env.HARNESS_PROJECT_ROOT (operator override; absolute path)
 *   2. Walk up from __dirname looking for a directory that contains BOTH
 *      `package.json` AND a `.agent-runs/` directory (vendored mode — the
 *      project root sits above tools/autonomous-delivery/)
 *   3. Walk up looking for the FIRST `package.json` (standalone mode — the
 *      package root IS the harness root)
 *   4. Fallback: 4-up from __dirname (legacy behavior; preserves vendored
 *      installs that don't have .agent-runs/ created yet)
 *
 * Cached at module-load time. Re-resolve only by setting HARNESS_PROJECT_ROOT
 * and re-importing in a fresh process.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedRoot: string | null = null;
let cachedPackageRoot: string | null = null;

/**
 * Find the package root (directory containing package.json) by walking up
 * from a starting path. Returns null if not found within 6 levels.
 */
function findPackageRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Find the project root (directory with package.json AND .agent-runs/) by
 * walking up. This distinguishes vendored mode (project root above package)
 * from standalone (package root === project root).
 */
function findVendoredProjectRoot(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, '.agent-runs'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Compute the harness root. Caller should pass `import.meta.url` so the
 * walk starts from the *consumer's* directory, not this lib file's.
 *
 * Most callers should use `harnessRoot()` (no args) — that uses the lib
 * file's own location which is stable across consumers.
 */
export function resolveHarnessRoot(consumerImportMetaUrl?: string): string {
  if (cachedRoot !== null) return cachedRoot;

  // Rule 1: env override
  const envOverride = process.env.HARNESS_PROJECT_ROOT;
  if (envOverride && fs.existsSync(envOverride)) {
    cachedRoot = path.resolve(envOverride);
    return cachedRoot;
  }

  // Determine starting directory
  const startDir = consumerImportMetaUrl
    ? path.dirname(fileURLToPath(consumerImportMetaUrl))
    : path.dirname(fileURLToPath(import.meta.url));

  // Rule 2: vendored mode (project has .agent-runs above package root)
  // Start ABOVE the package root since we want the OUTER project that hosts the package.
  const packageRoot = findPackageRoot(startDir);
  if (packageRoot) {
    const aboveStart = path.dirname(packageRoot);
    const vendored = findVendoredProjectRoot(aboveStart);
    if (vendored) {
      cachedRoot = vendored;
      return cachedRoot;
    }
    // Rule 3: standalone — package root IS harness root
    cachedRoot = packageRoot;
    return cachedRoot;
  }

  // Rule 4: legacy fallback — 4-up from caller
  cachedRoot = path.resolve(startDir, '..', '..', '..', '..');
  return cachedRoot;
}

/**
 * Convenience accessor — most callers want the harness root resolved from
 * THIS module's location (stable across consumers).
 */
export function harnessRoot(): string {
  return resolveHarnessRoot();
}

/**
 * Package root (containing package.json + src/). For CLIs that need to
 * shell out to `pnpm <something>` and need the cwd. Distinct from harness
 * root in vendored mode where pnpm scripts live under tools/<package>/.
 */
export function packageRoot(): string {
  if (cachedPackageRoot !== null) return cachedPackageRoot;
  const startDir = path.dirname(fileURLToPath(import.meta.url));
  const found = findPackageRoot(startDir);
  cachedPackageRoot = found ?? path.resolve(startDir, '..', '..');
  return cachedPackageRoot;
}

/**
 * Test-only: clear the cache. Used by smoke tests that flip
 * HARNESS_PROJECT_ROOT between cases.
 */
export function _resetHarnessRootCacheForTest(): void {
  cachedRoot = null;
  cachedPackageRoot = null;
}
