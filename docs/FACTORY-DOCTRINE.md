# FACTORY-DOCTRINE.md

The 8 load-bearing principles for the Hermes harness. Every CLI, every
stage, every state transition derives from these. PRs touching the
harness MUST cite which principles they interact with.

## 1. The driver never infers semantics from exit code alone

Exit code = transport success / process crash. Business outcomes live in
the typed `StageOutcome` envelope (`__STAGE_OUTCOME__::` magic line).
Stages emit; drivers parse. No driver decision (advance, patch-round,
park, etc.) is made on raw exit code alone — only on the typed envelope.

When no envelope is present, the driver synthesizes an
`infrastructure-error` envelope and routes to the operator (it does NOT
treat as failure or success).

## 2. Every state transition is an append-only, schema-validated event with an idempotency key

Side effects (writing TaskPack state, recording spend, emitting evidence,
opening PR) happen ONLY after admission control passes:

- Budget reservation (Layer 1 `reserveBudget`)
- Permission (Layer 0 stage registry permissions list)
- Dependency (Layer 7 DAG: predecessor stages completed)
- Disk (Layer 7 admission: estimated worktree + build artifacts < free)
- Kill-switch (`.agent-runs/_KILL_SWITCH` + `_BUDGET_CIRCUIT_BREAKER`)

Idempotency: `(module, stage, version, FRD-sha, harness-version)` hashes
to a stable plan ID via `computePlanId`. Re-running with the same
inputs returns the same task pack — never spawns a duplicate.

## 3. No hot-path component rewrites authoritative state without the state lock or event log

`TaskPack` writes go through `withTaskPackLock`. High-frequency progress
goes to the append-only sidecar (`evidence/<task_id>/_progress.jsonl`).
Reservation events go to the append-only `_reservations.jsonl`.
State-log entries chain via sha256.

Codex caught the original bug: pre-Layer-5, `auto:work` rewrote the
whole TaskPack at 1Hz to update `partial_progress`, with no lock. Fine
in serial; lost-update footgun in parallel. Sidecar split closed it.

## 4. Watchdogs trip on no-progress, not total elapsed

A worker with no observable activity for 5 minutes is dead — regardless
of its 45-min total ceiling. Layer 4.A enforces a 3-tier ladder:

- 2 min no progress → log warning
- 5 min no progress → SIGTERM process group (with B1 detached spawn)
- 7 min no progress → SIGKILL process group (or 30s after SIGTERM)

"No progress" = no stdout chunk AND no edit count delta AND no tool-call
count delta. Configurable via `AUTO_NO_OUTPUT_*_SEC`.

Layer 4.B adds a plateau detector for inter-round progress: identical
failure shapes across consecutive rounds → abort patch loop and pivot
to cognitive recovery.

## 5. Workers are isolated by default

One worktree + one container per dispatch (Layer 6 Docker). Host
filesystem is never the recovery target.

Why the container layer matters even with worktree-guard already in
place: Sprint M v2 had a real incident where a subagent ran
`git stash --include-untracked` and wiped operator files mid-spawn.
Guard rolled back post-hoc. A container would have prevented filesystem
damage from reaching the host at all.

Default mode (without `AUTO_WORKER_USE_DOCKER=1`) still uses B1's
detached process-group kill + worktree HEAD guard — these are the
fallback when Docker isn't available. Unattended overnight fan-outs
should always use container mode.

## 6. Cost is a precondition, not a post-mortem

Layer 1 `reserveBudget()` runs BEFORE every dispatch. `recordSpend()` /
`releaseReservation()` finalize. If the meter is unavailable, FAIL CLOSED
for new LLM work — never silently dispatch when we can't measure.

Caps enforced in priority order: circuit-breaker → per-task → per-day
→ rate-of-change. Emergency circuit breaker auto-engages when hourly
spend > 3× rolling-24h-mean (with 6h bootstrap window).

For subscription engines (claude max plan), cost is tracked as
`quota_pct` against an estimated 5M-token daily allowance.

## 7. Evidence is content-addressed at stage completion

Layer 9 emits `_manifest.json` per task at stage completion: sha256 of
every evidence file, harness_version, repo SHA, worktree path, manifest
root hash. Local files are mutable; the manifest is the immutable record.

Janitor (Layer 10) refuses to prune local evidence until the manifest
is confirmed durable in S3. Local prune ≠ destruction.

`verifyManifest()` re-hashes files vs. the manifest record — used by
drains to detect tampering and by janitor before pruning.

## 8. The harness blue-greens itself

Two tags: `harness-prod` (currently dispatched stages run this) and
`harness-canary` (new harness commits land here first).

Canary must pass against the full Layer 0 replay fixture corpus + one
sandbox module (M99 — synthetic, low-risk) + 24h of operational use
before becoming `harness-prod`. Rollback via `auto:harness-rollback`.

Every state transition + run manifest stamps `harness_version` so post-mortems can correlate "did the harness change between when this task
was planned and when it was run".

---

## CLI surface (after all 11 layers ship)

```
auto:plan        — propose work     (L0 envelope, L1 cost reservation)
auto:work        — dispatch worker  (L0, L4.A no-output watchdog, L4.B
                                      plateau, L5 sidecar, L6 docker,
                                      L9 manifest emit)
auto:postflight  — gate             (L0, L4.B plateau, F2 evidence gate)
auto:promote     — state transition (L0)
auto:land        — open PR          (L0)

auto:self-test   — L2 contract self-tests (CI gate per stage)
auto:fleet       — L3 single pane of glass
auto:module-status — L3 deep-dive on one module
auto:fanout      — L7 DAG scheduler driver (replaces serial-by-module.sh)
auto:drain       — L8 reroute parked queue (planned)
auto:janitor     — L10 housekeeping (gated on L9 manifests)
auto:throughput  — L11 daily KPIs

auto:budget       — L1 budget config + circuit breaker control
auto:reservation  — L1 reservation inspect / release
auto:harness-rollback — L7.B blue-green rollback (planned)
```

## Validation matrix

Each layer ships with a smoke that asserts its invariants:

| Layer | Smoke | Asserts |
|---|---|---|
| L0 | `auto:test:contracts` | envelope round-trip, registry consistency, fixture validation |
| L1 | `auto:test:budget-reservation` | fail-closed, per-task cap, recordSpend, circuit breaker |
| L2 | `auto:self-test --all` | every registered stage's fixtures pass |
| L4.B | `auto:test:progress-score` | plateau triggers + recommendation routing |
| L7 | `auto:test:fanout-scheduler` | DAG order, WIP caps, dependency gating, pause |
| L9 | `verifyManifest()` | sha256 mismatch detection |
| L11 | `auto:throughput --date X` | percentile + bottleneck computation |

Adding a new stage requires:
1. Registry entry in `src/lib/stageRegistry.ts`
2. Replay fixture(s) in `src/lib/replay/fixtures/`
3. Stage CLI emits L0 envelope on completion
4. Smoke test if it has new logic

## Failure-mode catalog

The harness has been hardened against these specific failure modes
(each mapped to its mitigation):

| Failure mode | Mitigation | Fixture |
|---|---|---|
| Worker hangs past timeout | B1 process-group kill + L4.A no-output | `B1-worker-progress-timeout.json` |
| Gate exits 1 for structural reason | L0 typed envelope + L2 self-test | `F2-postflight-broken-resolver.json` |
| Silent RBAC denial | L0 envelope (kind=policy-refusal) + identity.json | `F1-intake-rbac-denial.json` |
| Patch rounds re-emit identical failures | L4.B plateau detector | `L4-plateau-identical-rounds.json` |
| Driver crashes mid-fanout | L8 driver state file + heartbeat | (in-flight) |
| Worker corrupts host filesystem | L6 Docker worktree + read-only fs | (operational test) |
| Lost-update on TaskPack writes | L5 sidecar split | `lockCAS.smoke.ts` |
| Cost runaway | L1 reservation + circuit breaker | `budgetReservation.smoke.ts` |
