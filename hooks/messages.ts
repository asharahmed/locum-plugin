// What the model is told and sent: prompts, the conversation adapted for an
// OpenRouter model, and the tools it is offered.

import type { AgentDef } from './agents'
import { TOOL_SCHEMAS } from './schemas'

export type ApiBlock = Record<string, unknown> & { type: string }
export type ApiMsg = { role: string; content: ApiBlock[] }
export type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> }
type Messages = readonly { role: string; content: readonly unknown[] }[]

// The engine tells every subagent to end its run with this tool when it gives
// it one, so the request to OpenRouter has to offer it too.
export const HANDBACK_TOOL = {
  name: 'SubagentHandback',
  description:
    'Deliver your final report to the session that delegated this task. Call it once, as your last step, ' +
    'with your full report; the call ends your run. Plain text written at the end is not delivered.',
  input_schema: {
    type: 'object',
    properties: { message: { type: 'string', description: 'Your full final report' } },
    required: ['message'],
  },
}

export const SUBAGENT_PROMPT =
  'You are a subagent in Claude Code, working on a task delegated by the main session. ' +
  'Complete it with the tools available, verify your work where you can, and end with a ' +
  'concise report of what you did and found, including file paths. Use absolute paths. ' +
  'Prefer Read, Edit and Write for files over shell commands that do the same.\n\n' +
  'If a tool call is denied or needs permission you were not given, do not get the same ' +
  'effect another way (for example with cp, cat, sed, grep or a script in Bash). Stop that ' +
  'line of work and say in your report what was denied and why it was needed. The same goes for a ' +
  'tool you can\'t use: don\'t reach it another way, such as starting an MCP server yourself.'

// Auto mode (with the `autoMode: allow` option): SubagentHandback takes only the
// auto-mode classifier's approval, so the model reports in plain text instead and
// the plugin delivers that text itself.
export const AUTO_REPORT_RULE =
  '\n\nWhen your work is complete, write your full final report as your last message, in plain text, ' +
  'and make no further tool calls. Do not try to deliver it with a tool: it is delivered for you.'
export const HANDBACK_REMINDER = '[handback-send-enforce]'
// The plugin's own answer to those reminders; hidden in the transcript view
export const REMINDER_REPLY = 'My final report is my previous message; it is delivered for me.'
// Sent once, with the first reminder, to an auto-mode agent that reported
// without making a single tool call (a model can write a report of work it never did)
export const NO_TOOLS_NUDGE =
  'You have not made any tool calls in this run. If the task needs tools, do the work now with tool calls: ' +
  'a report that claims results you did not get from a tool is wrong. If the task truly needs no tools, ' +
  'reply with your final report again.'

const MODEL_LINE = /You are powered by the model named [^\n]*/
const HANDBACK_TEXT = /[^\n]*SubagentHandback[^\n]*/g
const PLAIN_REPORT = 'When your work is complete, write your full final report as your last message, in plain text. It is delivered for you; there is no tool to call for it.'

// What a native subagent's request would carry, adapted for an OpenRouter model:
// the model-identity reminder names the real model, media the model can't take
// becomes a note, and the end of the conversation is marked as a cache point.
export function adaptMessages(messages: Messages, agent: AgentDef, isAuto = false) {
  const identity = `You are powered by the model named ${agent.label}. The exact model ID is ${agent.model}, reached through OpenRouter.`
  const adaptBlock = (b: ApiBlock): ApiBlock => {
    if (b.type === 'text' && typeof b.text === 'string' && MODEL_LINE.test(b.text)) {
      return { ...b, text: b.text.replace(MODEL_LINE, identity) }
    }
    // In auto mode SubagentHandback is the classifier's alone; the engine's
    // reminders to call it would only send the model into refusals
    if (isAuto && b.type === 'text' && typeof b.text === 'string' && b.text.includes('SubagentHandback')) {
      return { ...b, text: b.text.replace(HANDBACK_TEXT, PLAIN_REPORT) }
    }
    if (b.type === 'image' && !agent.vision) {
      return { type: 'text', text: `[An image was here; ${agent.label} can't read images.]` }
    }
    if (b.type === 'document') {
      return { type: 'text', text: `[A document was here; it can't be passed to ${agent.label} through OpenRouter.]` }
    }
    // ToolSearch answers with tool_reference blocks, which only Anthropic's API
    // expands into schemas. Say plainly what loaded and what can't be used.
    if (b.type === 'tool_reference' && typeof b.tool_name === 'string') {
      return {
        type: 'text',
        text: TOOL_SCHEMAS[b.tool_name]
          ? `Loaded tool: ${b.tool_name}. It is available from your next step.`
          : `Tool ${b.tool_name} can't be used by this subagent: its input schema isn't available through OpenRouter. ` +
            `Don't reach it another way (for example by starting its server yourself); say in your report that you couldn't use it.`,
      }
    }
    if (b.type === 'tool_result' && Array.isArray(b.content)) {
      return { ...b, content: (b.content as ApiBlock[]).map(adaptBlock) }
    }
    return b
  }
  const out: ApiMsg[] = messages.map(m => ({ role: m.role, content: (m.content as ApiBlock[]).map(adaptBlock) }))
  const last = out.at(-1)?.content
  const i = last ? last.findLastIndex(b => b.type === 'text' || b.type === 'tool_result') : -1
  if (last && i >= 0) last[i] = { ...last[i]!, cache_control: { type: 'ephemeral' } }
  return out
}

// Adds the no-tool-calls nudge after the last user message's blocks
export function withNudge(messages: ApiMsg[]) {
  const last = messages.at(-1)
  if (last?.role === 'user') last.content.push({ type: 'text', text: NO_TOOLS_NUDGE })
  return messages
}

// Built-in tools ToolSearch loaded earlier in the conversation (as tool_reference
// blocks) that have a schema here; MCP tools never do (see adaptMessages)
function loadedTools(messages: Messages) {
  const names = new Set<string>()
  for (const m of messages) {
    for (const b of m.content as ApiBlock[]) {
      if (b.type !== 'tool_result' || !Array.isArray(b.content)) continue
      for (const c of b.content as ApiBlock[]) {
        if (c.type === 'tool_reference' && typeof c.tool_name === 'string' && TOOL_SCHEMAS[c.tool_name]) names.add(c.tool_name)
      }
    }
  }
  return [...names]
}

// The tools offered to the model: the session's built-ins that have a schema,
// built-ins ToolSearch loaded, and SubagentHandback when the engine gives it
export function toolsFor(session: readonly { name: string; description: string; mcp: boolean }[], messages: Messages, withHandback: boolean) {
  const direct: ToolDef[] = session
    .filter(t => !t.mcp && TOOL_SCHEMAS[t.name])
    .map(t => ({ name: t.name, description: t.description, input_schema: TOOL_SCHEMAS[t.name]! }))
  const offered = new Set(direct.map(t => t.name))
  const loaded: ToolDef[] = loadedTools(messages)
    .filter(name => !offered.has(name))
    .map(name => ({ name, description: session.find(t => t.name === name)?.description ?? name, input_schema: TOOL_SCHEMAS[name]! }))
  return withHandback ? [...direct, ...loaded, HANDBACK_TOOL] : [...direct, ...loaded]
}

// Claude Code gives a subagent SubagentHandback only in some sessions, and says
// so in a reminder
export function engineOffersHandback(messages: Messages) {
  return JSON.stringify(messages).includes('delivered through SubagentHandback')
}

// "Tool calls this run: Bash ×2, Write, Read (4)", from the calls the model asked for
export function toolSummary(names: readonly string[]) {
  if (!names.length) return 'Tool calls this run: none.'
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  return `Tool calls this run: ${parts.join(', ')} (${names.length}).`
}

// Claude Code takes tool-call ids of letters, digits, _ and - only; some providers
// (Kimi's) send others, and an id it refuses fails the whole step
export function safeToolId(id: string, index: number) {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '_')
  return clean || `toolu_openrouter_${index}`
}
