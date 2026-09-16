#!/usr/bin/env node
// Abre una sesión INTERACTIVA de Claude Code completa (herramientas, skills,
// hooks, MCP, subagentes) corriendo sobre DeepSeek. Todos los argumentos se
// pasan tal cual a `claude`.
//
// El entorno acotado vive solo en este proceso: cualquier otra sesión de
// Claude Code abierta en paralelo sigue con su login y modelos normales.
//
// Elegir modelo al abrir:  deepseek-session --model deepseek-flash-thinking
// Cambiar dentro:          /model

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson, resolveApiKey } from './deepseek-client.mjs';
import { ensureGatewayRunning } from './start.mjs';
import { buildScopedEnv } from './scoped-env.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const config = loadJson(path.join(SCRIPT_DIR, 'config.json'), null);
const envPath = path.join(SCRIPT_DIR, '.env');

async function main() {
  if (!config) { process.stderr.write('No se pudo leer config.json del gateway.\n'); return 1; }
  if (!resolveApiKey(envPath).key) { process.stderr.write(`Sin API key de DeepSeek. Pegala en: ${envPath}\n`); return 2; }

  const gw = await ensureGatewayRunning({ quiet: true, waitMs: 3000 });
  if (gw.failed) { process.stderr.write('El gateway DeepSeek no arrancó. Revisar gateway.log.\n'); return 2; }

  const args = process.argv.slice(2);
  const modelFlag = args.indexOf('--model');
  const model = modelFlag !== -1 ? args[modelFlag + 1] : config.defaultModel;

  // WebSearch la ejecuta Anthropic del lado del servidor; sobre DeepSeek no
  // hay quien la resuelva y el modelo termina inventando resultados. Se
  // bloquea acá salvo que quien invoque ya haya elegido su propia lista.
  if (!args.includes('--disallowedTools')) args.push('--disallowedTools', 'WebSearch');

  // Ctrl+C lo tiene que manejar claude, no este lanzador.
  process.on('SIGINT', () => {});
  const child = spawn('claude', args, { stdio: 'inherit', env: buildScopedEnv(config, { model }) });
  return new Promise((resolve) => {
    child.on('error', (e) => { process.stderr.write(`No se pudo lanzar claude: ${e.message}\n`); resolve(127); });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

main().then((code) => { process.exitCode = code; });
