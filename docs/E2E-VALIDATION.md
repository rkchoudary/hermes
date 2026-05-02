# E2E Validation — Greenfield + Brownfield

Real end-to-end test of OSS Hermes against two project types:

1. **Greenfield**: empty `/tmp` repo bootstrapped via `npx hermes init`
2. **Brownfield**: large existing monorepo (ProjectXV4, the regulated FP&A platform Hermes was originally built on)

Both ran the full **plan → work → verify** pipeline using the published OSS Hermes binary, not the in-repo dev copy. Five real upstream gaps were found and patched during the test; the patches are committed and reflected in the v0.1.0 line on `main`.

## Test methodology

- **Binary**: `~/GitHub/hermes/bin/hermes.mjs` from a fresh `git clone` of `rkchoudary/hermes`
- **Engine**: `claude-code-cli` (Claude Code Max plan, no API billing)
- **Bypass flags only for first dispatch**: `AUTO_MODEL_INVENTORY_BYPASS=1` (no inventory file in test fixture), `AUTO_FORCE_REASON="…"` (cwd is dirty in brownfield test)
- **No code paths shared** with the in-repo Hermes dev copy
- **Token cost**: ~$0.30 greenfield + ~$0.50 brownfield (Claude Code Max — usage included in the subscription)

## Results

### Greenfield

```
Setup:                empty /tmp/hermes-greenfield + git init + minimal SPEC.md (10 lines)
npx hermes init:      .hermes/config.yaml, .hermes/modules/M01.yaml, docs/specs/M01/SPEC.md
auto:plan:            TP-2026-05-02-001 (mode=greenfield, risk=low, generic src/**+tests/** paths)
auto:work --force:    297 sec wall, exit 0
                      diff.patch = 173 lines
                      6/6 tests pass
                      100% line / 100% func / 76.92% branch coverage on src/server.ts
verify-claims:        PASS (zero critical findings)
state transition:     planned → in-progress → awaiting-review
```

What landed: `src/server.ts` (Node `http` module, `/health` endpoint, `503` on shutdown), `src/index.ts` (entry), `tests/server.test.ts` (6 vitest cases, fake req/res helpers, edge cases).

The implementation is real production-quality TypeScript with proper types, no external deps, and meaningful test coverage. Spec compliance: every acceptance criterion in `SPEC.md` is addressed.

### Brownfield (ProjectXV4 M01: GL/Sub-Ledger Data Ingestion)

```
Setup:                ProjectXV4 monorepo (~16k commits, multiple worktrees)
                      Existing FRD: 779 lines at ~/Obsidian/NBF-FRD/FRDs/FRD-M01-…/FRD-M01.md
                      .hermes/modules/M01.yaml created with FP&A path conventions
auto:plan:            TP-2026-05-02-003 (mode=brownfield, risk=high)
                      allowed_paths resolved to apps/web/src/lib/fpa/modules/MOD-01-*,
                                                 apps/web/src/app/api/m01/**,
                                                 packages/shared-types/src/events/m01.ts
auto:work --force:    297 sec wall, exit 0
                      14 new files in apps/web/src/lib/fpa/modules/MOD-01-Ingestion/ +
                          apps/web/src/app/api/m01/{upload,replay}/ +
                          packages/shared-types/src/events/m01.ts
                      diff.patch = 4,489 lines, 3,014 LOC production code
                      27/27 functional requirements (FR-M01-001..027) covered
                      85/85 vitest tests pass in 250ms
                      typecheck clean for M01 files (pre-existing errors in
                          MOD-03 / .next/types remain; outside allowed_paths)
                      no new HIGH/CRITICAL CVEs (3 pre-existing not reachable
                          from M01 code)
                      red-team: 100% catch rate (8/8 perturbations detected)
verify-claims:        PASS
state transition:     planned → in-progress → awaiting-review
```

The brownfield test specifically exercised:
- **Project-specific path conventions** via `.hermes/modules/M01.yaml` (apps/web FP&A layout, not generic src/**)
- **External spec resolution** — FRD at `~/Obsidian/NBF-FRD/...` (not in-repo)
- **Allowed-paths discipline** — zero forbidden-path touches across 14 file creations
- **Coexistence with existing code** — preserved sibling MOD-01-NII/ unchanged
- **Avro event contract generation** from FRD §6
- **Typed-units convention** from FRD §7.0 (preserves IEEE-754 semantics)

## Gaps found and patched during the test

Five real bugs in OSS Hermes v0.1.0 surfaced during this run. All patched, all in the `main` branch of `rkchoudary/hermes`.

### GAP 1 — `plan.ts` rejected `code-sprint` and `test-coverage` task types

**Symptom:** `auto:plan --type code-sprint` failed with "Task type code-sprint not yet implemented in v0.1."

**Root cause:** OSS plan.ts only had builders for `frd-author/frd-polish/audit-log-route`. The in-repo dev copy had more task types but they weren't ported during OSS extraction.

**Fix (`ac3df52`):** ported generic `buildCodeSprintPack` and `buildTestCoveragePack`. They read `.hermes/modules/<MID>.yaml` for project-specific paths, falling back to sensible defaults (`src/<module>/**`, `tests/<module>/**`). New CLI flags: `--objective`, `--mode`, `--risk-class`, `--auto-fill`, `--template`, `--allowed-paths`.

### GAP 2 — `harnessRoot()` ignored `HERMES_PROJECT_ROOT` env var

**Symptom:** `evidence_dir` landed in the Hermes package directory (`~/GitHub/hermes/.agent-runs/...`) instead of the operator's project root, even when `HERMES_PROJECT_ROOT` was set.

**Root cause:** `src/lib/harnessRoot.ts` only checked `HARNESS_PROJECT_ROOT`. The OSS rebrand made `HERMES_PROJECT_ROOT` the canonical name everywhere else, but `harnessRoot.ts` wasn't updated.

**Fix (`ac3df52`):** Both env vars now supported; `HERMES_PROJECT_ROOT` wins if both set; `HARNESS_PROJECT_ROOT` retained as legacy alias.

### GAP 3 — Module YAML reader couldn't parse nested `references:` block

**Symptom:** `references.frd_path` defaulted to `docs/specs/M01/SPEC.md` even when `.hermes/modules/M01.yaml` declared `references: { spec: ~/Obsidian/...}`.

**Root cause:** Minimal YAML reader in `loadModuleConfig` was flat — no support for nested keys.

**Fix (`ac3df52`):** Indent-aware state machine that handles `allowed_paths`, `forbidden_paths`, `references.spec`, `references.code_paths`, `references.obsidian_paths` blocks. Operator's spec field now flows through to `TaskPack.references.frd_path` correctly.

### GAP 4 — `pinBaseSha()` refused dispatch when no `origin` remote

**Symptom:** `auto:work` failed at "git fetch origin main FAILED — refusing dispatch — base-SHA invariant cannot be verified."

**Root cause:** A fresh `git init`'d greenfield repo has no `origin`. Hermes's base-SHA invariant assumed every repo had a remote.

**Fix (`2120c1f`):** Detect missing remote (and `HERMES_SKIP_BASE_SHA=1` operator override). Fall back to local `HEAD`. The strict refusal still applies when origin **exists** but fetch fails (real network/auth issues, not greenfield).

### GAP 5 — `verify-claims` gate failed on relative `frd_path`

**Symptom:** "FRD not found at docs/specs/M01/SPEC.md" even though the file existed at exactly that path in the project.

**Root cause:** `verify.ts` checked `fileExists(frdPath)` against `process.cwd()` of the spawned verify process, not the project root. Relative paths don't resolve when the spawn cwd differs from the project root.

**Fix (`2120c1f`):** When `frd_path` is relative, resolve against `REPO_ROOT` (which now correctly honors `HERMES_PROJECT_ROOT`).

## How to reproduce

### Greenfield

```bash
mkdir -p /tmp/hermes-greenfield && cd /tmp/hermes-greenfield
git init -q
git config user.email you@example.com && git config user.name You
echo "node_modules/" > .gitignore
git add . && git commit -qm init

# Bootstrap
npx hermes init

# Edit docs/specs/M01/SPEC.md with your real spec, then:
export HERMES_PROJECT_ROOT="$(pwd)"
export AUTO_HARNESS_DRIVER=1
export AUTO_FORCE_REASON="my E2E test"
export AUTO_MODEL_INVENTORY_BYPASS=1
export AUTO_MODEL_INVENTORY_BYPASS_REASON="E2E test, no inventory needed"

npx hermes plan --module M01 --version v0.1 --type code-sprint --mode greenfield --risk-class low \
  --objective "<one-paragraph what to build>"

npx hermes work TP-<task_id> --engine claude-code-cli --force
```

### Brownfield

```bash
cd /path/to/your/existing/project
mkdir -p .hermes/modules

cat > .hermes/modules/M01.yaml <<EOF
name: M01 — your module name here
mode: brownfield
risk_class: high

allowed_paths:
  - 'src/lib/<module>/**'
  - 'src/app/api/<module>/**'
  - 'tests/<module>/**'

forbidden_paths:
  - '.hermes/**'
  - 'package.json'

references:
  spec: '/path/to/your/SPEC.md'
EOF

export HERMES_PROJECT_ROOT="$(pwd)"
export AUTO_HARNESS_DRIVER=1

npx hermes plan --module M01 --version v1.0 --type code-sprint --objective "Implement M01 per SPEC"
npx hermes work TP-<task_id> --engine claude-code-cli --force
```

## Verification commands

After dispatch:

```bash
# Inspect the generated diff
cat .agent-runs/<run_id>/evidence/<task_id>/diff.patch

# Inspect tests
cat .agent-runs/<run_id>/evidence/<task_id>/test-summary.md

# Inspect risk register (worker self-reports issues here)
cat .agent-runs/<run_id>/evidence/<task_id>/risk-register.md

# Check task state
cat .agent-runs/<run_id>/tasks/<task_id>.json | jq .state
# expected: "awaiting-review" after a clean dispatch
```

## What this proves

1. **The OSS harness is shippable** — anyone can clone, install, and drive a real implementation in <10 minutes.
2. **Greenfield + brownfield share one binary** — same `npx hermes` commands; project differences live in `.hermes/modules/<MID>.yaml`.
3. **The audit trail is real** — every state transition is sha256-chained; every override (`AUTO_FORCE_REASON`) is recorded to `_override-audit.jsonl`; every dispatch leaves a 5-file evidence package.
4. **The constraint discipline works** — allowed_paths zero-violation track record across 4,489 lines of generated code.
5. **The harness is self-improving** — when it fails against a real project, the failures are precise enough to diagnose and patch upstream in minutes.

## Open follow-ups (not blocking)

- **Brownfield consensus + land** — the next stages (`auto:consensus` for Codex review, `auto:land` for lint/test/coverage/audit/security gates + PR open) need separate validation. Codex CLI must be on `PATH` for the consensus stage.
- **Multi-module fan-out** — `bash scripts/serial-by-module.sh` against a list of modules. Validates per-module isolation under load.
- **Token-cost attribution** — `cost_telemetry` is read by the dashboard but not yet **written** by worker engines. v0.2 work.
- **Fully clean dispatch on dirty cwd** — `--force` worked but ideally Hermes would offer a "stash + work + restore" pattern.
