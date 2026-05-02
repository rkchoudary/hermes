# Hermes Prompt Library

Pre-curated prompt templates for common dispatch types. Each template
encodes the *intent* of the task (what good looks like) into the worker
prompt, so the operator just describes the specific objective.

## How to use

```bash
pnpm auto:plan \
  --module M21 \
  --version v1.0 \
  --type code-sprint \
  --template templates/prompts/bug-fix.yaml \
  --objective "Fix race condition in payment webhook signature verification"
```

The `--template` flag tells the planner to merge the YAML's `prompt_prefix`,
`acceptance_criteria_template`, and `forbidden_paths_default` into the
generated TaskPack.

## What's available

| Template | Type | Risk | Use when |
|---|---|---|---|
| `bug-fix.yaml` | code-sprint | medium | Specific defect; minimal diff; regression test first |
| `feature-add.yaml` | code-sprint | medium | New capability in existing module |
| `test-coverage.yaml` | test-coverage | low | Add tests without changing behavior |
| `refactor.yaml` | code-sprint | medium | Improve internal structure; no behavior change |
| `dep-upgrade.yaml` | code-sprint | high | Bump a dependency safely |
| `security-fix.yaml` | code-sprint | critical | Patch a CVE or known weakness |
| `perf-fix.yaml` | code-sprint | medium | Measured before/after performance work |
| `doc-update.yaml` | platform-doc | low | Update docs to match current code |
| `migration.yaml` | code-sprint | high | Schema or data migration with reversibility |
| `e2e-test.yaml` | test-coverage | low | Write or extend end-to-end tests |

## Authoring your own

Drop a new YAML file in this directory with this shape:

```yaml
role: my-role-name
type: code-sprint                    # task type from TaskType enum
risk_class: medium                   # low | medium | high | critical

prompt_prefix: |
  You are a <role> worker. <one-paragraph mission statement>.

  HARD RULES (any violation fails post-flight):
  1. ...
  2. ...

acceptance_criteria_template:
  - 'AC 1 (testable)'
  - 'AC 2 (testable)'

forbidden_paths_default:
  - 'glob/of/paths/to/protect'
```

Then test it: `pnpm auto:plan --template templates/prompts/my-role.yaml ...`

## Conventions

- **HARD RULES** in the prompt are violations that fail post-flight (deterministic).
- **Acceptance criteria** are what the operator memo and council read for promotion.
- **Forbidden paths** override the operator's default; intersection wins.
- Prompts speak in second person ("You are a...") and end with an explicit list of constraints.
- Prompts avoid prescribing implementation details; they prescribe *outcomes*.
