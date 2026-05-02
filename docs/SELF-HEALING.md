# Self-Healing & Graceful Resume

> **TL;DR:** Every state transition is an atomic file write to `.agent-runs/<run_id>/state-log.jsonl` (append-only) + per-task JSON overwrite. On crash, kill, or daemon restart, `pnpm auto:resume` reconstructs the entire system state from disk and resumes from the last completed transition. No work is lost; no work is double-done.

This doc answers the operator's question: **what happens if a task fails, the daemon crashes, the machine reboots, or a worker hangs?**

## Crash recovery contract (v0.1 design; v0.2 implementation)

The harness guarantees:

1. **Every state transition is durable before the next action runs.** The pattern is: (a) compute new state, (b) write `state-log.jsonl` append, (c) overwrite `tasks/TP-XXX.json`. If we crash between (a) and (b), the next start sees the OLD state and re-tries the action — the action is idempotent. If we crash between (b) and (c), the next start sees the new state in the log + reconciles the task pack.

2. **All actions are idempotent.** Running `auto:work TP-XXX` twice on the same task produces the same evidence (overwrites the same files). `auto:consensus TP-XXX` twice runs Codex twice but each round increments `rounds_executed` so we don't lose history. `auto:promote TP-XXX` checks if branch is already pushed before pushing again.

3. **Workers checkpoint incrementally.** A worker on a multi-step task writes evidence files as it goes — `evidence/diff.partial.patch`, `evidence/test-summary.partial.md`, etc. — and renames to the final filename on success. If the worker crashes mid-task, the next attempt sees `.partial` files and can decide to resume from the last checkpoint or start over.

4. **No silent corruption.** The state-log uses append-only JSONL; corruption of one entry doesn't poison subsequent entries. Each entry has a sha256 of the previous entry (per workflow-engine hash chain v0.3 pattern) for tamper detection.

5. **Stuck workers are reclaimed.** If a worker's heartbeat is older than `AUTO_DAEMON_WORKER_TIMEOUT_MIN` (default 30 min), the daemon marks the task `needs-revision` with reason `worker_stuck` and re-claims it.

## Failure modes + recovery

### Failure 1: Worker process crashes (segfault, OOM, killed by `kill -9`)

**Symptoms:** No more state transitions for that task. Heartbeat goes stale.

**Detection:** Daemon's `tickLoop()` checks `(Date.now() - worker.started_at) / 60000 > worker_timeout_min` for every active worker.

**Recovery:** Daemon marks the task `needs-revision` with reason `worker_stuck_<duration>`. Worker's partial evidence is preserved in `evidence/*.partial`. On the auto-revise round (or manual revision), the new worker reads the partials and decides: resume from last checkpoint, or restart fresh.

**Prevention:** Workers should checkpoint after each acceptance criterion satisfied (write `evidence/ac-N-complete.txt` with timestamp + summary). The next worker reads these checkpoints to know which AC to start from.

### Failure 2: Daemon process crashes / SIGKILL

**Symptoms:** `auto:daemon` PID is gone. No tick logs in `/var/log/nbf-auto-daemon.log`.

**Detection:** Operator notices via dashboard going stale, OR systemd `Restart=on-failure` directive auto-restarts.

**Recovery:** On daemon startup, the first action is `pnpm auto:resume` (also accessible standalone). This:
1. Scans `.agent-runs/` for runs that aren't marked `completed`
2. For each task in non-terminal state, classifies what to do:
   - `planned` → ready to spawn worker (normal)
   - `claimed` → worker may have died before starting; mark `planned` again
   - `in-progress` → check evidence dir; if `worker-handoff.json` exists, transition to `awaiting-review`; else mark `needs-revision` with reason `daemon_restart_during_work`
   - `awaiting-review` → re-dispatch Codex
   - `codex-reviewing` → check if `/tmp/codex-TP-XXX-rN.md` exists with a verdict; if yes, parse + transition; if no, re-dispatch
   - `needs-revision` → ready to auto-revise (if enabled) or wait for human
   - `promotable` → ready to promote
   - `merged` / `abandoned` → terminal; skip
3. Logs reconciliation actions to `state-log.jsonl` with reason `daemon_restart_recovery`
4. Resumes normal `tickLoop()`

**Prevention:** systemd service file with `Restart=on-failure` + `RestartSec=30`. Daemon checkpoints its own state to `.agent-runs/<latest>/daemon-state.json` every minute.

### Failure 3: Codex CLI call hangs or times out

**Symptoms:** `pnpm auto:consensus TP-XXX` doesn't return; `/tmp/codex-TP-XXX-rN.md` is partial or empty.

**Detection:** The Codex dispatch in `auto:consensus` has a 10-min timeout (`execSync` with `timeout: 10*60*1000`). If it exceeds, the dispatch errors and the task stays in `codex-reviewing`.

**Recovery:** The dispatch wrapper catches the error and:
1. Saves whatever Codex output exists (even if partial) to `evidence/codex-output-r<N>.partial.md`
2. Marks the task `needs-revision` with reason `codex_timeout`
3. On the next round, a fresh Codex call is dispatched (rounds_executed increments)
4. After `max_rounds` consecutive timeouts, escalate to human

**Prevention:** Codex bundle size budget (`max_codex_bundle_kb: 32`) keeps prompts small; smaller prompts = faster Codex completion. The auto-bundle builder validates size before dispatch.

### Failure 4: Anthropic API rate limit / 5xx

**Symptoms:** `auto:work` returns 429 or 5xx from Claude API.

**Detection:** Worker's API call wrapper catches the error.

**Recovery:** Worker retries with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s; max 6 retries). After 6 failures, the worker writes `evidence/api-error.json` with the error details + transitions task to `needs-revision` with reason `anthropic_api_error_<status>`.

**Prevention:** Cost cap (`AUTO_DAEMON_DAILY_BUDGET_USD`) prevents burning through the API quota. Per-tenant rate limit awareness file (future) tracks Anthropic monthly usage.

### Failure 5: Git push fails (network, auth, permission)

**Symptoms:** `auto:promote` fails at the `git push` step.

**Detection:** Promote wrapper catches the exit code.

**Recovery:** 3 retries with backoff. After 3 failures, mark task `awaiting-human-approval` with reason `push_failed_<count>`. The branch and commits are still in the local worktree; operator can inspect and push manually.

**Prevention:** Daemon does `git fetch origin` at startup to validate auth + reachability. Slack alert on first push failure (don't wait for retries to exhaust).

### Failure 6: Disk full

**Symptoms:** Can't write to `.agent-runs/`. Worker crashes with ENOSPC.

**Detection:** Daemon's tick checks `df -h .agent-runs/` every iteration; alerts if < 10% free.

**Recovery:** Daemon pauses new work spawning, alerts operator. Operator runs `auto:cleanup --keep-days 30` to archive old run dirs.

**Prevention:** `auto:cleanup` cron job that keeps last 90 days of `.agent-runs/` + archives older to `.agent-runs-archive/` (which can live on cheaper storage).

### Failure 7: Obsidian vault out of sync (e.g., user manually edited mid-task)

**Symptoms:** Worker's pre-task obsidian-state snapshot doesn't match current state when worker reaches edit step.

**Detection:** Worker checks `obsidian-state.json` SHA before each edit; if mismatch, abort.

**Recovery:** Mark task `needs-revision` with reason `obsidian_drift_detected`. Operator (or auto-resume) re-snapshots Obsidian + re-spawns worker; new worker sees fresh baseline.

**Prevention:** Obsidian snapshot is mandatory pre-task per the user's 2026-04-26 directive. The during-task partial-refresh (`auto:awareness --refresh obsidian --partial M02`) lets workers double-check before each edit.

### Failure 8: Operator wants to pause + restart later

**Symptoms:** Operator runs `kill -SIGTERM $(cat /tmp/auto-daemon.pid)`.

**Behavior:** Daemon SIGTERM handler:
1. Stops accepting new work
2. Waits up to `SIGTERM_GRACE_SEC` (default 60s) for in-flight workers to checkpoint + finish naturally
3. After grace period, marks any still-running tasks with reason `daemon_sigterm`
4. Writes final status to `.agent-runs/<latest>/daemon-stopped.json`
5. Exits 0

On restart:
- Daemon runs `auto:resume` automatically
- All work resumes from where it stopped
- No tasks are lost; no tasks are double-done

## Resume CLI (`pnpm auto:resume`)

```bash
# Default — resume all in-flight tasks across all runs
pnpm auto:resume

# Resume one specific run
pnpm auto:resume --run-id 2026-04-26-batch-1

# Resume one specific task
pnpm auto:resume --task TP-2026-04-26-001

# Dry-run — show what would happen, don't actually transition
pnpm auto:resume --dry-run

# Force re-claim of stuck workers regardless of timeout
pnpm auto:resume --force-reclaim

# Re-snapshot awareness after a long pause
pnpm auto:resume --refresh-awareness
```

## State invariants (verified by `pnpm auto:lint`)

- A task in state `merged` MUST have `codex.verdict == "GO"` OR `codex.verdict == "SIGNOFF-READY"` OR a `notes[]` entry with `human_override: true`
- A task in state `promotable` MUST have a non-null `codex.score` and `codex.score >= consensus.gate_threshold`
- A task in state `awaiting-review` MUST have evidence files: `diff.patch`, `test-summary.md`, `duplicate-scan.json`, `risk-register.md`
- The `state_history` array MUST be in monotonic timestamp order
- Every transition in `state_history` MUST be reflected in the parent run's `state-log.jsonl`
- A task with `worker.type == "manual"` cannot transition past `awaiting-review` without explicit operator action

`pnpm auto:lint` runs these checks on demand or as a CI gate (v0.3).

## Disaster recovery — full restore

If `.agent-runs/` is lost (disk failure, accidental rm -rf):

1. **What's lost:** in-flight task state, evidence files, daemon state, awareness snapshots.
2. **What's preserved:** committed git history (every Codex round committed to PR + change log), Obsidian content (separate disk), Anthropic + Codex output files at `/tmp/codex-*.md` (until reboot).
3. **Recovery steps:**
   - Re-run `pnpm auto:awareness --refresh-all` to rebuild awareness from current state
   - For each PR with in-flight task work, manually create a recovery task pack referencing the PR + last commit
   - Re-spawn workers via `pnpm auto:work --resume-from-pr` (v0.3 milestone)
4. **Prevention:** daily `rsync` of `.agent-runs/` to a separate disk + weekly s3 sync.

## Production-grade resilience checklist (for the operator setting up the daemon)

- [ ] systemd service with `Restart=on-failure` + `RestartSec=30`
- [ ] Per-task evidence backup (rsync `.agent-runs/` to durable storage hourly)
- [ ] PagerDuty integration for stuck-worker alerts (>30 min in same state)
- [ ] Dashboard accessible from outside the home network (Tailscale or ngrok)
- [ ] Slack channel with bot user that posts daemon events
- [ ] Anthropic + Codex API key rotation policy + monitoring
- [ ] Disk-full alerting on `.agent-runs/` partition
- [ ] Network egress allowlist for Anthropic + GitHub + Vercel APIs
- [ ] Read-only Neon scratch branch for safe duplicate-scan SELECT queries
- [ ] Backup of Obsidian vault (separate from repo backup)

## What gracefully resumes vs what requires human

**Gracefully resumes (no human):**
- Daemon restart
- Worker crash (auto-revise once)
- Codex timeout (re-dispatch on next tick)
- API 5xx (exponential backoff retry)
- Git push transient failure (3 retries)
- Disk-full pause + cleanup

**Requires human (escalation alert):**
- 2 consecutive Codex NO-GO verdicts on same task
- Worker stuck despite reclaim
- API auth failure (`401 Unauthorized` — can't be retried)
- Git push 4xx error (auth or permission)
- Disk-full after auto-cleanup
- Obsidian vault drift detected during task
- Any task with `requires_human_approval: true` (security, deploys, secrets)

The operator gets Slack alerts + dashboard surfaces these for review. The harness keeps making progress on everything else while the human handles the escalations.
