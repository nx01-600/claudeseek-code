// Local gateway: speaks Anthropic's protocol (/v1/messages) to Claude Code
// and translates it to DeepSeek's direct API.
//
// Two modes per request:
// - "scoped": the request carries the config.scopedToken token, meaning it
//   comes from a Claude Code process launched to run on DeepSeek (delegation
//   or an interactive session). EVERYTHING goes to DeepSeek, including the
//   internal calls Claude Code makes using Anthropic model names. Nothing is
//   ever forwarded to Anthropic with that token, because it isn't an
//   Anthropic credential.
// - normal: if the model is a DeepSeek one it gets translated; otherwise,
//   passthrough untouched to api.anthropic.com.
//
// Listens ONLY on 127.0.0.1. The DeepSeek key never travels to Anthropic and
// Anthropic credentials never travel to DeepSeek.

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
  try { appendFileSync(GATEWAY_LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8'); } catch { /* not critical */ }
}

function logUsage(entry) {
  try { appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* not critical */ }
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
    sendJson(res, 502, anthropicErrorEnvelope('api_error', `Could not reach Anthropic: ${e.message}`));
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
    log(`ERROR no DeepSeek API key (requested model=${requested})`);
    sendJson(res, 401, anthropicErrorEnvelope('authentication_error',
      `No DeepSeek API key configured. Paste it into ${ENV_PATH} as DEEPSEEK_API_KEY=sk-...`));
    return;
  }

  const thinking = shouldThink(body, model.thinking);
  // "vision" comes from config.json per model: if the chosen model can't
  // analyze images, the gateway replaces them with a text notice before sending.
  const openaiBody = anthropicToOpenAIRequest(body, { modelId: model.id, thinking, vision: model.vision !== false });
  const promptCharsEstimate = JSON.stringify(openaiBody.messages).length;
  const startedAt = Date.now();

  // If Claude Code cuts off the request (Ctrl+C, timeout), the call to
  // DeepSeek is also cut off so we don't keep paying for tokens no one will read.
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
        log(`Client closed the request (no-stream, model=${model.id})`);
      } else {
        const status = e.status || 502;
        log(`ERROR DeepSeek no-stream model=${model.id}: ${e.message}`);
        sendJson(res, status, anthropicErrorEnvelope(mapHttpStatusToAnthropicErrorType(status), e.message));
        record({ stream: false, ok: false, error: e.message });
      }
    } finally {
      finished = true;
    }
    return;
  }

  // We wait for DeepSeek's first event BEFORE sending the 200: this way an
  // initial 401/429/5xx reaches Claude Code as a real HTTP status and its
  // retry logic works the same as with Anthropic.
  const stream = streamDeepSeekChat(deepseekArgs);
  let first;
  try {
    first = await stream.next();
  } catch (e) {
    finished = true;
    if (controller.signal.aborted) { log(`Client closed the request before it started (model=${model.id})`); return; }
    const status = e.status || 502;
    log(`ERROR DeepSeek stream model=${model.id}: ${e.message}`);
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
      log(`Client closed the request mid-stream (model=${model.id})`);
    } else {
      log(`ERROR DeepSeek mid-stream model=${model.id}: ${e.message}`);
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
    process.stderr.write(`Could not read ${CONFIG_PATH}\n`);
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
        sendJson(res, 404, anthropicErrorEnvelope('not_found_error', `The DeepSeek gateway doesn't implement ${req.method} ${pathname}`));
        return;
      }

      await passthrough(config, req, res, rawBody);
    } catch (e) {
      log(`ERROR unhandled: ${e.stack || e.message}`);
      if (!res.headersSent) sendJson(res, 500, anthropicErrorEnvelope('api_error', 'Internal gateway error.'));
      else res.end();
    }
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      process.stderr.write(`Port ${config.port} is already in use (is the gateway already running?).\n`);
      process.exitCode = 0;
      return;
    }
    log(`ERROR server: ${e.message}`);
    process.exitCode = 1;
  });

  server.listen(config.port, '127.0.0.1', () => {
    log(`Gateway listening on http://127.0.0.1:${config.port} (pid ${process.pid})`);
  });
}

// Always invoked as its own process (`node server.mjs`).
createServer();
