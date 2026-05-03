#!/usr/bin/env bash
# Layer 6 — Egress allowlist bridge for hermes-worker containers.
#
# Creates a docker bridge network with iptables rules that constrain
# outbound traffic to a fixed allowlist:
#   *.anthropic.com    (Claude API + claude-code-cli auth refresh)
#   github.com         (gh CLI + git pushes)
#   *.npmjs.org        (pnpm registry)
#   registry.npmjs.org
#
# Re-runs are idempotent.
#
# Usage:
#   sudo bash docker/setup-egress-bridge.sh
#
# Verify:
#   docker network inspect hermes-egress-allowlist
#   docker run --rm --network hermes-egress-allowlist alpine sh -c 'apk add curl && curl -sI https://example.com'
#     → should TIMEOUT (egress blocked)
#   docker run --rm --network hermes-egress-allowlist alpine sh -c 'apk add curl && curl -sI https://github.com'
#     → should return 200
set -euo pipefail

NETWORK_NAME="hermes-egress-allowlist"
SUBNET="172.30.42.0/24"

if ! command -v docker >/dev/null 2>&1; then
  echo "[setup-egress-bridge] docker is not installed — install Docker Desktop first"
  exit 1
fi

if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "[setup-egress-bridge] creating bridge network $NETWORK_NAME ($SUBNET)"
  docker network create \
    --driver bridge \
    --subnet "$SUBNET" \
    --opt com.docker.network.bridge.name=hermes-br0 \
    "$NETWORK_NAME"
else
  echo "[setup-egress-bridge] network $NETWORK_NAME already exists"
fi

# Allowlist hostnames. Resolved at rule-install time; refresh by re-running.
ALLOWED_HOSTS=(
  "api.anthropic.com"
  "claude.ai"
  "console.anthropic.com"
  "github.com"
  "api.github.com"
  "raw.githubusercontent.com"
  "objects.githubusercontent.com"
  "codeload.github.com"
  "registry.npmjs.org"
  "registry.npmjs.com"
)

# On Linux hosts, install iptables rules. On Docker Desktop for Mac, the
# bridge runs inside the LinuxKit VM and host iptables don't apply; rely
# on Docker's network-level isolation + the worker container's lack of
# DNS for non-allowlist hosts (we ship a stub /etc/hosts in the image).
case "$(uname -s)" in
  Linux)
    echo "[setup-egress-bridge] Linux detected; installing iptables egress rules"
    sudo iptables -F DOCKER-USER 2>/dev/null || true
    sudo iptables -A DOCKER-USER -i hermes-br0 -d 169.254.169.254 -j REJECT  # block AWS metadata
    for host in "${ALLOWED_HOSTS[@]}"; do
      for ip in $(getent hosts "$host" | awk '{print $1}' | sort -u); do
        sudo iptables -A DOCKER-USER -i hermes-br0 -d "$ip" -j ACCEPT
      done
    done
    sudo iptables -A DOCKER-USER -i hermes-br0 -j REJECT  # default-deny
    sudo iptables -A DOCKER-USER -j RETURN  # let other containers through
    ;;
  Darwin)
    echo "[setup-egress-bridge] macOS Docker Desktop detected"
    echo "[setup-egress-bridge] Note: full egress allowlist enforcement on Docker Desktop"
    echo "[setup-egress-bridge] requires writing to the LinuxKit VM. As a v0 mitigation:"
    echo "[setup-egress-bridge]   1. Workers run on this dedicated bridge — separates them"
    echo "[setup-egress-bridge]      from the host network and other containers."
    echo "[setup-egress-bridge]   2. Image's /etc/hosts is sealed at build time to resolve only"
    echo "[setup-egress-bridge]      the allowlist; non-allowlist hostnames produce DNS NXDOMAIN."
    echo "[setup-egress-bridge]   3. For full kernel-level egress filter on Mac, run inside a"
    echo "[setup-egress-bridge]      Linux VM via colima/lima/podman-machine and re-run this"
    echo "[setup-egress-bridge]      script there."
    ;;
  *)
    echo "[setup-egress-bridge] unsupported host OS: $(uname -s)"
    exit 1
    ;;
esac

echo "[setup-egress-bridge] done — bridge $NETWORK_NAME ready for hermes-worker containers"
