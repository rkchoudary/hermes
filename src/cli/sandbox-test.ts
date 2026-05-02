#!/usr/bin/env node
/**
 * pnpm auto:sandbox-test
 *
 * Smoke-test the Docker sandbox plumbing without dispatching a real worker.
 * Sets AUTO_USE_SANDBOX=1 (if not already set), checks docker availability,
 * runs `node --version` inside the configured image with the project bind
 * mount, and reports pass/fail with diagnostics.
 *
 * Use this once after enabling sandbox mode to verify your setup:
 *   docker pull node:22-bookworm
 *   AUTO_USE_SANDBOX=1 pnpm auto:sandbox-test
 *
 * Then for actual worker dispatch, sandbox is automatic when
 * AUTO_USE_SANDBOX=1 is set.
 */
import { readSandboxConfig, isDockerAvailable, sandboxSelfTest } from '../lib/sandbox';

function main(): void {
  console.log('Hermes sandbox self-test');
  console.log('');

  if (!process.env.AUTO_USE_SANDBOX) {
    process.env.AUTO_USE_SANDBOX = '1';
    console.log('  AUTO_USE_SANDBOX not set in env; defaulting to 1 for this test.');
  }

  const cfg = readSandboxConfig();
  console.log(`  Enabled:      ${cfg.enabled}`);
  console.log(`  Image:        ${cfg.image}`);
  console.log(`  Memory cap:   ${cfg.memoryLimit}`);
  console.log(`  CPU cap:      ${cfg.cpuLimit}`);
  console.log(`  Network:      ${cfg.networkAllowed ? 'allowed' : 'isolated (--network=none)'}`);
  console.log(`  Extra mounts: ${cfg.extraMounts.length}`);
  console.log('');

  if (!isDockerAvailable()) {
    console.error('✗ docker CLI not found on PATH.');
    console.error('  Install Docker Desktop (mac) or docker-ce (linux) and re-run.');
    process.exit(1);
  }
  console.log('✓ docker CLI available');

  console.log('  Running node --version in sandbox…');
  const r = sandboxSelfTest();
  if (!r.ok) {
    console.error(`✗ sandbox run failed: ${r.error || 'unknown'}`);
    console.error('');
    console.error('  Common causes:');
    console.error(`    - Image ${cfg.image} not pulled. Try: docker pull ${cfg.image}`);
    console.error('    - Docker daemon not running.');
    console.error('    - Project root not accessible to Docker (check Docker Desktop file sharing).');
    process.exit(2);
  }
  console.log(`✓ sandbox run succeeded — node ${r.output}`);
  console.log('');
  console.log('Sandbox mode is operational. Set AUTO_USE_SANDBOX=1 in your shell to');
  console.log('route worker dispatch through the container.');
}

main();
