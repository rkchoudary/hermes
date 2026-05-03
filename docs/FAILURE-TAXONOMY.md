# FAILURE-TAXONOMY.md

The harness's verdict-to-action mapping. Codifies what each
`LivenessVerdict.kind` means, the driver's recommended action, and the
operator's expected response if the action escalates.

This document is the contract between `assessLiveness()` (PA4) and
the driver's reaper loop. Adding a new verdict kind requires updating
this taxonomy AND the failure-mode catalog in FACTORY-DOCTRINE.md.

## Verdict catalog

### `completed`

Engine emitted `worker.session_end` (the terminal event in claude
`--output-format stream-json`). Cleanest possible outcome.

- **Driver action**: `continue` — let the post-spawn evidence/manifest
  flow run.
- **Operator response**: none.
- **Confidence**: 1.0 (engine self-reported).

### `active`

Recent tool calls observed in the event ledger; rate above the
`active_tool_calls_per_min` threshold (default 0.5/min).

- **Driver action**: `continue`.
- **Operator response**: none.
- **Confidence**: 0.95.

### `recent_filesystem_activity`

No recent worker events but files in the task's `allowed_paths` are
being modified. Common when claude is in a heavy edit phase that the
event stream's buffering can hide.

- **Driver action**: `continue`.
- **Operator response**: none.
- **Confidence**: 0.85.

### `awaiting_model`

Container CPU is low AND there's active anthropic egress. The LLM is
computing in the cloud; nothing locally to do but wait.

- **Driver action**: `continue`.
- **Operator response**: none unless this state persists past
  `quiet_sigterm_s` (default 10 min) — at that point investigate
  Anthropic API status.
- **Confidence**: 0.75.

### `awaiting_tool`

A `worker.tool_call` was emitted but no matching `worker.tool_result`
within `quiet_warn_s` (default 60s). Some local tool (Bash, Edit) is
still running.

- **Driver action**: `continue` if age < `quiet_sigterm_s`, else
  `sigterm`.
- **Operator response**:
  - <60s: ignore
  - 60s–10min: confirm the tool is legitimately long-running (large
    test suite, big build)
  - >10min: sigterm, mark `worker-error retryable=true`. Likely root
    cause: tool deadlock, infinite loop, or container resource starve.
- **Confidence**: 0.8.

### `low_signal_active`

Some signal is present but not enough to classify cleanly. Treated as
working, with a logged warning so it surfaces in the operator audit.

- **Driver action**: `continue`.
- **Operator response**: investigate if this state persists for
  multiple successive verdicts.
- **Confidence**: 0.5.

### `no_recent_control_events`

No events at all for `quiet_warn_s` (default 60s) and no other progress
signals. Could be a hung worker, could be a long thinking step, could
be a partition between host and container.

- **Driver action**: `log-warning` if age in `[quiet_warn_s,
  quiet_sigterm_s]`, else `sigterm`.
- **Operator response**:
  - <10min: ignore (LLM thinking can take this long)
  - 10min+: investigate. Check container is alive (`docker ps`), check
    Anthropic API status, check network egress. If sigterm fires, the
    task transitions to `needs-revision` and the operator can
    re-dispatch with `--round N+1`.
- **Confidence**: 0.5–0.6.

### `heartbeat_lost`

The in-container heartbeat (PB1 docker integration) is missing for >
`heartbeat_lost_s` (default 30s) but the container has not yet
reported an exit. The container is unresponsive — host-supervisor sees
it as alive but it isn't talking.

- **Driver action**: `log-warning` (will escalate to `sigkill-and-reap`
  if heartbeat stays missing past `heartbeat_terminal_s`).
- **Operator response**: investigate — `docker stats` for resource
  exhaustion, `docker logs` for last activity, check for deadlock.
- **Confidence**: 0.85.

### `confirmed_terminated`

Either:
- Container reported exit (`container_state=exited`)
- Heartbeat missing for `heartbeat_terminal_s` (default 5 min) — long
  past plausible legitimate quiet

This is the strongest "it's dead" signal.

- **Driver action**: `sigkill-and-reap` (idempotent — if container
  already exited, just clean up).
- **Operator response**: review the final events in the ledger to
  determine cause. Re-dispatch is appropriate IF the cause is
  retryable (network blip, OOM with adjusted resources). Mark
  abandoned if cause is non-retryable (harness-bug, intentional kill).
- **Confidence**: 0.95–1.0.

## Recommended-action escalation policy

```
continue           → run normally
log-warning        → emit cp.liveness_assessed event with reason;
                     no kill action
sigterm            → killTree('SIGTERM'); 30s grace; then SIGKILL;
                     transition state to needs-revision; pack carries
                     last LivenessVerdict in artifact_acceptance.kill_decision
sigkill-and-reap   → killTree('SIGKILL'); reap container/process;
                     transition state to needs-revision (retryable kinds)
                     or abandoned (non-retryable kinds)
```

## "Why was this worker killed?" — operator surface

When the driver kills a worker, it MUST emit a `cp.kill_decided` event
with:

```json
{
  "task_id": "TP-...",
  "verdict_at_kill": { /* full LivenessVerdict */ },
  "kill_signal": "SIGTERM" | "SIGKILL",
  "elapsed_since_dispatch_s": 712,
  "post_kill_state": "needs-revision" | "abandoned",
  "operator_remediation": "string — see this taxonomy"
}
```

The fleet view's `auto:fleet --task <TP-id>` surfaces this directly:

```
TP-2026-05-03-007  M11  code-sprint  KILLED 712s ago
  verdict:    awaiting_tool (confidence 0.8, primary=unmatched_tool_call)
  reason:     tool call unmatched for 645s (>= sigterm threshold 600s)
  remediation: confirm tool is legitimately long-running; if not,
               re-dispatch with --round N+1 after diagnosing tool-side
               deadlock (see runbooks/stuck-worker.md)
```

## Adding a new verdict

1. Add the kind to `VerdictKind` in `src/lib/liveness.ts`
2. Implement the assessment branch in `assessLiveness()`
3. Add a section in this document describing meaning + driver action
4. Add a smoke assertion in `liveness.smoke.ts` that exercises it
5. Add a runbook entry under `docs/runbooks/` if the operator response
   is non-trivial

## See also

- `src/lib/liveness.ts` — assessLiveness implementation
- `src/lib/livenessPoller.ts` — periodic verdict generator (PA5)
- `src/cli/work.ts` — driver consumer (calls livenessPoller during
  worker spawn)
- `docs/FACTORY-DOCTRINE.md` — overall doctrine + load-bearing layers
