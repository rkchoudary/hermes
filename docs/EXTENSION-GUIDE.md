# Extension Guide — autonomous-delivery harness

> How to add new task types, CLI commands, scanners, and CI gates to the harness.

## Adding a new task type

The v0.1 harness supports 3 task types: `frd-polish`, `frd-author`, `audit-log-route`. Adding more (e.g., `code-sprint`, `test-coverage`, `platform-doc`) follows this pattern:

### 1. Add to the `TaskType` enum in `src/lib/taskPack.ts`

```typescript
export const TaskType = z.enum([
  'frd-polish',
  'frd-author',
  'audit-log-route',
  'code-sprint',     // NEW
  // ...
]);
```

### 2. Add a `build<TaskType>Pack()` function in `src/cli/plan.ts`

```typescript
function buildCodeSprintPack(args: PlanArgs, runId: string, taskId: string): TaskPack {
  return TaskPack.parse({
    task_id: taskId,
    run_id: runId,
    type: 'code-sprint',
    module_or_sprint: `Sprint-${args.sprint}`,
    version_target: args.version,
    objective: 'Implement <sprint scope> per <ROADMAP/FRD reference>...',
    acceptance_criteria: [
      'New code added under <module path>',
      'Per-feature unit tests pass (≥90% coverage on new code)',
      'Cross-package integration test added if shared types touched',
      'pnpm typecheck + pnpm lint + pnpm build all green',
      'Codex code/architecture review GO ≥ threshold',
    ],
    allowed_paths: [
      `apps/web/src/lib/${args.module}/**`,
      `apps/web/src/lib/${args.module}/__tests__/**`,
    ],
    forbidden_paths: ['NEXT-SESSION.md', 'ROADMAP.md', 'apps/web/src/lib/!(${args.module})/**'],
    // ... etc
  });
}
```

### 3. Wire it into `main()`

```typescript
case 'code-sprint':
  pack = buildCodeSprintPack(args, runId, taskId);
  break;
```

### 4. Add a Codex prompt template

Create `templates/codex-code-sprint-review.txt` with task-type-appropriate review axes (e.g., for code-sprint: code coverage, security, error handling, performance, documentation).

### 5. Document the new type in `README.md` + `ARCHITECTURE.md` §Task-pack-schema

## Adding a new CLI command (`auto:status` / `auto:claim` / `auto:review` / `auto:promote`)

These are v0.2 milestones. Each follows the pattern in `src/cli/consensus.ts`:

1. Create `src/cli/<command>.ts`
2. Parse args
3. Find run + task
4. Execute logic
5. Update state via `appendStateTransition()` + `appendStateLog()`
6. Print human-readable output

Wire into `package.json` scripts:

```json
"auto:status": "tsx src/cli/status.ts"
```

### `auto:status` design (v0.2)

```bash
pnpm auto:status                          # show all runs
pnpm auto:status 2026-04-26-pilot-1       # show one run's tasks
pnpm auto:status TP-2026-04-26-001        # show one task's full state + evidence inventory
```

Output as a table:

```
RUN: 2026-04-26-pilot-1   (created 2026-04-26 by orchestrator)
═════════════════════════════════════════════════════════════════════
TASK              MOD/SPRINT    STATE              CODEX  AGE   FILES
TP-2026-04-26-001 M02-v0.8      promotable         7.6    2h    diff,tests,verdict
TP-2026-04-26-002 Sprint-AA-2   needs-revision     6.4    1h    diff,tests,verdict
TP-2026-04-26-003 Sprint-AA-3   in-progress        —      30m   diff
═════════════════════════════════════════════════════════════════════
3 tasks · 1 promotable · 1 needs-revision · 1 in-progress
```

### `auto:claim` design (v0.2)

```bash
pnpm auto:claim TP-2026-04-26-001
# Creates: /private/tmp/auto-TP-2026-04-26-001-wt/ on the appropriate branch
# Writes: claimed_by, worktree_path, branch_name to task pack
# Transitions state: planned → claimed → in-progress
```

### `auto:review` design (v0.2)

```bash
pnpm auto:review TP-2026-04-26-001
# Auto-collects evidence:
#   - git diff from worktree → evidence/diff.patch
#   - runs commands.test → evidence/test-summary.md + test-full.log
#   - runs commands.duplicate_scan → evidence/duplicate-scan.json
#   - runs typecheck + lint → evidence/lint-typecheck.log
# Transitions state: in-progress → awaiting-review
```

### `auto:promote` design (v0.2)

```bash
pnpm auto:promote TP-2026-04-26-001
# Verifies: state == promotable (Codex GO recorded)
# Verifies: no secrets in diff (gitleaks scan)
# Verifies: cross-module reciprocity PASS in Codex verdict
# Pushes branch to origin
# Comments on PR with Codex score + verdict + evidence dir link
# Transitions state: promotable → merged
```

## Adding a duplicate-functionality scanner (v0.3)

Currently `commands.duplicate_scan` is a shell command. v0.3 adds a structured scanner:

```typescript
// src/lib/duplicateScan.ts
export interface DuplicateFinding {
  capability_claim: string;     // what the new code claims to do
  existing_match: {
    file: string;
    line_range: [number, number];
    export_name: string;
    confidence: 'high' | 'medium' | 'low';
  } | null;
  recommendation: 'reuse' | 'extend' | 'new-because';
  reasoning: string;
}

export async function scanForDuplicates(
  taskPack: TaskPack,
  searchPaths: string[]
): Promise<DuplicateFinding[]> {
  // 1. Parse the task pack objective + AC for capability keywords
  // 2. Use ripgrep + tree-sitter to find candidate matches
  // 3. For each match, evaluate confidence
  // 4. Return findings (orchestrator writes to evidence/duplicate-scan.json)
}
```

The scanner becomes a hard-fail gate in `auto:review` if any HIGH-confidence duplicate is found without a `recommendation: 'extend'` decision.

## Adding a CI gate (v0.3)

`.github/workflows/auto-delivery.yml`:

```yaml
name: Autonomous Delivery Gate

on:
  pull_request:
    paths:
      - '.agent-runs/**'
      - 'tools/autonomous-delivery/**'

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - run: pnpm install --frozen-lockfile

      # Validate all changed task packs against schema
      - run: |
          for task_pack in $(git diff --name-only origin/main...HEAD | grep '^.agent-runs/.*/tasks/.*\.json$'); do
            pnpm tsx tools/autonomous-delivery/src/cli/lint.ts "$task_pack" || exit 1
          done

      # Verify evidence is present for any task transitioning past awaiting-review
      - run: pnpm auto:status --check-evidence

      # Verify Codex verdict is GO for any task transitioning to merged
      - run: pnpm auto:status --check-codex-verdict
```

This makes the harness self-policing: PRs that introduce oversized task packs, missing evidence, or NO-GO Codex verdicts (without explicit human-override label) are rejected at the GitHub Actions layer.

## Conventions to maintain

1. **Single-writer rule:** orchestrator writes to NEXT-SESSION.md + ROADMAP.md + the run-state files. Workers NEVER touch coordination docs.
2. **Append-only state log:** never modify or delete entries from `state-log.jsonl`. Bug fixes go in NEW entries with a corrective `reason`.
3. **Evidence-to-disk:** prompts NEVER carry full FRDs / full diffs / full logs. Codex bundle is summary + reference paths.
4. **Worktree naming:** `/private/tmp/auto-{task_id}-wt/` for v0.1; v0.2 may add a configurable prefix.
5. **Branch naming:** match existing patterns — `docs/frd-mXX-auth` for FRD work, `claude/sprint-NN` for code sprints.
6. **Commit messages:** include task ID in commit message for traceability: `docs(frd-mXX): v0.X-polish; Codex R{N} [score] [verdict] [auto-delivery TP-...]`.

## Open extension points (v0.4+)

- **Multi-reviewer consensus:** v0.4 may add a second Codex run with a different prompt (e.g., security-focused) to catch issues a single reviewer misses.
- **Cost tracking:** per-task Codex cost meter + budget alerts.
- **Dashboard UI:** web UI showing all runs + tasks + Codex verdicts (consumed from `.agent-runs/` files).
- **Auto-revision:** if Codex returns NO-GO with surgical fixes, auto-spawn a worker to apply them (max 1 auto-revision before human escalate).
- **A/B test runs:** spawn 2 workers on the same task with different approaches; pick the higher-Codex-score winner.
