# Harness Debugging — Standard Operating Procedure

Last updated: 2026-05-02 (Sprint M v2 final)

## Quick triage flowchart

```
Driver alive?  →  No  →  [SECTION 1: Driver crashed]
        ↓ Yes
Branch correct? → No  →  [SECTION 2: Worktree hijack]
        ↓ Yes
KILL_SWITCH? → Yes → [SECTION 3: Kill switch tripped]
        ↓ No
Modules parking 100%? → Yes → [SECTION 4: All parking]
        ↓ No
Throughput collapsed? → Yes → [SECTION 5: Slow workers]
        ↓ No
PRs not merging? → Yes → [SECTION 6: PR merge stuck]
```

---

## Section 1: Driver crashed

**Symptom:** `pgrep -af "parallel-by-module|serial-by-module"` returns empty.

**Diagnose:**
```bash
# Check log tail for last activity
tail -30 /tmp/harness-runs/parallel-worker-*-*.log
# Check for kill switch
ls $HERMES_PROJECT_ROOT/.agent-runs/_KILL_SWITCH
# Check for orphaned workers
pgrep -af "auto:work TP-2026" | head
pgrep -af "claude --print" | head
```

**Fix:**
1. Kill any orphan workers: `pkill -KILL -f "auto:work TP-2026|claude --print"`
2. If kill switch exists: `pnpm auto:kill-off`
3. Clear escalations: `pnpm auto:escalate clear --by "harness-restart"`
4. Restart: `bash scripts/parallel-by-module.sh 2` (N=2 default)

**Common root causes:**
- Sprint M files lost mid-write → check `git stash list` for rescue stashes; recover via `git stash pop stash@{0}`
- KILL_SWITCH tripped by stale heartbeat escalations on April-27 zombie tasks → archive zombies via `mv .agent-runs/2026-04-27-batch-1/tasks/TP-2026-04-27-{103,111}.json _archived-zombies/`
- Driver process killed externally → check macOS Activity Monitor or `ps -ef`

---

## Section 2: Worktree hijack (CRITICAL)

**Symptom:** `git -C $HERMES_PROJECT_ROOT branch --show-current` returns wrong branch (not `<your-feature-branch>`).

**Diagnose:**
```bash
git -C $HERMES_PROJECT_ROOT status
git -C $HERMES_PROJECT_ROOT stash list | head -3
```

**Fix (auto-rollback path — Sprint K v2):**
The HEAD guard in `work.ts:680` should auto-roll back. If manual recovery needed:
```bash
git -C $HERMES_PROJECT_ROOT stash --include-untracked -m "manual-rescue-$(date -u +%FT%TZ)"
git -C $HERMES_PROJECT_ROOT checkout <your-feature-branch>
git -C $HERMES_PROJECT_ROOT stash pop
```

**Prevention:** Run with `AUTO_WORKER_RESTRICTED=1` — denies `git stash`/`clean`/`checkout`/`reset` at the subagent layer.

---

## Section 3: Kill switch tripped

**Symptom:** Driver exits with `KILL SWITCH active; stopping run`. File `.agent-runs/_KILL_SWITCH` exists.

**Diagnose:**
```bash
cat .agent-runs/_KILL_SWITCH
pnpm auto:escalate status
tail -10 .agent-runs/_escalation-log.jsonl
```

**Fix:**
1. Identify root cause from escalation reason (most common: stale heartbeat on zombie tasks)
2. Park or archive offending task records:
   ```bash
   for t in TP-2026-04-27-103 TP-2026-04-27-111; do
     mv .agent-runs/2026-04-27-batch-1/tasks/$t.json .agent-runs/2026-04-27-batch-1/tasks/_archived-zombies/
   done
   ```
3. Clear: `pnpm auto:kill-off && pnpm auto:escalate clear --by "operator-cleared"`
4. Restart driver

**Watchdog tuning:** Stale-heartbeat threshold is in `processWatchdog.ts`. Default reaper window may need extension if tasks legitimately run >2 hours.

---

## Section 4: All modules parking

**Symptom:** `★ ALL 28 STEPS RAN` count = 0 over multiple modules; PARK count growing.

**Diagnose per module:**
```bash
# Find latest parked task
tail -10 .agent-runs/_parked-modules.jsonl
# Inspect failed postflight
ls -t /tmp/serial-TP-2026-05-02-*-postflight*.log | head -3 | xargs grep "Post-flight FAIL"
# Cognitive recovery firing?
grep "COGNITIVE RECOVERY" /tmp/harness-runs/parallel-worker-*.log | tail -5
```

**Common fixes:**

| Failure | Fix |
|---|---|
| `ac_coverage` failed | FRD has too few/missing acceptance criteria tokens; manual edit FRD or accept park |
| `citations` failed | Imprecise regulatory citations; mechanical fixer should auto-correct (lib/mechanicalFix.ts) |
| `reciprocity` failed | Cross-module reference missing — paired modules must reference each other in §13 |
| `frontmatter` failed | YAML frontmatter malformed — check `status:` and `version:` |
| All workers exit=143 | Anthropic API rate-limited; back off + retry |

**Park-forever modules** (cognitive recovery doesn't converge):
- Check `evidence/<task>/sod-shadow-review.json` for shadow reviewer's `top_concern`
- Check `evidence/<task>/_bug-review.json` if diagnose ran — what fix-bugs strategy was tried
- Last resort: `SERIAL_FORCE_REDO=1 SERIAL_DISABLE_COGNITIVE_RECOVERY=1 bash scripts/serial-by-module.sh M<NN>` to force fresh attempt

---

## Section 5: Slow workers / throughput collapsed

**Symptom:** Modules taking >60 min wall (vs ~25 min/module-pair expected at parallel N=2).

**Diagnose:**
```bash
# Worker etime
ps -o pid,etime,command -p $(pgrep -f "auto:work TP-2026")
# claude --print CPU%
ps -o pid,etime,%cpu,command -p $(pgrep -f "claude --print")
# API rate limit signal
grep "rate.limit\|429" /tmp/harness-runs/parallel-worker-*.log | tail
```

**Common causes:**

| Cause | Fix |
|---|---|
| claude --print 0% CPU for >5 min (network-bound, API stalled) | Wait for 30-min hang threshold → self-healing kicks in |
| Multi-driver fighting for API quota | Reduce parallel N: `bash scripts/parallel-by-module.sh 1` (serial mode) |
| Disk full | `df -h ~` — should have >20 GB free; clean `.agent-runs/<run>/_workspaces/`; rotate `/tmp/harness-runs/*.log` |
| LLM choosing wrong tier | Check `[claude-code-cli] model=claude-sonnet-4-6 (tier-routed for type=...)` log; `AUTO_FORCE_MODEL` overrides |
| Memory pressure | `top -l 1 -n 0 -s 0` — if compressor ratio >5, kill some Claude processes; reduce N |

---

## Section 6: PRs not merging

**Symptom:** `★ ALL 28 STEPS RAN` but `Stage 28 Auto-merge: merged=0 skipped=N` consistently.

**Diagnose:**
```bash
# CI status
gh pr list --state open --limit 10 --json number,headRefName,mergeStateStatus,statusCheckRollup
# Specific PR
gh pr view <PR#> --json mergeable,mergeStateStatus,statusCheckRollup
```

**Common causes:**

| Cause | Symptom | Fix |
|---|---|---|
| CI still running | `mergeStateStatus=UNSTABLE` | Wait; Stage 28 polls up to 10 min for impl PRs, 3 min for doc PRs |
| Branch protection rule failing | `BLOCKED` | Check rule (likely `require_codex_go` or `require_sod_satisfied`); use `--admin` bypass with `AUTO_FORCE_REASON` |
| CI failed | `BLOCKED` after CI run | Check failed check; if expected (e.g., known-fail in pre-customer phase), use `gh pr merge --merge --admin` |
| Council blocking on (`AUTO_COUNCIL_BLOCKING=1`) | `cur_state=COUNCIL_BLOCKED` | Inspect council sidecar; if score is acceptable, set status manually |

---

## Recovery commands cheatsheet

| Command | Purpose |
|---|---|
| `pnpm auto:kill-off` | Clear KILL_SWITCH |
| `pnpm auto:escalate clear --by NAME` | Clear all open escalations |
| `pnpm auto:rollback M21` | Open revert PRs for module |
| `pnpm auto:council-sweep --auto-rollback` | Find merged-but-failed and revert |
| `pnpm auto:tick --verbose` | Force state recompute + see queue stats |
| `pnpm auto:resurrect` | Auto-recovery from crash (existing, separate path) |
| `pnpm auto:dashboard-live` | Spin up live HTTP UI on :7777 |
| `pnpm auto:engine-list` | Show which LLM engines are PATH-available |
| `bash scripts/parallel-by-module.sh 4` | Parallel N=4 driver |
| `SERIAL_FORCE_REDO=1 bash scripts/serial-by-module.sh M21` | Force re-author of M21 (skip idempotency) |

## Environment variables

| Var | Effect |
|---|---|
| `AUTO_HARNESS_DRIVER=1` | Required by all `auto:*` CLIs (the script sets this) |
| `AUTO_WORKER_RESTRICTED=1` | Replace `--dangerously-skip-permissions` with allow-list (RECOMMENDED for prod) |
| `MODULE_TIMEOUT_SEC=5400` | Per-module wall-clock budget (default 90 min) |
| `SERIAL_DEFER_CODE_SPRINT=0` | Code-sprint phase active (default; set to 1 to skip impl) |
| `SERIAL_DISABLE_COGNITIVE_RECOVERY=1` | Disable EXARCHON-pattern recovery |
| `SERIAL_FORCE_REDO=1` | Force re-author even if state=promotable/ready-for-merge/merged |
| `AUTO_MIN_COVERAGE=70` | Code-sprint coverage threshold (% blocking) |
| `AUTO_SOD_SHADOW_BLOCKING=1` | SoD shadow reviewer blocks on REJECT |
| `AUTO_COUNCIL_BLOCKING=1` | Stage 28 waits for council sidecar pass |
| `AUTO_FORCE_REASON="..."` | Required when `--force` bypasses any gate (SOX audit) |
| `AUTO_FORCE_MODEL=claude-opus-4-7` | Override tier-based model routing |
| `AUTO_CLAUDE_MODEL_TIER2=claude-sonnet-4-6` | Tier-2 model override |
| `AUTO_CLAUDE_MODEL_TIER3=claude-haiku-4-5` | Tier-3 model override |

## Log locations

| File | Purpose |
|---|---|
| `/tmp/harness-runs/parallel-worker-{0,1}-*.log` | Per-worker driver logs |
| `/tmp/harness-runs/all-modules-driver-*.log` | Single-driver run logs |
| `/tmp/serial-TP-*-{plan,work,patch-r{1,2,3},postflight,promote,land}.log` | Per-task per-step logs |
| `.agent-runs/<run>/tasks/<task>.json` | Task pack (state machine of record) |
| `.agent-runs/<run>/evidence/<task>/` | Evidence dir (diff.patch, test-summary.md, postflight.json, council/, etc) |
| `.agent-runs/_audit/council/<mod>/<phase>/<ver>.json` | Council sidecar (async result) |
| `.agent-runs/_override-audit.jsonl` | Every governance bypass (SOX evidence) |
| `.agent-runs/_escalation-log.jsonl` | Watchdog escalations |
| `.agent-runs/_parked-modules.jsonl` | Parked tasks (operator drains via Stage 25 memo) |
| `.agent-runs/_skill-memory/<phase>.jsonl` | Hermes-pattern producer log |
| `.agent-runs/_council-watchdog.jsonl` | Periodic sweep history |

## Stage reference

| # | Stage | Block on |
|---|---|---|
| 0 | Intake create + approve | n/a |
| 1 | FRD (skip if FRD-GO) | postflight |
| 2 | TRD (work + council + postflight + 1 patch) | postflight |
| 3 | Sprint Plan (same) | postflight |
| 4 | Code-Sprint (work + council + postflight + 3 patches + cognitive recovery) | postflight |
| 4a | Lint (`pnpm lint`) | errors |
| 4b | Tests (`pnpm test`) (code-sprint only) | failures |
| 4b-cov | Coverage gate (≥70% for code-sprint) | below threshold |
| 4b-sod | SoD shadow reviewer (advisory unless `AUTO_SOD_SHADOW_BLOCKING=1`) | shadow REJECT |
| 4c | Dep audit (`pnpm audit --prod`) (code-sprint) | HIGH/CRITICAL CVEs (allow-list checked) |
| 4d | security-check.json | HIGH/CRITICAL severity |
| 5 | Commit | git commit failure |
| 5b | Branch hygiene (>10 commits ahead = block) | drift |
| 6 | Push (--force-with-lease, HEAL-2 retry) | network |
| 25 | Validation memo (auto-sign) | n/a |
| 26 | Approval (auto-sign) | n/a |
| 27 | Tick + audit pack archive | n/a |
| 28 | Auto-merge module PRs (waits for CI green ≤10 min) | not CLEAN |
| 29 | Staging deploy (`auto:deploy-staging`) | smoke test fail |

## When to escalate to human (operator drain)

- Module parked >7 days
- Council sidecar `status=failed` with score <3.0
- Coverage <50%
- Security severity=CRITICAL not in allow-list
- Branch protection bypass attempted >3 times in 24h

## Sprint K + L + M v2 hardening (the "what's protecting you" list)

1. Worktree HEAD guard (`work.ts`)
2. Untracked-file deletion guard (`work.ts`)
3. Per-module 90-min timeout (`drive_phase`)
4. 3-round patch cap for code-sprint
5. Cognitive recovery (EXARCHON pattern)
6. Multi-model routing
7. Lint + test + coverage + audit + security blocking gates
8. SoD shadow reviewer
9. Strict CI-green wait Stage 28
10. Skill memory consumer
11. Council retroactive watchdog
12. Stage 29 staging deploy
13. CVE allow-list with expiry
14. Restricted-permissions mode (denies dangerous git ops)
15. Async council sidecar (Codex #1)
16. Loud module summary (Codex #4)
17. Idempotent re-fire (Codex #3)
18. KILL_SWITCH operator override
19. Branch hygiene (>10 commit refusal)
20. Empty-patch handling (external-doc-resident artifacts)
21. Override-audit log (every bypass recorded)

If you've checked all 21 and the harness still misbehaves, file an issue with: log tail (50 lines), tick output, branch + Sprint M file checks, and `git status` of harness worktree.
