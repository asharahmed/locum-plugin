# Changelog

## 0.7.0

- Split the hooks module into `agents.ts`, `openrouter.ts`, `messages.ts`, `guard.ts` and `state.ts`; `register.tsx` only wires hooks.
- `/openrouter` command: balance and key limit, each agent's model, effort and providers, the settings, and this session's runs with cost, providers and tool calls.
- Session spend cap (`maxSessionUsd`, default $3): new agents are refused and running ones stop once it's reached.
- Fallback model (`fallbackModel`): a step whose model keeps failing is retried once on another OpenRouter model, noted in the run's closing line and the auto-mode report label.
- A low balance ("could not verify available credits", 402) now says to top up instead of showing the raw error, and doesn't try the fallback.
- Run state records the model, start time, whether the run ended and its fallback steps (state shape `runs-2`).
- Tests for the fallback, the low-balance message, the session cap, a capped run handing back through SubagentHandback, `/openrouter`, and auto-mode report delivery (13 in all).
- README rewritten; this changelog added.

## 0.6.9

- Per-run spend cap (`maxRunUsd`, default $0.50).
- Cheapest zero-retention provider pins for kimi (Wafer, InferenceNet, Sail Research) and cheap (Relace, Reka).
- First recorded-stream tests (`claude plugin test .`).

## 0.6.8

- `privacy` option, zero-retention providers by default.

## 0.6.7

- The qwen agent became `cheap` on DeepSeek V4 Flash 0731: Qwen 3.7 Flash had one provider, which kept failing.

## 0.6.6

- Run state in `$.state`, so `/reload-plugins` mid-run keeps it.
- Model and effort options per agent, and a free `custom` slot.
- The path guard resolves relative paths, `~/` and `cd`.
- SubagentHandback is offered only when Claude Code gives it.

## 0.6.0 – 0.6.5

- Opt-in auto mode (`autoMode: allow`): tool calls allowed unreviewed, plain-text reports delivered by the plugin with a label listing the agent's tool calls, a one-time nudge for a report with no tool calls behind it, the engine's handback reminders answered locally and hidden in the view.
- SendMessage refused in auto mode; Bash refused on paths a file tool was refused for.
- In-stream provider errors retried; DeepSeek pinned to caching providers.
- The subagent view names the real model (spawn model, band above the prompt, header notice).

## 0.5.x

- Native tool pool and generated schemas for every background-subagent built-in; ToolSearch results handled; images replaced for text-only models; effort sets the reasoning budget; the model-identity line names the real model.
- Auto mode refused by default (its server-side check can't review these agents).

## 0.4.0

- Errors handled without falling back to Opus (a failed step had been finished on the session's model, which hid that Kimi's tool ids were refused); Kimi tool ids cleaned; prompt caching; reasoning streamed; cost shown; low-balance notice.

## 0.3.0

- Requests stream through `curl` (`$.http.fetch` gave up after 30 seconds).

## 0.2.0

- Native subagents: a `turn.step` hook answers their model requests, replacing 0.1.0's headless `claude -p` child process.
