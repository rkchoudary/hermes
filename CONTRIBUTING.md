# Contributing to Hermes

Thanks for considering a contribution. Hermes ships under Apache-2.0; by submitting a PR you grant the same license terms to your work.

## Quick start

1. Fork + clone
2. `pnpm install`
3. `pnpm exec tsc --noEmit` should print 0 errors
4. `pnpm auto:test:smoke` should pass 22/22 suites
5. Make your change, add a smoke test if it's a new behavior, open a PR

## Where help is most welcome

- **Engine adapters** — a new entry in `src/lib/engineRegistry.ts` plus its dispatch path in `work.ts`. We have 9 engines today; the more, the better the multi-vendor SoD story gets.
- **Compliance frameworks** — `regulatory/` was stripped before OSS launch (it was banking-specific). A clean plugin pattern that supports SOX/OSFI/HIPAA/PCI-DSS/etc. would be huge.
- **Dashboard / UX** — `dashboard-live.ts` is intentionally minimal. A real React UI with run-history navigation would be welcome.
- **Workflow library** — more `workflows/*.yaml` examples (greenfield React app, brownfield Rust port, monorepo with mixed languages, etc.).
- **Storage backends** — currently filesystem-based. A `lib/adapters/` Postgres/Redis/etc. backend would unblock multi-tenant deployments.

## Coding rules

- TypeScript strict; `tsc --noEmit` must stay 0 errors
- New CLIs go in `src/cli/`, new libs in `src/lib/`
- New CLIs must accept `--help` and not require args for the dry-run path
- New behavior needs a smoke test in `src/lib/__tests__/*.smoke.ts`
- Bash drivers stay shell-portable (avoid bashisms when posix sh works)
- Hardcoded paths are forbidden — use `process.env.HERMES_PROJECT_ROOT` or `process.cwd()`

## Commits

- Conventional commits: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`
- Reference the issue/PR in the body if applicable
- Co-authoring AI is fine; please credit the model

## Compliance contributions

If your contribution adds a regulatory framework adapter (HIPAA, PCI-DSS, etc.):

1. Document the framework's specific clauses your code maps to
2. Write a test fixture for at least one happy-path + one failure-path
3. Add a `decisions.yaml` policy template the operator can adopt
4. Avoid bundling proprietary spec content (cite, don't copy)

## Releasing

Maintainers tag with `git tag -a v0.X.Y -m "..."`, push the tag, and the CI smoke chain must be green on `main`.

## Code of Conduct

Be respectful. We're trying to build something that makes regulated-industry teams' lives easier. Treat each other accordingly.
