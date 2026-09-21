// Starts the gateway if it isn't already running. Idempotent: if one is
// already listening on the configured port, it does nothing. Meant to be
// invoked both by hand (`dsk gateway start`) and from Claude Code's
// SessionStart hook, where it has to be fast and never hang.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson } from './deepseek-client.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(SCRIPT_DIR, 'config.json');
const SERVER_PATH = path.join(SCRIPT_DIR, 'server.mjs');

async function isAlive(port, timeoutMs = 500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

export async function ensureGatewayRunning({ quiet = false, waitMs = 2000 } = {}) {
  const config = loadJson(CONFIG_PATH, { port: 4319 });
  const port = config.port;

  if (await isAlive(port)) {
    if (!quiet) process.stdout.write(`Gateway is already running on port ${port}.\n`);
    return { started: false, alreadyRunning: true, port };
  }

  const child = spawn(process.execPath, [SERVER_PATH], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await isAlive(port, 300)) {
      if (!quiet) process.stdout.write(`Gateway started on port ${port} (pid ${child.pid}).\n`);
      return { started: true, alreadyRunning: false, port, pid: child.pid };
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  if (!quiet) process.stderr.write(`Gateway didn't respond within ${waitMs}ms after starting it. Check gateway.log.\n`);
  return { started: false, alreadyRunning: false, port, failed: true };
}

// Invocable directo: `node start.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await ensureGatewayRunning();
  // exitCode instead of exit(): avoids crashing on Windows because of the
  // keep-alive sockets left behind by fetch/undici (see same fix in cli.mjs).
  process.exitCode = result.failed ? 1 : 0;
}
