// HTTP client for DeepSeek's direct API (OpenAI-compatible).
// Knows nothing about Anthropic or Claude Code: it only speaks DeepSeek's
// dialect. Protocol translation lives in translate.mjs.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function cleanKeyValue(v) {
  if (!v) return '';
  let s = v.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function maskKey(key) {
  if (!key) return '(no key)';
  if (key.length <= 8) return 'sk-...' + key.slice(-2);
  return key.slice(0, 3) + '...' + key.slice(-4);
}

export function loadDotEnv(envPath) {
  const out = {};
  if (!existsSync(envPath)) return out;
  const raw = stripBom(readFileSync(envPath, 'utf8'));
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

export function loadJson(p, fallback) {
  try {
    return JSON.parse(stripBom(readFileSync(p, 'utf8')));
  } catch {
    return fallback;
  }
}

// Resolves the DeepSeek API key. Never reads or touches any ANTHROPIC_*
// variable: this function is the only boundary with the DeepSeek secret.
export function resolveApiKey(envPath) {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && cleanKeyValue(fromEnv)) {
    return { key: cleanKeyValue(fromEnv), source: 'DEEPSEEK_API_KEY environment variable' };
  }
  const vars = loadDotEnv(envPath);
  const cleaned = cleanKeyValue(vars.DEEPSEEK_API_KEY);
  if (cleaned && !cleaned.includes('PEGA_TU_API_KEY') && !cleaned.includes('TU_API_KEY') && !cleaned.includes('PASTE_YOUR_API_KEY')) {
    return { key: cleaned, source: `file ${envPath}` };
  }
  return { key: null, source: null };
}

// Model catalog: name Claude Code sees -> { real DeepSeek id, reasoning
// mode }. Also accepts the old "modelAliases" format.
export function getModels(config) {
  if (config.models) return config.models;
  const out = {};
  for (const [alias, id] of Object.entries(config.modelAliases || {})) out[alias] = { id, thinking: 'auto' };
  return out;
}

// Resolves the requested model. "known" says whether the name is a DeepSeek
// one; if it isn't (e.g. an internal Claude Code call using a haiku-style
// name), the default model is returned so the caller decides what to do.
export function resolveModel(requested, config) {
  const models = getModels(config);
  if (requested && models[requested]) return { alias: requested, known: true, ...models[requested] };
  if (requested && /^deepseek[-/]/i.test(requested)) return { alias: requested, known: true, id: requested, thinking: 'auto' };
  const def = config.defaultModel || Object.keys(models)[0];
  return { alias: def, known: false, ...(models[def] || { id: def, thinking: 'auto' }) };
}

// Calls DeepSeek in streaming mode. Returns an async generator that emits the
// already-parsed JSON objects from each "data: {...}" event of DeepSeek's SSE
// (OpenAI-compatible format). Doesn't accumulate or interpret content: that's
// the responsibility of whoever translates it into Anthropic's format.
export async function* streamDeepSeekChat({ baseUrl, apiKey, body, signal, stallTimeoutMs = 120000 }) {
  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  let stallTimer = null;
  const resetStall = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), stallTimeoutMs);
  };
  resetStall();

  let response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(stallTimer);
    const err = new Error(e.name === 'AbortError' ? 'no activity from DeepSeek (timeout)' : e.message);
    err.networkError = true;
    throw err;
  }

  if (!response.ok) {
    clearTimeout(stallTimer);
    let bodyText = '';
    try { bodyText = await response.text(); } catch { /* ignore */ }
    const err = new Error(`DeepSeek HTTP ${response.status}: ${bodyText.slice(0, 500)}`);
    err.status = response.status;
    err.bodyText = bodyText;
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data:')) continue; // ignore comments/keep-alive
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch {
          // corrupt/split chunk, ignored
        }
      }
    }
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'no activity from DeepSeek (timeout)' : e.message);
    err.networkError = true;
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }
}

// Non-streaming call (used only if Claude Code requests stream:false).
export async function callDeepSeekChatOnce({ baseUrl, apiKey, body, signal }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    const err = new Error(`DeepSeek HTTP ${response.status}`);
    err.status = response.status;
    err.body = json;
    throw err;
  }
  if (!json || !Array.isArray(json.choices)) {
    const err = new Error('DeepSeek responded 200 but the body doesn\'t have the expected format (no "choices").');
    err.status = 502;
    throw err;
  }
  return json;
}

export async function fetchLiveModels(baseUrl, apiKey) {
  const resp = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  return (data.data || []).map((m) => m.id);
}

export function estimateCost(model, prices, inTok, cachedTok, outTok) {
  const table = prices[model] || prices._default;
  if (!table) return null;
  const uncachedIn = Math.max(0, inTok - (cachedTok || 0));
  return (
    (uncachedIn / 1_000_000) * table.inputPerM +
    ((cachedTok || 0) / 1_000_000) * table.cachedInputPerM +
    (outTok / 1_000_000) * table.outputPerM
  );
}
