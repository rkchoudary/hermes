# Durable orchestration

This document is for operators who want Hermes to keep working when nobody is
watching — i.e., when the operator's terminal session ends, when the laptop
goes to sleep, or when the box reboots overnight.

The harness ships three independent surfaces that can run autonomously:

- **`pnpm auto:daemon`** — long-running orchestrator. Spawns workers on
  queued tasks, dispatches Codex consensus on `awaiting-review` transitions,
  auto-promotes on Codex GO. **This is the engine.** Without it running,
  queued tasks sit forever.
- **`pnpm auto:tick`** — periodic housekeeping pass. Flushes progress, reaps
  stale workers, drains the path-overlap queue, runs cleanup policies, and
  (with `--auto-promote --auto-land`) drives state transitions for tasks
  that are already in terminal-eligible states. Idempotent + bounded.
- **`pnpm auto:dashboard`** — live SSE dashboard. Read-only. Optional but
  useful for at-a-glance status on a phone or second screen.

In a typical production setup, **the daemon is always running** and **the
tick is fired on a 15-minute cadence** (cron / launchd / systemd timer).

This document explains how to wire that up durably across macOS (launchd),
Linux (systemd), and containers (Docker / docker-compose).

---

## Why this matters

The default Hermes loop is operator-driven: you run `pnpm auto:daemon` in a
terminal, walk away, and it keeps working as long as that process is alive.
But:

- macOS will kill background processes when you log out.
- Linux SSH sessions take their child processes with them on disconnect
  (unless detached via `nohup` / `tmux` / `screen`).
- Laptops sleep. Servers reboot. Power blips.

When the daemon dies, autonomous progress stops cold. The **30 tasks frozen
at `ready-for-merge`** failure mode this document was written to address —
where a sprint of work sat half-shipped because nothing polled the queue — is
exactly what happens when the engine is in a transient operator session.

The fix is to put the daemon under a real process supervisor: launchd on
macOS, systemd on Linux, or Docker with `restart: unless-stopped`.

---

## macOS (launchd)

### Daemon

```bash
# 1. Edit the plist to point at your repo + node binary.
sed -e "s#HERMES_REPO_PATH#$(pwd)#" -e "s#HERMES_NODE_PATH#$(dirname $(which node))/..#" \
  deploy/launchd/com.hermes.daemon.plist > ~/Library/LaunchAgents/com.hermes.daemon.plist

# 2. Load it.
launchctl load ~/Library/LaunchAgents/com.hermes.daemon.plist

# 3. Verify.
launchctl list | grep hermes
tail -f .agent-runs/_launchd-daemon.err.log
```

The daemon will respawn automatically on crash (KeepAlive=SuccessfulExit:
false → respawn unless clean exit).

### Tick (15-minute cadence)

```bash
sed -e "s#HERMES_REPO_PATH#$(pwd)#" -e "s#HERMES_NODE_PATH#$(dirname $(which node))/..#" \
  deploy/launchd/com.hermes.tick.plist > ~/Library/LaunchAgents/com.hermes.tick.plist
launchctl load ~/Library/LaunchAgents/com.hermes.tick.plist
```

`StartInterval=900` fires every 15 minutes. The plist enables `--auto-promote
--auto-land` by default; comment those out if you want dry-run-only mode.

### Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.hermes.{daemon,tick}.plist
rm ~/Library/LaunchAgents/com.hermes.{daemon,tick}.plist
```

---

## Linux (systemd)

```bash
# 1. Create a dedicated unprivileged user.
sudo useradd --system --create-home --shell /usr/sbin/nologin hermes
sudo chown -R hermes:hermes /opt/hermes  # the repo

# 2. Install the units.
sudo cp deploy/systemd/hermes-daemon.service /etc/systemd/system/
sudo cp deploy/systemd/hermes-tick.service /etc/systemd/system/
sudo cp deploy/systemd/hermes-tick.timer /etc/systemd/system/

# 3. Reload + enable + start.
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-daemon
sudo systemctl enable --now hermes-tick.timer

# 4. Verify.
systemctl status hermes-daemon
systemctl list-timers | grep hermes
journalctl -u hermes-daemon -f
journalctl -u hermes-tick -f
```

The systemd units include defense-in-depth hardening (`NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome=read-only`, `PrivateTmp`). The daemon
respawns on crash (`Restart=on-failure`) with a 10-second back-off and a 5/300s
burst limit so a config bug doesn't hot-loop.

`SIGTERM` is honored via the daemon's drain logic — in-flight workers get up
to 5 minutes to finish before the unit is force-killed.

---

## Docker / docker-compose

```bash
# Build the harness-host image.
docker build -f deploy/docker/Dockerfile.harness-host -t hermes-host:latest .

# Or use compose (recommended — composes daemon + tick + volume mounts):
docker compose -f deploy/docker/docker-compose.host.yml up -d
docker compose -f deploy/docker/docker-compose.host.yml logs -f
```

Key design choices:

- **Docker-out-of-Docker.** The harness-host container talks to the host
  Docker daemon via `/var/run/docker.sock`. Workers spawn as sibling
  containers, not nested. This avoids docker-in-docker pain and lets the host
  reap workers if the harness crashes.
- **Read-only `~/.claude` mount.** The daemon invokes `claude --print …`
  against the operator's Claude Code Max subscription. The credentials mount
  is read-only — the daemon can read but never modify them.
- **Persistent `.agent-runs` volume.** All task state, evidence, audit logs
  survive container restarts.
- **`stop_grace_period: 5m`.** SIGTERM kicks the daemon's drain logic;
  Docker waits up to 5 minutes for clean exit.
- **Healthcheck via `_daemon-state.json` mtime.** The daemon writes its
  heartbeat on every poll cycle; the healthcheck fails if mtime is older
  than 2 minutes. Compose can be configured to restart on unhealthy.

### Production posture

For a real production deploy, swap docker-compose for ECS, k8s, or Nomad —
the same Dockerfile.harness-host image works under any. The healthcheck +
graceful shutdown signals are designed to play nicely with orchestrators.

---

## Three-signal opt-in for autonomous transitions

`auto-promote` and `auto-land` are **off by default** in all three deploy
paths. Each transition requires THREE signals to align:

1. **CLI / env signal** — `--auto-promote` flag or `AUTO_AUTO_PROMOTE=1`
   (likewise `--auto-land` / `AUTO_AUTO_LAND=1`)
2. **Per-task policy** — the task's pack must have
   `auto_promote_policy.enabled === true` (or `auto_land_policy.enabled`)
3. **Per-task type allowlist + score floor + consecutive GO** — see
   `src/lib/autoLand.ts` for the full predicate list

For real-merge (vs. dry-run report-only), `auto-land` additionally requires:

- `pack.auto_land_policy.real_merge_enabled === true`, AND
- `--apply-land` flag or `AUTO_AUTO_LAND_APPLY=1`

This three-tier design means an operator can safely run the daemon with all
flags enabled — only the explicit per-task opt-in lets autonomous merge
actually fire. Default-deny semantics; you can't accidentally auto-land
something whose pack doesn't already authorize it.

The recommended rollout:

1. **Week 1**: Deploy daemon + tick with `AUTO_AUTO_PROMOTE=1` only.
   Validate that promotable → ready-for-merge transitions audit cleanly.
2. **Week 2**: Add `AUTO_AUTO_LAND=1`. Eligible tasks now Slack a DRY-RUN
   report ("eligible for auto-land — would run `gh pr merge …`"). No
   actual merge. Verify the eligibility predicates fire correctly.
3. **Week 3**: For one specific low-risk task type (e.g.
   `frd-polish`), set `auto_land_policy.real_merge_enabled = true` AND
   `AUTO_AUTO_LAND_APPLY=1`. Watch one full sprint of real auto-merge.
4. **Week 4+**: Expand the allowlist task-by-task as confidence grows.

Never enable real-merge for a task type whose changes you can't operationally
unwind in under 5 minutes.

---

## Observability

All three deploys write to the same surfaces:

- **`.agent-runs/_state-log.jsonl`** — append-only audit log of every state
  transition. `auto-promote` and `auto-land` each contribute a
  `kind='auto-promote-decision'` / `'auto-land-decision'` entry per
  evaluated task.
- **`.agent-runs/_daemon-state.json`** — daemon heartbeat + active worker
  registry. mtime is the freshness signal.
- **`.agent-runs/_process-registry.json`** — registered child PIDs (for the
  watchdog). Reaped on every tick.
- **Slack** — `[INFO]`, `[ALERT]`, `[CRITICAL]` are routed to the configured
  webhook (or PagerDuty / email; see `notifications.ts`).
- **Live dashboard** — `pnpm auto:dashboard` exposes an SSE stream on port
  4500 by default. The Docker compose file maps it to the host.

If any of those surfaces stops updating, the daemon is wedged — page on
`_daemon-state.json` mtime older than 2× poll-sec.

---

## What this document closes (2026-05-03)

Until this point Hermes had:

- A working daemon (`auto:daemon`) — but operator-driven, no supervisor.
- A working tick (`auto:tick`) — but no scheduled cron / timer.
- A working land (`auto:land`) — but one-shot, no polling loop.

So a typical run looked like:

> Operator runs `auto:daemon` in a tmux pane → walks away → laptop sleeps →
> daemon dies → 30 tasks frozen at `ready-for-merge` → operator returns
> next morning to ZERO autonomous progress.

This document + the new `--auto-land` flag in `tick.ts` + the deploy/ tree
fix that. The `ready-for-merge → merged` transition is now a closed loop
when the tick is supervised by launchd/systemd/Docker.
