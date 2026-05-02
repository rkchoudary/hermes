# Autonomous Delivery Harness — Architecture

## Goals

1. **Scale FRD authoring + code sprints** from ~1 module-per-session to ~5-10 module-per-session through bounded parallelism.
2. **Eliminate duplicate-functionality risk** via mandatory pre-implementation scan + Codex consensus check.
3. **Bound context per task** so a single Codex pass at xhigh reasoning effort doesn't blow past the 200K-token window.
4. **Audit trail** — every task pack ships a directory of evidence (diff, tests, duplicate-scan, risk register, Codex verdict) suitable for SOX 404 / OSFI E-23 examiner review.
5. **Preserve human approval gates** for secrets, production deploys, destructive migrations, and final merges.

## Non-goals (v0.1)

- Real-time agent coordination (workers are sequential per worktree at v0.1; v0.2 adds parallelism within a single run)
- Production deploy automation (v0.3+)
- Automated CI gating (v0.3 — first ship a manual `pnpm auto:status` review pattern)

---

## System diagram

```
                                ┌────────────────────────────────┐
                                │  Operator (you) or scheduler   │
                                └────────────────┬───────────────┘
                                                 │
                                                 ▼
                                ┌────────────────────────────────┐
                                │  Orchestrator                  │
                                │  tools/autonomous-delivery/    │
                                │  - generates task packs        │
                                │  - assigns worktrees           │
                                │  - tracks state                │
                                │  - dispatches Codex            │
                                └────────────────┬───────────────┘
                                                 │
                ┌────────────────────────────────┼────────────────────────────────┐
                ▼                                ▼                                ▼
   ┌────────────────────────┐  ┌────────────────────────────┐  ┌────────────────────────────┐
   │  Worktree A            │  │  Worktree B                │  │  Worktree C                │
   │  /private/tmp/auto-... │  │  /private/tmp/auto-...     │  │  /private/tmp/auto-...     │
   │  branch: docs/frd-mXX  │  │  branch: claude/sprint-Y   │  │  branch: docs/frd-mZZ      │
   │  Worker: Claude Code   │  │  Worker: Claude Code       │  │  Worker: Claude Code       │
   │  Task: TP-...-001      │  │  Task: TP-...-002          │  │  Task: TP-...-003          │
   └────────────┬───────────┘  └─────────────┬──────────────┘  └─────────────┬──────────────┘
                │                            │                                │
                ▼                            ▼                                ▼
   ┌────────────────────────────────────────────────────────────────────────────────┐
   │                       Per-worker pipeline (in worktree)                        │
   │                                                                                 │
   │  1. Read task pack (.agent-runs/<run_id>/tasks/TP-...-NNN.json)                │
   │  2. Duplicate scan: scan apps/web + packages + platform for existing impl      │
   │  3. Implement edits (bounded scope per task pack `allowed_paths`)              │
   │  4. Run targeted tests + typecheck + lint                                       │
   │  5. Capture evidence: diff, test summary, duplicate scan, risk register         │
   │  6. Write evidence to .agent-runs/<run_id>/evidence/TP-...-NNN/                │
   │  7. Update task state to `awaiting-review`                                      │
   └────────────────────────┬───────────────────────────────────────────────────────┘
                            │
                            ▼
                ┌────────────────────────────────┐
                │  Codex 5.5 xhigh Reviewer      │
                │  - reads task pack + bundle    │
                │  - independent verdict         │
                │  - outputs to .agent-runs/...  │
                └────────────────┬───────────────┘
                                 │
                                 ▼
                ┌────────────────────────────────┐
                │  Promote gate                  │
                │  - if Codex GO ≥7.0:           │
                │    git push + comment on PR    │
                │  - else: documented fold-in    │
                │    plan in evidence/           │
                └────────────────────────────────┘
```

---

## Task pack lifecycle

```
        unplanned
            │
            │ pnpm auto:plan
            ▼
        planned
            │
            │ pnpm auto:claim
            ▼
        claimed (worktree assigned, agent owner set)
            │
            │ worker scanning + implementing
            ▼
        in-progress
            │
            │ worker writes evidence
            ▼
        awaiting-review
            │
            │ pnpm auto:review (build bundle)
            │ pnpm auto:consensus (dispatch Codex)
            ▼
        codex-reviewing
            │
            ├─── Codex GO  ──→ promotable ──→ pnpm auto:promote ──→ merged
            └─── Codex NO-GO ──→ needs-revision ──→ (back to claimed; max 2 revision cycles before human-escalate)
```

State transitions are append-only (each transition writes a new event row to `.agent-runs/<run_id>/state-log.jsonl`).

---

## Storage layout

```
.agent-runs/
└── <run_id>/                         # e.g., "2026-04-26-frd-batch-1"
    ├── manifest.json                 # run metadata: created_at, owner, scope, budget
    ├── state-log.jsonl               # append-only state transitions for all tasks
    ├── tasks/
    │   ├── TP-2026-04-26-001.json    # individual task packs
    │   ├── TP-2026-04-26-002.json
    │   └── ...
    ├── evidence/
    │   ├── TP-2026-04-26-001/
    │   │   ├── diff.patch            # git diff at handoff
    │   │   ├── test-summary.md       # compact test results
    │   │   ├── test-full.log         # full test output (NOT in prompt)
    │   │   ├── duplicate-scan.json   # findings from duplicate scanner
    │   │   ├── risk-register.md      # security/governance risk notes
    │   │   ├── codex-bundle.txt      # what Codex actually saw
    │   │   ├── codex-verdict.md      # Codex output verbatim
    │   │   └── promotion-decision.md # final disposition
    │   └── ...
    └── logs/
        ├── orchestrator.log          # CLI command log
        └── worker-TP-...-NNN.log     # per-worker stdout/stderr
```

---

## Task pack schema (v0.1)

```typescript
interface TaskPack {
  task_id: string;                     // "TP-YYYY-MM-DD-NNN"
  run_id: string;                      // parent run
  type: TaskType;                      // see below
  module_or_sprint: string;            // "M02-v0.8" | "Sprint-AA-2" | etc.
  version_target: string;              // "v0.8" or "round-2-of-N"
  objective: string;                   // ≤ 500 chars; what success looks like
  acceptance_criteria: string[];       // ≤ 10 items; each testable
  allowed_paths: string[];             // glob patterns; worker MUST NOT edit outside
  forbidden_paths: string[];           // never touch (NEXT-SESSION.md, etc.)
  context_budget: {
    max_task_pack_kb: number;          // default 8
    max_log_summary_kb: number;        // default 4
    max_codex_bundle_kb: number;       // default 32
  };
  references: {
    fr_d_path?: string;                // for FRD tasks
    code_paths?: string[];             // for sprint tasks
    obsidian_paths?: string[];         // for FRD tasks
    prior_codex_output?: string;       // /tmp/codex-...-r{N-1}.md
  };
  commands: {
    duplicate_scan: string;            // shell command(s)
    implement: string[];               // OPTIONAL — usually worker decides
    test: string[];                    // shell commands; outputs go to evidence/
    typecheck: string;                 // "pnpm -F <pkg> typecheck"
    lint?: string;                     // "pnpm -F <pkg> lint"
  };
  consensus: {
    reviewer: "codex-5.5-xhigh";       // future: extensibility for other reviewers
    prompt_template: string;           // path to .txt template
    gate_threshold: number;            // default 7.0; signoff-ready 7.5
    max_rounds: number;                // default 2; revision cycles before human escalate
  };
  state: TaskState;                    // see lifecycle above
  state_history: StateTransition[];    // append-only
  evidence_dir: string;                // .agent-runs/<run_id>/evidence/<task_id>/
  worker?: {
    type: "claude-code" | "subagent" | "manual";
    worktree_path?: string;
    branch_name?: string;
    started_at?: string;
    completed_at?: string;
  };
  codex?: {
    bundle_path?: string;
    verdict_path?: string;
    score?: number;
    verdict?: "GO" | "NO-GO" | "SIGNOFF-READY";
    rounds_executed: number;
  };
}

type TaskType =
  | "frd-author"           // create FRD v0.1-draft from skeleton
  | "frd-polish"           // surgical fixes to advance FRD round
  | "frd-reconcile"        // FRD vs shipped-impl reconciliation
  | "code-sprint"          // implementation work
  | "test-coverage"        // add tests for untested module
  | "audit-log-route"      // BCBS 239 mutation-route audit
  | "platform-doc"         // NBF-* doc authoring
  | "next-session-refresh"; // handoff doc maintenance

type TaskState =
  | "unplanned"
  | "planned"
  | "claimed"
  | "in-progress"
  | "awaiting-review"
  | "codex-reviewing"
  | "promotable"
  | "needs-revision"
  | "merged"
  | "abandoned";
```

---

## Codex bundle format

What Codex sees (NOT the full FRD):

```
PROMPT TEMPLATE (path: tools/autonomous-delivery/templates/codex-frd-polish-review.txt)
═══════════════════════════════════════════════════════════════════════════════════

You are an advisory reviewer for {{module_id}} at {{version_target}}.

CONTEXT (≤500 words bounded):
{{objective}}

EDITS APPLIED IN THIS ROUND ({{change_count}} surgical edits — verify each landed):
{{edit_summary}}

DUPLICATE SCAN FINDINGS:
{{duplicate_scan_summary}}

TEST RESULTS:
{{test_summary}}

PRIOR ROUND VERDICT (for context, not re-litigation):
{{prior_codex_verdict_summary}}

REVIEW SCOPE:
{{review_axes}}

VERDICT FORMAT:
- Score: N.N / 10
- Verdict: GO ≥{{gate_threshold}} / NO-GO < threshold / SIGNOFF-READY ≥7.5
- For NO-GO: list 6-12 specific findings with line numbers + recommended fix
- Always end with: "Cross-module reciprocity status: PASS|FAIL with [evidence]"
```

Bundle size targets: ≤ 32 KB. Full FRD (~50KB) NEVER goes in; Codex reads file directly via its own tool.

---

## CI integration (v0.3+)

Add `.github/workflows/auto-delivery.yml`:

```yaml
on:
  pull_request:
    paths: ['.agent-runs/**', '**/*.md']
jobs:
  auto-delivery-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: |
          # Reject if .agent-runs/ task pack exceeds size budget
          pnpm auto:lint --check-budgets
          # Reject if any task in `awaiting-review` state has no evidence/
          pnpm auto:lint --check-evidence
          # Reject if Codex verdict is NO-GO and PR not labeled human-override
          pnpm auto:lint --check-codex-verdict
```

---

## Agent role definitions

Per the spec:

### Orchestrator
**Owns:** task pack creation, state tracking, Codex dispatch.
**v0.1 implementation:** TypeScript CLI (`src/cli/`).
**v0.2 extension:** scheduled daemon (cron) that picks `unplanned` modules off the roadmap and generates task packs.

### Claude Worker Agents
**Owns:** task implementation inside an isolated worktree.
**v0.1 implementation:** human or Claude Code session inside a worktree, reading the task pack.
**v0.2 extension:** spawned via Agent tool with `isolation: "worktree"` from a parent orchestrator session.

### Duplicate-Functionality Agent
**Owns:** scanning `apps/web` + `packages` + `platform` for existing implementation of the proposed capability.
**v0.1 implementation:** delegated to `Explore` subagent via documented prompt template.
**v0.2 extension:** dedicated `pnpm auto:scan-duplicates` script that uses tree-sitter + path-pattern matching to surface existing exports/routes/tables before any new code is written.

### Test Agent
**Owns:** running affected-package tests, summarizing failures.
**v0.1 implementation:** worker runs `pnpm -F <pkg> test` and writes summary.md per the task pack contract.
**v0.2 extension:** `pnpm auto:test --task TP-...` that reads the task pack's `commands.test`, runs each, and writes structured evidence.

### Security/Governance Agent
**Owns:** scanning for secrets, env mishandling, missing audit hooks, missing HITL gates.
**v0.1 implementation:** documented checklist in `templates/security-checklist.md` that the worker fills in.
**v0.2 extension:** `pnpm auto:scan-security` automated check.

### Docs/Handoff Agent
**Owns:** updating `NEXT-SESSION.md` round entry + change log; never modifies FRD bodies (single-writer rule).
**v0.1 implementation:** worker runs `pnpm auto:append-changelog --task TP-...` after merge.
**v0.2 extension:** auto-runs on `merged` state transition.

### Codex 5.5 xhigh Reviewer
**Owns:** independent consensus review.
**v0.1 implementation:** `pnpm auto:consensus --task TP-...` builds the bundle + invokes `~/.windsurf/extensions/openai.chatgpt-0.4.76-universal/bin/macos-aarch64/codex exec -m gpt-5.5 -c model_reasoning_effort=xhigh -s read-only`.
**v0.2 extension:** automatic re-dispatch on revision cycle; Codex output parsed into structured JSON.

---

## Quality gates summary

| Gate | When | What blocks |
|---|---|---|
| Working tree clean | pre-claim | Uncommitted changes outside scope |
| Task pack ≤ 8 KB | pre-claim | Oversized task packs |
| Duplicate scan filed | pre-implement | Missing scan |
| Tests green | pre-review | Failed tests / typecheck / lint |
| Evidence directory complete | pre-consensus | Missing artifacts |
| Codex verdict ≥ threshold | pre-promote | NO-GO without human override |
| Cross-module reciprocity PASS | pre-promote | FAIL without explicit decision |
| No secrets in diff | pre-promote | Detected secrets |

---

## Evolution roadmap

| Version | Capability | Target |
|---|---|---|
| **v0.1 (THIS PR)** | Foundation: schemas, 2 CLI commands, 1 pilot task pack, docs | landed in claude/autonomous-delivery-harness |
| v0.2 | All 6 CLI commands working; Explore-subagent integration; status dashboard | next 1-2 sessions |
| v0.3 | CI gate; scheduled daemon; first parallel-3 pilot run | next 3-5 sessions |
| v0.4 | Production hardening: error recovery, human-override flow, retry logic | next 5-10 sessions |
| v0.5 | Full-portfolio sweep: complete remaining 83 FRDs + 30+ sprints autonomously | target Q3 2026 |
