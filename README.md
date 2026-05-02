# Hermes

**Open-source autonomous delivery harness — multi-engine AI agents with audit-trail compliance, by default.**

Hermes drives AI coding agents through a 28-stage delivery pipeline (intake → spec authoring → code-sprint → review → land → deploy) with the gates and audit trail that regulated industries actually require: SOX 404, OSFI E-23, BCBS 239, SR-11/7, GDPR. Greenfield or brownfield, single-repo or 80+ modules.

Production-tested on an 87-module banking platform: 33 modules end-to-end-completed, 54 parked, zero compliance violations.

## Why Hermes vs. Devin

| | Devin | Cursor agents | GitHub Copilot Workspace | **Hermes** |
|---|---|---|---|---|
| Open source | ✗ | ✗ | ✗ | **Apache-2.0** |
| Self-host | ✗ | partial | ✗ | **yes** |
| Multi-engine | locked stack | Cursor only | Copilot only | **9 adapters** (Claude / Codex / Cursor / Aider / Continue / Gemini / Ollama / OpenAI / Claude Agent SDK) |
| Audit trail by default | no | no | no | **chain-hash state log + WORM evidence + override audit + dual-control + SoD** |
| Cognitive recovery | ad-hoc | ad-hoc | ad-hoc | **3-patch + diagnose + fix-bugs different-approach (EXARCHON pattern)** |
| Skill memory | no | no | no | **producer log + LLM reflection (Hermes-Agent pattern)** |
| Kill switch | no | no | no | **operator-controlled `_KILL_SWITCH` halts all dispatch** |
| Per-module timeout | n/a | n/a | n/a | **90 min hard ceiling, no-stuck guarantee** |
| Worktree HEAD guard | no | no | no | **3-layer hijack prevention (HEAD/branch + untracked-file + restricted-perms)** |
| Compliance gates | no | no | no | **WORM, S3-archive, KMS-encrypted, CVE allow-list, role templates** |
| Observability | UI only | UI only | UI only | **Prometheus :9090 + live HTML dashboard :7777 + MCP server (stdio)** |
| Cost | $500/mo | $20/mo | $10-20/mo | **free + your engine costs only** |

## What's in the box

- **9-engine adapter registry** — claude-code-cli (default), claude-agent-sdk, codex-cli, cursor-cli, aider, continue, gemini-cli, ollama, openai-cli. PATH-detected; runtime-routable. Tier-1/2/3 fallback or dynamic complexity-based routing.
- **28-stage SDLC pipeline** — Stage 0 intake → Phase 1 FRD → Phase 2 TRD → Phase 3 Sprint Plan → Phase 4 Code-Sprint → Stages 25-28 validation/approval/tick/auto-merge → Stage 29 staging deploy. Each stage is a CLI; chain via `serial-by-module.sh` or run individually.
- **Cognitive recovery (EXARCHON)** — when 3 patch rounds exhaust, dispatch a diagnose-then-fix-bugs worker with a *different-approach* directive. Recovers ~40% of "stuck" tasks in production.
- **Skill memory (Hermes-Agent)** — every phase logs `(module, task_id, patch_rounds, recovered_via)` to JSONL; LLM reflection synthesizes patterns ("modules with >3 OSFI citations need 2 patches on average") which seed future worker prompts.
- **Council async sidecar (advisory pattern)** — codex review runs in parallel, writes verdict to JSON sidecar; non-blocking. Optional `AUTO_COUNCIL_BLOCKING=1` makes it a hard gate.
- **CI auto-fix loop (Composio pattern)** — when merged-to-main PR's CI goes red, scan checks, dispatch claude to author a fix diff, open a fix-PR autonomously.
- **YAML workflow runner (Archon pattern)** — define your own pipelines; minimal YAML parser; supports cmd/cmds/when/timeout/background/extract/hooks. Example: `workflows/code-sprint.yaml` (9 nodes mirroring `drive_phase`).
- **Worktree HEAD guard** — 3-layer prevention against agents hijacking your repo: pre/post HEAD check, branch check, untracked-file capture. Refuses to merge on detected drift.
- **Restricted-permissions mode** — `AUTO_WORKER_RESTRICTED=1` swaps the worker's `--dangerously-skip-permissions` for an explicit `--allowed-tools` whitelist (no rm -rf, no force-push, no protected-branch ops).
- **Per-module 90-min timeout** — every `drive_phase` invocation registers a watchdog; no stuck phase ever blocks the queue.
- **KILL_SWITCH operator override** — `touch .agent-runs/_KILL_SWITCH` halts all dispatch instantly; no race.
- **WORM-grade evidence** — every task pack carries `evidence/<task_id>/` with diff, tests, duplicate-scan, risk register, codex verdict, security check. S3-archive CLI uploads to KMS-encrypted bucket.
- **Audit-trail chain hash** — every state-log entry is `sha256(prev_hash || canonical_json(entry))`. Tampering is detectable; `verifyStateLogChain()` returns chained/legacy/mixed/broken.
- **MCP server** — JSON-RPC over stdio exposes `harness.status`, `.module_state`, `.list_parked`, `.skill_memory`. Drop into Claude Code, Cursor, or any MCP client.
- **Live HTML dashboard** — `pnpm auto:dashboard-live` serves `:7777` with auto-refreshing run/driver/merge/council/parked/resources panels.
- **Prometheus metrics daemon** — `pnpm auto:metrics-daemon` serves `:9090/metrics` with `harness_modules_completed_total`, `harness_modules_parked_total`, `harness_council_status`, `harness_disk_free_gb`, `harness_open_module_prs`, etc.
- **Council retroactive watchdog** — long-running daemon that periodically sweeps council sidecars; auto-rolls-back merged-but-failed modules.

## Quickstart

```bash
git clone https://github.com/rkchoudary/hermes.git
cd hermes
pnpm install
pnpm exec tsc --noEmit  # 0 errors expected

# Set required env
export HERMES_PROJECT_ROOT="$(pwd)/your-project"
export AUTO_HARNESS_DRIVER=1   # signal you're running via the harness, not by hand

# Greenfield: scaffold from scratch
pnpm auto:plan --module M01 --version v0.1 --type frd-author --auto-fill
pnpm auto:work
pnpm auto:tick

# Brownfield: surgical changes to existing repo
pnpm auto:plan --module M02 --version v0.5 --type code-sprint --auto-fill
pnpm auto:work
pnpm auto:land
```

Live status:
```bash
pnpm auto:dashboard-live   # http://localhost:7777
pnpm auto:metrics-daemon   # http://localhost:9090/metrics (Prometheus)
pnpm auto:mcp-server       # stdio JSON-RPC for MCP clients
```

Drive 80+ modules end-to-end:
```bash
bash scripts/serial-by-module.sh     # one-at-a-time, auditable
bash scripts/parallel-by-module.sh 2 # 2 drivers in parallel
```

## Examples

- [`examples/greenfield/`](examples/greenfield/) — bootstrap a new project from blank slate
- [`examples/brownfield/`](examples/brownfield/) — drop into an existing repo and add coverage
- [`workflows/code-sprint.yaml`](workflows/code-sprint.yaml) — full 9-node code-sprint phase as YAML

## Engines

```
✓ claude-code-cli      claude               Default impl-worker (Claude Code Max plan, no API billing)
✓ claude-agent-sdk     node                 Claude Agent SDK direct API
✗ codex-cli            codex                OpenAI Codex; council scoring (separate vendor for SoD)
✗ cursor-cli           cursor-agent         Cursor agent mode
✗ aider                aider                Aider git-aware pair programmer
✗ continue             continue             Continue.dev CLI
✗ gemini-cli           gemini               Google Gemini; non-Claude diversity
✓ ollama               ollama               Local Ollama; offline tier-3
✓ openai-cli           openai               OpenAI-compat CLI; works with proxies
```

(`✓` = on PATH, `✗` = not detected at runtime — install if needed.) Run `pnpm auto:engine-list` to verify your local availability.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Hermes Driver (bash or YAML)                    │
│   serial-by-module.sh   parallel-by-module.sh   yaml-runner.ts      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
        ┌──────────────────────┴────────────────────┐
        ▼                                           ▼
   28-Stage Pipeline                         Council Async Sidecar
   ──────────────────                        ─────────────────────
   Stage 0:  Intake                          Codex (separate vendor)
   Phase 1:  FRD authoring                   Score + verdict in JSON
   Phase 2:  TRD authoring                   Non-blocking by default
   Phase 3:  Sprint Plan                     AUTO_COUNCIL_BLOCKING=1
   Phase 4:  Code-Sprint
             ├── work (worker dispatch)
             ├── postflight (lint, tests, audit, security)
             ├── patch round 1-3 (auto-fix)
             └── cognitive recovery (different approach)
   Stage 25: Validation memo
   Stage 26: Approval (operator-signed)
   Stage 27: Tick + audit pack
   Stage 28: Auto-merge (CI-green wait, strict)
   Stage 29: Staging deploy + smoke

   Hardening Layer (every stage):
   ──────────────────────────────
   • Worktree HEAD guard (3-layer)        • SoD shadow reviewer
   • Per-module 90-min timeout            • CVE allow-list
   • KILL_SWITCH operator override        • Coverage gate (70%)
   • Restricted-permissions mode          • Branch hygiene check
   • WORM evidence + S3 archive           • Override audit (chain-hashed)
   • Skill memory producer + LLM          • Council retroactive watchdog
     reflection                           • CI auto-fix loop
```

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for full design.

## Compliance

Hermes implements audit-trail patterns required by:

- **SOX 404** — segregation of duties (creator ≠ reviewer ≠ approver), tamper-evident state log, override audit
- **OSFI E-23** — independent validation memo, named-operator attestation, audit-pack archive
- **BCBS 239** — every fact (`run_id`, `tenant_id`, `snapshot_id`, `as_of_date`), evidence directory, replay
- **SR-11/7** — model-inventory, multi-vendor consensus (impl-vendor ≠ review-vendor), challenger reviews
- **GDPR** — KMS-encrypted S3 archive, immutable WORM bucket, configurable retention

The compliance gates are *defaults*, not opt-ins. To run without them, you have to explicitly bypass with `AUTO_FORCE_REASON="<≥10 char rationale>"`, which is itself audit-logged.

## Development

```bash
pnpm install
pnpm exec tsc --noEmit              # typecheck (must be 0 errors)
pnpm auto:test:smoke:serial         # 16-test serial smoke chain
pnpm auto:test:smoke                # 22-test parallel smoke chain (CI)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome — especially for additional engine adapters, new compliance frameworks, and dashboard improvements.

## License

Apache-2.0. See [LICENSE](LICENSE).

## Status

`v0.1` — public preview. Production-tested on one regulated workload (87-module banking FP&A platform). Smoke tests 22/22 pass in CI. Battle-tested patterns; documentation still maturing.
