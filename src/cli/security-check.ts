#!/usr/bin/env node
/**
 * pnpm auto:security-check (M8 MVP) — security-compliance reviewer.
 *
 * Codex SOTA-bar: 'Missing entirely from the roster: ... model-risk/compliance
 * gate.' M8 was 🟡 partial via PUB-8 (SoD) + PUB-9 (policy-as-code) docs but
 * had no code. This MVP scans evidence/<task>/risk-register.md against a
 * regulatory keyword set and surfaces missing controls.
 *
 * Phase 2 will add: BCBS-239 control matrix mapping (not just keywords),
 * SOX/generic-model-governance cross-check, automated SBOM scan via Semgrep + OWASP,
 * threat-model template integration.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceDir, writeEvidence } from '../lib/runState';
import { harnessRoot } from '../lib/harnessRoot';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HARNESS_ROOT = harnessRoot();

interface Args {
  taskId: string;
  applyMode: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { taskId: '', applyMode: false, json: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.applyMode = true;
    else if (a === '--json') args.json = true;
    else if (!a.startsWith('--')) positional.push(a);
  }
  if (positional.length < 1) throw new Error('Required: <task_id>');
  args.taskId = positional[0];
  return args;
}

const COMPLIANCE_KEYWORDS = {
  sox: ['SOX', 'segregation of duties', 'SoD', 'audit trail', 'control'],
  bcbs239: ['BCBS-239', 'risk data aggregation', 'lineage', 'frozen snapshot', 'immutable'],
  sr_11_7: ['generic-model-governance', 'model risk', 'model validation', 'challenger model'],
  ifrs_9: ['IFRS 9', 'ECL', 'expected credit loss', 'SICR', 'stage transition'],
  pii: ['PII', 'PHI', 'GDPR', 'CCPA', 'privacy', 'redaction'],
  authn_authz: ['authentication', 'authorization', 'RBAC', 'ABAC', 'JWT', 'session token'],
};

interface SecurityReport {
  task_id: string;
  detected_at: string;
  risk_register_present: boolean;
  risk_register_size_kb: number;
  framework_coverage: Record<string, { keywords_found: string[]; coverage_pct: number }>;
  missing_critical_frameworks: string[];
  duplicate_scan_present: boolean;
  semgrep_present: boolean;
  severity: 'ok' | 'low' | 'medium' | 'high';
  recommendations: string[];
}

function findRunForTask(taskId: string): string {
  const runsDir = path.join(HARNESS_ROOT, '.agent-runs');
  if (!fs.existsSync(runsDir)) throw new Error(`No .agent-runs/`);
  for (const r of fs.readdirSync(runsDir)) {
    if (fs.existsSync(path.join(runsDir, r, 'tasks', `${taskId}.json`))) return r;
  }
  throw new Error(`Task ${taskId} not found`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runId = findRunForTask(args.taskId);
  const evDir = evidenceDir(runId, args.taskId);
  const riskRegisterPath = path.join(evDir, 'risk-register.md');
  const duplicateScanPath = path.join(evDir, 'duplicate-scan.json');
  // Semgrep would write to evidence/<task>/semgrep-report.json (Phase 2)
  const semgrepPath = path.join(evDir, 'semgrep-report.json');

  let riskRegisterBody = '';
  let riskRegisterSize = 0;
  if (fs.existsSync(riskRegisterPath)) {
    riskRegisterBody = fs.readFileSync(riskRegisterPath, 'utf8');
    riskRegisterSize = fs.statSync(riskRegisterPath).size;
  }

  const coverage: SecurityReport['framework_coverage'] = {};
  for (const [framework, keywords] of Object.entries(COMPLIANCE_KEYWORDS)) {
    const lowerBody = riskRegisterBody.toLowerCase();
    const found = keywords.filter((kw) => lowerBody.includes(kw.toLowerCase()));
    coverage[framework] = {
      keywords_found: found,
      coverage_pct: keywords.length > 0 ? Math.round((found.length / keywords.length) * 100) : 0,
    };
  }

  // For regulated workloads: SOX + BCBS-239 + generic-model-governance are CRITICAL.
  // Missing = high severity.
  const CRITICAL = ['sox', 'bcbs239', 'sr_11_7'];
  const missing = CRITICAL.filter((f) => coverage[f].keywords_found.length === 0);

  let severity: SecurityReport['severity'] = 'ok';
  if (missing.length >= 2) severity = 'high';
  else if (missing.length === 1) severity = 'medium';
  else if (!fs.existsSync(riskRegisterPath)) severity = 'high'; // no register at all
  else if (riskRegisterSize < 500) severity = 'low'; // tiny register

  const recommendations: string[] = [];
  if (!fs.existsSync(riskRegisterPath)) {
    recommendations.push(`risk-register.md MISSING from evidence dir. Worker must produce it.`);
  } else if (riskRegisterSize < 500) {
    recommendations.push(`risk-register.md is suspiciously small (${riskRegisterSize}b). Likely shallow analysis.`);
  }
  for (const fw of missing) {
    recommendations.push(`No mention of ${fw.toUpperCase()} controls in risk-register. For compliance-sensitive modules this MUST be addressed.`);
  }
  if (!fs.existsSync(duplicateScanPath)) {
    recommendations.push(`duplicate-scan.json missing. Operator: enforce in worker prompt.`);
  }
  if (!fs.existsSync(semgrepPath)) {
    recommendations.push(`semgrep-report.json missing (Phase 2 will auto-run Semgrep against the diff).`);
  }
  if (recommendations.length === 0) {
    recommendations.push('All compliance checks pass at MVP scope. Phase 2 will add BCBS-239 control matrix + automated SBOM scan.');
  }

  const report: SecurityReport = {
    task_id: args.taskId,
    detected_at: new Date().toISOString(),
    risk_register_present: fs.existsSync(riskRegisterPath),
    risk_register_size_kb: riskRegisterSize / 1024,
    framework_coverage: coverage,
    missing_critical_frameworks: missing,
    duplicate_scan_present: fs.existsSync(duplicateScanPath),
    semgrep_present: fs.existsSync(semgrepPath),
    severity,
    recommendations,
  };

  if (args.applyMode) {
    writeEvidence(runId, args.taskId, 'security-check.json', JSON.stringify(report, null, 2));
    console.log(`✓ wrote ${evDir}/security-check.json`);
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`Task: ${args.taskId} (run: ${runId})`);
  console.log(`risk-register.md: ${report.risk_register_present ? `${report.risk_register_size_kb.toFixed(1)} KB` : 'MISSING'}`);
  console.log(`duplicate-scan.json: ${report.duplicate_scan_present ? '✓' : 'MISSING'}`);
  console.log(`semgrep-report.json: ${report.semgrep_present ? '✓' : 'MISSING (Phase 2)'}`);
  console.log('');
  console.log(`Compliance framework coverage:`);
  for (const [fw, c] of Object.entries(report.framework_coverage)) {
    const tag = c.coverage_pct >= 50 ? '✓' : c.coverage_pct >= 20 ? '⚠' : ' ';
    console.log(`  ${tag} ${fw.toUpperCase()}: ${c.coverage_pct}% (${c.keywords_found.length}/${COMPLIANCE_KEYWORDS[fw as keyof typeof COMPLIANCE_KEYWORDS].length})`);
    if (c.keywords_found.length > 0) console.log(`     keywords: ${c.keywords_found.join(', ')}`);
  }
  console.log('');
  console.log(`Severity: ${severity.toUpperCase()}`);
  console.log(`Recommendations:`);
  for (const r of recommendations) console.log(`  - ${r}`);
}

main();
