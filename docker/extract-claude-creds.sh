#!/usr/bin/env bash
# Extract claude-code-cli OAuth credentials from macOS Keychain into a
# file the Linux worker container can read.
#
# Why: on macOS, claude-code-cli stores its OAuth tokens (accessToken /
# refreshToken / expiresAt) in Keychain Services under the entry
# "Claude Code-credentials". A Docker volume mount of ~/.claude into a
# Linux container can't reach Keychain, so claude inside the container
# reports "Not logged in" and refuses to run.
#
# claude-code-cli on Linux has a fallback path: if Keychain is
# unreachable, it reads from ~/.claude/.credentials.json. By extracting
# the Keychain blob (which IS already a JSON envelope) into that file
# and mounting it into the container, the same auth flows.
#
# This script is macOS-only — on Linux operators, Keychain doesn't
# exist and claude-code-cli writes the file directly.
#
# Output (paths can be overridden):
#   $HOME/.harness/claude-credentials.json   chmod 600, JSON contents
#
# The extractor is idempotent — running it again refreshes the file if
# the Keychain blob has changed. Mount-time path on the container is
# always /home/worker/.claude/.credentials.json.
#
# IMPORTANT: this script writes a file containing OAuth secrets to
# disk. The destination path is gitignored by default (under .harness/);
# do not commit it. Token rotation (refreshToken expiry) is handled by
# claude-code-cli itself — it refreshes Keychain in the background, so
# re-running this script picks up the new tokens.
set -euo pipefail

DEST="${HARNESS_CLAUDE_CREDS_PATH:-$HOME/.harness/claude-credentials.json}"
SERVICE="Claude Code-credentials"

# 1. Verify host platform.
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[extract-claude-creds] non-macOS host detected ($(uname -s))" >&2
  echo "[extract-claude-creds] on Linux, claude-code-cli writes ~/.claude/.credentials.json natively;" >&2
  echo "[extract-claude-creds] no extraction needed. Mount ~/.claude into the container as before." >&2
  exit 0
fi

# 2. Verify Keychain entry exists.
if ! security find-generic-password -s "$SERVICE" >/dev/null 2>&1; then
  echo "[extract-claude-creds] Keychain entry '$SERVICE' not found." >&2
  echo "[extract-claude-creds] Run 'claude' on the host once to authenticate before extracting." >&2
  exit 1
fi

# 3. Read the credentials JSON.
CREDS=$(security find-generic-password -s "$SERVICE" -w 2>/dev/null)
if [[ -z "$CREDS" ]]; then
  echo "[extract-claude-creds] Keychain returned empty credentials blob." >&2
  exit 1
fi

# 4. Validate it's parseable JSON with the expected shape.
if ! echo "$CREDS" | jq -e '.claudeAiOauth.accessToken and .claudeAiOauth.refreshToken' >/dev/null 2>&1; then
  echo "[extract-claude-creds] Keychain blob is not the expected shape" >&2
  echo "    (need .claudeAiOauth.accessToken + .refreshToken). Schema may have changed." >&2
  exit 1
fi

# 5. Warn if the token is close to expiring (claude-cli refreshes on use,
#    but inside a fresh container without cached state it relies on the
#    refreshToken, which itself can be revoked over time).
EXPIRES_AT_MS=$(echo "$CREDS" | jq -r '.claudeAiOauth.expiresAt // 0')
NOW_MS=$(($(date +%s) * 1000))
REMAINING_MIN=$(( (EXPIRES_AT_MS - NOW_MS) / 60000 ))
if (( EXPIRES_AT_MS > 0 )) && (( REMAINING_MIN < 30 )); then
  echo "[extract-claude-creds] WARNING: accessToken expires in ${REMAINING_MIN}m." >&2
  echo "[extract-claude-creds] claude inside the container will need to refresh on first call." >&2
fi

# 6. Write the file with mode 600. Atomic via tmp+rename so a crashed
#    extraction can't leave a partial write.
mkdir -p "$(dirname "$DEST")"
TMP="${DEST}.tmp.$$"
printf '%s' "$CREDS" > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$DEST"

# 7. Make sure $HOME/.harness is gitignored at the project level (operator
#    needs to see a friendly reminder if they're in a git repo).
if [[ -d "$(pwd)/.git" ]] || git -C "$(pwd)" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GITIGNORE="$(git -C "$(pwd)" rev-parse --show-toplevel)/.gitignore"
  if [[ -f "$GITIGNORE" ]] && ! grep -qE '(^|/)\.harness(/|$)' "$GITIGNORE"; then
    echo "[extract-claude-creds] HINT: add '.harness/' to .gitignore so credentials don't accidentally get committed." >&2
  fi
fi

echo "[extract-claude-creds] wrote $DEST (mode 600, $(wc -c < "$DEST") bytes)"
echo "[extract-claude-creds] mount it into the worker container at /home/worker/.claude/.credentials.json:ro"
echo "$DEST"  # final stdout line = path, for shell pipeline use
