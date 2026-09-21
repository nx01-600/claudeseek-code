#!/usr/bin/env bash
# Installs the claudeseek gateway (Claude Code running on DeepSeek) and the
# skill that teaches Claude Code when and how to delegate.
#
# Does NOT touch settings.json or any global ANTHROPIC_* variable: the gateway
# is only used when something explicitly invokes it (headless delegation or a
# dedicated interactive session). Your normal Claude Code session stays intact.
#
# Safe to run multiple times: never overwrites .env or the logs if they already exist.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
GATEWAY_SRC="$REPO_ROOT/gateway"
GATEWAY_DST="$CLAUDE_HOME/deepseek-gateway"
SKILL_SRC="$REPO_ROOT/claudeseek"
SKILL_DST="$CLAUDE_HOME/skills/claudeseek"

CODE_FILES=(
  deepseek-client.mjs translate.mjs server.mjs start.mjs cli.mjs scoped-env.mjs
  deepseek-agent.mjs deepseek-session.mjs deepseek-session.cmd deepseek-session
  escalate-to-sonnet.mjs dsk.cmd dsk config.json prices.json
)

echo "Installing gateway to $GATEWAY_DST ..."
mkdir -p "$GATEWAY_DST"
for f in "${CODE_FILES[@]}"; do
  cp -f "$GATEWAY_SRC/$f" "$GATEWAY_DST/$f"
done

ENV_PATH="$GATEWAY_DST/.env"
if [ ! -f "$ENV_PATH" ]; then
  echo "Creating $ENV_PATH with a placeholder (it didn't exist)..."
  cat > "$ENV_PATH" <<'EOF'
# Paste your DeepSeek API key here (https://platform.deepseek.com/api_keys).
# A single line, no quotes. This file is never pushed to git and never
# overwritten on reinstall.
DEEPSEEK_API_KEY=PASTE_YOUR_API_KEY_HERE
EOF
else
  echo "$ENV_PATH already exists, leaving it alone."
fi

echo "Installing the claudeseek skill to $SKILL_DST ..."
rm -rf "$SKILL_DST"
mkdir -p "$(dirname "$SKILL_DST")"
cp -r "$SKILL_SRC" "$SKILL_DST"

# Migration: up through v0.2 the skill was named "mascota-deepseek". If it's
# still installed, remove it so Claude Code doesn't see two identical skills.
OLD_SKILL_DST="$CLAUDE_HOME/skills/mascota-deepseek"
if [ -d "$OLD_SKILL_DST" ]; then
  rm -rf "$OLD_SKILL_DST"
  echo "Old 'mascota-deepseek' skill removed (now called 'claudeseek')."
fi

LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ]; then
  echo "Installing the short 'deepseek' command to $LOCAL_BIN ..."
  cp -f "$GATEWAY_SRC/bin/deepseek" "$LOCAL_BIN/deepseek"
  cp -f "$GATEWAY_SRC/bin/deepseek.cmd" "$LOCAL_BIN/deepseek.cmd"
  chmod +x "$LOCAL_BIN/deepseek"
else
  echo "WARNING: $LOCAL_BIN doesn't exist, the short 'deepseek' command wasn't installed."
  echo "       Use $GATEWAY_DST/deepseek-session directly."
fi

echo
if ! command -v node >/dev/null 2>&1; then
  echo "WARNING: could not find 'node' in PATH. Node.js 18+ is required."
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "WARNING: could not find 'claude' in PATH. Headless delegation needs it."
fi

echo "Done. Verification:"
echo "  1) Paste your API key into: $ENV_PATH"
echo "  2) Run: node \"$GATEWAY_DST/cli.mjs\" doctor"
echo "  3) Session on DeepSeek: deepseek [--model deepseek-flash-thinking] [-c|-r]"
echo
echo "Nothing was activated yet: the gateway only starts when something uses it"
echo "(delegation or an interactive session). Your normal Claude Code stays the same."
