#!/usr/bin/env bash
# Instala el gateway claudeseek (Claude Code sobre DeepSeek) y la skill que le
# enseña a Claude Code cuándo y cómo delegar.
#
# NO toca settings.json ni ninguna variable ANTHROPIC_* global: el gateway solo
# se usa cuando algo lo invoca explícitamente (delegación headless o sesión
# interactiva dedicada). Tu sesión normal de Claude Code queda intacta.
#
# Seguro de correr varias veces: nunca pisa .env ni los logs si ya existen.

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

echo "Instalando gateway en $GATEWAY_DST ..."
mkdir -p "$GATEWAY_DST"
for f in "${CODE_FILES[@]}"; do
  cp -f "$GATEWAY_SRC/$f" "$GATEWAY_DST/$f"
done

ENV_PATH="$GATEWAY_DST/.env"
if [ ! -f "$ENV_PATH" ]; then
  echo "Creando $ENV_PATH con placeholder (no existía)..."
  cat > "$ENV_PATH" <<'EOF'
# Pegá acá tu API key de DeepSeek (https://platform.deepseek.com/api_keys).
# Una sola línea, sin comillas. Este archivo nunca se sube a git ni se pisa
# al reinstalar.
DEEPSEEK_API_KEY=PEGA_TU_API_KEY_AQUI
EOF
else
  echo "$ENV_PATH ya existe, no se toca."
fi

echo "Instalando skill claudeseek en $SKILL_DST ..."
rm -rf "$SKILL_DST"
mkdir -p "$(dirname "$SKILL_DST")"
cp -r "$SKILL_SRC" "$SKILL_DST"

# Migración: hasta la v0.2 la skill se llamaba "mascota-deepseek". Si quedó
# instalada, se saca para que Claude Code no vea dos skills iguales.
OLD_SKILL_DST="$CLAUDE_HOME/skills/mascota-deepseek"
if [ -d "$OLD_SKILL_DST" ]; then
  rm -rf "$OLD_SKILL_DST"
  echo "Skill vieja 'mascota-deepseek' eliminada (ahora se llama 'claudeseek')."
fi

LOCAL_BIN="$HOME/.local/bin"
if [ -d "$LOCAL_BIN" ]; then
  echo "Instalando comando corto 'deepseek' en $LOCAL_BIN ..."
  cp -f "$GATEWAY_SRC/bin/deepseek" "$LOCAL_BIN/deepseek"
  cp -f "$GATEWAY_SRC/bin/deepseek.cmd" "$LOCAL_BIN/deepseek.cmd"
  chmod +x "$LOCAL_BIN/deepseek"
else
  echo "AVISO: no existe $LOCAL_BIN, no se instaló el comando corto 'deepseek'."
  echo "       Usá $GATEWAY_DST/deepseek-session directo."
fi

echo
if ! command -v node >/dev/null 2>&1; then
  echo "AVISO: no se encontró 'node' en el PATH. Hace falta Node.js 18+."
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "AVISO: no se encontró 'claude' en el PATH. La delegación headless lo necesita."
fi

echo "Listo. Verificación:"
echo "  1) Pegá tu API key en: $ENV_PATH"
echo "  2) Corré: node \"$GATEWAY_DST/cli.mjs\" doctor"
echo "  3) Sesión sobre DeepSeek: deepseek [--model deepseek-flash-thinking] [-c|-r]"
echo
echo "Nada se activó todavía: el gateway arranca solo cuando algo lo usa"
echo "(delegación o sesión interactiva). Tu Claude Code normal sigue igual."
