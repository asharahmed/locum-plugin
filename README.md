# openrouter-agents

A Claude Code plugin that adds subagents running on OpenRouter models, while the main session stays on your usual login and model (Opus on a Claude subscription, say). The main session can also be switched to any OpenRouter model with `/model <id>`.

| Agent | Default model | Use it for |
|---|---|---|
| `openrouter-agents:deepseek` | `deepseek/deepseek-v4.1-flash-1017` | the default: coding, research, multi-step tasks |
| `openrouter-agents:kimi` | `moonshotai/kimi-k3` | a second opinion from another model family |
| `openrouter-agents:glm` | `z-ai/glm-5.2` | design and planning |
| `openrouter-agents:cheap` | `deepseek/deepseek-v4-flash-0731` | tests and simple tasks, at ~$0.04 per million input tokens |
| `openrouter-agents:custom` | any OpenRouter model you set | trying a model out |

Ask for them as you would any subagent ("have kimi review this", "run the cheap agent on that").

## Switching the main session

`/model <openrouter-id>` (for example `/model moonshotai/kimi-k3`) runs the main session itself on that OpenRouter model; `/model opus` goes back. Claude Code accepts any model ID there, and the plugin answers every request of a session whose model is an OpenRouter ID (one with a `/`). `/openrouter models` lists IDs to choose from.

- The main session gets Claude Code's own system prompt, captured as Claude Code renders it, with the model-identity line naming the real model, and every built-in tool. MCP tools can't be used.
- Compaction is done by the same model through OpenRouter (Claude Code would ask Anthropic for it).
- Auto mode follows the `autoMode` option, as for the agents: refused by default; with `allow`, tool calls that auto mode would review run unreviewed.
- The session cap and the spend history count the main session's spend; the per-run cap doesn't apply to it.
- Claude Code may run its built-in subagents (general-purpose, Explore) on a Claude model of its choosing in such a session. A subagent that does inherit the OpenRouter model is answered through OpenRouter with the subagent tool set.
- One OpenRouter model can also sit in the `/model` picker through `ANTHROPIC_CUSTOM_MODEL_OPTION` (with `_NAME`, `_DESCRIPTION`, `_SUPPORTED_CAPABILITIES=effort,thinking`) in the `env` block of `~/.claude/settings.json`; DeepSeek V4.1 Flash 1017 is a good one (it tied the best on a coding benchmark at $0.15/$0.60 per million tokens). The picker can't list more than one: Claude Code fills it from its own models and that one entry.
- Picking a model in `/model` saves it as your default. To keep new sessions on Claude whatever gets picked, set `ANTHROPIC_MODEL` (to `opus`, say) in that same `env` block: it outranks the saved default at every launch, while `/model` still switches the session you're in. Pressing `s` in the picker applies a choice to the current session only.
- `/openrouter` shows the main session's model, the picker entry and that default.

## How it works

They are native Claude Code subagents: the Agent tool starts them, their tool calls run through Claude Code's own tools and permissions, and their transcripts open from the tasks list. A `turn.step` hook answers each of their model requests itself, streaming the subagent's conversation to OpenRouter's Anthropic-compatible `/v1/messages` endpoint through `curl`. Nothing a subagent asks goes to Anthropic.

What the model is sent matches a native subagent's request: the context blocks Claude Code puts in its messages (environment, date, `CLAUDE.md` when the agent gets it), the native subagent tool pool's built-in tools, and the agent definition's prompt as the system prompt. The model-identity line is rewritten to name the real model, and the subagent view's header and the band above the prompt name it too. Reasoning streams live as thinking.

## Setup

`OPENROUTER_API_KEY` must be in the environment `claude` starts from (exported from your shell profile, say).

From a clone of this repository:

```
claude plugin marketplace add /path/to/claude-openrouter-agents
claude plugin install openrouter-agents@ashar-local --scope user
```

Or straight from GitHub (a private repository needs `gh` or git signed in to an account that can read it):

```
claude plugin marketplace add asharahmed/claude-openrouter-agents
claude plugin install openrouter-agents@ashar-local --scope user
```

Then `/reload-plugins` in a running session, or start a new one. A marketplace added from a folder is read from that folder, so after `git pull` a `/reload-plugins` picks up the new version.

## The `/openrouter` command

| Command | What it does |
|---|---|
| `/openrouter` | Balance and key limit, each agent's model, effort and providers, the settings, spend history (today, last 7 days, all recorded, per agent, across sessions), and this session's runs. |
| `/openrouter models [search]` | Tool-capable OpenRouter models matching the search, cheapest input first, with price, context, images and reasoning. |
| `/openrouter use <agent> <model>` | Runs an agent on another OpenRouter model, checked against OpenRouter's list (it must support tool calls). Kept across sessions; takes effect after `/reload-plugins`. Wins over `/plugin configure` until undone. |
| `/openrouter use <agent> default` | Back to the configured model. |
| `/openrouter help` | The list above. |

The spend history and `use` choices live in the plugin's own store (`$.store`), not in Claude Code's settings.

## Settings (`/plugin configure openrouter-agents@ashar-local`)

| Option | Default | What it does |
|---|---|---|
| `privacy` | `zero-retention` | Which OpenRouter providers may serve these agents: `zero-retention` (providers that keep no prompts), `no-data-collection` (none that store or train on prompts) or `off`. The subagents send your files and command output to the provider. |
| `maxRunUsd` | 0.5 | A run that has spent this much stops before its next step, with a report saying so. 0: no cap. When OpenRouter reports no cost for a reply, it's estimated from the tokens at the listed prices. |
| `maxSessionUsd` | 3 | Once the session's OpenRouter subagents have spent this much, new ones are refused and running ones stop. 0: no cap. |
| `fallbackModel` | `deepseek/deepseek-v4-flash-0731` | When a step's model keeps failing (outage, rate limit, provider error), the step is retried once on this model. Never a Claude model. After 3 failed steps in a row a model is skipped for 2 minutes (steps go straight to the fallback), then tried again; `/openrouter` shows each model's health this session. |
| `autoMode` | `refuse` | Whether these agents run in auto mode (see below). |
| `lowBalanceUsd` | 5 | A notice at session start when the balance or key limit is below this. 0: off. |
| `<agent>Model`, `<agent>Effort` | per agent | The model behind deepseek, kimi, glm and cheap, and the reasoning effort when the Agent call names none (kimi defaults to low: its output is expensive). |
| `customModel`, `customLabel`, `customEffort` | empty | Set `customModel` to any OpenRouter model ID and `openrouter-agents:custom` runs on it. |

With the default models, each agent is pinned to its cheapest zero-retention providers (others stay as fallback): deepseek to DeepInfra and Cloudflare, kimi to Wafer, InferenceNet and Sail Research, cheap to Relace and Reka. A model other than the default isn't pinned.

## Auto mode

Auto mode's safety check runs server-side on Anthropic's responses, so it refuses every tool call an OpenRouter subagent makes, and a permission prompt doesn't get past it. With `autoMode: refuse` the plugin won't start these agents in auto mode.

With `autoMode: allow`, what the check would have reviewed is allowed unreviewed. Only the asks auto mode itself raises are allowed: your `permissions.ask` rules, other hooks' and plugins' asks, settings checks and admin limits still ask, and deny rules still deny. The permission mode is read from Claude Code's hook events, so after Shift+Tab mid-turn the next tool call can still see the old mode. SubagentHandback accepts only the check's approval, so the agent ends with a plain-text report that the plugin delivers in the completion notice, labelled "Auto mode did not review this report or the work behind it" and listing the tool calls the agent actually made; the report's `<` characters are escaped, so it can't forge notice markup around that label. An agent that reports without any tool calls is nudged once to do the work. SendMessage is refused, so the labelled report is the only way results reach the main session.

## Guards

- A path refused to Write, Edit, NotebookEdit or Read (a real refusal, not a file error) is refused to Bash commands that name it: absolute, relative, `~/…` or after a `cd`, matched as a whole path. It's best-effort: a command that builds the path (a variable, a glob, a script) isn't caught, and it doesn't apply to the main session.
- The system prompt tells the model not to work around a refusal or a tool it can't use.
- If the plugin's step hook fails, the step ends with an error instead of being finished on the session's own model.
- Per-run state (auto mode, the report, tool calls, refused paths, cost) lives in Claude Code's session state, so `/reload-plugins` mid-run keeps it.

## Limits

- MCP tools can't be used: ToolSearch answers with references only Anthropic's API expands, and no plugin API exposes an MCP tool's schema. The model is told when a tool it loaded can't be used.
- Built-in tool schemas aren't readable by plugins, so `hooks/schemas.ts` is generated from Claude Code's plugin type file. After a Claude Code update, rerun `python3 -I scripts/gen-schemas.py <path to claude-code.d.ts>` (needs npx; the path is printed when the plugin-authoring skill loads).
- The line under the logo ("Opus 5.5 · Claude Max") has no render hook, so it keeps naming the session's model. Claude Code's own cost summary doesn't count OpenRouter spend; `/openrouter` and each run's closing line do.
- Images go to models that take them (looked up at session start); others, and the fallback model, get a note in their place. PDF blocks become a note for all.

## Development

- `hooks/register.tsx` wires the hooks; `agents.ts` holds the agents and settings, `commands.ts` `/openrouter`, the spend ledger and `use` choices, `openrouter.ts` the streaming client, `messages.ts` what the model is sent, `guard.ts` the path guard, `state.ts` the run state, `schemas.ts` the generated tool schemas. `types/index.d.ts` declares the state.
- `scripts/check.sh` runs everything: `claude plugin validate .`, a type-check against the installed Claude Code's plugin API (the newest `claude-code.d.ts` on disk, or a path you pass), and `claude plugin test .`: recorded OpenRouter streams through the hooks, with the engine stood in for, so no credits are spent. It exits non-zero on any failure. `tests/helpers.ts` holds the stand-ins; the tests are split by area (stream, caps, guard, auto mode, command, routing).
- Turn it off with `claude plugin disable openrouter-agents@ashar-local`; remove it with `claude plugin uninstall openrouter-agents@ashar-local`.
