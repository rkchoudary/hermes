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

# ─── Probe 3: claude in container with mounted auth ───────────────────
echo ""
echo "3. claude-code-cli inside container"
if [ ! -d "$HOME/.claude" ]; then
  fail "$HOME/.claude not present on host — claude max plan must be authenticated locally first"
else
  if docker run --rm \
      -v "$HOME/.claude:/home/worker/.claude:ro" \
      "$IMAGE" claude --version >/dev/null 2>&1; then
    ok "claude --version works with mounted ~/.claude"
  else
    fail "claude --version failed inside container — auth mount or binary path issue"
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

# ─── Probe 6: claude --print latency ──────────────────────────────────
echo ""
echo "6. claude --print latency (single token round-trip)"
if [ -d "$HOME/.claude" ]; then
  start=$(date +%s)
  out=$(docker run --rm \
      -v "$HOME/.claude:/home/worker/.claude:ro" \
      "$IMAGE" sh -c 'echo "Reply with one word: hello" | claude --print --dangerously-skip-permissions' 2>/dev/null | head -c 200)
  dur=$(( $(date +%s) - start ))
  if [ -n "$out" ] && [ $dur -lt 60 ]; then
    ok "claude --print returned in ${dur}s ($(echo "$out" | head -c 40)...)"
  elif [ $dur -ge 60 ]; then
    fail "claude --print took ${dur}s (>60s threshold) — Apple Silicon perf concern"
  else
    fail "claude --print returned no output (auth or model-routing issue)"
  fi
fi

# ─── Probe 7: egress allowlist ────────────────────────────────────────
echo ""
echo "7. Egress allowlist (network=$NETWORK)"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  # github.com — allowed
  if docker run --rm --network "$NETWORK" "$IMAGE" sh -c 'curl -sI -o /dev/null -w "%{http_code}" --max-time 10 https://github.com 2>/dev/null' | grep -qE '^(200|301|302)'; then
    ok "github.com reachable (allowlist works)"
  else
    fail "github.com NOT reachable on $NETWORK — allowlist is too tight"
  fi
  # example.com — should be denied
  if docker run --rm --network "$NETWORK" "$IMAGE" sh -c 'curl -sI -o /dev/null -w "%{http_code}" --max-time 10 https://example.com 2>/dev/null' | grep -qE '^(200|301|302)'; then
    fail "example.com IS reachable on $NETWORK — egress allowlist is NOT enforced (Mac Docker Desktop limitation, see setup-egress-bridge.sh)"
  else
    ok "example.com NOT reachable (egress denied as expected)"
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
