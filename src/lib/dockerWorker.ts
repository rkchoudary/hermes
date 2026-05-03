/**
 * Layer 6 — Docker worker spawn helper.
 *
 * Doctrine: workers are isolated by default. When AUTO_WORKER_USE_DOCKER=1,
 * src/cli/work.ts uses spawnWorkerInDocker() instead of spawn('claude', …)
 * so the worker runs inside a hermes-worker container with:
 *
 *   - 4 GB RAM + 2 CPU + 256 PIDs caps
 *   - read-only filesystem (only /work + /evidence are writable)
 *   - egress restricted to the hermes-egress-allowlist bridge
 *   - claude max plan auth + gh auth volume-mounted from host (read-only)
 *   - the per-module worktree bind-mounted at /work
 *
 * Kill: `docker kill <name>` reaps the entire process tree atomically;
 * supersedes B1's process-group trick when running in this mode.
 *
 * v0 (this layer): the helper exposes the spawn args. Wire-in to
 * src/cli/work.ts gated behind AUTO_WORKER_USE_DOCKER=1 so the default
 * non-docker path (with B1 + L4.A + L4.B) keeps working unchanged.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

export interface DockerSpawnOptions {
  /** Used as the container name; derived from task_id. */
  taskId: string;
  /** Worktree mounted at /work in the container (rw). */
  worktreeHostPath: string;
  /** Evidence dir mounted at /evidence (rw). */
  evidenceHostPath: string;
  /** Image tag (default hermes-worker:latest). */
  image?: string;
  /** Memory cap (default 4g). */
  memory?: string;
  /** CPU cap in cores (default 2). */
  cpus?: number;
  /** PID cap (default 256). */
  pidsLimit?: number;
  /** Network name (default hermes-egress-allowlist). */
  network?: string;
  /** Args passed AFTER the image (claude --print + flags). */
  workerArgs: string[];
  /** Stdin contents (the worker prompt). */
  stdin: string;
  /** Optional env vars to forward into the container. */
  env?: Record<string, string>;
}

export interface DockerSpawnHandles {
  child: ChildProcess;
  containerName: string;
  /** Kill the container directly (reaps tree). */
  kill: (signal: NodeJS.Signals) => void;
}

const DEFAULT_IMAGE = process.env.AUTO_WORKER_DOCKER_IMAGE || 'hermes-worker:latest';
const DEFAULT_NETWORK = process.env.AUTO_WORKER_DOCKER_NETWORK || 'hermes-egress-allowlist';
const DEFAULT_MEMORY = process.env.AUTO_WORKER_DOCKER_MEMORY || '4g';
const DEFAULT_CPUS = parseFloat(process.env.AUTO_WORKER_DOCKER_CPUS || '2');
const DEFAULT_PIDS_LIMIT = parseInt(process.env.AUTO_WORKER_DOCKER_PIDS_LIMIT || '256', 10);

export function buildDockerArgs(opts: DockerSpawnOptions): { containerName: string; args: string[] } {
  const containerName = `hermes-worker-${opts.taskId.toLowerCase()}-${Date.now()}`;
  const home = os.homedir();
  // claude max plan auth on macOS lives in Keychain Services. The
  // extractor (docker/extract-claude-creds.sh) reads it out into a
  // file the Linux container can mount. Default path matches the
  // extractor's output.
  const credsPath = process.env.HARNESS_CLAUDE_CREDS_PATH
    ?? path.join(home, '.harness', 'claude-credentials.json');
  // NOTE: --read-only is intentionally OMITTED. claude-code-cli refreshes
  // OAuth tokens on demand and writes the new accessToken back to its
  // credentials file. With --read-only + a :ro credentials mount, that
  // write fails silently and claude exits 1s with no output (verified
  // 2026-05-03 drive test).
  //
  // Blast-radius is still contained: the only host paths the container
  // can write to are the explicit bind mounts (/work, /evidence, and the
  // credentials file). The container's own filesystem layer is
  // copy-on-write and dropped on --rm exit. Other host paths are
  // unreachable.
  //
  // The credentials mount is RW (not :ro) so claude can persist refreshed
  // tokens — which is desirable: the host file stays in sync with the
  // newest accessToken, and the next host-side claude call doesn't need
  // a fresh extraction from Keychain.
  const args: string[] = [
    'run',
    '--rm',
    '--name', containerName,
    '--network', opts.network ?? DEFAULT_NETWORK,
    '--memory', opts.memory ?? DEFAULT_MEMORY,
    '--cpus', String(opts.cpus ?? DEFAULT_CPUS),
    '--pids-limit', String(opts.pidsLimit ?? DEFAULT_PIDS_LIMIT),
    // Worktree (rw) — claude reads + writes here
    '-v', `${opts.worktreeHostPath}:/work:rw`,
    // Evidence dir (rw) — diff.patch, test-summary.md, etc.
    '-v', `${opts.evidenceHostPath}:/evidence:rw`,
    // Claude max plan credentials (RW so token refresh round-trips back
    // to the host file).
    '-v', `${credsPath}:/home/worker/.claude/.credentials.json:rw`,
    // gh CLI auth (ro is fine — gh refreshes don't round-trip)
    '-v', `${path.join(home, '.config/gh')}:/home/worker/.config/gh:ro`,
    // Don't mount ssh keys — force HTTPS auth for git
    // stdin in/stdout/stderr piped via -i (interactive but non-tty)
    '-i',
  ];
  // Forward selected env vars
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    args.push('-e', `${k}=${v}`);
  }
  args.push(opts.image ?? DEFAULT_IMAGE);
  args.push(...opts.workerArgs);
  return { containerName, args };
}

export function spawnWorkerInDocker(opts: DockerSpawnOptions): DockerSpawnHandles {
  const { containerName, args } = buildDockerArgs(opts);
  const child = spawn('docker', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.stdin) {
    child.stdin.write(opts.stdin);
    child.stdin.end();
  }
  return {
    child,
    containerName,
    kill: (signal: NodeJS.Signals) => {
      // `docker kill` is the canonical reap (atomic over process tree).
      // If docker daemon is unreachable, fall back to direct child.kill.
      try {
        spawn('docker', ['kill', '--signal', signal, containerName], { detached: true }).unref();
      } catch {
        try { child.kill(signal); } catch { /* gone */ }
      }
    },
  };
}

/**
 * Pre-flight check: docker daemon reachable + image present + network set up.
 * Returns null on green; descriptive string on fail. Called by auto:work
 * when AUTO_WORKER_USE_DOCKER=1 is set, before the first dispatch.
 */
export async function dockerPreflightCheck(image?: string, network?: string): Promise<string | null> {
  const img = image ?? DEFAULT_IMAGE;
  const net = network ?? DEFAULT_NETWORK;
  // Docker reachable?
  const versionResult = await runCmd('docker', ['version', '--format', '{{.Server.Version}}']);
  if (versionResult.exitCode !== 0) {
    return `docker daemon unreachable: ${versionResult.stderr || 'unknown'}`;
  }
  // Image present?
  const imageResult = await runCmd('docker', ['image', 'inspect', img]);
  if (imageResult.exitCode !== 0) {
    return `docker image ${img} not found locally — build with: docker build -t ${img} -f docker/Dockerfile .`;
  }
  // Network exists?
  const netResult = await runCmd('docker', ['network', 'inspect', net]);
  if (netResult.exitCode !== 0) {
    return `docker network ${net} not found — run: bash docker/setup-egress-bridge.sh`;
  }
  // Auth: extracted credentials file (macOS Keychain → file) + gh dir.
  const home = os.homedir();
  const fs = await import('node:fs');
  const credsPath = process.env.HARNESS_CLAUDE_CREDS_PATH
    ?? path.join(home, '.harness', 'claude-credentials.json');
  if (!fs.existsSync(credsPath)) {
    return `${credsPath} not found — run docker/extract-claude-creds.sh to extract claude max plan auth from Keychain (macOS) or run 'claude' once on Linux to populate ~/.claude/.credentials.json (then symlink to ${credsPath})`;
  }
  if (!fs.existsSync(path.join(home, '.config/gh'))) {
    return `~/.config/gh not found on host — gh CLI must be authenticated locally (run \`gh auth login\`)`;
  }
  return null;
}

function runCmd(cmd: string, args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on('error', () => resolve({ exitCode: 1, stdout, stderr: 'spawn error' }));
  });
}
