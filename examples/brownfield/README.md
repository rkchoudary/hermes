# Brownfield example — drop into an existing repo

Use Hermes to add features, fix bugs, or migrate code in an existing codebase. This is the most common case.

## Setup

```bash
cd my-existing-repo

# Option A: vendor the harness (recommended for monorepos)
git submodule add https://github.com/rkchoudary/hermes.git tools/hermes
cd tools/hermes && pnpm install && cd ../..

# Option B: install globally + symlink
git clone https://github.com/rkchoudary/hermes.git ~/hermes
(cd ~/hermes && pnpm install)
alias hermes='cd ~/hermes && env HERMES_PROJECT_ROOT="'$(pwd)'" '

# Either way, point Hermes at the calling repo
export HERMES_PROJECT_ROOT="$(git rev-parse --show-toplevel)"
export AUTO_HARNESS_DRIVER=1
```

## Define a module

A "module" is just a unit of work — a directory or a feature you want the agent to focus on. Hermes uses `M01..MNN` by convention but you can name them anything.

```bash
# Tell Hermes what M21 means in your repo
cat > .hermes/modules/M21.yaml <<EOF
name: M21 — Payment Webhook Verification
allowed_paths:
  - 'apps/api/src/payments/**'
  - 'apps/api/test/payments/**'
forbidden_paths:
  - 'infra/**'
  - 'apps/web/**'
references:
  - 'docs/payments-spec.md'
EOF
```

## Add coverage to existing untested code

```bash
pnpm auto:plan --module M21 --version v1.0 --type test-coverage --auto-fill
pnpm auto:work
# auto:land runs blocking gates: lint + tests + 70% coverage + dep-audit + security
pnpm auto:land
```

## Surgical bug fix

```bash
# A single small change with full audit trail
pnpm auto:plan --module M21 --version v1.0 --type code-sprint \
  --objective "Fix race condition in payment webhook signature verification" \
  --auto-fill

pnpm auto:work
pnpm auto:land
```

## Refactor / migration (multi-module)

```bash
# Drive 5 related modules end-to-end with cognitive-recovery enabled
echo -e "M21\nM22\nM23\nM24\nM25" > .hermes/modules.txt
HERMES_MODULE_LIST_FILE=.hermes/modules.txt bash scripts/serial-by-module.sh
```

## Compliance gates that fire by default

When `auto:land` runs in brownfield mode against a `code-sprint` task, these gates BLOCK the merge unless `--force` + `AUTO_FORCE_REASON` set:

- `lint` — must pass
- `test` — must pass
- `coverage` — ≥70% on changed files
- `audit` — no HIGH/CRITICAL CVEs in prod deps (allow-list available)
- `security` — `security-check.json` severity ≤ medium
- `branch-hygiene` — ≤10 commits ahead of base
- `sod` — creator ≠ reviewer ≠ approver

Every bypass is recorded to `.agent-runs/_override-audit.jsonl` with chain hash.

## Brownfield-specific knobs

```bash
# Match existing project conventions (lint config, test runner, etc.)
export HERMES_MODE="brownfield"  # default

# Pin the worker to the same SHA you reviewed
export HERMES_BASE_SHA="$(git rev-parse origin/main)"

# Worktree HEAD guard — refuses if HEAD drifts during dispatch (default ON)
# Disable only if you know what you're doing (e.g., E2E tests)
# export HERMES_WORKTREE_GUARD=0
```

## Watching it work

```bash
# Live HTML dashboard
pnpm auto:dashboard-live   # http://localhost:7777

# Prometheus / Grafana
pnpm auto:metrics-daemon   # http://localhost:9090/metrics

# Stream stdout from a multi-module run
tail -f /tmp/harness-runs/serial-driver-*.log
```
