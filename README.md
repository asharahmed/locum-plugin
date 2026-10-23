# openrouter-agents

Adds four subagent types to a normal Claude Code session: `openrouter-agents:deepseek` (DeepSeek V4.1 Flash 1017), `openrouter-agents:kimi` (Kimi K3), `openrouter-agents:glm` (GLM-5.2) and `openrouter-agents:qwen` (Qwen 3.7 Flash, the very low cost one for tests and simple tasks). The main session stays on your usual login and model.

They are native subagents: the Agent tool starts them, their tool calls run and show like any subagent's, and you can open their transcripts. A `turn.step` hook answers each of their model requests by sending the subagent's conversation to OpenRouter's Anthropic-compatible `/v1/messages` endpoint, so only those requests leave for OpenRouter.

## Setup

`OPENROUTER_API_KEY` must be in the environment `claude` starts from. Options (in `/plugin configure`): `lowBalanceUsd` (default 5) sets when a low-balance notice appears at session start, 0 turns it off; `autoMode` (`refuse` or `allow`, default `refuse`) decides whether these agents run in auto mode.

## What you see

- The subagent's reasoning streams live as thinking, then its text and tool calls, as for a native subagent. Claude Code keeps only thinking Anthropic signed, so reasoning isn't saved in the subagent's transcript.
- The status line shows the agent, its step count and its OpenRouter spend so far; when the run ends, a transcript line gives the total.

## Limits

- Tools: Claude Code grants these agents the native subagent tool pool. The mod offers the model every built-in in that pool the session has (Read, Bash, Edit, Write, NotebookEdit, LSP, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, Monitor, TaskStop, SendMessage, Artifact, EnterWorktree, ExitWorktree on this build), plus SubagentHandback. Plugins can't read tool schemas, so `hooks/schemas.ts` is generated from Claude Code's plugin type file; after a Claude Code update, rerun `python3 -I scripts/gen-schemas.py <path to claude-code.d.ts>` (needs npx; the path is printed when the plugin-authoring skill loads).
- MCP tools can't be used. ToolSearch answers with references that only Anthropic's API expands into schemas, and no plugin API exposes an MCP tool's schema. The model is told plainly when a tool it loaded can't be used.
- Context: environment, date, CLAUDE.md (unless the agent omits it) and the other context blocks reach the model exactly as Claude Code puts them in a native subagent's messages. The model-identity line is rewritten to name the real model. The system prompt is the agent definition's own.
- Images go to DeepSeek and Kimi as they are; GLM-5.2 is text-only, so it gets a note in their place. Documents (PDF blocks) become a note for all three.
- Reasoning budget follows the Agent call's `effort` (or the session's): low 1k, medium 4k, high 8k, xhigh 12k, max 16k tokens.
- The subagent and its messages are labelled with the OpenRouter model (the plugin names it at spawn). Claude Code logs a harmless validation error for that, since the Agent tool's `model` normally takes only Claude aliases.
- With one of these subagents' transcripts open, the band above the prompt names its model, and the header's "Using <model> (from …)" notice is redrawn to name it too. The "Opus 5.5 · Claude Max" line under the logo has no render hook, so it keeps showing the session's model.
- Auto mode: its safety check runs server-side on Anthropic's responses, so it refuses every tool call these agents make, and a permission prompt doesn't get past it. With the `autoMode` option at `refuse` (the default) the plugin won't start these agents in auto mode. At `allow`, what the safety check would have reviewed is allowed unreviewed (deny rules still apply), and since SubagentHandback accepts only the classifier's approval, the agent ends with a plain-text report that the plugin delivers in the completion notice (or the Agent result), labelled as not reviewed by auto mode.
- Requests stream through `curl` (`$.http.fetch` gives up after 30 s). A 429, 5xx or network error before any output is retried twice; a stream cut off mid-reply keeps what arrived and the run goes on. A context-length error ends the step as `model_context_window_exceeded`.
- If the hook itself fails, the step ends with an error instead of quietly running on the session's own model. (Without that handler Claude Code finishes a failed step on Opus.)
- Prompt caching: the system prompt and the latest message are marked for caching. Kimi and GLM cache on OpenRouter; DeepSeek's current provider doesn't.
- Persistent 429s ("could not verify available credits") usually mean the OpenRouter balance is low.

## Turning it off

Disable with `/plugin` or `claude plugin disable openrouter-agents@ashar-local`; remove with `claude plugin uninstall openrouter-agents@ashar-local`.
