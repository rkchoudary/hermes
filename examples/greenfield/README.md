# Greenfield example — bootstrap a new project

Use Hermes to scaffold a brand-new repo from a one-page spec.

## Setup

```bash
mkdir my-new-app && cd my-new-app
git init
echo "# my-new-app" > README.md
git add . && git commit -m "init"

# Point Hermes at this dir
export HERMES_PROJECT_ROOT="$(pwd)"
export AUTO_HARNESS_DRIVER=1
export AUTO_FORCE_REASON="greenfield bootstrap"
```

## Author the FRD (Functional Requirements Doc)

```bash
# Drop a minimal spec
mkdir -p docs/specs/M01
cat > docs/specs/M01/SPEC.md <<EOF
# M01 — User authentication

## Goal
Email + password login with JWT sessions.

## Acceptance criteria
- POST /auth/register creates a user, returns 201
- POST /auth/login verifies password, returns JWT
- GET /me returns 200 with user when JWT valid, 401 otherwise
- Passwords stored as argon2id hashes
- JWT secret loaded from env, never logged
EOF
```

## Run the harness

```bash
# Phase 1: produce a polished FRD from your spec
pnpm auto:plan --module M01 --version v0.1 --type frd-author --auto-fill
pnpm auto:work
pnpm auto:postflight

# Phase 4: implement
pnpm auto:plan --module M01 --version v0.1 --type code-sprint --auto-fill
pnpm auto:work
pnpm auto:land   # runs lint, tests, dep-audit, security-check, opens PR

# Or one-shot all phases for the module:
bash scripts/serial-by-module.sh M01
```

## What you get

- Implementation diff in a feature branch
- PR opened with full evidence directory: `evidence/<task_id>/{diff.patch, test-summary.md, duplicate-scan.json, risk-register.md, worker-handoff.json, codex-verdict.md, security-check.json}`
- Audit-trail entry for every state transition (chain-hashed sha256)
- Council verdict written async to sidecar JSON

## Greenfield-specific knobs

```bash
# Mode signals "this is a new project, not modifying existing"
export HERMES_MODE="greenfield"

# Skip the citation validator (no regulatory FRDs yet)
export HERMES_SKIP_CITATION_CHECK=1
```
