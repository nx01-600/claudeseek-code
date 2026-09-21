#!/usr/bin/env bash
# Uninstalls the claudeseek gateway and the skill. NEVER deletes .env,
# usage.jsonl, or agent-runs.jsonl -- if you want to delete them, do it by hand.
# If the gateway is running, it kills it first (otherwise it would leave an
# orphaned process with no one managing it).

set -uo pipefail

CLAUDE_HOME="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
GATEWAY_DST="$CLAUDE_HOME/deepseek-gateway"
SKILL_DST="$CLAUDE_HOME/skills/claudeseek"
OLD_SKILL_DST="$CLAUDE_HOME/skills/mascota-deepseek"

CODE_FILES=(
  deepseek-client.mjs translate.mjs server.mjs start.mjs cli.mjs scoped-env.mjs
  deepseek-agent.mjs deepseek-session.mjs deepseek-session.cmd deepseek-session
  dsk.cmd dsk config.json prices.json
)

# Gateway port (config.json takes precedence, 4319 by default).
PORT=4319
if [ -f "$GATEWAY_DST/config.json" ]; then
  P="$(node -e "try{console.log(require('$GATEWAY_DST/config.json').port||4319)}catch{console.log(4319)}" 2>/dev/null || echo 4319)"
  [ -n "$P" ] && PORT="$P"
fi

PID="$(node -e "
fetch('http://127.0.0.1:$PORT/health').then(r=>r.json()).then(j=>{if(j&&j.pid)console.log(j.pid)}).catch(()=>{})
" 2>/dev/null || true)"

if [ -n "${PID:-}" ]; then
  echo "Stopping gateway (pid $PID)..."
  kill "$PID" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.15
  done
fi

for f in "${CODE_FILES[@]}"; do
  p="$GATEWAY_DST/$f"
  if [ -f "$p" ]; then
    rm -f "$p"
    echo "Deleted: $p"
  fi
done
echo "Kept (on purpose): .env, usage.jsonl, agent-runs.jsonl, gateway.log in $GATEWAY_DST"

for d in "$SKILL_DST" "$OLD_SKILL_DST"; do
  if [ -d "$d" ]; then
    rm -rf "$d"
    echo "Deleted: $d"
  fi
done

LOCAL_BIN="$HOME/.local/bin"
for f in deepseek deepseek.cmd; do
  p="$LOCAL_BIN/$f"
  if [ -f "$p" ]; then
    rm -f "$p"
    echo "Deleted: $p"
  fi
done
