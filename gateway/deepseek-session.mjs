#!/usr/bin/env node
// Opens a full INTERACTIVE Claude Code session (tools, skills, hooks, MCP,
// subagents) running on DeepSeek. All arguments are passed straight through
// to `claude`.
//
// The scoped environment lives only in this process: any other Claude Code
// session open in parallel keeps its normal login and models.
//
// Choose the model on launch:  deepseek-session --model deepseek-flash-thinking
// Change it from inside:       /model

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson, resolveApiKey } from './deepseek-client.mjs';
import { ensureGatewayRunning } from './start.mjs';
import { buildScopedEnv, WEBSEARCH_NOTICE } from './scoped-env.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const config = loadJson(path.join(SCRIPT_DIR, 'config.json'), null);
const envPath = path.join(SCRIPT_DIR, '.env');

async function main() {
  if (!config) { process.stderr.write('Could not read the gateway config.json.\n'); return 1; }
  if (!resolveApiKey(envPath).key) { process.stderr.write(`No DeepSeek API key. Paste it into: ${envPath}\n`); return 2; }

  const gw = await ensureGatewayRunning({ quiet: true, waitMs: 3000 });
  if (gw.failed) { process.stderr.write('The DeepSeek gateway didn\'t start. Check gateway.log.\n'); return 2; }

  const args = process.argv.slice(2);
  const modelFlag = args.indexOf('--model');
  const model = modelFlag !== -1 ? args[modelFlag + 1] : config.defaultModel;

  // WebSearch runs server-side on Anthropic's end; on DeepSeek there's no one
  // to resolve it and the model ends up making up results. It's blocked here
  // unless the caller already picked their own list.
  if (!args.includes('--disallowedTools')) args.push('--disallowedTools', 'WebSearch');
  if (!args.includes('--append-system-prompt') && !args.includes('--system-prompt')) {
    args.push('--append-system-prompt', WEBSEARCH_NOTICE);
  }

  // Ctrl+C has to be handled by claude, not by this launcher.
  process.on('SIGINT', () => {});
  const child = spawn('claude', args, { stdio: 'inherit', env: buildScopedEnv(config, { model }) });
  return new Promise((resolve) => {
    child.on('error', (e) => { process.stderr.write(`Could not launch claude: ${e.message}\n`); resolve(127); });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

main().then((code) => { process.exitCode = code; });
