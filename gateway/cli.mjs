#!/usr/bin/env node
// dsk - CLI de diagnóstico y control del gateway DeepSeek <-> Claude Code.
//
// La forma normal de usar DeepSeek ahora es elegirlo como modelo dentro de
// Claude Code (/model). Este CLI es para instalar, diagnosticar y operar el
// gateway, no para delegar tareas puntuales.

import { existsSync, readFileSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadJson, resolveApiKey, maskKey, getModels, fetchLiveModels, stripBom,
} from './deepseek-client.mjs';
import { ensureGatewayRunning } from './start.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const USAGE_LOG_PATH = path.join(SCRIPT_DIR, 'usage.jsonl');
const GATEWAY_LOG_PATH = path.join(SCRIPT_DIR, 'gateway.log');

function fmtCost(n) {
  if (n == null) return '?';
  return n < 0.01 ? n.toFixed(4) : n.toFixed(3);
}

function since(spec) {
  const m = /^(\d+)([dhm])$/.exec(spec || '');
  if (!m) return null;
  const unit = { d: 86400000, h: 3600000, m: 60000 }[m[2]];
  return Date.now() - Number(m[1]) * unit;
}

async function isAlive(port) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 1000);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function cmdDoctor() {
  const config = loadJson(CONFIG_PATH, null);
  const lines = [];
  lines.push(`node: ${process.version}`);
  lines.push(`config.json: ${config ? 'OK' : 'FALTA -> ' + CONFIG_PATH}`);
  if (!config) { process.stdout.write(lines.join('\n') + '\n'); return 1; }

  const { key, source } = resolveApiKey(ENV_PATH);
  if (!key) {
    lines.push(`API key: NO ENCONTRADA. Pegala en ${ENV_PATH} como DEEPSEEK_API_KEY=sk-...`);
    process.stdout.write(lines.join('\n') + '\n');
    return 2;
  }
  lines.push(`API key: ${maskKey(key)} (fuente: ${source})`);

  const health = await isAlive(config.port);
  lines.push(health
    ? `Gateway: corriendo en 127.0.0.1:${config.port} (pid ${health.pid}, uptime ${health.uptimeSec}s)`
    : `Gateway: NO responde en 127.0.0.1:${config.port}. Correr: node "${path.join(SCRIPT_DIR, 'cli.mjs')}" gateway start`);

  try {
    const ids = await fetchLiveModels(config.deepseekBaseUrl, key);
    lines.push(`Conectividad DeepSeek: OK. Modelos vivos: ${ids.join(', ')}`);
    for (const [name, m] of Object.entries(getModels(config))) {
      const vision = m.vision === false ? 'sin imágenes' : 'con imágenes';
      lines.push(`  ${name} -> ${m.id} (${vision})`);
      if (!ids.includes(m.id)) lines.push(`  AVISO: "${name}" -> "${m.id}" no aparece en la lista viva de DeepSeek.`);
    }
  } catch (e) {
    lines.push(`Conectividad DeepSeek: FALLÓ (${e.status ? 'HTTP ' + e.status : e.message})`);
    process.stdout.write(lines.join('\n') + '\n');
    return 3;
  }

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function cmdModels() {
  const config = loadJson(CONFIG_PATH, { deepseekBaseUrl: 'https://api.deepseek.com' });
  const { key } = resolveApiKey(ENV_PATH);
  if (!key) { process.stderr.write(`Sin API key. Pegala en ${ENV_PATH}\n`); return 2; }
  try {
    const ids = await fetchLiveModels(config.deepseekBaseUrl, key);
    for (const id of ids) process.stdout.write(id + '\n');
    return 0;
  } catch (e) {
    process.stderr.write(`Error: ${e.status ? 'HTTP ' + e.status : e.message}\n`);
    return 3;
  }
}

function cmdCost(opts) {
  if (!existsSync(USAGE_LOG_PATH)) {
    process.stdout.write('Sin registros aún.\n');
    return 0;
  }
  const cutoff = opts.since ? since(opts.since) : null;
  const rows = [];
  for (const l of stripBom(readFileSync(USAGE_LOG_PATH, 'utf8')).split('\n').filter(Boolean)) {
    try {
      const r = JSON.parse(l);
      if (cutoff && new Date(r.ts).getTime() < cutoff) continue;
      rows.push(r);
    } catch { /* línea corrupta */ }
  }
  if (!rows.length) { process.stdout.write('Sin registros en el rango pedido.\n'); return 0; }

  const groups = new Map();
  for (const r of rows) {
    const key = r.model || '?';
    if (!groups.has(key)) groups.set(key, { count: 0, in: 0, out: 0, cost: 0, fail: 0 });
    const g = groups.get(key);
    g.count++;
    if (r.ok === false) g.fail++;
    g.in += r.in || 0; g.out += r.out || 0; g.cost += r.cost_usd || 0;
  }
  let totalCost = 0;
  const out = [];
  for (const [key, g] of groups) {
    totalCost += g.cost;
    out.push(`${key.padEnd(20)} llamadas=${g.count} (fallas=${g.fail})  in=${g.in}  out=${g.out}  ~$${fmtCost(g.cost)}`);
  }
  out.push('-'.repeat(60));
  out.push(`TOTAL                llamadas=${rows.length}  ~$${fmtCost(totalCost)}`);
  process.stdout.write(out.join('\n') + '\n');
  return 0;
}

function cmdKey() {
  const { key, source } = resolveApiKey(ENV_PATH);
  process.stdout.write(`Archivo .env: ${ENV_PATH}\n`);
  process.stdout.write(key ? `Key cargada: ${maskKey(key)} (fuente: ${source})\n` : 'Key: NO cargada.\n');
  return 0;
}

async function cmdGateway(sub) {
  const config = loadJson(CONFIG_PATH, { port: 4319 });
  if (sub === 'start') {
    const r = await ensureGatewayRunning({ quiet: false });
    return r.failed ? 1 : 0;
  }
  if (sub === 'stop' || sub === 'restart') {
    // Hace falta para que el gateway recargue config.json o código nuevo.
    const health = await isAlive(config.port);
    if (health) {
      try { process.kill(health.pid); } catch { /* ya no existía */ }
      for (let i = 0; i < 20 && await isAlive(config.port); i++) await new Promise((r) => setTimeout(r, 150));
      process.stdout.write(`Gateway detenido (pid ${health.pid}).\n`);
    } else {
      process.stdout.write('El gateway no estaba corriendo.\n');
    }
    if (sub === 'stop') return 0;
    const r = await ensureGatewayRunning({ quiet: false });
    return r.failed ? 1 : 0;
  }
  if (sub === 'status') {
    const health = await isAlive(config.port);
    process.stdout.write(health
      ? `Corriendo: pid ${health.pid}, uptime ${health.uptimeSec}s, puerto ${config.port}\n`
      : `No responde en el puerto ${config.port}.\n`);
    return health ? 0 : 1;
  }
  if (sub === 'logs') {
    if (!existsSync(GATEWAY_LOG_PATH)) { process.stdout.write('Sin log todavía.\n'); return 0; }
    const lines = stripBom(readFileSync(GATEWAY_LOG_PATH, 'utf8')).split('\n').filter(Boolean);
    process.stdout.write(lines.slice(-40).join('\n') + '\n');
    return 0;
  }
  process.stderr.write('Uso: dsk gateway start|status|logs\n');
  return 1;
}

function usage() {
  return `dsk - diagnóstico y control del gateway DeepSeek <-> Claude Code

Uso:
  dsk doctor                     Chequeo completo: key, gateway, conectividad
  dsk models                     Lista modelos vivos de DeepSeek
  dsk cost [--since 7d]          Resume el consumo (usage.jsonl)
  dsk key                        Muestra de dónde sale la API key (enmascarada)
  dsk gateway start|status|logs  Arranca / consulta / ve el log del gateway
`;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) { opts[rest[i].slice(2)] = rest[i + 1]; i++; }
  }
  switch (command) {
    case 'doctor': return cmdDoctor();
    case 'models': return cmdModels();
    case 'cost': return cmdCost(opts);
    case 'key': return cmdKey();
    case 'gateway': return cmdGateway(rest[0]);
    default:
      process.stdout.write(usage());
      return command ? 0 : 1;
  }
}

// process.exitCode en vez de process.exit(): forzar la salida cierra de
// golpe los sockets keep-alive que deja abiertos fetch/undici, y en Windows
// eso puede crashear el proceso con "Assertion failed: UV_HANDLE_CLOSING".
// Con exitCode, Node cierra solo apenas el event loop queda vacío.
main().then((code) => { process.exitCode = code ?? 0; }).catch((e) => {
  process.stderr.write(`Error inesperado: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
