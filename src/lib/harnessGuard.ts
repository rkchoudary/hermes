/**
 * Sprint J — Harness driver enforcement.
 *
 * Per operator directive 2026-05-01: "harden the harness to make sure it
 * enforces following the steps. you cannot deviate from the step and need
 * to follow the harness steps end to end."
 *
 * The fundamental harness contract: the 27-step chain is the ONLY path
 * forward. Each auto:* CLI is a STEP in that chain, not an independent
 * tool. Manual invocation of individual CLIs lets operators (or LLMs)
 * skip steps, re-order steps, or bypass guards — defeating the
 * determinism guarantee that makes the harness regulator-defensible.
 *
 * Enforcement mechanism: every auto:* CLI calls requireHarnessDriver()
 * at startup. The check passes when:
 *   - env AUTO_HARNESS_DRIVER=1 (set by scripts/serial-by-module.sh)
 *   - OR --override-harness-driver --reason "<why>" passed (audit-logged)
 *   - OR test mode (env AUTO_HARNESS_TEST_MODE=1, used by smoke tests)
 *
 * Otherwise the CLI exits with a helpful error pointing to the script.
 */
import * as os from 'node:os';
import { harnessRoot } from './harnessRoot';
import { captureIdentity } from './sod';
import { appendOverrideAudit } from './overrideAudit';

export interface HarnessGuardOptions {
  /** Name of the CLI being guarded (for error messages + audit trail). */
  cliName: string;
  /** Operator-supplied override reason from --override-harness-driver. */
  overrideReason?: string;
  /** Task ID being operated on (for audit trail). */
  taskId?: string;
  /** Run ID (for audit trail). */
  runId?: string;
}

/**
 * Refuse to run unless dispatched by the harness driver. Helpful error
 * message points operator at the script. Override path logs audit entry.
 */
export function requireHarnessDriver(opts: HarnessGuardOptions): void {
  const isDriverDispatched = process.env.AUTO_HARNESS_DRIVER === '1';
  const isTestMode = process.env.AUTO_HARNESS_TEST_MODE === '1';

  if (isDriverDispatched || isTestMode) {
    return; // OK — invoked from the harness driver or in tests
  }

  if (opts.overrideReason && opts.overrideReason.trim().length >= 10) {
    // Operator explicitly bypassed; record audit entry
    try {
      appendOverrideAudit(harnessRoot(), {
        schema_version: '1',
        at: new Date().toISOString(),
        actor: captureIdentity(),
        kind: 'human-override-promote', // closest enum; harness-driver-bypass uses same channel
        reason: `HARNESS-DRIVER-BYPASS [${opts.cliName}]: ${opts.overrideReason}`,
        task_id: opts.taskId ?? 'unknown',
        run_id: opts.runId ?? 'unknown',
        context: { cli: opts.cliName, kind: 'manual-invocation-bypass' },
        pid: process.pid,
        host: os.hostname(),
      });
    } catch (e) {
      console.warn(`[harness-guard] failed to record bypass audit: ${(e as Error).message.slice(0, 100)}`);
    }
    console.log(`[harness-guard] ⚠️ MANUAL INVOCATION BYPASS: ${opts.cliName}`);
    console.log(`  reason: ${opts.overrideReason}`);
    console.log(`  audit:  .agent-runs/_override-audit.jsonl`);
    return;
  }

  // Refuse the invocation
  console.error('');
  console.error('═══════════════════════════════════════════════════════════════');
  console.error(`HARNESS-GUARD: refusing manual invocation of ${opts.cliName}`);
  console.error('═══════════════════════════════════════════════════════════════');
  console.error('');
  console.error('The harness drives the 27-step chain end-to-end. Individual auto:*');
  console.error('CLIs are STEPS in that chain, not standalone tools. Manual invocation');
  console.error('lets you skip steps / re-order steps / bypass guards — defeating the');
  console.error('determinism guarantee that makes the harness regulator-defensible.');
  console.error('');
  console.error('Use the harness driver instead:');
  console.error('  bash scripts/serial-by-module.sh                # drive all modules');
  console.error('  bash scripts/serial-by-module.sh M76            # drive ONE module');
  console.error('  bash scripts/serial-by-module.sh M76 M28 M42    # drive a subset');
  console.error('');
  console.error('The driver runs all 27 stages in the correct order:');
  console.error('  Stage 0     Intake (auto-quorum)');
  console.error('  Stages 1-6  FRD phase    (plan → work → council → postflight → patch? → promote+land)');
  console.error('  Stages 7-13 TRD phase (same 6-step pattern)');
  console.error('  Stages 14-20 Sprint Plan phase (same)');
  console.error('  Stages 21-24 Code-Sprint phase (same)');
  console.error('  Stage 25    Validation memo (named-operator signoff)');
  console.error('  Stage 26    Approval');
  console.error('  Stage 27    Tick + audit pack archive');
  console.error('');
  console.error('Legitimate manual-invocation cases (debugging, recovering parked module,');
  console.error('forensic investigation): pass --override-harness-driver --reason "<≥10 char rationale>".');
  console.error('Bypass is audit-logged to _override-audit.jsonl.');
  console.error('');
  process.exit(8);
}

/**
 * Convenience helper: extract --override-harness-driver from argv.
 * Returns the reason string or undefined.
 */
export function extractOverrideReason(argv: string[]): string | undefined {
  const i = argv.indexOf('--override-harness-driver');
  if (i === -1) return undefined;
  // Look for --reason in argv too (mirrors --human-override / --reason pattern)
  const reasonIdx = argv.indexOf('--reason');
  if (reasonIdx !== -1 && reasonIdx + 1 < argv.length) {
    return argv[reasonIdx + 1];
  }
  // Allow --override-harness-driver=<reason> form
  const arg = argv[i];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  // Bare flag without reason → still triggers the guard
  return '<no-reason-supplied>';
}
