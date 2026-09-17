// Construye el entorno de un proceso de Claude Code que corre sobre DeepSeek.
//
// Todo lo que se setea acá vive SOLO en ese proceso hijo. La sesión normal de
// Claude Code nunca ve estas variables y sigue con su login por suscripción.

import { getModels } from './deepseek-client.mjs';

// Bloquear WebSearch (server.mjs / los launchers) no alcanza: el modelo
// tiene que saber que existe un camino para investigar igual, si no lo pide
// por su cuenta o inventa datos. Se lo decimos directo en el system prompt
// en vez de confiar en que descubra la skill claudeseek solo (DeepSeek
// sigue esas convenciones peor que Claude).
export const WEBSEARCH_NOTICE = 'WebSearch esta deshabilitada en esta sesion: corre sobre DeepSeek, que no puede ejecutarla (es una herramienta de servidor de Anthropic). Si necesitas buscar algo en internet o verificar un dato actual, ejecuta con Bash: node "$HOME/.claude/deepseek-gateway/escalate-to-sonnet.mjs" --task "<que buscar>" -- lanza un Claude real (Sonnet) con WebSearch y devuelve la respuesta con fuentes. Usalo cada vez que haga falta informacion de internet; no inventes resultados ni digas que no podes buscar.';

// Variables que Claude Code le pone a los procesos que lanza. Si el hijo las
// hereda, puede creer que está anidado dentro de la sesión padre.
const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

// Solo las claves que hay que agregar/pisar para que un proceso de Claude
// Code corra sobre DeepSeek. Sirve tanto para spawn({env}) como para el
// bloque "env" de un archivo --settings.
export function scopedOverrides(config, { model } = {}) {
  const main = model || config.defaultModel;
  const roles = config.roleModels || {};
  const models = getModels(config);

  // Opción extra en el selector /model: la variante con o sin razonamiento
  // del modelo principal, para poder alternar sin salir de la sesión.
  const sibling = main.endsWith('-thinking') ? main.slice(0, -'-thinking'.length) : `${main}-thinking`;

  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    // El gateway reconoce este token y manda TODO a DeepSeek. No es un secreto:
    // la key real de DeepSeek la pone el gateway, nunca pasa por Claude Code.
    ANTHROPIC_AUTH_TOKEN: config.scopedToken,
    ANTHROPIC_MODEL: main,
    // Claude Code usa nombres de rol (opus/sonnet/haiku) para subagentes y
    // llamadas internas; se mapean a modelos de DeepSeek.
    ANTHROPIC_DEFAULT_OPUS_MODEL: roles.opus || main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: roles.sonnet || main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: roles.haiku || main,
    ANTHROPIC_SMALL_FAST_MODEL: roles.haiku || main,
    // Telemetría y chequeos que irían a Anthropic con un token que no es suyo.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Claude Code no reconoce "deepseek-flash" como modelo propio, así que
    // por defecto le asigna una ventana de contexto mucho más chica de la
    // real y compacta antes de tiempo. Esto le dice la ventana real.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.contextWindowTokens || 1_000_000),
  };

  if (models[sibling]) {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = sibling;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = sibling.endsWith('-thinking') ? 'DeepSeek con razonamiento' : 'DeepSeek sin razonamiento';
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = `${models[sibling].id} (API directa de DeepSeek)`;
  }
  return env;
}

// Para spawn({ env }): el entorno completo del proceso hijo (hereda el de
// esta sesión + los overrides de arriba). Uso: deepseek-session (interactiva
// en primer plano) y el modo --foreground de deepseek-agent.
export function buildScopedEnv(config, { model, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  for (const k of PARENT_SESSION_VARS) delete env[k];
  Object.assign(env, scopedOverrides(config, { model }));
  return env;
}
