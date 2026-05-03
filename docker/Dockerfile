# Layer 6 — Hermes worker container.
#
# Doctrine: workers are isolated by default. One worktree + one container
# per dispatch. Host filesystem is never the recovery target.
#
# Build:
#   docker build -t hermes-worker:<sha> -f docker/Dockerfile .
#
# Run via auto:work --use-docker (or AUTO_WORKER_USE_DOCKER=1) — the
# spawn loop in src/cli/work.ts shells out to `docker run` instead of
# `spawn('claude', …)` when this flag is on.
#
# Image surface:
#   - node:22-bookworm-slim base (matches operator's local Node major)
#   - pnpm + git + gh + ripgrep + jq pinned at install time
#   - claude-code-cli installed globally (auth lives in /work/.claude
#     volume mount; image carries no secrets)
#   - non-root user (uid 1000) so file ownership matches the operator's
#     when worktrees are bind-mounted
#
# Worker contract (the harness mounts these at runtime):
#   /work/<MID>           — the per-module worktree (rw)
#   /work/.claude         — claude max plan auth (ro)
#   /work/.config/gh      — gh CLI auth (ro)
#   /evidence/<task_id>   — evidence dir (rw)
#
# Network: workers run on a custom bridge `hermes-egress-allowlist` with
# iptables rules constraining egress to *.anthropic.com, github.com,
# *.npmjs.org, registry.npmjs.org. Configure that bridge separately
# (docker/setup-egress-bridge.sh) before first use.
FROM node:22-bookworm-slim AS base

# Pin tool versions for reproducibility. Bumps come via image rebuild.
ARG GH_VERSION=2.61.0
ARG PNPM_VERSION=9.12.3

# Apt-get with --no-install-recommends to keep the image lean.
# gh CLI ships per-arch .deb files; use dpkg --print-architecture so the
# image builds correctly on both amd64 (Intel/AMD) and arm64 (Apple
# Silicon, AWS Graviton).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep jq build-essential \
 && DPKG_ARCH=$(dpkg --print-architecture) \
 && curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${DPKG_ARCH}.deb" -o /tmp/gh.deb \
 && dpkg -i /tmp/gh.deb \
 && rm /tmp/gh.deb \
 && rm -rf /var/lib/apt/lists/*

# pnpm via corepack to avoid global npm side effects.
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

# claude-code-cli — installed globally; auth comes via mounted ~/.claude
# at runtime so the image carries zero secrets.
RUN npm install -g @anthropic-ai/claude-code

# Non-root worker user; uid 1000 matches the typical operator uid so
# bind-mounted worktrees retain expected ownership across the boundary.
# The node:22-bookworm-slim base already ships a `node` user at uid 1000
# with a home dir at /home/node — rename it to `worker` so the rest of
# the image references stay consistent.
RUN usermod --login worker --move-home --home /home/worker node \
 && groupmod --new-name worker node

USER worker
WORKDIR /work

# Default cmd is overridden by the harness's docker run; this is just a
# sanity check that everything's in place.
CMD ["bash", "-lc", "claude --version && gh --version | head -1 && pnpm --version && git --version && echo 'hermes-worker image ready'"]
