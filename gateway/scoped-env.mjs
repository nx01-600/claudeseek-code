// Builds the environment for a Claude Code process running on DeepSeek.
//
// Everything set here lives ONLY in that child process. The normal Claude
// Code session never sees these variables and keeps its subscription login.

import { getModels } from './deepseek-client.mjs';

// Blocking WebSearch (server.mjs / the launchers) isn't enough: the model
// still needs to know there's a way to research anyway, or it'll ask for it
// on its own or make up data. We tell it directly in the system prompt
// instead of relying on it discovering the claudeseek skill by itself
// (DeepSeek follows those conventions worse than Claude does).
export const WEBSEARCH_NOTICE = 'WebSearch is disabled in this session: it runs on DeepSeek, which cannot execute it (it\'s an Anthropic server-side tool). If you need to search the internet or verify a current fact, run with Bash: node "$HOME/.claude/deepseek-gateway/escalate-to-sonnet.mjs" --task "<what to search for>" -- this launches a real Claude (Sonnet) with WebSearch and returns the answer with sources. Use it whenever you need internet information; do not make up results or say you cannot search.';

// Variables Claude Code sets on the processes it launches. If the child
// inherits them, it may think it's nested inside the parent session.
const PARENT_SESSION_VARS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];

// Only the keys that need to be added/overridden for a Claude Code process to
// run on DeepSeek. Used both for spawn({env}) and for the "env" block of a
// --settings file.
export function scopedOverrides(config, { model } = {}) {
  const main = model || config.defaultModel;
  const roles = config.roleModels || {};
  const models = getModels(config);

  // Extra option in the /model selector: the with/without-reasoning variant
  // of the main model, so you can switch without leaving the session.
  const sibling = main.endsWith('-thinking') ? main.slice(0, -'-thinking'.length) : `${main}-thinking`;

  const env = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.port}`,
    // The gateway recognizes this token and sends EVERYTHING to DeepSeek. It's
    // not a secret: the gateway holds the real DeepSeek key, which never passes through Claude Code.
    ANTHROPIC_AUTH_TOKEN: config.scopedToken,
    ANTHROPIC_MODEL: main,
    // Claude Code uses role names (opus/sonnet/haiku) for subagents and
    // internal calls; these map them to DeepSeek models.
    ANTHROPIC_DEFAULT_OPUS_MODEL: roles.opus || main,
    ANTHROPIC_DEFAULT_SONNET_MODEL: roles.sonnet || main,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: roles.haiku || main,
    ANTHROPIC_SMALL_FAST_MODEL: roles.haiku || main,
    // Telemetry and checks that would otherwise go to Anthropic with a token that isn't theirs.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // Claude Code doesn't recognize "deepseek-flash" as one of its own models,
    // so by default it assigns a context window much smaller than the real
    // one and compacts early. This tells it the real window size.
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(config.contextWindowTokens || 1_000_000),
  };

  if (models[sibling]) {
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = sibling;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = sibling.endsWith('-thinking') ? 'DeepSeek with reasoning' : 'DeepSeek without reasoning';
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = `${models[sibling].id} (direct DeepSeek API)`;
  }
  return env;
}

// For spawn({ env }): the child process's full environment (inherits this
// session's + the overrides above). Used by: deepseek-session (foreground
// interactive) and deepseek-agent's --foreground mode.
export function buildScopedEnv(config, { model, baseEnv = process.env } = {}) {
  const env = { ...baseEnv };
  delete env.ANTHROPIC_API_KEY;
  for (const k of PARENT_SESSION_VARS) delete env[k];
  Object.assign(env, scopedOverrides(config, { model }));
  return env;
}
