---
name: claudeseek
description: Use to delegate a task to a full Claude Code (all tools, skills, MCP, subagents, and optional reasoning) running on DeepSeek instead of the current model. Typical for large writing or content-generation tasks (sections of a site, copy, FAQs, translations, boilerplate, sample data) where the expensive model's judgment isn't needed. Also when the user says "delegate to deepseek", "use deepseek", "send it to deepseek" ("delegá a deepseek", "usá deepseek", "mandalo a deepseek"), "/deepseek", or asks how to open a session on DeepSeek. Also applies INSIDE a session already running on DeepSeek when it needs WebSearch or any other Anthropic server-side tool that doesn't exist there: this skill explains how to escalate that one-off step to a real Sonnet.
---

# Delegating to DeepSeek from Claude Code

Here DeepSeek works as **just another Claude Code model**: delegation spins
up a real `claude -p`, with everything any session has (tools, skills,
hooks, MCP, CLAUDE.md, subagents), but whose model calls go to DeepSeek's
direct API through a local gateway. That process is independent from this
session: it doesn't touch its login or its configuration.

## Golden rule

The delegated agent is already instructed to finish with a short response
(files touched + one sentence). **Don't read the files it wrote in full**
unless that response indicates a problem: reading them defeats the token
savings, which is the whole reason to delegate. To verify, it's enough to
look at the start/end of the file or search for something specific.

## When to delegate

| Delegate to DeepSeek | Handle in this session |
|---|---|
| Writing or adapting long content (copy, sections, FAQs, spec sheets) | Architecture or design decisions |
| Well-specified repetitive tasks (boilerplate, sample data, translations) | Changes that require deeply understanding the rest of the repo |
| Batches of files independent from each other | Small tasks: spinning up another process doesn't pay off |

**Proactive notice:** if a task the user asked for involves a lot of output
text (on the order of 1500 words or more), propose delegating it to DeepSeek
in one line and wait for their OK. Don't delegate on your own without that
OK, unless the user already authorized it earlier in this session.

## How to delegate

1. Write the brief to a file (session scratchpad). Always a file: it avoids
   quoting/accent issues between PowerShell and Bash. The brief has to be
   self-contained: the delegated agent doesn't see this conversation.
2. Run:

```bash
node "$HOME/.claude/deepseek-gateway/deepseek-agent.mjs" \
  --task-file "<brief path>" \
  --dir "<project folder>" \
  --label "<short name>"
```

**By default it stays as a visible background session** (doesn't block this
call): it shows up in Claude Code's agent view (the user enters with ← from
their session, or you with `claude attach <id>`), in `claude agents`, and
keeps running even after this command finishes. The receipt carries the id
and the commands to follow it (`attach` / `logs` / `stop`). If the user asks
"how do I see what it's doing?" or "how do I get in?", that's the answer:
← key or `claude attach <id>`.

With `--foreground` it instead blocks this call and returns a short summary
when done (no session left visible after) — useful when only the final
result matters and there's no need to inspect it.

Useful options:

- `--model deepseek-flash` (default): only reasons if needed (if Claude Code
  asks for it).
- `--model deepseek-flash-thinking`: always reasons. For tasks that require
  thinking (logic, planning, non-trivial code).
- `--name <text>`: session name in the agent view (default: `--label` or the
  folder's name).
- `--permission-mode <mode>`: default `bypassPermissions` (doesn't ask for
  confirmations). The only thing blocked by default is `git push`.
- `--timeout-min <n>`: only applies with `--foreground` (default 30).

**Several tasks in parallel:** one invocation per task (each returns its own
id right away, no need for Bash's `run_in_background`). Have them work on
different files.

## Interactive session on DeepSeek (for the user)

If the user wants to work on DeepSeek themselves:

```
$HOME/.claude/deepseek-gateway/deepseek-session.cmd
$HOME/.claude/deepseek-gateway/deepseek-session.cmd --model deepseek-flash-thinking
```

It's a normal Claude Code session in that terminal, with everything
available. Inside, `/model` lets you toggle between the with- and
without-reasoning variant. It doesn't affect any other open session.

## Escalating to a real Sonnet (for a session already running on DeepSeek)

If you're running on DeepSeek and the task needs something that doesn't
exist here — WebSearch is the typical case, see Limitations — don't make it
up or call it impossible: you can escalate that one-off step to a real
Claude Code (Sonnet, your subscription login) without leaving this session,
via Bash:

```bash
node "$HOME/.claude/deepseek-gateway/escalate-to-sonnet.mjs" \
  --task "Search the web for: <specific query> and give me the data with sources" \
  --dir "<current folder>"
```

For longer tasks, `--task-file <path>` instead of `--task`. Blocks and
returns Sonnet's text response; no session is left visible after. Use it
only for the one-off step that needs it (a search, a fact that needs
verifying), not to delegate the whole task — that consumes real
Anthropic quota/cost, not DeepSeek's.

## Diagnostics and cost

```bash
node "$HOME/.claude/deepseek-gateway/cli.mjs" doctor           # key, gateway, connectivity
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway restart  # after changing config.json
node "$HOME/.claude/deepseek-gateway/cli.mjs" gateway logs     # latest requests
node "$HOME/.claude/deepseek-gateway/cli.mjs" cost --since 7d  # real DeepSeek cost
```

The dollar cost Claude Code reports inside a DeepSeek session **isn't real**
(it uses Anthropic rates). The real one is `cost`'s.

## Common errors

| Message | What to do |
|---|---|
| `No DeepSeek API key` | Tell the user: paste it into `$HOME/.claude/deepseek-gateway/.env` |
| `The DeepSeek gateway didn't start` | Run `doctor` and `gateway logs` |
| `DEEPSEEK-AGENT WITH ERROR` (only `--foreground`) | Read the result: the agent explains what failed |
| `Could not start the background session` | The process's stderr/stdout is printed; check it before retrying |

## Limitations

- Anthropic's "server-side" tools (WebSearch) don't exist on DeepSeek.
  WebFetch does work. To escalate a one-off step to a real Sonnet, see
  "Escalating to a real Sonnet" above.
- Images are analyzed by `deepseek-flash`, even inside a `tool_result`
  (useful for screenshots). `deepseek-pro` can't see them: a text notice
  arrives there instead.
- DeepSeek currently redirects `deepseek-pro` to `deepseek-flash` (since
  2026-09-14), so in practice they're the same model.
