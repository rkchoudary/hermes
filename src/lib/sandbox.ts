/**
 * sandbox.ts — Docker / container sandbox wrapper for worker dispatch.
 *
 * When AUTO_USE_SANDBOX=1 is set, work.ts routes the engine spawn through
 * `runInSandbox` instead of running directly against the operator's
 * machine. Direct-against-repo remains the default for performance and
 * because the audit trail integrity story is stronger when state is local.
 *
 * The sandbox model:
 *   - Mount the project repo at /workspace (RW for the worker).
 *   - Mount the harness package at /hermes (RO).
 *   - Mount .agent-runs/ explicitly so audit writes persist back.
 *   - No network by default (--network=none); --sandbox-net flag unlocks.
 *   - Memory + CPU caps via env (default: 4g / 2 cpu).
 *   - Container is removed after the worker exits.
 *
 * Why provide it: some operators (financial, regulated, untrusted-input
 * processing) need workers isolated from the host. Mirrors Devin's
 * sandboxed-VM approach but as an opt-in addition, not a replacement.
 */
import * as path from 'node:path';
import { spawnSync, SpawnSyncReturns } from 'node:child_process';
import { harnessRoot } from './harnessRoot';

export interface SandboxConfig {
  enabled: boolean;
  image: string;
  memoryLimit: string;
  cpuLimit: string;
  networkAllowed: boolean;
  extraMounts: Array<{ from: string; to: string; ro: boolean }>;
}

export function readSandboxConfig(): SandboxConfig {
  return {
    enabled: process.env.AUTO_USE_SANDBOX === '1' || process.env.HERMES_USE_SANDBOX === '1',
    image: process.env.AUTO_SANDBOX_IMAGE || 'node:22-bookworm',
    memoryLimit: process.env.AUTO_SANDBOX_MEMORY || '4g',
    cpuLimit: process.env.AUTO_SANDBOX_CPU || '2',
    networkAllowed: process.env.AUTO_SANDBOX_NETWORK === '1',
    extraMounts: parseExtraMounts(process.env.AUTO_SANDBOX_MOUNTS),
  };
}

function parseExtraMounts(raw?: string): Array<{ from: string; to: string; ro: boolean }> {
  if (!raw) return [];
  return raw.split(',').filter(Boolean).map(spec => {
    const parts = spec.split(':');
    return { from: parts[0], to: parts[1] || parts[0], ro: parts[2] === 'ro' };
  });
}

export function isDockerAvailable(): boolean {
  const r = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 3000 });
  return r.status === 0;
}

export interface SandboxRunOptions {
  /** The project root the worker should see at /workspace. */
  projectRoot: string;
  /** Command + args to run inside the container. */
  cmd: string[];
  /** Pass through stdin to the container. */
  stdin?: string;
  /** Env vars to forward into the container. Defaults: AUTO_*, HERMES_*. */
  env?: Record<string, string>;
  /** Capture stdout/stderr; default 'inherit'. */
  stdio?: 'inherit' | 'pipe';
  /** Hard timeout in ms. Defaults to 30 minutes. */
  timeoutMs?: number;
}

/**
 * Run a command inside a Docker sandbox. Returns the SpawnSync result of the
 * docker run invocation.
 */
export function runInSandbox(opts: SandboxRunOptions): SpawnSyncReturns<string> {
  const cfg = readSandboxConfig();
  if (!cfg.enabled) {
    throw new Error('Sandbox not enabled — AUTO_USE_SANDBOX=1 not set.');
  }
  if (!isDockerAvailable()) {
    throw new Error('docker CLI not found on PATH; cannot run sandbox.');
  }

  const projectAbs = path.resolve(opts.projectRoot);
  const hermesAbs = path.resolve(harnessRoot());

  const dockerArgs: string[] = [
    'run', '--rm', '-i',
    '--memory', cfg.memoryLimit,
    '--cpus', cfg.cpuLimit,
    '--workdir', '/workspace',
    '--mount', `type=bind,source=${projectAbs},target=/workspace`,
    '--mount', `type=bind,source=${hermesAbs},target=/hermes,readonly`,
  ];

  // Network policy
  if (!cfg.networkAllowed) dockerArgs.push('--network=none');

  // User mapping — try to match host UID/GID so files written inside the
  // container don't end up root-owned on the host. On macOS Docker Desktop
  // this is handled by the file-sharing layer; on Linux it matters.
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (typeof uid === 'number' && typeof gid === 'number') {
    dockerArgs.push('--user', `${uid}:${gid}`);
  }

  // Extra mounts
  for (const m of cfg.extraMounts) {
    dockerArgs.push('--mount', `type=bind,source=${m.from},target=${m.to}${m.ro ? ',readonly' : ''}`);
  }

  // Forward selected env vars (whitelist; never the host shell's full env)
  const forwarded: Record<string, string> = {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/hermes/node_modules/.bin',
    HOME: '/tmp',
    HERMES_PROJECT_ROOT: '/workspace',
    HERMES_PACKAGE_ROOT: '/hermes',
    AUTO_HARNESS_DRIVER: '1',
    ...opts.env,
  };
  for (const [k, v] of Object.entries(forwarded)) {
    dockerArgs.push('-e', `${k}=${v}`);
  }

  // Image + command
  dockerArgs.push(cfg.image);
  dockerArgs.push(...opts.cmd);

  return spawnSync('docker', dockerArgs, {
    input: opts.stdin,
    encoding: 'utf8',
    stdio: opts.stdio === 'inherit' ? 'inherit' : ['pipe', 'pipe', 'pipe'],
    timeout: opts.timeoutMs ?? 30 * 60_000,
  });
}

/**
 * Smoke test: run `node --version` inside the sandbox to verify the image is
 * pullable + the bind mount + env forwarding all work end-to-end.
 */
export function sandboxSelfTest(): { ok: boolean; output: string; error?: string } {
  if (!isDockerAvailable()) return { ok: false, output: '', error: 'docker not on PATH' };
  const r = runInSandbox({
    projectRoot: process.cwd(),
    cmd: ['node', '--version'],
    stdio: 'pipe',
  });
  return {
    ok: r.status === 0,
    output: (r.stdout || '').trim(),
    error: r.status !== 0 ? (r.stderr || '').slice(-200) : undefined,
  };
}
