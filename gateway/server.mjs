// Gateway local: habla el protocolo de Anthropic (/v1/messages) hacia Claude
// Code y lo traduce a la API directa de DeepSeek.
//
// Dos modos por petición:
// - "scoped": la petición trae el token de config.scopedToken, o sea viene de
//   un proceso de Claude Code lanzado para correr sobre DeepSeek (delegación o
//   sesión interactiva). TODO va a DeepSeek, incluidas las llamadas internas
//   que Claude Code hace con nombres de modelo de Anthropic. Nunca se reenvía
//   nada a Anthropic con ese token, porque no es una credencial de Anthropic.
// - normal: si el modelo es DeepSeek se traduce; si no, passthrough intacto
//   hacia api.anthropic.com.
//
// Escucha SOLO en 127.0.0.1. La key de DeepSeek nunca viaja a Anthropic y las
// credenciales de Anthropic nunca viajan a DeepSeek.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';
import {
  loadJson, resolveApiKey, resolveModel, getModels,
  streamDeepSeekChat, callDeepSeekChatOnce, estimateCost,
} from './deepseek-client.mjs';
import {
  anthropicToOpenAIRequest, openAIResponseToAnthropic, AnthropicStreamTranslator,
  anthropicErrorEnvelope, mapHttpStatusToAnthropicErrorType, shouldThink,
} from './translate.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const PRICES_PATH = path.join(SCRIPT_DIR, 'prices.json');
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const USAGE_LOG_PATH = path.join(SCRIPT_DIR, 'usage.jsonl');
const GATEWAY_LOG_PATH = path.join(SCRIPT_DIR, 'gateway.log');

const FORWARD_REQUEST_HEADERS = [
  'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta',
  'content-type', 'accept', 'anthropic-dangerous-direct-browser-access',
];
const DROP_RESPONSE_HEADERS = new Set(['content-length', 'transfer-encoding', 'connection', 'content-encoding']);

function log(line) {
  try { appendFileSync(GATEWAY_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch { /* no crítico */ }
}

function logUsage(entry) {
  try { appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* no crítico */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function isScoped(req, config) {
  const token = config.scopedToken;
  if (!token) return false;
  return req.headers.authorization === `Bearer ${token}` || req.headers['x-api-key'] === token;
}

async function passthrough(config, req, res, rawBody) {
  const headers = {};
  for (const h of FORWARD_REQUEST_HEADERS) {
    if (req.headers[h]) headers[h] = req.headers[h];
  }
  let upstream;
  try {
    upstream = await fetch(config.anthropicBaseUrl + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : rawBody,
    });
  } catch (e) {
    log(`ERROR passthrough ${req.method} ${req.url}: ${e.message}`);
    sendJson(res, 502, anthropicErrorEnvelope('api_error', `No se pudo contactar a Anthropic: ${e.message}`));
    return;
  }
  const outHeaders = {};
  for (const [k, v] of upstream.headers.entries()) {
    if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
  }
  res.writeHead(upstream.status, outHeaders);
  if (!upstream.body) { res.end(); return; }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

function listModels(config) {
  const ids = Object.keys(getModels(config));
  const data = ids.map((id) => ({ type: 'model', id, display_name: id, created_at: '2026-09-10T00:00:00Z' }));
  return { data, has_more: false, first_id: ids[0] ?? null, last_id: ids[ids.length - 1] ?? null };
}

async function handleMessages(config, prices, req, res, body) {
  const requested = body.model;
  const model = resolveModel(requested, config);
  const { key } = resolveApiKey(ENV_PATH);

  if (!key) {
    log(`ERROR sin API key de DeepSeek (modelo pedido=${requested})`);
    sendJson(res, 401, anthropicErrorEnvelope('authentication_error',
      `No hay API key de DeepSeek configurada. Pegala en ${ENV_PATH} como DEEPSEEK_API_KEY=sk-...`));
    return;
  }

  const thinking = shouldThink(body, model.thinking);
  // "vision" sale de config.json por modelo: si el modelo elegido no analiza
  // imágenes, el gateway las reemplaza por un aviso de texto antes de mandar.
  const openaiBody = anthropicToOpenAIRequest(body, { modelId: model.id, thinking, vision: model.vision !== false });
  const promptCharsEstimate = JSON.stringify(openaiBody.messages).length;
  const startedAt = Date.now();

  // Si Claude Code corta la petición (Ctrl+C, timeout), se corta también la
  // llamada a DeepSeek para no seguir pagando tokens que nadie va a leer.
  const controller = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) controller.abort(); });

  const record = (extra) => logUsage({
    ts: new Date().toISOString(), requested, model: model.id, thinking, ms: Date.now() - startedAt, ...extra,
  });
  const recordOk = (usage, stream) => record({
    stream, ok: true, in: usage.promptTotal, cached: usage.cached, out: usage.output, reasoning: usage.reasoning,
    cost_usd: estimateCost(model.id, prices, usage.promptTotal, usage.cached, usage.output),
  });
  const deepseekArgs = { baseUrl: config.deepseekBaseUrl, apiKey: key, body: openaiBody, signal: controller.signal };

  if (body.stream === false) {
    try {
      const json = await callDeepSeekChatOnce(deepseekArgs);
      const { anthropic, usage } = openAIResponseToAnthropic(json, { originalModel: requested, promptCharsEstimate });
      sendJson(res, 200, anthropic);
      recordOk(usage, false);
    } catch (e) {
      if (controller.signal.aborted) {
        log(`Cliente cerró la petición (no-stream, modelo=${model.id})`);
      } else {
        const status = e.status || 502;
        log(`ERROR DeepSeek no-stream modelo=${model.id}: ${e.message}`);
        sendJson(res, status, anthropicErrorEnvelope(mapHttpStatusToAnthropicErrorType(status), e.message));
        record({ stream: false, ok: false, error: e.message });
      }
    } finally {
      finished = true;
    }
    return;
  }

  // Se espera el primer evento de DeepSeek ANTES de mandar el 200: así un
  // 401/429/5xx inicial llega a Claude Code como status HTTP real y su lógica
  // de reintentos funciona igual que con Anthropic.
  const stream = streamDeepSeekChat(deepseekArgs);
  let first;
  try {
    first = await stream.next();
  } catch (e) {
    finished = true;
    if (controller.signal.aborted) { log(`Cliente cerró la petición antes de empezar (modelo=${model.id})`); return; }
    const status = e.status || 502;
    log(`ERROR DeepSeek stream modelo=${model.id}: ${e.message}`);
    sendJson(res, status, anthropicErrorEnvelope(mapHttpStatusToAnthropicErrorType(status), e.message));
    record({ stream: true, ok: false, error: e.message });
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const translator = new AnthropicStreamTranslator({ originalModel: requested, promptCharsEstimate });
  try {
    if (!first.done) {
      res.write(translator.handleChunk(first.value));
      for await (const chunk of stream) res.write(translator.handleChunk(chunk));
    }
    const { sse, usage } = translator.finalize();
    res.write(sse);
    recordOk(usage, true);
  } catch (e) {
    if (controller.signal.aborted) {
      log(`Cliente cerró la petición a mitad del stream (modelo=${model.id})`);
    } else {
      log(`ERROR DeepSeek a mitad del stream modelo=${model.id}: ${e.message}`);
      const errType = mapHttpStatusToAnthropicErrorType(e.status || 500);
      res.write(`event: error\ndata: ${JSON.stringify(anthropicErrorEnvelope(errType, e.message))}\n\n`);
      record({ stream: true, ok: false, error: e.message });
    }
  } finally {
    finished = true;
    res.end();
  }
}

function createServer() {
  const config = loadJson(CONFIG_PATH, null);
  if (!config) {
    process.stderr.write(`No se pudo leer ${CONFIG_PATH}\n`);
    process.exitCode = 1;
    return;
  }
  const prices = loadJson(PRICES_PATH, {});

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = (req.url || '').split('?')[0];
      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, pid: process.pid, uptimeSec: Math.round(process.uptime()) });
        return;
      }

      const rawBody = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
      let body = null;
      if (rawBody.length) {
        try { body = JSON.parse(rawBody.toString('utf8')); } catch { body = null; }
      }

      const scoped = isScoped(req, config);
      const deepseekModel = !!body && resolveModel(body.model, config).known;
      const route = scoped ? 'deepseek(scoped)' : deepseekModel ? 'deepseek' : 'passthrough';
      log(`${req.method} ${pathname} model=${body?.model ?? '-'} -> ${route}`);

      if (req.method === 'POST' && pathname === '/v1/messages/count_tokens') {
        if (scoped || deepseekModel) {
          const text = JSON.stringify(body?.messages ?? '') + JSON.stringify(body?.system ?? '') + JSON.stringify(body?.tools ?? '');
          sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(text.length / 4)) });
          return;
        }
        await passthrough(config, req, res, rawBody);
        return;
      }

      if (req.method === 'POST' && pathname === '/v1/messages' && body) {
        if (scoped || deepseekModel) {
          await handleMessages(config, prices, req, res, body);
          return;
        }
        await passthrough(config, req, res, rawBody);
        return;
      }

      if (scoped) {
        if (req.method === 'GET' && pathname === '/v1/models') {
          sendJson(res, 200, listModels(config));
          return;
        }
        if (req.method === 'GET' && pathname.startsWith('/v1/models/')) {
          const id = decodeURIComponent(pathname.slice('/v1/models/'.length));
          if (getModels(config)[id]) {
            sendJson(res, 200, { type: 'model', id, display_name: id, created_at: '2026-09-10T00:00:00Z' });
            return;
          }
        }
        sendJson(res, 404, anthropicErrorEnvelope('not_found_error', `El gateway DeepSeek no implementa ${req.method} ${pathname}`));
        return;
      }

      await passthrough(config, req, res, rawBody);
    } catch (e) {
      log(`ERROR no manejado: ${e.stack || e.message}`);
      if (!res.headersSent) sendJson(res, 500, anthropicErrorEnvelope('api_error', 'Error interno del gateway.'));
      else res.end();
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`El puerto ${config.port} ya está en uso (¿el gateway ya estaba corriendo?).\n`);
      process.exitCode = 0;
      return;
    }
    log(`ERROR de servidor: ${e.message}`);
    process.exitCode = 1;
  });

  server.listen(config.port, '127.0.0.1', () => {
    log(`Gateway escuchando en http://127.0.0.1:${config.port} (pid ${process.pid})`);
  });
}

// Se invoca siempre como proceso propio (`node server.mjs`).
createServer();
