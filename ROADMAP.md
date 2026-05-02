# Hermes Roadmap

Living document. PRs welcome to amend, add, or push priorities up/down.

## v0.1.0 — Public preview (this release)

**Theme:** OSS-shippable autonomous delivery harness with audit-trail-by-default.

**Done:**
- 28-stage SDLC pipeline (intake → FRD/TRD/Sprint-Plan → code-sprint → land → deploy)
- 9-engine adapter registry (Claude, Codex, Cursor, Aider, Continue, Gemini, Ollama, OpenAI, Claude Agent SDK)
- Worktree HEAD guard, KILL_SWITCH, restricted-permissions, per-module 90-min timeout
- WORM evidence + KMS-encrypted S3 archive + chain-hashed state log
- Council async sidecar + retroactive watchdog + auto-rollback
- Cognitive recovery (3-patch + diagnose + fix-bugs different-approach)
- Skill memory producer + LLM reflection
- CI auto-fix loop (Composio pattern)
- YAML workflow runner (Archon pattern)
- MCP server (JSON-RPC over stdio)
- Live HTML dashboard `:7777` + Prometheus metrics `:9090`
- `npx hermes init` onboarding wizard
- `auto:interrupt` / `auto:steer` / `auto:diagnose-task` / `auto:plan-preview`
- 10-template prompt library (bug-fix, feature-add, test-coverage, refactor, dep-upgrade, security-fix, perf-fix, doc-update, migration, e2e-test)
- Framework-aware RAG: 158 frameworks in registry, 153 indexed locally, BM25 retrieval
- Specialized worker roles, web-fetch tool, vision-loop, brownfield init scan
- VS Code extension, React dashboard package, Docker sandbox, SWE-bench runner, A/B workflow runner
- Cloud control plane skeleton, opt-in skill-memory aggregator with k-anonymity

## v0.2.0 — Operational maturity (1-2 months)

**Theme:** Make daily operation feel polished.

- [ ] **Vector embeddings for RAG** — alongside BM25, plug Voyage / OpenAI / SentenceTransformers via the existing `Embedder` interface
- [ ] **Cost telemetry capture in worker dispatch** — engine adapters emit token-count + est_usd per LLM call into `pack.cost_telemetry` (currently the dashboard reads it; nothing writes it)
- [ ] **Hermes-UI parity** — full feature-parity with HTML dashboard; replace `:7777` static page entirely
- [ ] **`auto:cloud-poll`** — operator-side companion to `hermes-cloud`, long-polls for triggers
- [ ] **`auto:scaffold` (tokenless code generation)** — deterministic templates for common patterns (Next.js page, Django ViewSet, FastAPI endpoint, etc.) — complements RAG, doesn't replace it
- [ ] **VS Code extension marketplace publish** — currently scaffolded but not packaged via `vsce package`
- [ ] **lockCAS smoke flake fix** — tighten the 25ms timing-jitter tolerance + add retries
- [ ] **All 158 frameworks indexed** — fix the 5 silent-empty fetches
- [ ] **Doc-source license enforcement** — automated check that prevents redistribution of vendor-EULA chunks

## v0.3.0 — Performance + scale (2-3 months)

**Theme:** Make it fast and observable enough for >100-module portfolios.

- [ ] **Durable storage backend** — Postgres / D1 / KV adapter for `hermes-cloud` and `hermes-skill-aggregator` (currently in-memory)
- [ ] **Multi-tenant `hermes-cloud`** — proper auth (Auth0/Clerk/Supabase) + per-tenant DB partitioning + role-based access
- [ ] **Plugin marketplace** — formalize the `plugins/` contrib pattern + central index
- [ ] **Workflow library beyond `code-sprint.yaml`** — greenfield React app, brownfield Rust port, monorepo with mixed languages, etc.
- [ ] **Replay UI improvements** — inline diff viewer for evidence files
- [ ] **Charts in dashboard** — modules-completed-over-time, cost burn rate, council pass rate
- [ ] **Mobile responsive review** for `hermes-ui`

## v1.0.0 — Production-ready (6-12 months)

**Theme:** Sign-off on regulated workloads without operator hand-holding.

- [ ] **SWE-bench Verified actual run published** — honest number, reproducible methodology
- [ ] **SOC 2 Type 2** if hosting customer data
- [ ] **Real SLA + monitoring** for `hermes-cloud`
- [ ] **Quotas + billing** for the cloud package
- [ ] **Audit-trail integration with hermes-cloud** — triggers + completions mirror to operator's local override-audit log
- [ ] **GDPR RTBF API** for `hermes-skill-aggregator` once durable storage lands
- [ ] **Webhook signature verification** for incoming trigger sources
- [ ] **Cross-project skill memory used in worker prompts** — surface the aggregated patterns as enrichment context
- [ ] **First enterprise pilot customer** — validates the audit-trail story under real auditor scrutiny

## Forever-deferred (intentionally out of scope)

- **Hosted-only sandbox** — would weaken the audit-trail integrity story (state lives in someone else's VM)
- **Single-engine vendor lock** — multi-engine is our moat; trading it is a strategic loss
- **Closed protocol** — MCP server is more useful than a proprietary API
- **Black-box agent reasoning** — chain-hashed state log + skill memory = explainable; we won't replace that with mysticism
- **Marketing-first benchmarks** — we'll publish honest numbers even when we lose

## How to influence the roadmap

- Open a `feature-request` issue describing the problem (not just the solution)
- Comment on related items above with your use case
- Submit a PR that implements a roadmap item — fastest path to ship
- For commercial-relevant asks (cloud / multi-tenant / SOC 2 / SLA), email rkchoudary@users.noreply.github.com — those need scoping conversations rather than just code
