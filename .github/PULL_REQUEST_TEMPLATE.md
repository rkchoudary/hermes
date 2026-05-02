## Summary

<!-- 1-3 sentences describing what changed and why. Link to a related issue if applicable. -->

Fixes #

## What changed

<!-- Per-file or per-feature bullets are fine. Focus on behavior changes; reviewers can see the diff. -->

-

## Test plan

<!-- How did you verify this works? At minimum: `pnpm exec tsc --noEmit` and `pnpm auto:test:smoke`.
     For new features, describe the manual testing you did. -->

- [ ] `pnpm exec tsc --noEmit` passes (0 errors)
- [ ] `pnpm auto:test:smoke` passes (22/22)
- [ ] (if RAG-related) `pnpm auto:rag-list` and a real `--match` query work
- [ ] (if work.ts touched) tested a real `auto:work` dispatch end-to-end
- [ ]

## Audit-trail considerations

<!-- Any change that affects worker dispatch, evidence writes, override audit, or state-log
     should explicitly call out the audit-trail impact. Skip if not applicable. -->

- [ ] N/A — this PR doesn't touch audit-trail surfaces
- [ ] State-log compatibility preserved (chain hash, schema version)
- [ ] Override-audit kind added/changed (specify): __
- [ ] Evidence-directory contract preserved

## Compliance considerations

<!-- For changes touching SoD enforcement, CVE allow-list, role gating, or any compliance gate. -->

- [ ] N/A — no compliance gates touched
- [ ] SoD rules preserved (creator ≠ reviewer ≠ approver)
- [ ] CVE allow-list semantics unchanged or explicitly versioned
- [ ] Force-bypass paths still require `AUTO_FORCE_REASON` and audit-log

## Breaking changes

<!-- Any change to public CLIs, env vars, file formats, or schemas. -->

- [ ] None
- [ ] Yes — described in commit message + ROADMAP.md updated

## Author checklist

- [ ] Commit message follows Conventional Commits (`feat(scope):` / `fix(scope):` / `docs:`)
- [ ] No hardcoded paths (uses `process.env.HERMES_PROJECT_ROOT` or `process.cwd()`)
- [ ] No proprietary identifiers in test fixtures or comments
- [ ] CONTRIBUTING.md guidance followed
