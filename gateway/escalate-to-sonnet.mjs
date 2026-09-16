#!/usr/bin/env node
// Escapa el entorno DeepSeek para lanzar un Claude Code real (Sonnet, login
// por suscripción) DESDE DENTRO de una sesión que corre sobre DeepSeek.
//
// Uso típico: la sesión DeepSeek necesita algo que ella no puede hacer
// (WebSearch u otra herramienta "de servidor" de Anthropic) y delega ese
// paso puntual a un Sonnet real, vía Bash, sin salir de lo que está haciendo.
//
// No toca la sesión que lo invoca: crea un proceso `claude` nuevo con el
// entorno limpio de los overrides que le puso scoped-env.mjs, y espera su
// resultado. Ese Sonnet real usa cuota/costo real de Anthropic, no la del
// gateway DeepSeek.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson } from './deepseek-client.mjs';
import { scopedOverrides } from './scoped-env.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { opts[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return opts;
}

function usage() {
  return `escalate-to-sonnet - lanza un Claude Code real (Sonnet, login por suscripción) desde una sesión DeepSeek

Uso:
  node escalate-to-sonnet.mjs --task-file <brief.txt> [--dir <carpeta>] [--model sonnet]
  node escalate-to-sonnet.mjs --task "<texto corto>"

Para cuando la sesión DeepSeek necesita algo que no puede hacer ella misma
(WebSearch u otra herramienta de servidor de Anthropic que no exista en
DeepSeek). Bloquea y devuelve la respuesta de texto de Sonnet; no queda una
sesión visible después.

Ojo: esto SÍ consume cuota/costo real de Anthropic, a diferencia del resto
de la sesión DeepSeek que lo invoca. Usar solo para el paso puntual que lo
necesita, no para delegar la tarea entera.
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts['task-file'] && !opts.task) {
    process.stderr.write(usage());
    return 1;
  }
  const taskText = opts['task-file'] ? readFileSync(opts['task-file'], 'utf8') : opts.task;

  const config = loadJson(CONFIG_PATH, null);
  // Las mismas claves que scoped-env.mjs le agrega/pisa a una sesión DeepSeek.
  // Se leen de ahí (no se copian a mano) para no desincronizarse si cambian.
  const overrideKeys = config ? Object.keys(scopedOverrides(config, {})) : [];

  const env = { ...process.env };
  for (const k of overrideKeys) delete env[k];

  // Por defecto solo herramientas de investigación (esto es para escalar un
  // paso puntual de research, no para delegarle la tarea entera a Sonnet).
  // "none" abre el resto si hace falta, ej. para verificar algo con Bash.
  const allowed = opts['allowed-tools'] === 'none' ? []
    : opts['allowed-tools'] ? opts['allowed-tools'].split(',').map((s) => s.trim()).filter(Boolean)
    : ['WebSearch', 'WebFetch'];

  const args = ['-p', taskText, '--model', opts.model || 'sonnet', '--output-format', 'json',
    '--permission-mode', opts['permission-mode'] || 'bypassPermissions'];
  if (allowed.length) args.push('--allowedTools', ...allowed);
  const cwd = opts.dir && existsSync(opts.dir) ? opts.dir : process.cwd();

  const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });

  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });

  if (code !== 0) {
    process.stderr.write(err || `claude terminó con código ${code}\n`);
    return code ?? 1;
  }

  try {
    const parsed = JSON.parse(out);
    process.stdout.write(`${parsed.result ?? out}\n`);
  } catch {
    process.stdout.write(out);
  }
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  process.stderr.write(`Error inesperado: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
