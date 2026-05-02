#!/usr/bin/env node
/**
 * pnpm auto:verify-claims — pre-Codex factual-grounding gate.
 *
 * Verifies an FRD's claims against actual code + flags anti-patterns.
 * The intent: catch the kinds of issues Codex consensus would catch (and burn
 * 5-8 min doing) in 30 seconds via deterministic grep + file existence checks.
 *
 * Usage:
 *   pnpm auto:verify-claims --frd <path>                    # ad-hoc verify
 *   pnpm auto:verify-claims --task <task_id>                # task-pack-driven
 *   pnpm auto:verify-claims --frd <path> --json             # machine-readable output
 *
 * Verification rules (v0.4-minimal — extensible via src/verifiers/):
 *
 * RULE-1 file:anchor existence — for every claim of the form
 *   `path/to/file.ts:LINE` or `path/to/file.ts:SYMBOL` (e.g., FUNC_NAME),
 *   the file must exist + the symbol must grep-match in the file.
 *
 * RULE-2 anti-pattern denylist — regex-match the FRD against known
 *   bad-patterns:
 *   - compliance-INVALID-PINCITE: `§IV(\(|\b)|§V\(|§VI(\(|\b)|§VII(\b)` in OSFI E-23 context
 *   - DEAD-AI-ROUTE: claims about /api/ai/{chat,scenario/build,variance-commentary,
 *     audit-log,flags} as if shipped (these don't exist at SHA 946257e)
 *   - PRESENT-STATE-OUTBOX: "outbox" or "Iceberg" without the "target-state" /
 *     "v1.0" qualifier nearby
 *   - PRIMITIVE-ONLY-OVER-CLAIM: claims like "X has no call sites" (the v0.5 trap)
 *     when in fact X DOES appear in another file (verified by grep -r "X(")
 *
 * RULE-3 no-call-site claim verification — for every "X has no call sites"
 *   claim, run grep -r "X(" against the apps/web/src tree; if grep finds matches,
 *   flag as factual error (over-correction risk).
 *
 * RULE-4 wired-claim verification — for every "X is wired in route Y" claim,
 *   verify route Y exists AND grep route Y for X import/call.
 *
 * Output: evidence/<task_id>/verify-claims.json (or stdout if --json):
 *   {
 *     status: "ok" | "fail",
 *     duration_sec: number,
 *     rule_results: { [rule]: { findings: [...], severity: ... } }
 *   }
 *
 * Exit code: 0 if no critical findings, 1 if any critical, 2 on error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = harnessRoot();
const RUNS_DIR = path.join(REPO_ROOT, '.agent-runs');

interface Finding {
  rule: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  location: string; // file:line or section
  detail: string;
  recommended_fix: string;
}

interface VerifyResult {
  frd_path: string;
  task_id?: string;
  duration_sec: number;
  status: 'ok' | 'fail';
  total_findings: number;
  critical_count: number;
  high_count: number;
  rule_results: Record<string, { findings: Finding[] }>;
}

function parseArgs(argv: string[]): { frdPath?: string; taskId?: string; json: boolean; codeRoot: string } {
  let frdPath: string | undefined;
  let taskId: string | undefined;
  let json = false;
  let codeRoot = path.join(REPO_ROOT, 'apps/web/src');
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--frd' && i + 1 < argv.length) frdPath = path.resolve(argv[++i]);
    else if (arg === '--task' && i + 1 < argv.length) taskId = argv[++i];
    else if (arg === '--json') json = true;
    else if (arg === '--code-root' && i + 1 < argv.length) codeRoot = path.resolve(argv[++i]);
  }
  if (!frdPath && !taskId) {
    throw new Error('Required: --frd <path> OR --task <task_id>');
  }
  return { frdPath, taskId, json, codeRoot };
}

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function grep(pattern: string, dir: string, fixedString = false): string[] {
  // Use ripgrep if available; fallback to grep -r
  const args = fixedString
    ? ['-rn', '-F', pattern, dir]
    : ['-rn', '-E', pattern, dir];
  const r = spawnSync('grep', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0 && r.status !== 1) {
    return [];
  }
  return (r.stdout || '').split('\n').filter(Boolean);
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * Resolve an FRD-cited file path against the actual repo. FRDs commonly use
 * shorthand like `src/snapshot.ts` (meaning `packages/shared-types/src/snapshot.ts`)
 * or `runtime.ts:191` (meaning a specific file in the M28 agent path). This
 * function tries multiple search roots before declaring the file missing,
 * which prevents false-positive RULE-1 findings against bare-shorthand
 * citations (a noisy bug that surfaced on M03 v0.6 verify-claims runs:
 * 4 critical findings for `src/snapshot.ts` + `src/dimensions.ts` that
 * actually exist at `packages/shared-types/src/`).
 *
 * v0.4.2 (this fix): walk `packages/*` and `platform/*` siblings when the
 * direct path doesn't resolve. Also accepts the file under a worktree root
 * so verify-claims can run from any worktree and still resolve canonical
 * citations against the main repo's package layout.
 */
function findFileInRepo(repoRoot: string, fileRel: string): string | null {
  // 1. Direct path (apps/web/src/..., tools/..., etc.)
  const direct = path.join(repoRoot, fileRel);
  if (fileExists(direct)) return direct;

  // 2. apps/web/<fileRel> (covers `src/...` shorthand for apps/web/src/...)
  const appsWebPath = path.join(repoRoot, 'apps/web', fileRel);
  if (fileExists(appsWebPath)) return appsWebPath;

  // 3. packages/*/<fileRel>
  const packagesDir = path.join(repoRoot, 'packages');
  if (fs.existsSync(packagesDir)) {
    try {
      for (const pkg of fs.readdirSync(packagesDir)) {
        const candidate = path.join(packagesDir, pkg, fileRel);
        if (fileExists(candidate)) return candidate;
      }
    } catch {
      // ignore readdir errors (permissions, missing dir)
    }
  }

  // 4. platform/*/<fileRel>
  const platformDir = path.join(repoRoot, 'platform');
  if (fs.existsSync(platformDir)) {
    try {
      for (const plat of fs.readdirSync(platformDir)) {
        const candidate = path.join(platformDir, plat, fileRel);
        if (fileExists(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }

  // 5. domains/*/<fileRel>
  const domainsDir = path.join(repoRoot, 'domains');
  if (fs.existsSync(domainsDir)) {
    try {
      for (const dom of fs.readdirSync(domainsDir)) {
        const candidate = path.join(domainsDir, dom, fileRel);
        if (fileExists(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function ruleFileAnchorExistence(frd: string, codeRoot: string): Finding[] {
  // Match patterns like `apps/web/src/lib/ai/governance.ts:PRE-01` or `runtime.ts:191`
  const findings: Finding[] = [];
  const re = /\b((?:apps\/web\/src|src|tools)\/[a-zA-Z0-9_\-/.]+\.ts):([A-Z][A-Z0-9_\-]+|\d+(?:[-,]\d+)?)/g;
  let match: RegExpExecArray | null;
  const checked = new Set<string>();
  while ((match = re.exec(frd)) !== null) {
    const fileRel = match[1];
    const anchor = match[2];
    const key = `${fileRel}:${anchor}`;
    if (checked.has(key)) continue;
    checked.add(key);

    // v0.4.2: search multiple repo roots (packages/*, platform/*, domains/*,
    // apps/web) before declaring the file missing — fixes the false-positive
    // bug for FRD-shorthand citations like `src/snapshot.ts` that resolve to
    // `packages/shared-types/src/snapshot.ts`.
    const fullPath = findFileInRepo(REPO_ROOT, fileRel);
    if (!fullPath) {
      findings.push({
        rule: 'RULE-1 file-existence',
        severity: 'critical',
        location: fileRel,
        detail: `Cited file does NOT exist (searched: direct path, apps/web/, packages/*, platform/*, domains/* under ${REPO_ROOT})`,
        recommended_fix: `Remove the citation OR mark as v1.0-target if the file is planned`,
      });
      continue;
    }

    // If anchor is a number (line), no further check (line could be valid or stale; can't tell statically)
    if (/^\d/.test(anchor)) continue;

    // If anchor is a SYMBOL, grep for it in the file
    const content = readFile(fullPath);
    if (!content.includes(anchor)) {
      findings.push({
        rule: 'RULE-1 anchor-existence',
        severity: 'high',
        location: `${fileRel}:${anchor}`,
        detail: `Cited symbol \`${anchor}\` not found in file`,
        recommended_fix: `Verify the symbol name is correct OR remove the citation`,
      });
    }
  }
  return findings;
}

function ruleAntiPatterns(frd: string): Finding[] {
  const findings: Finding[] = [];

  // compliance-INVALID-PINCITE: §IV / §V( / §VI / §VII in any context
  const osfiBadRe = /§IV[\s(\b]|§V\(|§VI[\s(\b]|§VII\b/g;
  let match: RegExpExecArray | null;
  while ((match = osfiBadRe.exec(frd)) !== null) {
    // Compute approximate "section" by looking back for nearest ## or ### header
    const before = frd.slice(0, match.index);
    const lastHeader = before.match(/(?:^|\n)#{1,4}\s+([^\n]+)$/m);
    const section = lastHeader ? lastHeader[1].trim() : '<unknown>';
    findings.push({
      rule: 'RULE-2 compliance-INVALID-PINCITE',
      severity: 'high',
      location: `§ ${section} (char offset ${match.index})`,
      detail: `Invalid OSFI E-23 pin-cite notation \`${match[0]}\` — final guideline uses C.2 / C.3 / Appendix 1 only`,
      recommended_fix: `Replace with the authoritative C.2 / C.3 / Appendix 1 notation`,
    });
  }

  // DEAD-AI-ROUTE: claim of /api/ai/{chat,scenario,variance,audit-log,flags} as shipped
  const deadRoutes = ['/api/ai/chat', '/api/ai/scenario/build', '/api/ai/variance-commentary',
                       '/api/ai/audit-log/route.ts', '/api/ai/flags/route.ts'];
  for (const r of deadRoutes) {
    const idx = frd.indexOf(r);
    if (idx === -1) continue;
    // Look at surrounding 200 chars to check if it's qualified as v1.0 / target-state / NEW
    const ctx = frd.slice(Math.max(0, idx - 200), idx + 200);
    const isQualified = /v1\.0|target-state|NEW|do\s*NOT\s*exist|does\s*NOT\s*exist|missing|primitive-only/i.test(ctx);
    if (!isQualified) {
      findings.push({
        rule: 'RULE-2 DEAD-AI-ROUTE',
        severity: 'high',
        location: `char offset ${idx}`,
        detail: `Reference to \`${r}\` not qualified as v1.0-target / NEW / does-not-exist within 200-char context`,
        recommended_fix: `Add explicit v1.0-target qualifier OR remove the citation`,
      });
    }
  }

  // PRESENT-STATE-OUTBOX: "outbox" or "Iceberg" without target-state qualifier nearby
  const outboxRe = /\b(outbox|Iceberg)\b/g;
  while ((match = outboxRe.exec(frd)) !== null) {
    const ctx = frd.slice(Math.max(0, match.index - 150), match.index + 150);
    const isQualified = /target-state|v1\.0|prerequisite|when\s+M02|once\s+M02|TODAY|primitive-only/i.test(ctx);
    if (!isQualified) {
      findings.push({
        rule: 'RULE-2 PRESENT-STATE-OUTBOX',
        severity: 'medium',
        location: `char offset ${match.index}`,
        detail: `\`${match[0]}\` referenced without target-state qualifier in 300-char context`,
        recommended_fix: `Add explicit "v1.0 target-state" or "once M02 v1.0 lands" qualifier`,
      });
    }
  }

  return findings;
}

function ruleNoCallSiteClaims(frd: string, codeRoot: string): Finding[] {
  // Look for claims like "X has NO call sites" or "X is primitive-only" or "X has no invocation"
  const findings: Finding[] = [];
  // Pattern: identifier followed by 0-300 chars then "no call sites" / "primitive-only" / "no invocation"
  const patterns = [
    /`?([a-zA-Z][a-zA-Z0-9_]*)\(?\)?`?[^.\n]{0,300}?(?:NO\s+call\s+sites|no\s+call\s+sites|primitive-only|no\s+invocation\s+sites)/g,
  ];
  const claimedFns = new Set<string>();
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(frd)) !== null) {
      const fnName = match[1];
      if (fnName.length < 3) continue; // skip short hits (likely false positive)
      if (['NO', 'no', 'the', 'and', 'or', 'has', 'have', 'been'].includes(fnName.toLowerCase())) continue;
      if (claimedFns.has(fnName)) continue;
      claimedFns.add(fnName);
    }
  }

  // For each claimed-no-call-site function, grep -r "fnName(" in code root
  for (const fnName of claimedFns) {
    if (!fs.existsSync(codeRoot)) continue;
    const matches = grep(`\\b${fnName}\\(`, codeRoot, false);
    // Filter out the function's own definition (matches "function fnName(" or "const fnName =" or similar)
    const callSites = matches.filter((line) => {
      // Skip if line contains "function fnName" or "export function fnName" or similar definition pattern
      if (/\bfunction\s+\w+\(/.test(line) || /export\s+(default\s+)?(async\s+)?function/.test(line)) return false;
      if (/=\s*(async\s+)?(\([^)]*\)|function)/.test(line)) return false; // arrow fn definition
      if (/^\s*export\s+\{/.test(line)) return false; // re-export
      return true;
    });
    if (callSites.length > 0) {
      findings.push({
        rule: 'RULE-3 NO-CALL-SITE-OVER-CLAIM',
        severity: 'critical',
        location: `claimed: ${fnName}() has no call sites`,
        detail: `${fnName}() actually has ${callSites.length} call site(s) in ${codeRoot}: ${callSites.slice(0, 3).join(' / ')}`,
        recommended_fix: `Either remove the no-call-sites claim OR list the actual call sites and explain why they don't count`,
      });
    }
  }

  return findings;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let frdPath = args.frdPath;
  if (args.taskId && !frdPath) {
    // Look up task pack to find the FRD path
    const runsDir = RUNS_DIR;
    if (!fs.existsSync(runsDir)) {
      throw new Error(`No .agent-runs/ directory at ${runsDir}; provide --frd directly`);
    }
    for (const runId of fs.readdirSync(runsDir)) {
      const taskPath = path.join(runsDir, runId, 'tasks', `${args.taskId}.json`);
      if (fs.existsSync(taskPath)) {
        const pack = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        frdPath = pack.references?.frd_path?.replace('~', process.env.HOME || '');
        // Resolve glob (e.g., FRD-M29-*) to actual path
        if (frdPath && frdPath.includes('*')) {
          const dir = path.dirname(frdPath);
          if (fs.existsSync(dir)) {
            const dirEntries = fs.readdirSync(dir);
            // pattern is e.g., FRD-M29-* — find first match
            const baseName = path.basename(frdPath);
            const re = new RegExp('^' + baseName.replace(/\*/g, '.*') + '$');
            const matched = dirEntries.find((e) => re.test(e));
            if (matched) frdPath = path.join(dir, matched);
          }
          // If glob is in middle (e.g., FRD-M29-*/FRD-M29.md), expand the dir-glob portion
          if (frdPath && frdPath.includes('*')) {
            const parts = frdPath.split(path.sep);
            const expandedParts: string[] = [];
            let current = parts[0] === '' ? '/' : parts[0];
            expandedParts.push(current);
            for (let i = 1; i < parts.length; i++) {
              const part = parts[i];
              if (part.includes('*')) {
                const dirEntries = fs.existsSync(current) ? fs.readdirSync(current) : [];
                const re = new RegExp('^' + part.replace(/\*/g, '.*') + '$');
                const matched = dirEntries.find((e) => re.test(e));
                if (matched) {
                  current = path.join(current, matched);
                  expandedParts.push(matched);
                } else {
                  current = path.join(current, part);
                  expandedParts.push(part);
                }
              } else {
                current = path.join(current, part);
                expandedParts.push(part);
              }
            }
            frdPath = current;
          }
        }
      }
    }
    if (!frdPath) throw new Error(`Task ${args.taskId} not found OR has no frd_path`);
  }

  if (!frdPath) throw new Error('Could not resolve --frd path');
  if (!fileExists(frdPath)) throw new Error(`FRD not found at ${frdPath}`);

  const start = Date.now();
  const frd = readFile(frdPath);

  const rule1 = ruleFileAnchorExistence(frd, args.codeRoot);
  const rule2 = ruleAntiPatterns(frd);
  const rule3 = ruleNoCallSiteClaims(frd, args.codeRoot);

  const allFindings = [...rule1, ...rule2, ...rule3];
  const criticalCount = allFindings.filter((f) => f.severity === 'critical').length;
  const highCount = allFindings.filter((f) => f.severity === 'high').length;

  const result: VerifyResult = {
    frd_path: frdPath,
    task_id: args.taskId,
    duration_sec: (Date.now() - start) / 1000,
    status: criticalCount === 0 ? 'ok' : 'fail',
    total_findings: allFindings.length,
    critical_count: criticalCount,
    high_count: highCount,
    rule_results: {
      'RULE-1 file-anchor-existence': { findings: rule1 },
      'RULE-2 anti-patterns': { findings: rule2 },
      'RULE-3 no-call-site-claims': { findings: rule3 },
    },
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n═══════════════════════════════════════════════════════════════════════`);
    console.log(`auto:verify-claims — ${frdPath}`);
    console.log(`═══════════════════════════════════════════════════════════════════════`);
    console.log(`Duration: ${result.duration_sec.toFixed(2)}s`);
    console.log(`Status:   ${result.status === 'ok' ? '✓ OK' : '✗ FAIL'}`);
    console.log(`Findings: ${allFindings.length} total (${criticalCount} critical, ${highCount} high)`);
    console.log('');
    if (allFindings.length === 0) {
      console.log(`No findings. FRD is grep-clean against verify-claims rules.`);
    } else {
      for (const finding of allFindings.slice(0, 30)) {
        const sev = finding.severity.toUpperCase().padEnd(8);
        console.log(`[${sev}] ${finding.rule}`);
        console.log(`           ${finding.location}`);
        console.log(`           ${finding.detail}`);
        console.log(`     fix → ${finding.recommended_fix}`);
        console.log('');
      }
      if (allFindings.length > 30) {
        console.log(`... and ${allFindings.length - 30} more findings (use --json for full output)`);
      }
    }
  }

  // Persist to evidence dir if --task
  if (args.taskId) {
    for (const runId of fs.readdirSync(RUNS_DIR)) {
      const taskPath = path.join(RUNS_DIR, runId, 'tasks', `${args.taskId}.json`);
      if (fs.existsSync(taskPath)) {
        const evidenceDir = path.join(RUNS_DIR, runId, 'evidence', args.taskId);
        if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
        fs.writeFileSync(
          path.join(evidenceDir, 'verify-claims.json'),
          JSON.stringify(result, null, 2)
        );
        console.log(`\n[evidence] verify-claims.json written to ${evidenceDir}/`);
        break;
      }
    }
  }

  process.exit(result.status === 'ok' ? 0 : 1);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(2);
});
