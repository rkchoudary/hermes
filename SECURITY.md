# Security Policy

Hermes is autonomous-delivery infrastructure used for code authoring and merging. Security issues here are taken seriously — a vulnerability in the harness can be amplified across every dispatch it executes.

## Reporting a vulnerability

**Please do NOT open public GitHub issues for security vulnerabilities.**

Instead, email **rkchoudary@users.noreply.github.com** with:

- A description of the vulnerability
- Steps to reproduce (or PoC if available)
- Affected versions / commit SHAs
- Your assessment of impact (RCE / privilege escalation / data exfil / DoS / etc.)
- Whether you'd like public credit when the fix ships

We aim to:

- **Acknowledge** within 72 hours
- **Triage** within 7 days
- **Patch** critical issues within 14 days; high/medium within 30 days
- **Disclose** publicly within 90 days OR after fix is widely deployed, whichever is sooner

## What's in scope

- Code execution paths in any `src/cli/*.ts`
- Prompt-injection vectors in worker dispatch / RAG enrichment
- Audit-trail tampering (chain hash bypass, override-audit corruption)
- Worktree-guard / sandbox bypasses
- CVE allow-list bypasses
- Permission escalation (`AUTO_WORKER_RESTRICTED` → unrestricted)
- Secrets disclosure in evidence/audit logs
- Dependency vulnerabilities in shipped lockfile

## What's NOT in scope

- Issues in third-party engines (claude-code-cli, codex-cli, etc.) — report upstream
- Issues in operator-chosen external services (S3, Github Actions, etc.)
- Self-inflicted misconfigurations (operator runs with `AUTO_FORCE_REASON="bypass everything"`)
- Reports without a proof-of-concept

## Hardening posture (current state)

- Worktree HEAD guard (3-layer): pre/post HEAD check, branch check, untracked-file capture
- Restricted-permissions mode (`AUTO_WORKER_RESTRICTED=1`)
- Per-module 90-min hard timeout
- KILL_SWITCH operator override (`touch .agent-runs/_KILL_SWITCH`)
- Override audit chain (sha256-chained JSONL)
- CVE allow-list with operator-set expiry dates
- SoD enforcement (creator ≠ reviewer ≠ approver)
- WORM-grade evidence directory + KMS-encrypted S3 archive option

## Reward / bug bounty

We don't currently run a paid bounty program. We do publicly credit reporters in release notes (with permission) and, where possible, on the project website.
