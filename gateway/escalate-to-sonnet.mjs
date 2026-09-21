#!/usr/bin/env node
// Escapes the DeepSeek environment to launch a real Claude Code (Sonnet,
// subscription login) FROM INSIDE a session running on DeepSeek.
//
// Typical use: the DeepSeek session needs something it can't do itself
// (WebSearch or another Anthropic "server-side" tool) and delegates that
// one-off step to a real Sonnet, via Bash, without leaving what it's doing.
//
// Doesn't touch the session that invokes it: it creates a new `claude`
// process with the environment cleaned of the overrides scoped-env.mjs
// applied, and waits for its result. That real Sonnet uses real Anthropic
// quota/cost, not the DeepSeek gateway's.

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
  return `escalate-to-sonnet - launches a real Claude Code (Sonnet, subscription login) from a DeepSeek session

Usage:
  node escalate-to-sonnet.mjs --task-file <brief.txt> [--dir <folder>] [--model sonnet]
  node escalate-to-sonnet.mjs --task "<short text>"

For when the DeepSeek session needs something it can't do itself (WebSearch
or another Anthropic server-side tool that doesn't exist on DeepSeek). Blocks
and returns Sonnet's text response; no session is left visible afterward.

Careful: this DOES consume real Anthropic quota/cost, unlike the rest of the
DeepSeek session that invokes it. Use it only for the one-off step that needs
it, not to delegate the entire task.
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
  // The same keys scoped-env.mjs adds/overrides on a DeepSeek session. Read
  // from there (not copied by hand) so they don't drift out of sync if they change.
  const overrideKeys = config ? Object.keys(scopedOverrides(config, {})) : [];

  const env = { ...process.env };
  for (const k of overrideKeys) delete env[k];

  // Research tools only by default (this is for escalating a one-off research
  // step, not for delegating the whole task to Sonnet).
  // "none" opens up the rest if needed, e.g. to verify something with Bash.
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
    process.stderr.write(err || `claude exited with code ${code}\n`);
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
  process.stderr.write(`Unexpected error: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
