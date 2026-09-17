#!/usr/bin/env node
// Delega una tarea a un Claude Code COMPLETO (todas las herramientas, skills,
// hooks, MCP, CLAUDE.md y subagentes) que corre sobre DeepSeek.
//
// Por defecto usa `claude --bg`: la sesión delegada queda VISIBLE como una
// sesión más -- aparece en el agent view (← desde una sesión interactiva) y
// en `claude agents`, se puede seguir con `claude attach/logs`, y sigue
// corriendo aunque este comando ya haya terminado. Es el mismo mecanismo que
// usa Claude Code para cualquier sesión en segundo plano; acá solo se le
// pasa un entorno acotado (--settings) para que hable con DeepSeek en vez de
// con Anthropic. Esa sesión que invoca este script nunca ve esa variable.
//
// Uso:
//   node deepseek-agent.mjs --task-file brief.txt --dir "C:/proyecto" [opciones]
//   node deepseek-agent.mjs --task "texto corto" --dir "C:/proyecto" --foreground

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson, resolveApiKey, resolveModel, getModels, stripBom } from './deepseek-client.mjs';
import { ensureGatewayRunning } from './start.mjs';
import { buildScopedEnv, scopedOverrides, WEBSEARCH_NOTICE } from './scoped-env.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const AGENT_LOG_PATH = path.join(SCRIPT_DIR, 'agent-runs.jsonl');
const BG_SETTINGS_DIR = path.join(SCRIPT_DIR, '.bg-settings');

// Se agrega al final de toda tarea: la respuesta final es lo único que entra
// al contexto de quien delegó (o lo primero que se ve en `claude logs`), así
// que tiene que ser corta.
const OUTPUT_CONTRACT = `

---
Cuando termines toda la tarea, tu ÚLTIMA respuesta de texto debe ser SOLO:
- La lista de archivos que creaste o modificaste (rutas relativas).
- Una frase de una línea confirmando qué se hizo, o qué quedó pendiente y por qué.
No repitas el contenido de los archivos ni pegues fragmentos largos.`;

// Un brief largo como argumento de línea de comandos arriesga el límite de
// Windows; por encima de esto se escribe a archivo y se le pide al agente
// que lo lea con su propia herramienta.
const INLINE_TASK_MAX_CHARS = 3500;

// WebSearch es tool de servidor de Anthropic (la ejecuta Anthropic dentro de
// la misma llamada a la API): no existe forma de que DeepSeek la resuelva.
// Si se deja disponible, el modelo la intenta igual y devuelve resultados
// inventados o directamente falla. Se bloquea para que solo la use Claude real.
const DEFAULT_DISALLOWED = ['Bash(git push:*)', 'Bash(git push *)', 'WebSearch'];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

function usage(config) {
  const models = Object.keys(getModels(config)).join(', ');
  return `deepseek-agent - delega una tarea a un Claude Code completo corriendo sobre DeepSeek

Uso:
  node deepseek-agent.mjs --task-file <brief.txt> --dir <carpeta> [opciones]

Por defecto queda como sesión en segundo plano VISIBLE (agent view, "claude
agents", "claude attach/logs/stop"). Con --foreground corre bloqueando esta
llamada y devuelve un resumen corto al terminar (sin quedar visible después).

Opciones:
  --task-file <ruta>          Brief de la tarea (preferido)
  --task <texto>              Alternativa para tareas cortas
  --dir <ruta>                Carpeta de trabajo del agente (obligatorio)
  --model <nombre>            ${models} (default: ${config.defaultModel})
  --name <texto>              Nombre de la sesión (default: --label o la carpeta)
  --foreground                Bloquea y devuelve un resumen; no queda visible después
  --permission-mode <modo>    Default bypassPermissions (acceptEdits, auto, manual...)
  --disallowed-tools <lista>  Separadas por coma; "none" para no bloquear nada.
                              Default: ${DEFAULT_DISALLOWED.join(', ')}
  --timeout-min <n>           Solo con --foreground (default 30)
  --label <texto>             Etiqueta para agent-runs.jsonl
`;
}

function buildTaskText(opts, dir) {
  let raw = opts.task || '';
  if (opts['task-file']) raw = stripBom(readFileSync(opts['task-file'], 'utf8'));
  const full = raw.trim() + OUTPUT_CONTRACT;
  if (full.length <= INLINE_TASK_MAX_CHARS) return full;

  mkdirSync(BG_SETTINGS_DIR, { recursive: true });
  const briefPath = path.join(BG_SETTINGS_DIR, `brief-${Date.now()}.md`);
  writeFileSync(briefPath, full, 'utf8');
  return `Tu tarea completa está en el archivo "${briefPath}". Leelo primero con tu ` +
    `herramienta de lectura de archivos y después seguí exactamente lo que diga, ` +
    `incluidas sus instrucciones de cómo responder al terminar.`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadJson(CONFIG_PATH, null);
  if (!config) { process.stderr.write(`No se pudo leer ${CONFIG_PATH}\n`); return 1; }

  if (!opts.dir || (!opts['task-file'] && !opts.task)) {
    process.stderr.write(usage(config));
    return 1;
  }
  if (!existsSync(opts.dir)) {
    process.stderr.write(`La carpeta de trabajo no existe: ${opts.dir}\n`);
    return 1;
  }

  const model = opts.model || config.defaultModel;
  if (!resolveModel(model, config).known) {
    process.stderr.write(`Modelo desconocido: ${model}. Disponibles: ${Object.keys(getModels(config)).join(', ')}\n`);
    return 1;
  }

  const { key } = resolveApiKey(ENV_PATH);
  if (!key) { process.stderr.write(`Sin API key de DeepSeek. Pegala en: ${ENV_PATH}\n`); return 2; }

  const gw = await ensureGatewayRunning({ quiet: true, waitMs: 3000 });
  if (gw.failed) { process.stderr.write('El gateway DeepSeek no arrancó. Revisar gateway.log.\n'); return 2; }

  const taskText = buildTaskText(opts, opts.dir);
  const label = opts.label || path.basename(path.resolve(opts.dir));
  const name = opts.name || label;
  const permissionMode = opts['permission-mode'] || 'bypassPermissions';
  const disallowed = opts['disallowed-tools'] === 'none' ? []
    : opts['disallowed-tools'] ? opts['disallowed-tools'].split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_DISALLOWED;

  if (opts.foreground) return runForeground({ config, model, opts, taskText, label, permissionMode, disallowed });
  return runBackground({ config, model, opts, taskText, name, label, permissionMode, disallowed });
}

// --- modo por defecto: sesión visible en segundo plano ---
async function runBackground({ config, model, opts, taskText, name, label, permissionMode, disallowed }) {
  mkdirSync(BG_SETTINGS_DIR, { recursive: true });
  const settingsPath = path.join(BG_SETTINGS_DIR, `${label}-${Date.now()}.json`);
  writeFileSync(settingsPath, JSON.stringify({ env: scopedOverrides(config, { model }) }, null, 2), 'utf8');

  const args = ['--bg', '--settings', settingsPath, '--model', model, '--name', name, '--permission-mode', permissionMode];
  args.push('--append-system-prompt', WEBSEARCH_NOTICE);
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  // "--" corta la lista variádica de --disallowedTools: sin esto, el texto
  // de la tarea se tragaba como si fuera un nombre de herramienta más y la
  // sesión quedaba backgroundeada sin ningún prompt inicial (idle).
  args.push('--', taskText);

  const startedAt = Date.now();
  const child = spawn('claude', args, { cwd: opts.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => { stderr += `\n${e.message}`; resolve(127); });
    child.on('close', (code) => resolve(code ?? 1));
  });

  // eslint-disable-next-line no-control-regex
  const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const m = clean.match(/backgrounded\s*[·•]\s*([a-f0-9-]+)\s*[·•]\s*([^(\r\n]+)/i);
  appendFileSync(AGENT_LOG_PATH, JSON.stringify({
    ts: new Date().toISOString(), label, model, dir: opts.dir, mode: 'background',
    exitCode, seconds: (Date.now() - startedAt) / 1000, bgId: m?.[1] ?? null, ok: exitCode === 0 && !!m,
  }) + '\n', 'utf8');

  if (!m) {
    process.stderr.write(`No se pudo iniciar la sesión en segundo plano (exit ${exitCode}).\n`);
    if (stderr.trim()) process.stderr.write(stderr.trim().slice(-1500) + '\n');
    if (clean.trim()) process.stderr.write(clean.trim().slice(-1500) + '\n');
    return exitCode || 1;
  }

  const id = m[1];
  process.stdout.write(
    `DEEPSEEK EN SEGUNDO PLANO | id ${id} | nombre "${m[2].trim()}" | modelo ${model} | ${opts.dir}\n` +
    `Visible en el agent view de Claude Code (tecla para volver desde una sesión) y en "claude agents".\n` +
    `  claude attach ${id}   -> entrar a esa sesión en esta terminal\n` +
    `  claude logs ${id}     -> ver su salida sin entrar\n` +
    `  claude stop ${id}     -> detenerla\n` +
    `No hay que esperar nada acá: la sesión sigue corriendo sola.\n`
  );
  return 0;
}

// --- --foreground: bloquea y devuelve un resumen corto, sin quedar visible después ---
async function runForeground({ config, model, opts, taskText, label, permissionMode, disallowed }) {
  const args = ['-p', '--model', model, '--permission-mode', permissionMode, '--output-format', 'json'];
  args.push('--append-system-prompt', WEBSEARCH_NOTICE);
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);

  const startedAt = Date.now();
  const child = spawn('claude', args, {
    cwd: opts.dir,
    env: buildScopedEnv(config, { model }),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdin.end(taskText, 'utf8');

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  const timeoutMin = Number(opts['timeout-min'] || 30);
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMin * 60_000);
  const exitCode = await new Promise((resolve) => {
    child.on('error', (e) => { stderr += `\n${e.message}`; resolve(127); });
    child.on('close', (code) => resolve(code ?? 1));
  });
  clearTimeout(timer);
  const seconds = (Date.now() - startedAt) / 1000;

  let parsed = null;
  const trimmed = stdout.trim();
  try { parsed = JSON.parse(trimmed); } catch {
    try { parsed = JSON.parse(trimmed.split('\n').filter(Boolean).pop() || ''); } catch { parsed = null; }
  }

  appendFileSync(AGENT_LOG_PATH, JSON.stringify({
    ts: new Date().toISOString(), label, model, dir: opts.dir, mode: 'foreground', exitCode, seconds, timedOut,
    turns: parsed?.num_turns ?? null, isError: parsed?.is_error ?? null, sessionId: parsed?.session_id ?? null,
  }) + '\n', 'utf8');

  if (!parsed) {
    process.stderr.write(`El agente delegado no devolvió un resultado válido (exit ${exitCode}${timedOut ? ', cortado por timeout' : ''}).\n`);
    process.stderr.write((stderr.trim() || trimmed).slice(-1500) + '\n');
    return exitCode || 1;
  }

  const status = parsed.is_error ? 'CON ERROR' : 'OK';
  process.stdout.write(
    `AGENTE-DEEPSEEK ${status} | modelo ${model} | ${opts.dir} | ${parsed.num_turns ?? '?'} turnos | ${seconds.toFixed(1)}s\n` +
    `Costo real: node "${path.join(SCRIPT_DIR, 'cli.mjs')}" cost --since 1h (el costo que calcula Claude Code usa tarifas de Anthropic)\n` +
    `--- resultado ---\n${String(parsed.result ?? '(sin texto final)').trim()}\n`
  );
  return parsed.is_error ? 1 : exitCode;
}

// exitCode en vez de exit(): evita crashear en Windows por sockets keep-alive
// que deja fetch abiertos.
main().then((code) => { process.exitCode = code ?? 0; }).catch((e) => {
  process.stderr.write(`Error inesperado: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
