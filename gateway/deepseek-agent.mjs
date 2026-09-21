#!/usr/bin/env node
// Delegates a task to a FULL Claude Code (all tools, skills, hooks, MCP,
// CLAUDE.md, and subagents) running on DeepSeek.
//
// By default uses `claude --bg`: the delegated session stays VISIBLE as just
// another session -- it shows up in the agent view (← from an interactive
// session) and in `claude agents`, can be followed with `claude attach/logs`,
// and keeps running even after this command has finished. It's the same
// mechanism Claude Code uses for any background session; here it's just
// given a scoped environment (--settings) so it talks to DeepSeek instead of
// Anthropic. The session that invokes this script never sees that variable.
//
// Usage:
//   node deepseek-agent.mjs --task-file brief.txt --dir "C:/project" [options]
//   node deepseek-agent.mjs --task "short text" --dir "C:/project" --foreground

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

// Appended to the end of every task: the final response is the only thing
// that reaches the delegator's context (or the first thing seen in `claude
// logs`), so it has to be short.
const OUTPUT_CONTRACT = `

---
When you finish the whole task, your LAST text response must be ONLY:
- The list of files you created or modified (relative paths).
- A one-line sentence confirming what was done, or what's left pending and why.
Do not repeat file contents or paste long snippets.`;

// A long brief as a command-line argument risks Windows' limit; above this
// it's written to a file and the agent is asked to read it with its own tool.
const INLINE_TASK_MAX_CHARS = 3500;

// WebSearch is an Anthropic server-side tool (Anthropic executes it within
// the same API call): there's no way for DeepSeek to resolve it. If left
// available, the model tries it anyway and returns made-up results or just
// fails outright. It's blocked so only a real Claude uses it.
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
  return `deepseek-agent - delegates a task to a full Claude Code running on DeepSeek

Usage:
  node deepseek-agent.mjs --task-file <brief.txt> --dir <folder> [options]

By default it stays as a VISIBLE background session (agent view, "claude
agents", "claude attach/logs/stop"). With --foreground it runs blocking this
call and returns a short summary when done (without staying visible after).

Options:
  --task-file <path>          Task brief (preferred)
  --task <text>               Alternative for short tasks
  --dir <path>                Agent's working folder (required)
  --model <name>              ${models} (default: ${config.defaultModel})
  --name <text>               Session name (default: --label or the folder)
  --foreground                Blocks and returns a summary; doesn't stay visible after
  --permission-mode <mode>    Default bypassPermissions (acceptEdits, auto, manual...)
  --disallowed-tools <list>   Comma-separated; "none" to block nothing.
                              Default: ${DEFAULT_DISALLOWED.join(', ')}
  --timeout-min <n>           Only with --foreground (default 30)
  --label <text>              Label for agent-runs.jsonl
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
  return `Your full task is in the file "${briefPath}". Read it first with your ` +
    `file-reading tool and then follow exactly what it says, ` +
    `including its instructions on how to respond when you're done.`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadJson(CONFIG_PATH, null);
  if (!config) { process.stderr.write(`Could not read ${CONFIG_PATH}\n`); return 1; }

  if (!opts.dir || (!opts['task-file'] && !opts.task)) {
    process.stderr.write(usage(config));
    return 1;
  }
  if (!existsSync(opts.dir)) {
    process.stderr.write(`Working folder doesn't exist: ${opts.dir}\n`);
    return 1;
  }

  const model = opts.model || config.defaultModel;
  if (!resolveModel(model, config).known) {
    process.stderr.write(`Unknown model: ${model}. Available: ${Object.keys(getModels(config)).join(', ')}\n`);
    return 1;
  }

  const { key } = resolveApiKey(ENV_PATH);
  if (!key) { process.stderr.write(`No DeepSeek API key. Paste it into: ${ENV_PATH}\n`); return 2; }

  const gw = await ensureGatewayRunning({ quiet: true, waitMs: 3000 });
  if (gw.failed) { process.stderr.write('The DeepSeek gateway didn\'t start. Check gateway.log.\n'); return 2; }

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

// --- default mode: visible background session ---
async function runBackground({ config, model, opts, taskText, name, label, permissionMode, disallowed }) {
  mkdirSync(BG_SETTINGS_DIR, { recursive: true });
  const settingsPath = path.join(BG_SETTINGS_DIR, `${label}-${Date.now()}.json`);
  writeFileSync(settingsPath, JSON.stringify({ env: scopedOverrides(config, { model }) }, null, 2), 'utf8');

  const args = ['--bg', '--settings', settingsPath, '--model', model, '--name', name, '--permission-mode', permissionMode];
  args.push('--append-system-prompt', WEBSEARCH_NOTICE);
  if (disallowed.length) args.push('--disallowedTools', ...disallowed);
  // "--" cuts off the variadic --disallowedTools list: without this, the
  // task text got swallowed as if it were just another tool name and the
  // session ended up backgrounded with no initial prompt (idle).
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
    process.stderr.write(`Could not start the background session (exit ${exitCode}).\n`);
    if (stderr.trim()) process.stderr.write(stderr.trim().slice(-1500) + '\n');
    if (clean.trim()) process.stderr.write(clean.trim().slice(-1500) + '\n');
    return exitCode || 1;
  }

  const id = m[1];
  process.stdout.write(
    `DEEPSEEK IN BACKGROUND | id ${id} | name "${m[2].trim()}" | model ${model} | ${opts.dir}\n` +
    `Visible in Claude Code's agent view (key to return from a session) and in "claude agents".\n` +
    `  claude attach ${id}   -> enter that session in this terminal\n` +
    `  claude logs ${id}     -> view its output without entering\n` +
    `  claude stop ${id}     -> stop it\n` +
    `Nothing to wait for here: the session keeps running on its own.\n`
  );
  return 0;
}

// --- --foreground: blocks and returns a short summary, without staying visible after ---
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
    process.stderr.write(`The delegated agent didn't return a valid result (exit ${exitCode}${timedOut ? ', cut off by timeout' : ''}).\n`);
    process.stderr.write((stderr.trim() || trimmed).slice(-1500) + '\n');
    return exitCode || 1;
  }

  const status = parsed.is_error ? 'WITH ERROR' : 'OK';
  process.stdout.write(
    `DEEPSEEK-AGENT ${status} | model ${model} | ${opts.dir} | ${parsed.num_turns ?? '?'} turns | ${seconds.toFixed(1)}s\n` +
    `Real cost: node "${path.join(SCRIPT_DIR, 'cli.mjs')}" cost --since 1h (the cost Claude Code calculates uses Anthropic rates)\n` +
    `--- result ---\n${String(parsed.result ?? '(no final text)').trim()}\n`
  );
  return parsed.is_error ? 1 : exitCode;
}

// exitCode instead of exit(): avoids crashing on Windows because of keep-alive
// sockets fetch leaves open.
main().then((code) => { process.exitCode = code ?? 0; }).catch((e) => {
  process.stderr.write(`Unexpected error: ${e.stack || e.message}\n`);
  process.exitCode = 1;
});
