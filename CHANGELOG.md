# Changelog

Locum was called openrouter-agents until 1.0.1.

## 1.1.3

- Routing by price. With a lab's key set, each step goes first to whichever route costs less at that moment, the lab's own API or OpenRouter, and the other is the backup. Prices come from OpenRouter's public lists at session start: the providers that meet the privacy setting (OpenRouter's zero-retention list under `zero-retention` and `no-data-collection`), and the lab's own listing for its price. The comparison uses a typical step (mostly cached input), adds OpenRouter's 5.5% credit fee, and counts DeepSeek's peak hours.
- On 24 October 2026 that put deepseek, minimax and glm on OpenRouter first (DeepInfra, Relace and Wafer were cheaper than the labs) and qwen on Alibaba. 1.1.1 and 1.1.2 sent a step to the lab whenever it had a key, which cost more for those three.
- `direct` is now `cheapest` (default), `always` (the lab first whenever it has a key, for a flat-price plan such as GLM's Coding Plan) or `off`.
- Direct prices are the lab's listing on OpenRouter, with the table in `providers.ts` as the fallback when it's missing.
- Compaction takes the same routes as a step, so a session on a lab's model compacts without an OpenRouter key.
- `/locum` shows each agent's two routes with their prices and which goes first, and health per route (`… via OpenRouter`, `… via DeepSeek`).
- Updates. Locum checks GitHub's latest release twice a day and shows one notice per new version. `/locum update` shows the release notes; `/locum update install` runs `claude plugin marketplace update asharahmed` and `claude plugin update locum@asharahmed`, and only when the person typed it (at the terminal or through Remote Control), never when the model or a plugin runs the command. The new `updates` option is `notify` (default), `auto` (install at session start; choosing it grants that) or `off`. A copy read from a folder is never changed. The check needs the repository to be public.
- `scripts/release.sh x.y.z`: bumps the version and README badge, runs `scripts/check.sh`, pushes, waits for CI on that commit, then tags and publishes the release with its CHANGELOG section. A failing check or CI stops it before the tag. `--dry-run` changes nothing.
- 73 tests (prices and route choice, the backup route, `always`, compaction through a lab, update notices, the install's origin check and commands). The live suite adds a scenario that loads real prices.

## 1.1.2

- The marketplace is now `asharahmed` (it was `ashar-local`), so the plugin installs as `locum@asharahmed`. The plugin name, agent types and `/locum` are unchanged.
- To move an existing install: `claude plugin uninstall locum@ashar-local`, `claude plugin marketplace remove ashar-local`, `claude plugin marketplace add asharahmed/claude-locum`, `claude plugin install locum@asharahmed`. Uninstalling clears the plugin's options, keys included, so note any you set first. The spend history lives in `~/.claude/plugins/store/locum_ashar-local-*.json` and can be copied into the new `locum_asharahmed-*.json`.
- README rewritten: centred header with icon and badges, contents, shorter tables, long details folded away. The release badge is static, and `scripts/check.sh` fails if it doesn't match the manifest's version.
- Icon, MIT license file, security policy, author and repository metadata, and a GitHub Actions check on every push.

## 1.1.1

Setup made as short as it can be: install, paste one key, done.

- API keys go in the plugin's config dialog (`/plugin configure locum@ashar-local`), which Claude Code shows at install and keeps in the keychain: OpenRouter's first, then optional DeepSeek, Alibaba, MiniMax and Z.ai keys. Environment variables still work for any field left empty.
- `direct` is now `auto` (the default) or `off`. With `auto`, a lab you've given a key gets its models directly; there's no list of labs to type.
- Region-bound keys need no URL: Locum tries Alibaba's endpoints (Singapore, Virginia, Beijing, Hong Kong, the Coding Plan's host), MiniMax's (international, mainland) and Z.ai's (international, Zhipu) until one takes the key, and keeps using that one. `dashscopeBaseUrl` is only for workspace-dedicated URLs.
- A key a lab refuses at every endpoint gets one notice naming the config dialog, and isn't tried again that session.
- A lab key works without an OpenRouter key: that lab's models run, and others say which key to add. With no key at all, the session-start notice points to `/locum setup`.
- `/locum setup` lists which keys are set, what each one is for, where to get it, and how to add it from the dialog or a terminal. `/locum` shows a keys line.
- Verified live: a key saved through `claude plugin configure --values-stdin` reached the plugin from the keychain, went to DeepSeek, and didn't appear in the debug log.
- 61 tests.

## 1.1.0

- Direct providers. The new `direct` option lists labs to call through their own Anthropic-compatible APIs ahead of OpenRouter: `deepseek` (DeepSeek), `zai` (Z.ai), `dashscope` (Alibaba Model Studio, with `dashscopeBaseUrl` for a workspace URL) and `minimax` (MiniMax). Each needs its key in the environment. A failed direct request goes to OpenRouter for the same model, then to the fallback model; a direct route that keeps failing is skipped for a while.
- Direct steps are priced from the labs' own price lists, with DeepSeek's peak-hour doubling, so the spend caps and history still hold.
- `/locum` shows each agent's route and which listed labs have no key. Agent descriptions and the subagent header name the lab when a run goes direct.
- New agents: `locum:qwen` (Qwen 3.8 Flash) and `locum:minimax` (MiniMax M3.1 Flash). `locum:glm` moves to GLM-5.3.
- The `privacy` option doesn't apply to direct calls; the README says so and when direct is cheaper and when it isn't.
- `scripts/live-regression.sh` has 14 scenarios: the minimax agent, and a deepseek run with `direct: deepseek` and a key DeepSeek refuses, which must finish through OpenRouter. An agent's check now runs its asserts instead of matching the exact wording of the last line. All 14 passed on Claude Code 2.1.310.
- 55 tests: the direct URL, auth header, model ID and missing `provider` field; the key passed only in the environment; direct failure going to OpenRouter; a missing key or option staying on OpenRouter; `/locum` routes; peak pricing and the workspace URL.

## 1.0.1

- Renamed from openrouter-agents to **Locum**: the plugin is `locum@ashar-local`, the agent types `locum:deepseek`, `locum:kimi`, `locum:glm`, `locum:cheap` and `locum:custom`, the command `/locum`, and the repository `claude-locum`. Behaviour is unchanged. README "Upgrading" says how to move saved options and the spend history across.
- README rewritten: what Locum is and why the name, a quick start, then the agents, main-session switching, `/locum`, settings, cost and reliability, auto mode, safety, limits, requirements, troubleshooting, upgrading and development.

## 1.0.0

The first stable release. Unchanged code since 0.9.9, which passed every automated test (49) and every live scenario (12), on Claude Code 2.1.309 and again on 2.1.310.

What 1.0 is:

- Native Claude Code subagents on OpenRouter models (deepseek, kimi, glm, cheap and a custom slot), with the main session on your usual login and model.
- The main session itself on any OpenRouter model through `/model <id>`, with Claude Code's own system prompt, every built-in tool, and compaction by the same model.
- Zero-retention providers by default, pinned to the cheapest qualifying ones; per-run and per-session spend caps; a fallback model and a skip for failing models.
- Opt-in auto mode with unreviewed actions clearly labelled; a best-effort path guard; nothing ever falling back to the session's own model.
- `/openrouter` for balance, agents, settings, health, runs and spend history across sessions; `models` and `use` to pick models.
- `scripts/check.sh` (validate, type-check, 49 tests) and `scripts/live-regression.sh` (12 live scenarios).

From here, agent names, option names and `/openrouter` subcommands are stable.

## 0.9.9

- Release candidate. `scripts/live-regression.sh`: twelve scenarios against real OpenRouter, each checked by outcome (files the agents wrote are rerun) and for steps leaking to Anthropic. All twelve passed for $0.04: the four agents, auto mode with `allow` and `refuse`, the main session on OpenRouter, the run cap, the privacy setting, the path guard, `/openrouter`, and compaction across resumes.

## 0.9.8

- README: a troubleshooting table covering every message the plugin shows (cause and fix), how to confirm with a debug log that nothing reaches Anthropic, and upgrading notes (pulling a folder marketplace, regenerating schemas after a Claude Code update, state shape changes, the `qwen` → `cheap` rename).

## 0.9.7

- Tests for what the model is sent and the auto-mode report handling (49 in all): an image for a text-only model and one that reads images, ToolSearch results (a loadable built-in and an unusable MCP tool), the model-identity rewrite, SubagentHandback offered only when Claude Code offers it, an auto-mode handback call becoming the report, reminders answered locally after one no-tools nudge, a mode change seen at the next tool call, and the Agent call's effort reaching the reasoning budget.
- Removing the effort handover or the nudge makes its test fail.
- README: development notes list the test files.

## 0.9.6

- Model health: after 3 failed steps in a row, a model is skipped for 2 minutes, so steps go straight to the fallback instead of paying three retries each, then it's tried again.
- `/openrouter` lists each model's health this session: steps answered, time per step, failed steps with the last error, and whether it's being skipped.
- A test for the skip and the health listing (40 in all).

## 0.9.5

Fixes from a security review of the plugin:

- High: after `/model` back to a Claude model, the plugin still treated the main session as on OpenRouter, so in auto mode with `autoMode: allow` it turned the Claude session's asks into allows, and `/compact` could send its transcript to OpenRouter. Every main step now records its model, and compaction asks Claude Code for the current one.
- High: in auto mode with `allow`, any ask became an allow, including `permissions.ask` rules, hooks' and other plugins' asks, settings checks and admin ceilings. Only the mode's own asks are allowed now.
- Medium: an auto-mode report could forge task-notification markup outside its "not reviewed" label; its `<` is escaped now. Reports are only delivered into real task notifications (`origin.kind`), not pasted or peer-sent look-alikes.
- Medium: steps whose cost OpenRouter didn't report (a cut-off stream, an interruption, a provider that leaves it out) counted as $0 toward the caps. Missing costs are estimated from tokens at OpenRouter's listed prices, and compaction counts toward the caps and checks the session cap first.
- Low: the path guard matches whole paths (a refused `.env` no longer blocks `.env.example`), records only real refusals (not EACCES file errors), and is documented as best-effort.
- Low: agent names are looked up without inherited properties (`constructor`, `__proto__`); spend-ledger writes are serialised.
- Documented: the permission mode is read from hook events, so a Shift+Tab mid-turn is seen one tool call late.
- Tests for each fix (39 in all); undoing the stale-model, ask-rule or escaping fix makes its test fail.

## 0.9.4

- `scripts/check.sh`: validation, a type-check against the installed Claude Code's plugin API, and the tests in one command, exiting non-zero on any failure (checked against a planted type error).

## 0.9.3

- Fix: compacting a resumed session on an OpenRouter model (`/compact` before any step) went to Anthropic and failed, because the plugin only knew the main model once a step had named it. It now asks Claude Code for the session's model.
- Verified live: a session on DeepSeek V4.1 Flash was resumed, compacted by the plugin through OpenRouter (Claude Code's own compaction never ran), and resumed again with its facts intact, with no request to Anthropic.
- A test for compacting right after a resume (32 in all).

## 0.9.2

- Model capabilities from OpenRouter's list (read at session start) shape each request: a model without reasoning support gets no thinking budget, and one without tool calls fails at once with a clear message, since Claude Code needs tools.
- A model ID OpenRouter doesn't know (a typo after `/model`, say) gets "OpenRouter doesn't know the model …" instead of a raw error, and isn't hidden behind the fallback model.
- Tests for all three (31 in all).

## 0.9.1

- `/openrouter` shows the main session's model (and how to switch back when it runs on OpenRouter), the `/model` picker entry, and the model new sessions start on (`ANTHROPIC_MODEL`).
- README: the picker entry recommendation (DeepSeek V4.1 Flash 1017) and how to keep Claude as the default whatever `/model` saves.

## 0.9.0

- Main-session switching: `/model <openrouter-id>` runs the main session on that OpenRouter model, answered by the plugin. It gets Claude Code's own system prompt (captured from `prompt.compose`, model line rewritten) and every built-in tool; `/model opus` goes back.
- Any loop on an OpenRouter model is answered through OpenRouter: the main session, the plugin's agents, and subagents that inherit an OpenRouter model (those get the subagent tool set and prompt).
- Compaction of an OpenRouter conversation is done by the same model (`session.compact`), since Claude Code would ask Anthropic for it.
- Auto mode for the main session follows `autoMode`; the permission mode is tracked from the classic UserPromptSubmit, SubagentStart and PostToolUse events.
- `hooks/schemas.ts` now holds every built-in tool's schema plus `SUBAGENT_TOOLS`.
- The step error handler never lets an OpenRouter loop fall to the session's model.
- Tests for the main session, pass-through on a Claude model, inherited subagents, the captured system prompt, main-session auto mode and compaction (28 in all).
- Live: a session started with `--model openai/gpt-6-luna` wrote and tested a script with Read, Write and Bash on Claude Code's real 6,959-character system prompt, with no request to Anthropic.

## 0.8.0

- Spend history across sessions: each step's cost is added to a per-day, per-agent ledger in the plugin's store; `/openrouter` shows today, the last 7 days and everything recorded.
- `/openrouter models [search]`: tool-capable OpenRouter models, cheapest input first, with price, context, images and reasoning.
- `/openrouter use <agent> <model>` and `use <agent> default`: run an agent on another model, checked against OpenRouter's list and kept across sessions.
- `/openrouter help`; the command module moved to `hooks/commands.ts`.
- Fix: `/openrouter` read the manifest relative to the session's folder, so the version from 0.7.1 never showed outside tests; it now reads it from the plugin's folder.
- Tests for the ledger, `models`, `use` and `help` (22 in all).

## 0.7.3

- OpenRouter's "could not verify available credits for this request in time. Retry shortly" is retried, with the output cap halved each time (down to 4,096 tokens) so the worst case it checks the balance against shrinks, then tried on the fallback model. It had been treated as an empty balance, and Kimi and GLM failed whenever several agents ran at once on a low balance.
- A real shortfall (402, "Insufficient credits") still stops at once with the top-up link.
- Tests for both (18 in all).

## 0.7.2

- A run whose agent the settings no longer have (the custom slot cleared mid-run, say) stops with a message instead of carrying on on the session's own model. Any agent type named `openrouter-agents:…` counts as the plugin's own.
- The status line says what a run does after each step (running tools, finishing, stopped) instead of always "waiting on tools".
- Zero costs show as $0.00.
- README: exact install commands, from a clone or from GitHub.
- Tests split by area into six files with shared stand-ins in `tests/helpers.ts`; a test for the unconfigured-agent stop (16 in all).

## 0.7.1

- Another plugin's or a built-in subagent is looked up once, then passed straight through (each of its steps and tool checks had listed every agent).
- A `fallbackModel` equal to the failing agent's own model now moves on to the next fallback instead of retrying the same model.
- The fallback model is checked against OpenRouter's list at session start, like the agents' models.
- `/openrouter` names the plugin's version.

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
