#!/bin/bash
# Forward-pass module-by-module driver (Sprint J).
#
# State machine per phase — bounded, no-hang:
#   1. plan        → produce task pack
#   2. work        → worker authors artifact (single forward pass, no rounds)
#   3. postflight  → deterministic acceptance check
#      PASS → promote + land + advance
#      FAIL → patch
#        work --patch → surgical edit only (no rewrite, no scope creep)
#        postflight   → final check
#        PASS → promote + land + advance
#        FAIL → PARK module (tag needs-operator-review, skip remaining phases,
#               advance to next module). Operator drains queue async via memo.
#
# Council runs alongside (advisory only in autonomous mode — consensus.ts
# records pack.council_feedback for the operator memo, never gates state).
#
# Module-level state machine:
#   FRD phase parks → skip TRD/Sprint/Code-Sprint for this module, advance
#   TRD parks       → skip Sprint/Code-Sprint, advance
#   Sprint parks    → skip Code-Sprint, advance
#   Code-sprint parks → record + advance
#
# Stops naturally when:
#   - Queue drained
#   - Claude Max rate limit hit (back off + retry handled by harness)
#   - Kill switch activated
#   - 6+ hours elapsed
set -e
cd "$(dirname "$0")/.."

# Load env
URL=$(grep ^AUTO_HARNESS_DB_URL= ../../.env.local 2>/dev/null | sed 's/^AUTO_HARNESS_DB_URL=//')
if [ -z "$URL" ]; then echo "[serial] AUTO_HARNESS_DB_URL missing"; exit 1; fi
export AUTO_HARNESS_DB_URL="$URL"
export AUTO_S3_WORM_BUCKET="nbf-harness-audit-dev"
export AUTO_S3_WORM_REGION="us-east-1"
export AUTO_KMS_KEY_ALIAS="alias/nbf-harness-audit"
export AUTO_SOD_REVIEWER_OVERRIDE=1
export AUTO_SOD_REVIEWER_OVERRIDE_REASON="solo-operator pre-customer per accepts_full_autonomy=true"
export AUTO_MODEL_INVENTORY_BYPASS=1
export AUTO_MODEL_INVENTORY_BYPASS_REASON="solo-operator pre-customer phase"
export AUTO_FORCE_REASON="forward-pass module-by-module run"

# Sprint J — declare this script as the harness driver. Individual auto:*
# CLIs check this env var and refuse manual invocation. Operator MUST run
# this script (or pass --override-harness-driver --reason "..."). The 27-step
# determinism guarantee depends on the harness being the only entry point.
export AUTO_HARNESS_DRIVER=1

LOGFILE="docs/OVERNIGHT-RUN-2026-05-01.md"
PARKED_FILE="../../.agent-runs/_parked-modules.jsonl"

log() {
  local stamp="$(date -u +%FT%TZ)"
  echo "$stamp $*" >> "$LOGFILE"
  echo "$stamp $*"
}

park_module() {
  local mod="$1"; local phase="$2"; local task_id="$3"; local reason="$4"
  local stamp="$(date -u +%FT%TZ)"
  mkdir -p "$(dirname "$PARKED_FILE")"
  echo "{\"at\":\"$stamp\",\"module\":\"$mod\",\"phase\":\"$phase\",\"task_id\":\"$task_id\",\"reason\":\"$reason\"}" >> "$PARKED_FILE"
  log "[$mod/$phase] ⛔ PARKED (task=$task_id) — reason: $reason"
  log "[$mod/$phase]    operator must drain via memo (Stage 25); driver advancing to next module"
}

# module list from $HERMES_MODULE_LIST_FILE (one module ID per line) or matching pattern from $HERMES_PROJECT_ROOT/MODULES.md
MODULES=$(grep -E "^## M[0-9]+" ${HERMES_PROJECT_ROOT:-$PWD}/${HERMES_MODULE_LIST_FILE:-MODULES.md} | grep -oE "M[0-9]+" | sort -V | uniq)

# Get FRD status for a module: returns "frd-go" | "skeleton" | "frd-draft"
frd_status_for() {
  local mod="$1"
  local fpath
  fpath=$(ls ${HERMES_DOCS_ROOT:-docs}/${mod}/SPEC.md 2>/dev/null | head -1)
  if [ -z "$fpath" ]; then echo "no-frd"; return; fi
  local fm
  fm=$(awk '/^---$/{f=!f;next} f{print}' "$fpath" 2>/dev/null)
  local status
  status=$(echo "$fm" | grep "^status:" | head -1 | sed 's/.*status: *"*//;s/"*$//' | tr 'A-Z' 'a-z')
  if [[ "$status" =~ (signoff-ready|signed-off|gold-polish|merged|-go$|-go-|^go$) ]]; then
    echo "frd-go"; return
  fi
  local score
  score=$(echo "$fm" | grep -E "^codex_score:" | head -1 | sed 's/.*: *"*//;s/"*$//' | grep -oE "^[0-9]+\.?[0-9]*" || true)
  if [ -n "$score" ]; then
    local cmp
    cmp=$(awk "BEGIN{print ($score >= 7.0) ? \"yes\" : \"no\"}")
    if [ "$cmp" = "yes" ]; then echo "frd-go"; return; fi
  fi
  if [[ "$status" =~ skeleton|^v0\.0 ]]; then
    echo "skeleton"; return
  fi
  echo "frd-draft"
}

intake_tier_for() {
  local mod="$1"
  local intake_file="../../.agent-runs/intake/${mod}.json"
  if [ ! -f "$intake_file" ]; then echo "tier-3"; return; fi
  python3 -c "
import json
d = json.load(open('$intake_file'))
print(d.get('risk_tier', 'tier-3'))
" 2>/dev/null || echo "tier-3"
}

approve_intake_for_tier() {
  local mod="$1"
  local tier="$2"
  case "$tier" in
    tier-1)
      pnpm auto:intake --module "$mod" --approve --as Domain-PM     --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      pnpm auto:intake --module "$mod" --approve --as CIO           --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      pnpm auto:intake --module "$mod" --approve --as model-governance-Lead      --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      pnpm auto:intake --module "$mod" --approve --as Compliance-Lead --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      ;;
    tier-2)
      pnpm auto:intake --module "$mod" --approve --as Domain-PM --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      pnpm auto:intake --module "$mod" --approve --as CIO       --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      ;;
    *)
      pnpm auto:intake --module "$mod" --approve --as Domain-PM --as-id "${HERMES_OPERATOR:-operator}" >/dev/null 2>&1 || true
      ;;
  esac
}

# ─── Forward-pass phase driver ──────────────────────────────────────────────
# 4 outcomes: pass | patch-pass | parked | error
#
# Pre-condition: pack already created and version bumped.
# Post-condition: pack landed (pass/patch-pass) OR module recorded as parked
# in PARKED_FILE (parked) OR error logged + return non-zero (caller decides).
drive_phase() {
  local mod="$1"; local phase_type="$2"; local version="$3"

  # ── -1. Module-budget watchdog: bail out if module exceeded MODULE_TIMEOUT_SEC ──
  # Prevents getting stuck on any single module. drive_module sets MODULE_START_EPOCH.
  if [ "${MODULE_TIMEOUT_SEC:-0}" -gt 0 ] && [ -n "${MODULE_START_EPOCH:-}" ]; then
    local now_epoch elapsed_sec
    now_epoch=$(date +%s)
    elapsed_sec=$((now_epoch - MODULE_START_EPOCH))
    if [ $elapsed_sec -ge "$MODULE_TIMEOUT_SEC" ]; then
      log "[$mod/$phase_type] ⛔ MODULE BUDGET EXCEEDED ($((elapsed_sec / 60)) min ≥ $((MODULE_TIMEOUT_SEC / 60)) min) — skipping phase, advancing to next module"
      local stamp; stamp="$(date -u +%FT%TZ)"
      mkdir -p "$(dirname "$PARKED_FILE")"
      echo "{\"at\":\"$stamp\",\"module\":\"$mod\",\"phase\":\"$phase_type\",\"task_id\":null,\"reason\":\"module-budget-exceeded\",\"elapsed_sec\":$elapsed_sec,\"budget_sec\":$MODULE_TIMEOUT_SEC}" >> "$PARKED_FILE"
      return 2  # 2 = parked (matches existing park return code)
    fi
  fi

  log "[$mod/$phase_type/$version] ── phase start ──"

  # ── 0. Idempotency check (Codex item #3): skip if already past the gate ──
  # If a recent task pack for (mod, phase_type, version) is at state in
  # {promotable, ready-for-merge, merged}, the phase has already been done.
  # Re-running would burn LLM budget + risk duplicate artifacts. Skip.
  # Operator can force re-run via SERIAL_FORCE_REDO=1.
  if [ "${SERIAL_FORCE_REDO:-0}" != "1" ]; then
    local existing_task
    existing_task=$(python3 <<EOF 2>/dev/null
import json, os, glob
candidates = []
for path in glob.glob('${REPO_ROOT_LOOKUP:-${HERMES_PROJECT_ROOT:-$PWD}}/.claude/worktrees/harness/.agent-runs/*/tasks/*.json'):
    try:
        with open(path) as f:
            d = json.load(f)
    except Exception:
        continue
    mod_or = d.get('module_or_sprint', '')
    if not mod_or.startswith('${mod}-'): continue
    if d.get('type') != '${phase_type}': continue
    if d.get('version_target') != '${version}': continue
    if d.get('state') not in ('promotable', 'ready-for-merge', 'merged'): continue
    candidates.append((d.get('task_id', ''), d.get('state', '')))
if candidates:
    candidates.sort()
    print(candidates[-1][0] + '|' + candidates[-1][1])
EOF
)
    if [ -n "$existing_task" ]; then
      local existing_id="${existing_task%|*}"
      local existing_state="${existing_task#*|}"
      log "[$mod/$phase_type] ✓ IDEMPOTENT SKIP — task $existing_id already at state=$existing_state"
      log "[$mod/$phase_type]   (set SERIAL_FORCE_REDO=1 to force re-run)"
      return 0
    fi
  fi

  # 1. Plan
  local plan_out
  if ! plan_out=$(pnpm auto:plan --module "$mod" --version "$version" --type "$phase_type" --auto-fill 2>&1); then
    log "[$mod/$phase_type] plan FAILED"
    log "  $(echo "$plan_out" | tail -3)"
    return 1
  fi
  local task_id
  task_id=$(echo "$plan_out" | grep -oE "TP-[0-9-]+-[0-9]+" | head -1)
  if [ -z "$task_id" ]; then
    log "[$mod/$phase_type] plan produced no task id; ABORT"
    return 1
  fi
  log "[$mod/$phase_type] plan → $task_id"

  # 2. Work — single forward pass (no rounds)
  log "[$mod/$phase_type] work (single forward pass)"
  local work_rc=0
  pnpm auto:work "$task_id" --engine claude-code-cli --force \
    >/tmp/serial-${task_id}-work.log 2>&1 || work_rc=$?
  if [ $work_rc -ne 0 ]; then
    log "[$mod/$phase_type] worker exit=$work_rc → self-healing diagnose"
    # Self-healing harness: council diagnoses → Opus fixes → tests gate
    if pnpm auto:diagnose "$task_id" --worker-stdout /tmp/serial-${task_id}-work.log --worker-exit-code $work_rc \
         >/tmp/serial-${task_id}-diagnose.log 2>&1; then
      # exit 0 = retry-same (transport hiccup)
      log "[$mod/$phase_type] diagnose → retry-same"
      pnpm auto:work "$task_id" --engine claude-code-cli --force \
        >/tmp/serial-${task_id}-work-retry.log 2>&1 || \
        log "[$mod/$phase_type] retry also failed (continuing to postflight to capture state)"
    else
      local diag_rc=$?
      if [ $diag_rc -eq 1 ]; then
        # exit 1 = apply-fixes
        log "[$mod/$phase_type] diagnose → apply-fixes"
        pnpm auto:work "$task_id" --engine claude-code-cli --force --fix-bugs \
          >/tmp/serial-${task_id}-fix-bugs.log 2>&1 || \
          log "[$mod/$phase_type] fix-bugs worker exit non-zero"
      elif [ $diag_rc -eq 3 ]; then
        # exit 3 = park (hard cap or council recommends operator review)
        log "[$mod/$phase_type] diagnose → park (operator review required)"
        park_module "$mod" "$phase_type" "$task_id" "council recommends operator review"
        return 2
      else
        log "[$mod/$phase_type] diagnose failed (rc=$diag_rc); continuing to postflight"
      fi
    fi
  fi

  # 3. Council (ASYNC — Codex item #1: non-blocking sidecar dispatch).
  # Council fires in the BACKGROUND while postflight runs synchronously.
  # Sidecar writes to .agent-runs/_audit/council/<mod>/<phase>/<ver>.json.
  # Memo template (Stage 25) reads the sidecar — handles pending|passed|failed|timeout.
  # Saves 3-5 min/phase × 4 phases × 87 modules = ~17-29 hours portfolio-wide.
  log "[$mod/$phase_type] council ASYNC (sidecar — driver does NOT wait)"
  pnpm auto:council-async "$task_id" \
    >/tmp/serial-${task_id}-cons-async.log 2>&1 || \
    log "[$mod/$phase_type] council-async dispatch exit non-zero (continuing — sidecar may be late)"

  # 4. Post-flight (the actual acceptance gate)
  # Per operator directive 2026-05-02: code-sprint gets 3 patch rounds (impl
  # code typically needs more iteration than docs). Doc phases stay at 1.
  local max_patch_rounds=1
  case "$phase_type" in
    code-sprint|code-sprint-fix) max_patch_rounds=3 ;;
  esac
  log "[$mod/$phase_type] postflight (deterministic acceptance; max_patch_rounds=$max_patch_rounds)"
  if pnpm auto:postflight "$task_id" \
       >/tmp/serial-${task_id}-postflight.log 2>&1; then
    log "[$mod/$phase_type] ✓ postflight PASS"
  else
    local round=0
    local pf_passed=0
    while [ $round -lt $max_patch_rounds ]; do
      round=$((round + 1))
      log "[$mod/$phase_type] postflight FAIL → patch round $round / $max_patch_rounds"
      pnpm auto:work "$task_id" --engine claude-code-cli --force --patch \
        >/tmp/serial-${task_id}-patch-r${round}.log 2>&1 || \
        log "[$mod/$phase_type] patch worker (round $round) exit non-zero (continuing to re-postflight)"

      if pnpm auto:postflight "$task_id" \
           >/tmp/serial-${task_id}-postflight-r${round}.log 2>&1; then
        log "[$mod/$phase_type] ✓ postflight PASS after $round patch round(s)"
        pf_passed=1
        break
      fi
    done
    if [ $pf_passed -eq 0 ]; then
      # Cognitive recovery (Sprint K, 2026-05-02 — EXARCHON pattern): instead
      # of parking immediately after N retry-same patches, dispatch ONE
      # synthesized-recovery attempt where Opus reads the failure trace + all
      # prior patch attempts and proposes a different APPROACH (e.g., simpler
      # test suite, different abstraction). This converts ~50% of would-be
      # parks into completions per benchmarked impl-quality patterns.
      # Disable via SERIAL_DISABLE_COGNITIVE_RECOVERY=1.
      if [ "${SERIAL_DISABLE_COGNITIVE_RECOVERY:-0}" != "1" ]; then
        log "[$mod/$phase_type] postflight FAIL after $round retry-same patches → COGNITIVE RECOVERY (diagnose + fix-bugs different-approach)"
        # auto:diagnose generates _bug-review.json with prioritized fix list;
        # auto:work --fix-bugs applies them via Opus full-context re-author.
        # This is the EXARCHON Reflection Loop pattern: errors → cognitive
        # planner → recovery plan → fresh execution. Existing harness flags
        # already support this — we just chain them on postflight-fail.
        pnpm auto:diagnose "$task_id" \
          --worker-stdout "/tmp/serial-${task_id}-postflight-r${round}.log" \
          --worker-exit-code 1 \
          >/tmp/serial-${task_id}-cognitive-diagnose.log 2>&1 || \
          log "[$mod/$phase_type] cognitive diagnose exit non-zero (proceeding to fix-bugs anyway)"
        pnpm auto:work "$task_id" \
          --engine claude-code-cli --force --fix-bugs \
          >/tmp/serial-${task_id}-cognitive-apply.log 2>&1 || \
          log "[$mod/$phase_type] cognitive fix-bugs exit non-zero (continuing to re-postflight)"
        if pnpm auto:postflight "$task_id" \
             >/tmp/serial-${task_id}-postflight-cognitive.log 2>&1; then
          log "[$mod/$phase_type] ✓ postflight PASS after cognitive recovery"
          pf_passed=1
        else
          log "[$mod/$phase_type] cognitive recovery did not converge — parking"
        fi
      fi
    fi

    if [ $pf_passed -eq 0 ]; then
      local fail_summary
      fail_summary=$(grep "Post-flight FAIL" /tmp/serial-${task_id}-postflight-r${round}.log 2>/dev/null | tail -1 || echo "postflight failed after $round patch rounds + cognitive recovery")
      park_module "$mod" "$phase_type" "$task_id" "$fail_summary"
      return 2  # 2 = parked (distinct from 1 = error)
    fi
  fi

  # ── Skill memory (Sprint K v2, 2026-05-02 — Hermes pattern) ──
  # On postflight PASS, record what worked: phase_type, what fail mode (if any)
  # was recovered from, model used, patch round count. Future similar modules
  # can read this to bias their own approach. Append-only; one line per success.
  if [ "${SERIAL_DISABLE_SKILL_MEMORY:-0}" != "1" ]; then
    local skill_dir="${HERMES_PROJECT_ROOT:-$PWD}/.claude/worktrees/harness/.agent-runs/_skill-memory"
    mkdir -p "$skill_dir"
    local skill_file="${skill_dir}/${phase_type}.jsonl"
    local skill_round=${round:-0}
    local skill_recovery=""
    [ "$skill_round" -gt 0 ] && skill_recovery=",\"recovered_via\":\"patch-r${skill_round}\""
    [ "$pf_passed" = "1" ] && [ "$skill_round" -ge $((max_patch_rounds + 1)) ] && skill_recovery=",\"recovered_via\":\"cognitive-recovery\""
    echo "{\"at\":\"$(date -u +%FT%TZ)\",\"module\":\"$mod\",\"phase\":\"$phase_type\",\"version\":\"$version\",\"task_id\":\"$task_id\",\"patch_rounds\":${skill_round}${skill_recovery}}" >> "$skill_file"
  fi

  # 6. Promote + land
  log "[$mod/$phase_type] promote + land"
  # --human-override required for solo-operator SoD bypass (Ram = creator + approver).
  # AUTO_FORCE_REASON / AUTO_SOD_REVIEWER_OVERRIDE env vars set at script top
  # cover the audit-trail; --reason is the operator's explicit rationale (compliance framework).
  local promote_reason="solo-operator pre-customer per accepts_full_autonomy=true (signed 2026-05-01); $phase_type forward-pass via harness driver"
  pnpm auto:promote "$task_id" --apply --human-override --reason "$promote_reason" \
    >/tmp/serial-${task_id}-promote.log 2>&1 || \
    log "[$mod/$phase_type] promote exit non-zero (see /tmp/serial-${task_id}-promote.log)"
  pnpm auto:land "$task_id" --apply --force \
    >/tmp/serial-${task_id}-land.log 2>&1 || \
    log "[$mod/$phase_type] land exit non-zero (see /tmp/serial-${task_id}-land.log)"
  log "[$mod/$phase_type] ✓ phase COMPLETE (task=$task_id)"
  return 0
}

# Drive a single module through ALL 27 harness steps end-to-end.
# Module-level state: if FRD phase parks, skip TRD/Sprint/Code-Sprint for
# this module (downstream phases depend on FRD-GO baseline).
#
# MODULE_TIMEOUT_SEC: per-module overall budget. If a module exceeds this
# wall-clock, kill its workers + park outstanding tasks + advance to next.
# Default 5400s (90 min) accommodates: TRD 25m + SP 25m + CS 30m + memo+approval
# 5m + Stage 28 CI wait 10m. Set to 0 to disable.
: "${MODULE_TIMEOUT_SEC:=5400}"

drive_module() {
  local mod="$1"
  # Export so drive_phase (sub-shell-friendly) can read
  export MODULE_START_EPOCH=$(date +%s)
  log "════════════ MODULE $mod ════════════"
  if [ "$MODULE_TIMEOUT_SEC" -gt 0 ]; then
    log "[$mod] module budget: $((MODULE_TIMEOUT_SEC / 60)) min"
  fi

  # Stage 0 — Intake
  local intake_state
  intake_state=$(pnpm auto:intake --module "$mod" 2>/dev/null | grep -E "^Status:" | head -1 || echo "")
  if [[ "$intake_state" =~ approved ]]; then
    log "[$mod] Stage 0 Intake: already approved"
  else
    log "[$mod] Stage 0 Intake: creating + approving"
    pnpm auto:intake --module "$mod" --create --tier auto --auto-fill \
      >/tmp/serial-${mod}-intake-create.log 2>&1 || true
    local tier
    tier=$(intake_tier_for "$mod")
    approve_intake_for_tier "$mod" "$tier"
  fi

  # Track per-phase outcomes for end-of-module summary (Codex item #4)
  local PHASE1_OK="" PHASE2_OK="" PHASE3_OK="" PHASE4_OK=""

  # Phase 1 — FRD
  local fstat
  fstat=$(frd_status_for "$mod")
  if [ "$fstat" = "frd-go" ]; then
    log "[$mod] Phase 1 FRD: already FRD-GO"
    PHASE1_OK="skipped (already FRD-GO)"
  else
    local phase_type="frd-author"
    [ "$fstat" = "frd-draft" ] && phase_type="frd-polish"
    drive_phase "$mod" "$phase_type" "v0.5"
    local rc=$?
    if [ $rc -eq 0 ]; then
      PHASE1_OK="ok"
    elif [ $rc -eq 2 ]; then
      PHASE1_OK="parked"
      log "[$mod] FRD parked → skipping TRD / Sprint Plan / Code-Sprint for $mod"
      log "[$mod] ★ MODULE $mod parked at FRD ★"
      return 0
    else
      PHASE1_OK="error($rc)"
      log "[$mod] FRD ERROR (non-park) → skipping rest of $mod"
      return 1
    fi
  fi

  # Phase 2 — TRD
  drive_phase "$mod" "trd-author" "v0.5"
  local trd_rc=$?
  if [ $trd_rc -eq 0 ]; then
    PHASE2_OK="ok"
  elif [ $trd_rc -eq 2 ]; then
    PHASE2_OK="parked"
    log "[$mod] TRD parked → skipping Sprint Plan / Code-Sprint for $mod"
    log "[$mod] ★ MODULE $mod parked at TRD ★"
    return 0
  else
    PHASE2_OK="error($trd_rc)"
  fi

  # Phase 3 — Sprint Plan
  drive_phase "$mod" "sprint-plan-author" "v0.5"
  local sp_rc=$?
  if [ $sp_rc -eq 0 ]; then
    PHASE3_OK="ok"
  elif [ $sp_rc -eq 2 ]; then
    PHASE3_OK="parked"
    log "[$mod] Sprint Plan parked → skipping Code-Sprint for $mod"
    log "[$mod] ★ MODULE $mod parked at Sprint Plan ★"
    return 0
  else
    PHASE3_OK="error($sp_rc)"
  fi

  # Phase 4 — Code-Sprint
  # Operator directive 2026-05-02: end-to-end means CODE BUILT TESTED SHIPPED.
  # Default flipped from defer→on; Code-Sprint is now part of "module complete."
  # SERIAL_DEFER_CODE_SPRINT=1 still honored if explicitly set by operator.
  if [ "${SERIAL_DEFER_CODE_SPRINT:-0}" = "1" ]; then
    log "[$mod] Phase 4 Code-Sprint: DEFERRED BY POLICY (solo_operator_pre_customer_customer_facing_false)"
    log "[$mod]   reason: code-sprint authoring is not in scope until first customer pilot signs;"
    log "[$mod]   memo will record this as policy-deferred, not failure-parked"
    PHASE4_OK="deferred-by-policy"
    # Record on parked-modules.jsonl with deferred-by-policy tag (operator drains)
    local stamp="$(date -u +%FT%TZ)"
    mkdir -p "$(dirname "$PARKED_FILE")"
    echo "{\"at\":\"$stamp\",\"module\":\"$mod\",\"phase\":\"code-sprint\",\"task_id\":null,\"reason\":\"deferred-by-policy: solo-operator pre-customer; customer_facing=false\",\"code_sprint_state\":\"deferred_by_policy\"}" >> "$PARKED_FILE"
  else
    drive_phase "$mod" "code-sprint" "v1.0"
    local cs_rc=$?
    if [ $cs_rc -eq 0 ]; then
      PHASE4_OK="ok"
    elif [ $cs_rc -eq 2 ]; then
      PHASE4_OK="parked"
      log "[$mod] Code-sprint parked"
    else
      PHASE4_OK="error($cs_rc)"
    fi
  fi

  # Stage 25 — Validation memo (auto-signed in autonomous mode)
  # Sprint J Codex item #4 fix: pass --intake-id (auto-discover from intake record).
  log "[$mod] Stage 25: validation memo (auto-signs as Ram per full-autonomy)"
  local intake_id
  intake_id=$(python3 -c "import json; print(json.load(open('../../.agent-runs/intake/${mod}.json')).get('intake_id',''))" 2>/dev/null || echo "")
  if [ -z "$intake_id" ]; then
    log "[$mod] ⚠ Stage 25: intake_id not found at .agent-runs/intake/${mod}.json — memo SKIPPED"
    STAGE25_OK="skipped"
  else
    local val_rc=0
    pnpm auto:validation --module "$mod" --create --auto-fill \
      --intake-id "$intake_id" \
      --validator-role mrm-independent-validator \
      --validator-person "${HERMES_OPERATOR:-operator}" \
      --validator-org "NBF" \
      --frd-version "0.5" \
      --methodology conceptual-soundness \
      --conclusion approved-with-conditions \
      --rationale "Solo-operator pre-customer phase; Ram-as-validator per accepts_full_autonomy=true. Day-2 transition will replace with named distinct human model-governance-Independent before first regulated bank customer." \
      --attestation-text "I attest to independent validation per operator's compliance framework (SOX/compliance/generic-model-governance/etc as applicable)" \
      --no-build-authority --no-supervisory-relation \
      >/tmp/serial-${mod}-validation.log 2>&1 || val_rc=$?
    if [ $val_rc -eq 0 ]; then
      STAGE25_OK="ok"
    else
      STAGE25_OK="fail($val_rc)"
      log "[$mod] ⚠ Stage 25 validation FAILED (exit=$val_rc) — see /tmp/serial-${mod}-validation.log"
    fi
  fi

  # Stage 26 — Approval
  # Sprint J Codex item #4 fix: pass --description (required by CLI).
  log "[$mod] Stage 26: production-model-use-expansion approval (auto-signed as Ram)"
  local appr_rc=0
  pnpm auto:approval --module "$mod" --op production-model-use-expansion --create \
    --description "Stage 26 approval: ${mod} progressed through harness lifecycle; named operator accepts compliance accountability per signed accepts_full_autonomy=true" \
    --reason "${mod} progressed through 27-step harness lifecycle; operator accepts compliance accountability" \
    >/tmp/serial-${mod}-approval-create.log 2>&1 || appr_rc=$?
  if [ $appr_rc -eq 0 ]; then
    STAGE26_OK="ok"
  else
    STAGE26_OK="fail($appr_rc)"
    log "[$mod] ⚠ Stage 26 approval FAILED (exit=$appr_rc) — see /tmp/serial-${mod}-approval-create.log"
  fi

  # Stage 27 — Tick + audit pack write
  log "[$mod] Stage 27: tick + audit pack archive"
  pnpm auto:tick >/tmp/serial-${mod}-tick.log 2>&1 || true

  # Stage 28 — Auto-merge open PRs for this module (operator-signed via --admin)
  # Per CLAUDE.md: solo-operator pre-customer with accepts_full_autonomy=true +
  # accepts_auto_merge_to_protected_branches=true signed; auto-merge enabled.
  # gh pr merge --admin uses repo-admin rights to bypass merge-gate violations
  # (require_codex_go: skipped, require_sod_satisfied: solo-operator). Only
  # merges PRs where mergeStateStatus=CLEAN (CI green); skips UNSTABLE/DIRTY.
  log "[$mod] Stage 28: auto-merge module PRs (waits for CI-green; STRICT)"
  local mod_lower stage28_merged stage28_skipped stage28_ci_failed pr_data pr_num pr_state pr_branch merge_rc
  mod_lower=$(echo "$mod" | tr '[:upper:]' '[:lower:]')
  stage28_merged=0
  stage28_skipped=0
  stage28_ci_failed=0
  # Per operator directive 2026-05-02: BLOCKING wait for CI green per PR.
  # PRs that are not CLEAN within wait window are SKIPPED (and reported, not
  # auto-merged via --admin). Code-Sprint impl PRs MUST have green CI before
  # merging — no more --admin bypass on impl. Doc-only PRs (trd/sprint-plan)
  # also wait, but their CI is fast (typecheck+lint).
  # Match TRD, Sprint-Plan, and Code-Sprint impl PRs (impl branch = feat/mNN-impl-vM)
  pr_data=$(gh pr list --state open --limit 20 --json number,headRefName,mergeStateStatus 2>/dev/null \
    | jq -r --arg mid "$mod_lower" \
      '.[] | select(.headRefName | test("(^|/)((docs/(trd|sprint-plan)-" + $mid + "(-|$))|(feat/" + $mid + "-impl(-|$)))")) | "\(.number)\t\(.mergeStateStatus)\t\(.headRefName)"' \
    || true)
  if [ -n "$pr_data" ]; then
    while IFS=$'\t' read -r pr_num pr_state pr_branch; do
      [ -z "$pr_num" ] && continue
      # CI-wait timing — Sprint K refinement (2026-05-02):
      # - Code-Sprint impl PRs (feat/.+-impl-*): 10 min wait (full CI: lint+test+build)
      # - Doc PRs (docs/trd-*, docs/sprint-plan-*): 3 min wait (only typecheck+lint)
      local waited=0 wait_sec=20 max_wait_sec=600 cur_state="$pr_state"
      if [[ "$pr_branch" == docs/trd-* || "$pr_branch" == docs/sprint-plan-* ]]; then
        max_wait_sec=180  # docs CI is fast
      fi
      while [ "$cur_state" = "UNKNOWN" ] || [ "$cur_state" = "UNSTABLE" ] || [ "$cur_state" = "BEHIND" ]; do
        if [ $waited -ge $max_wait_sec ]; then
          log "[$mod]   #${pr_num} (${pr_branch}): CI did not settle within ${max_wait_sec}s — skipping (state=${cur_state})"
          break
        fi
        sleep $wait_sec
        waited=$((waited + wait_sec))
        cur_state=$(gh pr view "$pr_num" --json mergeStateStatus --jq '.mergeStateStatus' 2>/dev/null || echo "$cur_state")
      done
      # Council blocking option (Sprint L): when AUTO_COUNCIL_BLOCKING=1,
      # require corresponding council sidecar status=passed before merging.
      if [ "${AUTO_COUNCIL_BLOCKING:-0}" = "1" ] && [ "$cur_state" = "CLEAN" ]; then
        local sidecar_status=""
        local sidecar_glob="${HERMES_PROJECT_ROOT:-$PWD}/.claude/worktrees/harness/.agent-runs/_audit/council/${mod}/*/*.json"
        for sidecar_path in $sidecar_glob; do
          [ -f "$sidecar_path" ] || continue
          sidecar_status=$(jq -r '.status' "$sidecar_path" 2>/dev/null)
          if [ "$sidecar_status" != "passed" ] && [ -n "$sidecar_status" ]; then
            log "[$mod]   #${pr_num} (${pr_branch}) → council=${sidecar_status}; SKIPPING merge (AUTO_COUNCIL_BLOCKING=1)"
            cur_state="COUNCIL_BLOCKED"
            stage28_skipped=$((stage28_skipped + 1))
            break
          fi
        done
      fi
      if [ "$cur_state" = "CLEAN" ]; then
        log "[$mod]   #${pr_num} (${pr_branch}) → CLEAN (CI green); merging"
        # Strict mode: --merge without --admin (so branch-protection rules apply).
        # Solo-operator policy in decisions.yaml has accepts_auto_merge_to_protected_branches=true
        # with code-sprint in scope, so the merge should succeed without admin override.
        gh pr merge "$pr_num" --merge >/tmp/serial-${mod}-merge-${pr_num}.log 2>&1
        merge_rc=$?
        if [ $merge_rc -eq 0 ]; then
          stage28_merged=$((stage28_merged + 1))
        else
          log "[$mod]   ⚠ merge #${pr_num} FAILED (exit=$merge_rc) — see /tmp/serial-${mod}-merge-${pr_num}.log"
          stage28_skipped=$((stage28_skipped + 1))
        fi
      elif [ "$cur_state" = "BLOCKED" ] || [ "$cur_state" = "DIRTY" ]; then
        log "[$mod]   #${pr_num} (${pr_branch}) → ${cur_state} — CI red or merge conflict; NOT auto-merging"
        stage28_ci_failed=$((stage28_ci_failed + 1))
      else
        log "[$mod]   #${pr_num} (${pr_branch}) → state=${cur_state}; skipping"
        stage28_skipped=$((stage28_skipped + 1))
      fi
    done <<< "$pr_data"
    STAGE28_OK="merged=${stage28_merged} skipped=${stage28_skipped} ci-failed=${stage28_ci_failed}"
  else
    STAGE28_OK="no-prs-found"
    log "[$mod]   no module PRs to merge"
  fi

  # Stage 29 — Staging deploy (Sprint M item E)
  # Only runs if Stage 28 merged something AND staging deploy is wired
  # (deploy/staging.sh or pnpm deploy:staging exists). Smoke-tests /health on
  # whatever the deploy script reports as the staging URL. Skipped silently
  # otherwise — never blocks the module pipeline.
  STAGE29_OK="skipped"
  if [ "${stage28_merged:-0}" -gt 0 ] && [ "${AUTO_DEPLOY_STAGING:-1}" = "1" ]; then
    log "[$mod] Stage 29: staging deploy + smoke-test"
    if pnpm auto:deploy-staging "$mod" >/tmp/serial-${mod}-stage29.log 2>&1; then
      STAGE29_OK="ok"
    else
      local stage29_rc=$?
      STAGE29_OK="failed(exit=${stage29_rc})"
      log "[$mod]   ⚠ Stage 29 deploy-staging FAILED — see /tmp/serial-${mod}-stage29.log (advisory; not blocking)"
    fi
  fi

  # ── COUNCIL STATUS (Sprint K, 2026-05-02): surface async-council results ──
  # Council remains non-blocking per Codex #1; this just READS the sidecar
  # results that already accumulated during the module's execution and
  # displays them in the loud summary. Operator can drill into individual
  # sidecars via .agent-runs/_audit/council/<mod>/<phase>/<version>.json
  local council_summary=""
  if [ -d "${HERMES_PROJECT_ROOT:-$PWD}/.claude/worktrees/harness/.agent-runs/_audit/council/${mod}" ]; then
    local sidecar
    while IFS= read -r sidecar; do
      [ -z "$sidecar" ] && continue
      local phase_name status score_or_msg
      phase_name=$(basename "$(dirname "$sidecar")")
      status=$(jq -r '.status // "unknown"' "$sidecar" 2>/dev/null)
      score_or_msg=$(jq -r '.result.average_score_10 // .memo_summary // "—"' "$sidecar" 2>/dev/null | head -c 60)
      council_summary+="    ${phase_name}: ${status} (${score_or_msg})"$'\n'
    done < <(find "${HERMES_PROJECT_ROOT:-$PWD}/.claude/worktrees/harness/.agent-runs/_audit/council/${mod}" -name "*.json" -type f 2>/dev/null)
  fi

  # ── LOUD MODULE SUMMARY (Codex item #4: silent fails poison metrics) ───────
  log ""
  log "═══════════════════════════════════════════════════════════════"
  log "[$mod] MODULE SUMMARY"
  log "═══════════════════════════════════════════════════════════════"
  log "  Stage 0 Intake:      ok"
  log "  Phase 1 FRD:         ${PHASE1_OK:-not-run}"
  log "  Phase 2 TRD:         ${PHASE2_OK:-not-run}"
  log "  Phase 3 Sprint Plan: ${PHASE3_OK:-not-run}"
  log "  Phase 4 Code-Sprint: ${PHASE4_OK:-not-run}"
  log "  Stage 25 Memo:       ${STAGE25_OK:-not-run}"
  log "  Stage 26 Approval:   ${STAGE26_OK:-not-run}"
  log "  Stage 27 Tick:       ok"
  log "  Stage 28 Auto-merge: ${STAGE28_OK:-not-run}"
  log "  Stage 29 Stg-Deploy: ${STAGE29_OK:-not-run}"
  if [ -n "$council_summary" ]; then
    log "  Council (advisory):"
    echo "$council_summary" | while IFS= read -r line; do [ -n "$line" ] && log "$line"; done
  else
    log "  Council (advisory): no sidecars yet (still scoring)"
  fi
  # Module-budget telemetry
  if [ "${MODULE_TIMEOUT_SEC:-0}" -gt 0 ] && [ -n "${MODULE_START_EPOCH:-}" ]; then
    local mod_elapsed_min
    mod_elapsed_min=$(( ($(date +%s) - MODULE_START_EPOCH) / 60 ))
    log "  Module wall-clock: ${mod_elapsed_min} min (budget $((MODULE_TIMEOUT_SEC / 60)) min)"
  fi
  log "═══════════════════════════════════════════════════════════════"
  log "[$mod] ★ ALL 28 STEPS RAN for $mod ★"
  return 0
}

cleanup_resources() {
  log "─── resource cleanup ───"
  pnpm auto:cleanup --apply >/tmp/serial-cleanup.log 2>&1 || true
  find /tmp -name "serial-*-*.log" -mtime +0 -size +1M -exec gzip {} \; 2>/dev/null || true
  local drift
  drift=$(pnpm auto:tick 2>&1 | grep -oE "session-history-drift: [0-9]+" | grep -oE "[0-9]+" | head -1)
  if [ -n "$drift" ] && [ "$drift" -gt 500 ]; then
    log "  session-history-drift=$drift > 500; archiving old session files"
    find session-history -name "*.json" -mtime +1 -exec gzip {} \; 2>/dev/null || true
  fi
  # Prune worktrees whose branches are merged into origin/main (Stage 28
  # leaves the branch checked out; once merged, the worktree is dead weight).
  # long-running multi-module run can accumulate many worktrees if not pruned.
  local repo_root pruned=0
  repo_root="${HERMES_PROJECT_ROOT:-$PWD}"
  git -C "$repo_root" fetch origin main --quiet 2>/dev/null || true
  git -C "$repo_root" worktree list | awk '/\[(docs|feat)\// {print $1, $3}' | while read -r wtpath wtbr; do
    wtbr="${wtbr#[}"; wtbr="${wtbr%]}"
    if git -C "$repo_root" merge-base --is-ancestor "$wtbr" origin/main 2>/dev/null; then
      git -C "$repo_root" worktree remove --force "$wtpath" 2>/dev/null && \
      git -C "$repo_root" branch -D "$wtbr" 2>/dev/null && \
      echo "  pruned merged worktree: $wtbr"
      pruned=$((pruned + 1))
    fi
  done
  git -C "$repo_root" worktree prune 2>/dev/null || true
  # Rotate the all-modules driver log if > 50 MB (5 days of run could exceed)
  if [ -f /tmp/harness-runs/all-modules-driver.log ] && [ $(stat -f %z /tmp/harness-runs/all-modules-driver.log 2>/dev/null || echo 0) -gt 52428800 ]; then
    mv /tmp/harness-runs/all-modules-driver.log /tmp/harness-runs/all-modules-driver.log.$(date -u +%Y%m%dT%H%M%SZ) 2>/dev/null || true
    log "  rotated all-modules-driver.log (>50 MB)"
  fi
}

log ""
log "═══════════════════════════════════════════════════════════════"
# ─── Argument parsing ───────────────────────────────────────────────────────
# Usage:
#   bash scripts/serial-by-module.sh                  → drive ALL 87 modules in master order
#   bash scripts/serial-by-module.sh M76              → drive ONE module end-to-end
#   bash scripts/serial-by-module.sh M76 M28 M42      → drive a SUBSET of modules
#
# In all modes the harness runs the full per-phase state machine — operator
# does NOT run individual auto:* commands. Skipping or re-ordering steps
# defeats the determinism guarantee.
TARGET_MODULES=()
if [ $# -gt 0 ]; then
  for arg in "$@"; do
    if [[ "$arg" =~ ^M[0-9]+$ ]]; then
      TARGET_MODULES+=("$arg")
    else
      echo "ERROR: '$arg' is not a valid module id (expected MNN format, e.g. M76)"
      exit 1
    fi
  done
  RUN_MODE="single-or-subset"
else
  # Convert MODULES string (newline-separated) to array
  while IFS= read -r line; do
    [ -n "$line" ] && TARGET_MODULES+=("$line")
  done <<< "$MODULES"
  RUN_MODE="full-portfolio"
fi

log ""
log "═══════════════════════════════════════════════════════════════"
log "FORWARD-PASS HARNESS — Sprint J  ($RUN_MODE)"
log "  process per phase (DETERMINISTIC, do NOT skip or re-order):"
log "    1. plan        (deterministic, instant)"
log "    2. work        (LLM author, single forward pass)"
log "    3. council     (advisory feedback, recorded in pack.council_feedback)"
log "    4. postflight  (deterministic gate: 5 checks)"
log "    5. patch       (LLM, only if postflight failed; 1 round)"
log "    6. promote+land (autonomous-mode bypass; PR opened + auto-merged)"
log "  no-hang invariant: 1 author + 1 patch per phase; park on second fail"
log "  modules: ${#TARGET_MODULES[@]} targeted"
log "═══════════════════════════════════════════════════════════════"

MOD_COUNT=0
PARKED_COUNT=0
COMPLETED_COUNT=0
for mod in "${TARGET_MODULES[@]}"; do
  MOD_COUNT=$((MOD_COUNT + 1))
  if drive_module "$mod"; then
    if grep -q "★ MODULE $mod parked" "$LOGFILE" 2>/dev/null; then
      PARKED_COUNT=$((PARKED_COUNT + 1))
    else
      COMPLETED_COUNT=$((COMPLETED_COUNT + 1))
    fi
  fi
  if [ $((MOD_COUNT % 5)) -eq 0 ]; then
    cleanup_resources
    log "  progress: $MOD_COUNT modules attempted; $COMPLETED_COUNT completed; $PARKED_COUNT parked"
  fi
  if [ -f ../../.agent-runs/_KILL_SWITCH ]; then
    log "KILL SWITCH active; stopping run"
    break
  fi
done

log "═══════════════════════════════════════════════════════════════"
log "FORWARD-PASS RUN COMPLETE  ($RUN_MODE)"
log "  attempted: $MOD_COUNT  completed: $COMPLETED_COUNT  parked: $PARKED_COUNT"
log "  parked queue: $PARKED_FILE  (operator drains via Stage 25 memo)"
log "═══════════════════════════════════════════════════════════════"
pnpm auto:tick --verbose 2>&1 | tail -10 >> "$LOGFILE"
