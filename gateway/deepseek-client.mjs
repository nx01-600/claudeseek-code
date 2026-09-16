// Cliente HTTP hacia la API directa de DeepSeek (OpenAI-compatible).
// No sabe nada de Anthropic ni de Claude Code: solo habla el dialecto de
// DeepSeek. La traducción de protocolo vive en translate.mjs.

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
  if (!key) return '(sin key)';
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

// Resuelve la API key de DeepSeek. Nunca lee ni toca ninguna variable
// ANTHROPIC_*: esta función es la única frontera con el secreto de DeepSeek.
export function resolveApiKey(envPath) {
  const fromEnv = process.env.DEEPSEEK_API_KEY;
  if (fromEnv && cleanKeyValue(fromEnv)) {
    return { key: cleanKeyValue(fromEnv), source: 'variable de entorno DEEPSEEK_API_KEY' };
  }
  const vars = loadDotEnv(envPath);
  const cleaned = cleanKeyValue(vars.DEEPSEEK_API_KEY);
  if (cleaned && !cleaned.includes('PEGA_TU_API_KEY') && !cleaned.includes('TU_API_KEY')) {
    return { key: cleaned, source: `archivo ${envPath}` };
  }
  return { key: null, source: null };
}

// Catálogo de modelos: nombre que ve Claude Code -> { id real en DeepSeek,
// modo de razonamiento }. Acepta también el formato viejo "modelAliases".
export function getModels(config) {
  if (config.models) return config.models;
  const out = {};
  for (const [alias, id] of Object.entries(config.modelAliases || {})) out[alias] = { id, thinking: 'auto' };
  return out;
}

// Resuelve el modelo pedido. "known" indica si el nombre es de DeepSeek; si no
// lo es (por ejemplo una llamada interna de Claude Code con nombre de haiku),
// se devuelve el modelo por defecto para que quien llame decida qué hacer.
export function resolveModel(requested, config) {
  const models = getModels(config);
  if (requested && models[requested]) return { alias: requested, known: true, ...models[requested] };
  if (requested && /^deepseek[-/]/i.test(requested)) return { alias: requested, known: true, id: requested, thinking: 'auto' };
  const def = config.defaultModel || Object.keys(models)[0];
  return { alias: def, known: false, ...(models[def] || { id: def, thinking: 'auto' }) };
}

// Llama a DeepSeek en modo streaming. Devuelve un async generator que emite
// los objetos JSON ya parseados de cada evento "data: {...}" del SSE de
// DeepSeek (formato OpenAI-compatible). No acumula ni interpreta contenido:
// eso es responsabilidad de quien traduce hacia el formato de Anthropic.
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
    const err = new Error(e.name === 'AbortError' ? 'sin actividad de DeepSeek (timeout)' : e.message);
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
        if (!line.startsWith('data:')) continue; // ignora comentarios/keep-alive
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          yield JSON.parse(data);
        } catch {
          // chunk corrupto/partido, se ignora
        }
      }
    }
  } catch (e) {
    const err = new Error(e.name === 'AbortError' ? 'sin actividad de DeepSeek (timeout)' : e.message);
    err.networkError = true;
    throw err;
  } finally {
    clearTimeout(stallTimer);
  }
}

// Llamada no-streaming (usada solo si Claude Code pide stream:false).
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
    const err = new Error('DeepSeek respondió 200 pero el cuerpo no tiene el formato esperado (sin "choices").');
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
