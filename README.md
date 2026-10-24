# Locum

Locum lets other models do Claude's job inside Claude Code. A *locum tenens* is a doctor who covers for another, working in the same practice with its patients, records and rules. Here the practice is Claude Code: the agents Locum adds use its tools, permissions, transcripts and subagent view exactly as a native subagent does. Only the model doing the work is different, reached through [OpenRouter](https://openrouter.ai).

Your Claude login and model stay the default. You hand work to a Locum agent when you want a cheaper model, a second opinion from another model family, or the whole session on another model for a while.

```
> have kimi review the error handling in hooks/openrouter.ts
> run the cheap agent on the test failures
> /model deepseek/deepseek-v4.1-flash-1017
```

## Quick start

1. Get an [OpenRouter API key](https://openrouter.ai/settings/keys) with a few dollars of credit, and export it where Claude Code will see it, in your shell profile for example:

   ```
   export OPENROUTER_API_KEY=sk-or-...
   ```

2. Install the plugin, from a clone or straight from GitHub (a private repository needs `gh` or git signed in to an account that can read it):

   ```
   claude plugin marketplace add /path/to/claude-locum      # or: asharahmed/claude-locum
   claude plugin install locum@ashar-local --scope user
   ```

3. Start a session, or run `/reload-plugins` in one, and ask for an agent: "have the deepseek agent write tests for parser.py". `/locum` shows your balance, the agents and what they've spent.

## The agents

| Agent | Default model | Use it for |
|---|---|---|
| `locum:deepseek` | DeepSeek V4.1 Flash 1017 | the default: coding, research, multi-step tasks |
| `locum:kimi` | Kimi K3 | a second opinion from another model family |
| `locum:glm` | GLM-5.2 | design and planning |
| `locum:cheap` | DeepSeek V4 Flash 0731 | tests and simple tasks, at about $0.04 per million input tokens |
| `locum:custom` | any OpenRouter model you set | trying a model out |

Each one is a native subagent. The Agent tool starts it, its tool calls run through Claude Code's own tools and permission rules, and its transcript opens from the tasks list with its real model named. It gets what a native subagent's request carries: Claude Code's context blocks (environment, date, `CLAUDE.md` when the agent gets it), the native subagent tool set, and its reasoning streamed live.

Every model and reasoning effort can be changed (see Settings), and `/locum models` finds alternatives.

## Switching the main session

`/model <openrouter-id>` puts the main session itself on that model, and `/model opus` takes it back. Claude Code accepts any model ID there; Locum answers every request of a session whose model is an OpenRouter ID (one with a `/`).

- The model gets Claude Code's own system prompt, captured as Claude Code builds it, with the identity line naming the real model, and every built-in tool.
- Compaction is done by the same model, since Claude Code would ask Anthropic for it.
- One model can sit in the `/model` picker: set `ANTHROPIC_CUSTOM_MODEL_OPTION` (with `_NAME`, `_DESCRIPTION` and `_SUPPORTED_CAPABILITIES=effort,thinking`) in the `env` block of `~/.claude/settings.json`. DeepSeek V4.1 Flash 1017 is a good choice: it tied for best on a coding benchmark at $0.15/$0.60 per million tokens. The picker can't list more than that one.
- Picking a model in `/model` saves it as your default. To keep new sessions on Claude regardless, set `ANTHROPIC_MODEL=opus` in that same `env` block: it outranks the saved choice at every launch, and `/model` still switches the session you're in. Pressing `s` in the picker applies a choice to the current session only.
- In such a session Claude Code may run its built-in subagents (general-purpose, Explore) on a Claude model of its own choosing. A subagent that inherits the OpenRouter model is answered through OpenRouter with the subagent tool set.

## The `/locum` command

| Command | What it shows or does |
|---|---|
| `/locum` | Balance and key limit; each agent's model, effort and providers; the settings; the main session's model and the picker entry; spend history across sessions (today, last 7 days, all recorded, per agent); model health this session; this session's runs. |
| `/locum models [search]` | Tool-capable OpenRouter models matching the search, cheapest input first, with price, context, images and reasoning. |
| `/locum use <agent> <model>` | Puts an agent on another model, checked against OpenRouter's list (it must support tool calls). Kept across sessions, applied at `/reload-plugins`, and ahead of `/plugin configure` until `/locum use <agent> default`. |
| `/locum help` | The list above. |

## Settings

Change them with `/plugin configure locum@ashar-local`.

| Option | Default | What it does |
|---|---|---|
| `privacy` | `zero-retention` | Which providers may serve Locum's requests: `zero-retention` (providers that keep no prompts), `no-data-collection` (none that store or train on prompts) or `off`. The agents send your files and command output to the provider. |
| `maxRunUsd` | 0.5 | A run that has spent this much stops before its next step, with a report saying so. 0 turns the cap off. |
| `maxSessionUsd` | 3 | Once a session's OpenRouter spend reaches this, new agents are refused and running ones stop. 0 turns the cap off. |
| `fallbackModel` | DeepSeek V4 Flash 0731 | A step whose model keeps failing (outage, rate limit, provider error) is retried once on this model, never a Claude model. |
| `autoMode` | `refuse` | Whether Locum agents run in auto mode (see below). |
| `lowBalanceUsd` | 5 | A notice at session start when the balance or the key's limit is below this. 0 turns it off. |
| `<agent>Model`, `<agent>Effort` | per agent | The model behind deepseek, kimi, glm and cheap, and the reasoning effort when the Agent call names none. Kimi defaults to low, since its output is expensive. |
| `customModel`, `customLabel`, `customEffort` | empty | Set `customModel` to any OpenRouter model ID and `locum:custom` runs on it. |

## Cost and reliability

- With the default models, each agent is pinned to its cheapest zero-retention providers, with OpenRouter's others kept as fallback: deepseek to DeepInfra and Cloudflare, kimi to Wafer, InferenceNet and Sail Research, cheap to Relace and Reka. Prompts are marked for caching; a cached step costs a fraction of a fresh one.
- Costs come from OpenRouter's reports. When a reply carries none (a cut-off stream, an interruption, a provider that leaves it out), Locum estimates it from the tokens at OpenRouter's listed prices, so the caps still hold.
- Retryable errors are retried. OpenRouter's "could not verify available credits … retry shortly" is retried with a smaller output cap, since it checks the balance against a request's worst case. After 3 failed steps in a row a model is skipped for 2 minutes, so steps go straight to the fallback.
- Model capabilities come from OpenRouter's list at session start. A model without reasoning support gets no thinking budget, one without tool calls is refused with a clear message, and an ID OpenRouter doesn't know isn't hidden behind the fallback model.
- Claude Code's own cost summary doesn't see OpenRouter spend. `/locum` and each run's closing line do.

## Auto mode

Auto mode's safety check runs on Anthropic's side, against Anthropic's responses, so it refuses every tool call an OpenRouter model makes, and a permission prompt doesn't get past it. With `autoMode: refuse`, Locum won't start its agents, or run the main session on an OpenRouter model, in auto mode.

With `autoMode: allow`, actions the check would have reviewed run unreviewed. Only the asks auto mode itself raises are allowed: your `permissions.ask` rules, other hooks' and plugins' asks, settings checks and admin limits still ask, and deny rules still deny. Because SubagentHandback accepts only the check's approval, an agent ends with a plain-text report that Locum delivers in the completion notice. The report is labelled "Auto mode did not review this report or the work behind it" with the tool calls the agent actually made; its `<` characters are escaped so it can't forge markup around that label; an agent that reports without making any tool call is asked once to do the work; and SendMessage is refused, so the labelled report is the only way results reach you. The permission mode is read from Claude Code's hook events, so after Shift+Tab mid-turn the next tool call can still see the old mode.

## Safety

- Nothing falls back to your Claude model. If Locum's own step code fails, the step ends with an error, and an agent the settings no longer have stops instead of carrying on.
- A path refused to Write, Edit, NotebookEdit or Read is refused to Bash commands that name it, whether absolute, relative, `~/…` or after a `cd`. It's best-effort: a command that builds the path from a variable, a glob or a script isn't caught, and it doesn't apply to the main session.
- The agents' system prompt tells them not to work around a refusal or a tool they can't use.
- Your API key reaches `curl` through its environment, never its command line.
- Per-run state lives in Claude Code's session state, so `/reload-plugins` mid-run keeps it.

## Limits

- MCP tools can't be used. ToolSearch answers with references that only Anthropic's API expands, and no plugin API exposes an MCP tool's schema; the model is told when a tool it loaded can't be used.
- Plugins can't read built-in tool schemas, so `hooks/schemas.ts` is generated from Claude Code's plugin type file and needs regenerating after an update that changes a tool.
- The line under the logo ("Opus 5.5 · Claude Max") has no render hook and keeps naming the session's model. The band above the prompt and the "Using …" notice name the real one.
- Images go to models that take them; others, and the fallback model, get a note in their place. PDF blocks become a note for all.

## Requirements

- Claude Code with the function-hooks plugin API: built on 2.1.309, tested on 2.1.309 and 2.1.310. Locum depends on that API's `turn.step`, `prompt.compose` and `session.compact` hooks, so check it after a Claude Code update (see Development).
- An OpenRouter key with credit. A low balance makes OpenRouter's request checks fail intermittently; keep a few dollars on it.
- `curl` and `python3` on the PATH.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| `Agent type 'locum:…' not found` | The session loaded Locum before that agent existed (after an update or a `/locum use`). | `/reload-plugins`. |
| `OPENROUTER_API_KEY is not set in the environment claude started from` | The key isn't in the environment of the process that started Claude Code. | Export it from your shell profile and start a new session. The desktop app doesn't read a shell profile; put it in the `env` block of `~/.claude/settings.json` there. |
| `… can't run in auto mode` | Auto mode's check can't review OpenRouter models' actions, and `autoMode` is `refuse`. | Shift+Tab to manual or accept-edits, or set `autoMode` to `allow` if you accept unreviewed actions. |
| `the OpenRouter balance is too low` or `couldn't confirm the balance covers this request` | The balance is short, or too low for OpenRouter's check when several requests arrive together. | Top up at https://openrouter.ai/settings/credits, or run fewer agents at once. |
| `no OpenRouter provider of … meets the privacy setting` | No provider of that model qualifies under `privacy`. | Pick another model (`/locum models`), or loosen `privacy`. |
| `… doesn't support tool calls` or `OpenRouter doesn't know the model …` | The model can't call tools, or the ID is wrong. | `/locum models <name>` for a tool-capable ID. |
| `Stopped: this run reached the … spend cap` | `maxRunUsd` or `maxSessionUsd` was reached. | Raise it in `/plugin configure` if the spend is expected. |
| A new session starts on an OpenRouter model | Picking a model in `/model` saved it as your default. | Set `ANTHROPIC_MODEL` in the `env` block of `~/.claude/settings.json`. |

To confirm nothing reaches Anthropic, start Claude Code with `--debug-file /tmp/d.log` and look for `dispatching to firstParty` lines. A step a subagent sends to Anthropic is preceded by one with `cc_is_subagent=true`; there should be none for Locum's agents.

## Upgrading

- From **openrouter-agents** (1.0.0 and earlier, renamed in 1.0.1): agent types are now `locum:…`, the command is `/locum`, and options live under `locum@ashar-local`. Uninstall `openrouter-agents@ashar-local`, install `locum@ashar-local`, and move any saved options in `~/.claude/settings.json` from `pluginConfigs."openrouter-agents@ashar-local"` to `pluginConfigs."locum@ashar-local"`. The spend history is in `~/.claude/plugins/store/openrouter-agents_ashar-local-*.json`; its `ledger-v1` entry can be copied into the new `locum_ashar-local-*.json`.
- A marketplace added from a folder is read from that folder: `git pull`, then `/reload-plugins`.
- After a Claude Code update, rerun `scripts/gen-schemas.py` and `scripts/check.sh`.
- When the run state's shape changes (`runs-2` in `hooks/state.ts`), runs recorded before the update drop out of `/locum`; the spend history and `use` choices carry over.

## Development

- `hooks/register.tsx` wires the hooks. `agents.ts` holds the agents and settings, `openrouter.ts` the streaming client, `messages.ts` what the model is sent, `commands.ts` `/locum` with the spend ledger and `use` choices, `guard.ts` the path guard, `state.ts` the run state, and `schemas.ts` the generated tool schemas. `types/index.d.ts` declares the state.
- `scripts/check.sh` validates the plugin, type-checks it against the installed Claude Code's plugin API, and runs the 49 tests, which feed recorded OpenRouter streams through the hooks with the engine stood in for, so they spend nothing. It exits non-zero on any failure.
- `scripts/live-regression.sh` runs twelve scenarios against real OpenRouter for a few cents: each agent on a small coding task, auto mode with `allow` and `refuse`, the main session on OpenRouter, the run cap, the privacy setting, the path guard, `/locum`, and compaction across resumes. It reruns the files the agents wrote and checks that no step of an OpenRouter loop went to Anthropic. Run it before a release.
- `scripts/gen-schemas.py <path to claude-code.d.ts>` regenerates the tool schemas (needs npx; the type file is written when Claude Code's plugin-authoring skill loads).
- Turn Locum off with `claude plugin disable locum@ashar-local`; remove it with `claude plugin uninstall locum@ashar-local`.
