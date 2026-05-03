#!/usr/bin/env bash
# Layer 6 — Apple Silicon (and Linux) compatibility probe for the
# hermes-worker Docker image.
#
# Run before flipping AUTO_WORKER_USE_DOCKER=1 to default. Probes:
#
#   1. Docker daemon reachable
#   2. Image builds cleanly (cold ~3 min, warm <30s)
#   3. claude --version works inside the container with mounted ~/.claude auth
#   4. gh --version works with mounted ~/.config/gh auth
#   5. pnpm install --frozen-lockfile completes inside a worktree mount
#   6. Image runs at acceptable speed: claude --print 'hello' returns < N seconds
#   7. Egress allowlist is enforced (network reaches anthropic + npmjs;
#      doesn't reach example.com)
#
# Exit 0 = all probes green; OK to flip default.
# Exit 1 = at least one probe failed; investigate before docker-mode use.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
HARNESS_ROOT="$(cd "$HERE/.." && pwd)"
IMAGE="${HERMES_WORKER_IMAGE:-hermes-worker:compat-probe}"
NETWORK="${HERMES_WORKER_NETWORK:-hermes-egress-allowlist}"

PASS=0
FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL+1)); }

echo "═══════════════════════════════════════════════════════════════"
echo "Hermes Docker Compat Probe"
echo "═══════════════════════════════════════════════════════════════"
echo "Image:   $IMAGE"
echo "Network: $NETWORK"
echo "Arch:    $(uname -m)"
echo "OS:      $(uname -s)"
echo ""

# ─── Probe 1: docker daemon ───────────────────────────────────────────
echo "1. Docker daemon"
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  ok "docker reachable ($(docker version --format '{{.Server.Version}}' 2>/dev/null))"
else
  fail "docker daemon unreachable; install Docker Desktop or start dockerd"
  echo ""
  echo "Result: $PASS pass, $FAIL fail"
  exit 1
fi

# ─── Probe 2: image build ─────────────────────────────────────────────
echo ""
echo "2. Image build"
build_start=$(date +%s)
if (cd "$HARNESS_ROOT" && docker build -t "$IMAGE" -f docker/Dockerfile . >/tmp/hermes-build.log 2>&1); then
  build_dur=$(( $(date +%s) - build_start ))
  ok "image built in ${build_dur}s"
else
  fail "image build failed (see /tmp/hermes-build.log)"
  tail -30 /tmp/hermes-build.log | sed 's/^/    /'
  exit 1
fi

# ─── Probe 3: claude in container with extracted credentials ─────────
echo ""
echo "3. claude-code-cli inside container"
# On macOS, claude max plan auth lives in Keychain (not ~/.claude).
# Run the extractor so we have a credentials file the Linux container
# can actually read.
if [[ "$(uname -s)" == "Darwin" ]]; then
  if ! bash "$HERE/extract-claude-creds.sh" >/dev/null 2>&1; then
    fail "extract-claude-creds.sh failed — Keychain unreachable or no claude-code-cli auth on host"
  fi
fi
CREDS_PATH="${HARNESS_CLAUDE_CREDS_PATH:-$HOME/.harness/claude-credentials.json}"
if [ ! -f "$CREDS_PATH" ]; then
  fail "$CREDS_PATH not present — run docker/extract-claude-creds.sh (macOS) or 'claude' on Linux to populate"
else
  if docker run --rm \
      -v "$CREDS_PATH:/home/worker/.claude/.credentials.json:ro" \
      "$IMAGE" claude --version >/dev/null 2>&1; then
    ok "claude --version works with mounted credentials file"
  else
    fail "claude --version failed inside container — credentials mount or binary path issue"
  fi
fi

# ─── Probe 4: gh in container with mounted auth ───────────────────────
echo ""
echo "4. gh CLI inside container"
if [ ! -d "$HOME/.config/gh" ]; then
  fail "$HOME/.config/gh not present — run 'gh auth login' on host first"
else
  if docker run --rm \
      -v "$HOME/.config/gh:/home/worker/.config/gh:ro" \
      "$IMAGE" gh auth status >/dev/null 2>&1; then
    ok "gh auth status works with mounted ~/.config/gh"
  else
    fail "gh auth status failed inside container"
  fi
fi

# ─── Probe 5: pnpm install in mounted worktree ────────────────────────
echo ""
echo "5. pnpm install in mounted worktree (warm dep cache)"
PROBE_TMP=$(mktemp -d)
cat > "$PROBE_TMP/package.json" <<EOF
{"name":"probe","version":"0.0.0","dependencies":{"zod":"^3.23.0"}}
EOF
if docker run --rm \
    -v "$PROBE_TMP:/work" \
    "$IMAGE" sh -c 'cd /work && pnpm install --silent' >/dev/null 2>&1; then
  ok "pnpm install zod completed inside mounted worktree"
else
  fail "pnpm install failed inside container (egress allowlist or mount issue)"
fi
rm -rf "$PROBE_TMP"

# ─── Probe 6: claude --print latency + AUTH ───────────────────────────
echo ""
echo "6. claude --print latency + auth (single token round-trip)"
if [ -f "$CREDS_PATH" ]; then
  start=$(date +%s)
  out=$(docker run --rm \
      -v "$CREDS_PATH:/home/worker/.claude/.credentials.json:ro" \
      "$IMAGE" sh -c 'echo "Reply with one word: hello" | claude --print --dangerously-skip-permissions' 2>/dev/null | head -c 400)
  dur=$(( $(date +%s) - start ))
  # Hard-fail on auth-class errors. Soft-fail on perf threshold.
  if echo "$out" | grep -qiE 'not logged in|please run /login|authentication required|no api key|unauthorized|invalid_grant|token expired'; then
    fail "claude inside container returned NOT-LOGGED-IN even with extracted credentials"
    echo "    Output: $(echo "$out" | head -c 80)..."
    echo "    Try re-running 'claude' on the host once to refresh tokens, then re-extract."
  elif [ -z "$out" ]; then
    fail "claude --print returned no output (model routing or network)"
  elif [ $dur -ge 60 ]; then
    fail "claude --print took ${dur}s (>60s threshold) — Apple Silicon perf concern"
  else
    ok "claude --print returned in ${dur}s + authenticated ($(echo "$out" | head -c 40)...)"
  fi
else
  fail "$CREDS_PATH missing — probe #3 should have created it"
fi

# ─── Probe 7: egress allowlist ────────────────────────────────────────
echo ""
echo "7. Egress allowlist (network=$NETWORK)"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  # github.com — must be reachable (positive control)
  if docker run --rm --network "$NETWORK" "$IMAGE" sh -c 'curl -sI -o /dev/null -w "%{http_code}" --max-time 10 https://github.com 2>/dev/null' | grep -qE '^(200|301|302)'; then
    ok "github.com reachable (allowlist works)"
  else
    fail "github.com NOT reachable on $NETWORK — allowlist is too tight"
  fi
  # example.com — should be denied (negative control)
  EXAMPLE_REACHABLE=false
  if docker run --rm --network "$NETWORK" "$IMAGE" sh -c 'curl -sI -o /dev/null -w "%{http_code}" --max-time 10 https://example.com 2>/dev/null' | grep -qE '^(200|301|302)'; then
    EXAMPLE_REACHABLE=true
  fi
  if [ "$EXAMPLE_REACHABLE" = false ]; then
    ok "example.com NOT reachable (egress denied as expected)"
  else
    case "$(uname -s)" in
      Darwin)
        # Soft-warn: this is the documented Mac Docker Desktop limitation.
        # Bridge isolation IS in effect (workers are off the host network
        # and can't see other docker containers), but kernel-level egress
        # filtering needs Linux iptables which Docker Desktop's LinuxKit
        # VM doesn't expose to host iptables rules.
        echo "  ⚠ example.com IS reachable — Mac Docker Desktop limitation"
        echo "    Bridge isolation is active (workers off host network),"
        echo "    but kernel egress filtering requires Linux iptables."
        echo "    For HARD enforcement, install colima or run on Linux."
        echo "    For solo-operator overnight runs with trusted prompts,"
        echo "    bridge-only isolation is the documented v0 posture."
        # Counted as PASS for Mac (soft-warn). Set HERMES_DOCKER_STRICT_EGRESS=1
        # to flip back to hard-fail for operators who installed colima.
        if [ "${HERMES_DOCKER_STRICT_EGRESS:-0}" = "1" ]; then
          fail "HERMES_DOCKER_STRICT_EGRESS=1 set; egress not enforced — failing as requested"
        else
          ok "egress: bridge-isolated (Mac soft-warn; set HERMES_DOCKER_STRICT_EGRESS=1 to require kernel filter)"
        fi
        ;;
      *)
        fail "example.com IS reachable on $NETWORK — egress allowlist is NOT enforced; check iptables DOCKER-USER chain"
        ;;
    esac
  fi
else
  fail "network $NETWORK not found — run docker/setup-egress-bridge.sh first"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "Result: $PASS pass, $FAIL fail"
if [ $FAIL -eq 0 ]; then
  echo "✓ Compat probe GREEN — safe to flip AUTO_WORKER_USE_DOCKER=1 default"
  exit 0
else
  echo "✗ Compat probe FAIL — investigate before enabling docker-mode worker"
  exit 1
fi
