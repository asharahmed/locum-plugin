# openrouter-agents

A Claude Code plugin that adds subagents running on OpenRouter models, while the main session stays on your usual login and model (Opus on a Claude subscription, say).

| Agent | Default model | Use it for |
|---|---|---|
| `openrouter-agents:deepseek` | `deepseek/deepseek-v4.1-flash-1017` | the default: coding, research, multi-step tasks |
| `openrouter-agents:kimi` | `moonshotai/kimi-k3` | a second opinion from another model family |
| `openrouter-agents:glm` | `z-ai/glm-5.2` | design and planning |
| `openrouter-agents:cheap` | `deepseek/deepseek-v4-flash-0731` | tests and simple tasks, at ~$0.04 per million input tokens |
| `openrouter-agents:custom` | any OpenRouter model you set | trying a model out |

Ask for them as you would any subagent ("have kimi review this", "run the cheap agent on that").

## How it works

They are native Claude Code subagents: the Agent tool starts them, their tool calls run through Claude Code's own tools and permissions, and their transcripts open from the tasks list. A `turn.step` hook answers each of their model requests itself, streaming the subagent's conversation to OpenRouter's Anthropic-compatible `/v1/messages` endpoint through `curl`. Nothing a subagent asks goes to Anthropic.

What the model is sent matches a native subagent's request: the context blocks Claude Code puts in its messages (environment, date, `CLAUDE.md` when the agent gets it), the native subagent tool pool's built-in tools, and the agent definition's prompt as the system prompt. The model-identity line is rewritten to name the real model, and the subagent view's header and the band above the prompt name it too. Reasoning streams live as thinking.

## Setup

`OPENROUTER_API_KEY` must be in the environment `claude` starts from. Install from this folder (a local marketplace), then `/reload-plugins`.

`/openrouter` shows your OpenRouter balance, each agent's model, effort and providers, the settings, and this session's runs with their cost.

## Settings (`/plugin configure openrouter-agents@ashar-local`)

| Option | Default | What it does |
|---|---|---|
| `privacy` | `zero-retention` | Which OpenRouter providers may serve these agents: `zero-retention` (providers that keep no prompts), `no-data-collection` (none that store or train on prompts) or `off`. The subagents send your files and command output to the provider. |
| `maxRunUsd` | 0.5 | A run that has spent this much stops before its next step, with a report saying so. 0: no cap. |
| `maxSessionUsd` | 3 | Once the session's OpenRouter subagents have spent this much, new ones are refused and running ones stop. 0: no cap. |
| `fallbackModel` | `deepseek/deepseek-v4-flash-0731` | When a step's model keeps failing (outage, rate limit, provider error), the step is retried once on this model. Never a Claude model. |
| `autoMode` | `refuse` | Whether these agents run in auto mode (see below). |
| `lowBalanceUsd` | 5 | A notice at session start when the balance or key limit is below this. 0: off. |
| `<agent>Model`, `<agent>Effort` | per agent | The model behind deepseek, kimi, glm and cheap, and the reasoning effort when the Agent call names none (kimi defaults to low: its output is expensive). |
| `customModel`, `customLabel`, `customEffort` | empty | Set `customModel` to any OpenRouter model ID and `openrouter-agents:custom` runs on it. |

With the default models, each agent is pinned to its cheapest zero-retention providers (others stay as fallback): deepseek to DeepInfra and Cloudflare, kimi to Wafer, InferenceNet and Sail Research, cheap to Relace and Reka. A model other than the default isn't pinned.

## Auto mode

Auto mode's safety check runs server-side on Anthropic's responses, so it refuses every tool call an OpenRouter subagent makes, and a permission prompt doesn't get past it. With `autoMode: refuse` the plugin won't start these agents in auto mode.

With `autoMode: allow`, what the check would have reviewed is allowed unreviewed (deny rules still apply). SubagentHandback accepts only the check's approval, so the agent ends with a plain-text report that the plugin delivers in the completion notice, labelled "Auto mode did not review this report or the work behind it" and listing the tool calls the agent actually made. An agent that reports without any tool calls is nudged once to do the work. SendMessage is refused, so the labelled report is the only way results reach the main session.

## Guards

- A path refused to Write, Edit, NotebookEdit or Read is refused to Bash too, however the command spells it (relative, `~/…`, after a `cd`).
- The system prompt tells the model not to work around a refusal or a tool it can't use.
- If the plugin's step hook fails, the step ends with an error instead of being finished on the session's own model.
- Per-run state (auto mode, the report, tool calls, refused paths, cost) lives in Claude Code's session state, so `/reload-plugins` mid-run keeps it.

## Limits

- MCP tools can't be used: ToolSearch answers with references only Anthropic's API expands, and no plugin API exposes an MCP tool's schema. The model is told when a tool it loaded can't be used.
- Built-in tool schemas aren't readable by plugins, so `hooks/schemas.ts` is generated from Claude Code's plugin type file. After a Claude Code update, rerun `python3 -I scripts/gen-schemas.py <path to claude-code.d.ts>` (needs npx; the path is printed when the plugin-authoring skill loads).
- The line under the logo ("Opus 5.5 · Claude Max") has no render hook, so it keeps naming the session's model. Claude Code's own cost summary doesn't count OpenRouter spend; `/openrouter` and each run's closing line do.
- Images go to models that take them (looked up at session start); others, and the fallback model, get a note in their place. PDF blocks become a note for all.

## Development

- `hooks/register.tsx` wires the hooks; `agents.ts` holds the agents and settings, `openrouter.ts` the streaming client, `messages.ts` what the model is sent, `guard.ts` the path guard, `state.ts` the run state, `schemas.ts` the generated tool schemas. `types/index.d.ts` declares the state.
- `claude plugin validate .` and `claude plugin test .` (recorded OpenRouter streams through the hooks, with the engine stood in for; no credits spent).
- Turn it off with `claude plugin disable openrouter-agents@ashar-local`; remove it with `claude plugin uninstall openrouter-agents@ashar-local`.
