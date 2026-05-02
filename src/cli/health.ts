#!/usr/bin/env node
/**
 * pnpm auto:health — print system health report.
 *
 * Usage:
 *   pnpm auto:health                    # human-readable summary
 *   pnpm auto:health --json             # machine-readable for dashboard
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHealthChecks } from '../lib/systemHealth';
import { harnessRoot } from '../lib/harnessRoot';

const __filename_health = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename_health);
const HARNESS_ROOT = harnessRoot();

function main(): void {
  const json = process.argv.includes('--json');
  const report = runHealthChecks(HARNESS_ROOT);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.overall === 'critical' ? 2 : 0);
  }

  const icon = report.overall === 'critical' ? '🔴' :
               report.overall === 'warning' ? '🟡' :
               report.overall === 'info' ? '🔵' : '🟢';
  console.log(`[health ${report.at}] host=${report.host} overall=${icon} ${report.overall.toUpperCase()}`);
  for (const c of report.checks) {
    const sevIcon = c.severity === 'critical' ? '✗' :
                    c.severity === 'warning' ? '⚠' :
                    c.severity === 'info' ? 'ℹ' : '✓';
    console.log(`  ${sevIcon} ${c.id.padEnd(24)} ${String(c.value).padStart(10)}  (${c.threshold})`);
    if (c.recommendation) console.log(`      → ${c.recommendation}`);
  }
  process.exit(report.overall === 'critical' ? 2 : 0);
}

try { main(); }
catch (e) {
  console.error(`[health] error: ${(e as Error).message}`);
  process.exit(1);
}
