# claudeseek

**Run full Claude Code on DeepSeek**, against the direct API, no OpenRouter
and no middlemen. Tools, skills, hooks, MCP, CLAUDE.md, subagents, and
images. The only thing that changes is the model answering.

Claude Code stays Claude Code: it's just told to talk to a local gateway that
translates Anthropic's protocol to DeepSeek's, and nothing else.

> Not affiliated with Anthropic or DeepSeek. It's a bridge between two public
> APIs.

---

## Index

- [What it is](#what-it-is) — technical spec
- [What it's for](#what-its-for)
- [How it works](#how-it-works)
- [Replicating it in your Claude Code](#replicating-it-in-your-claude-code)
- [Usage](#usage)
- [Models](#models)
- [Images](#images)
- [Security](#security)
- [Limitations](#limitations)
- [Adding a model](#adding-a-model)
- [Troubleshooting](#troubleshooting)
- [Repo structure](#repo-structure)
- [Status](#status)
- [Uninstalling](#uninstalling)
- [License](#license)

---

## What it is

A **local HTTP gateway** that implements Anthropic's Messages API and
translates it to DeepSeek's OpenAI-compatible API, in both directions. It
sits between a Claude Code process and `api.deepseek.com`.

### Spec

| | |
|---|---|
| **Listens on** | `127.0.0.1:4319` (configurable in `config.json`), loopback only |
| **Speaks** | Anthropic Messages API ↔ DeepSeek (`/chat/completions`) |
| **Upstream** | `https://api.deepseek.com` (configurable) |
| **Runtime** | Node.js 18+, no external dependencies (uses native `fetch`) |
| **Routes implemented** | `POST /v1/messages`, `POST /v1/messages/count_tokens`, `GET /v1/models`, `GET /v1/models/:id`, `GET /health` |
| **Any other route** | untouched passthrough to `api.anthropic.com` |
| **Configuration** | `gateway/config.json` (read once at startup) |
| **Secrets** | `~/.claude/deepseek-gateway/.env` (never committed) |

### What it translates

| Capability | Status |
|---|---|
| Text, SSE streaming and non-streaming | Yes |
| Tools (`tool_use` / `tool_result`) | Yes |
| **Images** (user message and `tool_result`) | Yes, with models that support them |
| DeepSeek reasoning → Anthropic `thinking` blocks | Yes |
| `stop_reason`, `usage` (including cache hit) | Yes |
| System prompt | Yes |
| Anthropic server-side tools (`web_search`, `code_execution`) | **No** — Anthropic executes them, not the client |
| `cache_control` | **No** — DeepSeek only caches server-side |

### Routing modes

The gateway decides per request, with one of three rules:

1. **scoped** — the request carries the local token (`config.scopedToken`),
   meaning it comes from a Claude Code process launched to run on DeepSeek.
   **Everything** goes to DeepSeek, including the internal calls Claude Code
   makes using Anthropic model names (opus/sonnet/haiku).
2. **DeepSeek model** — the model name is a DeepSeek one. It gets translated.
3. **anything else** — untouched passthrough to `api.anthropic.com`.

---

## What it's for

Two ways to use it, and both coexist with your normal Claude Code:

1. **Delegate a task** from any Claude Code session to another Claude Code
   process running on DeepSeek. By default it stays as a **visible
   background session** (agent view, `claude agents`,
   `claude attach/logs/stop`), so it can be watched and entered like any
   other background session. With `--foreground` it instead blocks, returns
   a short summary, and leaves no visible session.
2. **Open an interactive session** of Claude Code on DeepSeek, in the
   foreground, in its own terminal.

The reason to delegate: tasks with a lot of output text (sections of a site,
copy, FAQs, translations, boilerplate, sample data) where the expensive
model's judgment isn't needed. DeepSeek comes out quite a bit cheaper.

**Your normal Claude Code session, its subscription login, and your
`settings.json` are never touched.**

---

## How it works

```
Normal Claude Code session (subscription login, intact)
  |
  | node deepseek-agent.mjs --task-file ... --dir ...
  v
claude --bg   (child session, full Claude Code, visible in agent view)
  scoped environment via --settings: ANTHROPIC_BASE_URL=http://127.0.0.1:4319
                                  ANTHROPIC_AUTH_TOKEN=<local token>
                                  opus/sonnet/haiku -> DeepSeek models
  v
local gateway (127.0.0.1, never exposed to the network)
  |-- "scoped" token          -> EVERYTHING to DeepSeek (including internal calls)
  |-- deepseek-* model        -> DeepSeek
  |-- anything else           -> untouched passthrough to api.anthropic.com
  v
api.deepseek.com   (the gateway supplies the DeepSeek key)
```

### Why a child process and not a global variable

Claude Code accepts pointing to your own gateway with `ANTHROPIC_BASE_URL`,
but in the process where that variable is set, claude.ai login stops being
used and it starts requiring an explicit credential
([official doc](https://code.claude.com/docs/en/llm-gateway-connect)). If
that variable were in `settings.json`, your normal Opus/Sonnet usage would
stop coming out of the paid plan.

That's why the variables are set **only in a child process's environment**
(`gateway/scoped-env.mjs`). The normal session never sees them, which is why
you can have both things at the same time without conflict.

### The "scoped" token

`config.json` has a `scopedToken` with a fixed, public value
(`deepseek-gateway-scoped`). **It's not a secret**: it's a local marker that
tells the gateway "this request comes from a process that should go to
DeepSeek." It lets the gateway route even Claude Code's internal calls, which
use Anthropic model names.

The DeepSeek key is a different thing entirely and never leaves the gateway.

---

## Replicating it in your Claude Code

### Requirements

- **Node.js 18 or newer** (uses native `fetch`).
- **Claude Code** installed and in the PATH.
- A **DeepSeek API key** ([platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)).
- Windows, macOS, or Linux.

### Quick path

```bash
git clone https://github.com/nx01-600/claudeseek-code.git
cd claudeseek-code
```

**Windows (PowerShell):**

```powershell
.\install.ps1
```

**macOS / Linux (bash):**

```bash
./install.sh
```

Either one copies the gateway to `~/.claude/deepseek-gateway/` and the skill
to `~/.claude/skills/claudeseek/`. Safe to run multiple times: it never
overwrites `.env` or the logs.

Then, paste your API key into `~/.claude/deepseek-gateway/.env`:

```
DEEPSEEK_API_KEY=sk-your-key-here
```

And verify:

```bash
node "$HOME/.claude/deepseek-gateway/cli.mjs" doctor
```

`doctor` checks the key, whether the gateway responds, connectivity with
DeepSeek, and which models are live, including whether each one analyzes
images.

No need to restart Claude Code. The gateway starts on its own the first time
something uses it.

### Replicating it by hand (understanding each piece)

If you want to do it step by step without the installer:

**1. Copy the gateway**

```bash
mkdir -p ~/.claude/deepseek-gateway
cp gateway/*.mjs gateway/*.json gateway/dsk gateway/dsk.cmd \
   gateway/deepseek-session gateway/deepseek-session.cmd \
   ~/.claude/deepseek-gateway/
```

**2. Set the API key**

```bash
echo 'DEEPSEEK_API_KEY=sk-your-key-here' > ~/.claude/deepseek-gateway/.env
```

**3. Copy the skill**

```bash
mkdir -p ~/.claude/skills
cp -r claudeseek ~/.claude/skills/claudeseek
```

The skill is what teaches Claude Code *when* to delegate. Without it
everything still works, but Claude Code won't propose delegating on its own.

**4. Start the gateway and check that it responds**

```bash
node ~/.claude/deepseek-gateway/cli.mjs gateway start
node ~/.claude/deepseek-gateway/cli.mjs doctor
```

**5. Test a session on DeepSeek**

```bash
node ~/.claude/deepseek-gateway/deepseek-session.mjs --model deepseek-flash
```

If that opens a Claude Code session and it responds, you're done: the rest
(background delegation, the short `deepseek` command) is sugar on top of the
same thing.

### How to check it's really going to DeepSeek

```bash
node ~/.claude/deepseek-gateway/cli.mjs gateway logs
```

Each line says where the request went:

```
POST /v1/messages model=deepseek-flash -> deepseek(scoped)
POST /v1/messages model=claude-sonnet-5 -> passthrough
```

And the real cost, which Claude Code can't calculate:

```bash
node ~/.claude/deepseek-gateway/cli.mjs cost --since 1d
```

---

## Usage

### Delegating from Claude Code

Normally Claude Code does this on its own, following the `claudeseek` skill.
By hand:

```bash
node "$HOME/.claude/deepseek-gateway/deepseek-agent.mjs" \
  --task-file brief.md \
  --dir "/path/to/project" \
  [--model deepseek-flash-thinking] \
  [--label short-name] \
  [--foreground]
```

It stays as a visible background session: the receipt carries the id and the
commands to follow it (`claude attach` / `logs` / `stop`). Several parallel
tasks are one invocation per task, working on different files.

Runs with `--permission-mode bypassPermissions` and the only thing blocked by
default is `git push`, in both modes.

### Interactive session

```
deepseek [--model deepseek-flash-thinking] [-c|-r] [--dangerously-skip-permissions]
```

The short `deepseek` command is installed in `~/.local/bin` (if that folder
exists) and is equivalent to `~/.claude/deepseek-gateway/deepseek-session`.
Inside the session, `/model` toggles between the with- and without-reasoning
variant.

### Diagnostics and cost

```bash
node "$HOME/.claude/deepseek-gateway/cli.mjs" doctor           # key, gateway, connectivity, models
node "$HOME/.claude/deepseek-gateway/cli.mjs" cost --since 7d  # real DeepSeek cost
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway restart  # after changing config.json or the code
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway logs     # latest requests and where they were routed
```

The dollar cost Claude Code shows inside a DeepSeek session **isn't real**
(it uses Anthropic rates). The real one is `cost`'s, which is calculated
with `prices.json` against the usage recorded in `usage.jsonl`.

---

## Models

Defined in `gateway/config.json`:

| Name in Claude Code | DeepSeek model | Reasoning | Images |
|---|---|---|---|
| `deepseek-flash` (default) | `deepseek-flash` | Only if Claude Code asks for it | **Yes** |
| `deepseek-flash-thinking` | `deepseek-flash` | Always | **Yes** |
| `deepseek-pro` / `deepseek-pro-thinking` | `deepseek-v4-pro` | Same as above | No |

DeepSeek's reasoning is exposed as Claude Code's native *thinking* block.
`roleModels` defines which model subagents and Claude Code's internal calls
using opus/sonnet/haiku names go to.

---

## Images

The gateway translates images to the format DeepSeek accepts, in the two
places Claude Code sends them:

- **in the user's message** — pasted screenshots, photos, diagrams;
- **inside a `tool_result`** — this is how screenshots a tool returns get through.

Careful: this makes it possible for the model to **see** a screenshot, but it
doesn't give you browser control. That needs a browser tool, and the
*Claude in Chrome* integration **doesn't work on DeepSeek** (see
[Limitations](#limitations)).

At the protocol level, an Anthropic `image` block
(`{type: "image", source: {type: "base64", media_type, data}}`) is
translated to an OpenAI `image_url` part
(`{type: "image_url", image_url: {url: "data:...;base64,..."}}`). DeepSeek
accepts that shape both in a user message and in a `role: "tool"` one, which
is what makes the second case possible.

`deepseek-v4-pro` doesn't analyze images. With that model the gateway
replaces each one with a text notice, instead of sending DeepSeek something
it will reject. If the task depends on seeing images, you need to use
`deepseek-flash` (the with- and without-reasoning variants both work).

One measured detail: an image makes the model reason more, so with a small
`max_tokens` the budget runs out on reasoning and the text response can come
back empty. With the values Claude Code uses, this doesn't happen.

---

## Security

- The gateway listens **only on `127.0.0.1`**, never exposed to the network.
- The DeepSeek key lives in `~/.claude/deepseek-gateway/.env` and **only the
  gateway uses it**. It never travels to Anthropic or to Claude Code's child
  processes.
- Conversely, Anthropic credentials never travel to DeepSeek.
- `.env`, `usage.jsonl`, `agent-runs.jsonl`, `gateway.log`, and
  `.bg-settings/` are in `.gitignore`: they never get committed.

---

## Limitations

- **WebSearch** doesn't work: it's a tool Anthropic runs on its own servers.
  WebFetch does work.
- **claude.ai connectors** (Gmail, Canva, etc.) don't load in processes
  running on DeepSeek, because they depend on claude.ai login. Local MCPs do
  work.
- **Claude in Chrome doesn't work**, and there's no way to make it work
  within this design. It's a first-party MCP that Claude Code spins up and
  wires per session, but it's gated behind a claude.ai subscription check
  (`Claude in Chrome requires a claude.ai subscription.`). And the gateway
  exists precisely so the child process does **not** use claude.ai login:
  `ANTHROPIC_AUTH_TOKEN` takes precedence and disables it. The two things
  are mutually exclusive by construction.

  Verified on 2026-09-15: a normal session with `--chrome` gets 22
  `mcp__claude-in-chrome__*` tools; the same session on DeepSeek gets zero.
  Third-party MCPs do work, so the way to get a browser on DeepSeek is your
  own browser MCP (e.g. Playwright MCP), which can now also return useful
  screenshots since image translation exists.
- **Images**: analyzed by the `deepseek-flash*` models. With `deepseek-pro*`
  a text notice arrives instead.
- Claude Code prints an `unrecognized_model` warning on startup: it's
  harmless, it just means it doesn't recognize the model name.
- `/v1/messages/count_tokens` returns an estimate (characters / 4), not a
  real count.
- Blocking `git push` depends on Claude Code's `--disallowedTools` rules.
- Only thoroughly tested on Windows. The code is plain Node and the
  installers cover macOS and Linux, but those two paths haven't been
  verified yet.

---

## Adding a model

In `gateway/config.json`:

```json
"my-model": { "id": "real-name-on-deepseek", "thinking": "auto", "vision": true }
```

- `thinking`: `"on"` (always reasons), `"off"` (never) or `"auto"` (only if
  Claude Code asks for it).
- `vision`: `true` if the model analyzes images. If you leave it out, `true`
  is assumed, so an image isn't silently dropped; the cost is that a
  non-vision model returns a visible error from DeepSeek.

After touching `config.json` you have to restart the gateway
(`cli.mjs gateway restart`), because it's read only once at startup.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| `No DeepSeek API key` | Paste the key into `~/.claude/deepseek-gateway/.env` |
| `The DeepSeek gateway didn't start` | Run `doctor` and `gateway logs` |
| `unrecognized_model` at startup | Harmless, can be ignored |
| Images don't get through | You're on `deepseek-pro*`; switch to `deepseek-flash` |
| Empty text responses | Small `max_tokens` and reasoning ate up the budget |
| Changed `config.json` and nothing happens | Missing `cli.mjs gateway restart` |
| The cost Claude Code shows doesn't add up | That's Anthropic's; the real one is `cli.mjs cost` |

---

## Repo structure

```
gateway/
  server.mjs             Gateway: scoped/passthrough routing, streaming, errors
  translate.mjs          Anthropic Messages API <-> DeepSeek's OpenAI format
  deepseek-client.mjs    DeepSeek client, key, model catalog, prices
  scoped-env.mjs         Scoped environment for Claude Code processes
  start.mjs              Idempotent gateway startup
  cli.mjs (dsk)          doctor / models / cost / key / gateway start|stop|restart|logs
  deepseek-agent.mjs     Headless delegation
  deepseek-session.mjs   Interactive session (+ .cmd and bash shim)
  bin/                   Shims for the short `deepseek` command
  config.json / prices.json
claudeseek/SKILL.md      When and how to delegate (what Claude Code reads)
install.sh / install.ps1
uninstall.sh / uninstall.ps1
```

---

## Status

Verified on 2026-09-15 against real DeepSeek through the gateway: streaming
text with accented characters, visible reasoning with signature, an internal
call using a haiku name routed to DeepSeek, a two-turn tool cycle in
reasoning mode, real passthrough to Anthropic, `/v1/models` and
`count_tokens`. Also, a full delegation (the agent created and read a file),
the session launcher in `-p` mode, and image translation across its four
cases: text+image, image only, image inside a `tool_result`, and a
non-vision model.

---

## Uninstalling

```bash
./uninstall.sh        # macOS / Linux
.\uninstall.ps1       # Windows
```

Kills the gateway if it's running, deletes the code and the skill, and
**keeps `.env`, `usage.jsonl`, and `agent-runs.jsonl`** in case you want to
reinstall without losing the cost history.

---

## License

[Apache-2.0](LICENSE).
