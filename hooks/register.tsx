import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepResult, TurnStepToolUse, TurnStopReason, TurnUsage } from 'claude-code'
import type { AgentRun } from '../types'
import { TOOL_SCHEMAS } from './schemas'

type AgentDef = {
  model: string
  label: string
  when: string
  // Whether the model takes images; refreshed from OpenRouter's model list at session start
  vision: boolean
  // Reasoning effort when the Agent call names none
  effort: string
  // OpenRouter providers to try first (others still serve as fallbacks)
  providers?: string[]
}

// Subagent types this mod answers, each pinned to one OpenRouter model. The
// Agent tool sees them as `openrouter-agents:<name>`. They are ordinary native
// subagents; only their model requests go to OpenRouter. Each model and effort
// can be changed in /plugin configure (`<name>Model`, `<name>Effort`).
const DEFAULT_AGENTS: Record<string, AgentDef> = {
  deepseek: {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    label: 'DeepSeek V4.1 Flash',
    vision: true,
    effort: 'medium',
    // These two cache prompts; unpinned, runs landed on a provider that didn't
    // (tested 2026-10-23: a cached second call cost ~1/12 of the first)
    providers: ['deepinfra', 'cloudflare'],
    when: 'Default OpenRouter subagent for delegated coding, research and multi-step tasks; cheap, fast, 1M context.',
  },
  kimi: {
    model: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    vision: true,
    // Its output costs ~$10.80 per million tokens, and reasoning is output
    effort: 'low',
    when: 'Use when the user asks for Kimi, or wants a second opinion from a different model family.',
  },
  glm: {
    model: 'z-ai/glm-5.2',
    label: 'GLM-5.2',
    vision: false,
    effort: 'medium',
    when: 'Use when the user asks for GLM, or for design and planning work.',
  },
  // Replaced qwen/qwen3.7-flash (one provider, Alibaba, which kept erroring):
  // 26 tool-capable endpoints, 5/5 on live tool-call tests, ZDR providers available
  cheap: {
    model: 'deepseek/deepseek-v4-flash-0731',
    label: 'DeepSeek V4 Flash',
    vision: false,
    effort: 'medium',
    when: 'Very low cost ($0.044/$0.133 per million tokens). Use when the user asks for the cheap agent, or for tests and simple tasks.',
  },
}

const OPENROUTER = 'https://openrouter.ai/api/v1'
// Output room beyond the reasoning budget
const ANSWER_TOKENS = 12000
// Reasoning budget per effort level
const THINKING_BUDGET: Record<string, number> = { low: 1024, medium: 4000, high: 8000, xhigh: 12000, max: 16000 }
// Waits before retrying a 429/5xx/network error that came before any output;
// a hook's sleeps count against its 10 s budget
const RETRY_WAITS_MS = [1000, 2000]
const CONTEXT_ERROR = /context (length|window)|too many tokens|prompt is too long|maximum context/i

// The engine tells every subagent to end its run with this tool, which it adds
// itself, so the request to OpenRouter has to offer it too.
const HANDBACK_TOOL = {
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

const SUBAGENT_PROMPT =
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
const AUTO_REPORT_RULE =
  '\n\nWhen your work is complete, write your full final report as your last message, in plain text, ' +
  'and make no further tool calls. Do not try to deliver it with a tool: it is delivered for you.'
const HANDBACK_REMINDER = '[handback-send-enforce]'
// The plugin's own answer to those reminders; hidden in the transcript view
const REMINDER_REPLY = 'My final report is my previous message; it is delivered for me.'
// Sent once, with the first reminder, to an auto-mode agent that reported
// without making a single tool call (a model can write a report of work it never did)
const NO_TOOLS_NUDGE =
  'You have not made any tool calls in this run. If the task needs tools, do the work now with tool calls: ' +
  'a report that claims results you did not get from a tool is wrong. If the task truly needs no tools, ' +
  'reply with your final report again.'

// One server-sent event of a streamed Messages API reply
type StreamEvent = {
  type: string
  index?: number
  message?: { model?: string; usage?: Record<string, unknown>; provider?: string }
  content_block?: { type: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string | null
  }
  usage?: Record<string, unknown>
  error?: { message?: string }
}

type ApiBlock = Record<string, unknown> & { type: string }
type ApiMsg = { role: string; content: ApiBlock[] }
type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> }

// Every run of our agents, by agentId: kept in session state, so a reload of the
// plugin mid-run keeps auto-mode delivery, the guards and the totals
const runsAtom = atom({ plugin: 'openrouter-agents', key: 'runs' } as const, {} as Record<string, AgentRun>, { shape: 'runs-1' })

const newRun = (name: string, isAuto: boolean, effort?: string): AgentRun => ({
  name,
  isAuto,
  ...(effort ? { effort } : {}),
  toolNames: [],
  deniedPaths: [],
  isNudged: false,
  steps: 0,
  usd: 0,
  providers: [],
})

const num = (v: unknown) => (typeof v === 'number' ? v : 0)
const usd = (v: number) => `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`

// Streamed usage arrives in pieces (message_start, then message_delta); keep the largest seen
function addUsage(into: Record<string, number>, from: Record<string, unknown> | undefined) {
  for (const k of Object.keys(into)) into[k] = Math.max(into[k] ?? 0, num(from?.[k]))
}

async function getRun($: EngineInterface, agentId: string): Promise<AgentRun | undefined> {
  return (await read($, runsAtom))[agentId]
}

async function patchRun($: EngineInterface, agentId: string, change: (run: AgentRun) => AgentRun) {
  await update($, runsAtom, runs => {
    const run = runs[agentId]
    return run ? { ...runs, [agentId]: change(run) } : runs
  })
}

// The run of one of our agents, created on first sight for one spawned before
// this code loaded (its type still names it); undefined for anyone else's agent
async function runOf($: EngineInterface, agents: Record<string, AgentDef>, agentId: string) {
  const run = await getRun($, agentId)
  if (run) return run
  const info = (await $.agent.list()).find(a => a.id === agentId)
  const prefix = `${$.plugin.name}:`
  const name = info?.type.startsWith(prefix) ? info.type.slice(prefix.length) : ''
  if (!agents[name]) return undefined
  const created = newRun(name, false)
  await update($, runsAtom, runs => (runs[agentId] ? runs : { ...runs, [agentId]: created }))
  return (await getRun($, agentId)) ?? created
}

const MODEL_LINE = /You are powered by the model named [^\n]*/
const HANDBACK_TEXT = /[^\n]*SubagentHandback[^\n]*/g
const PLAIN_REPORT = 'When your work is complete, write your full final report as your last message, in plain text. It is delivered for you; there is no tool to call for it.'

// What a native subagent's request would carry, adapted for an OpenRouter model:
// the model-identity reminder names the real model, media the model can't take
// becomes a note, and the end of the conversation is marked as a cache point.
function adaptMessages(messages: readonly { role: string; content: readonly unknown[] }[], agent: AgentDef, isAuto = false) {
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

// "Tool calls this run: Bash ×2, Write, Read (4)", from the calls the model asked for
function toolSummary(names: readonly string[]) {
  if (!names.length) return 'Tool calls this run: none.'
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  const parts = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
  return `Tool calls this run: ${parts.join(', ')} (${names.length}).`
}

// A refused file tool call (permission, not a tool error like a missing file)
const REFUSAL = /permission|haven't granted|denied|not allowed|rejected|classifier/i
const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', Read: 'file_path', NotebookEdit: 'notebook_path' }

// An absolute, normalized path: `~` is home, a relative path is taken from `base`
function normalizePath(path: string, base: string, home: string) {
  let p = path
  if (home && (p === '~' || p.startsWith('~/'))) p = home + p.slice(1)
  if (!p.startsWith('/')) p = `${base.replace(/\/+$/, '')}/${p}`
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// The paths a shell command may name: each word that looks like a path, taken
// from the session's folder and from any folder the command `cd`s into
function pathsInCommand(command: string, cwd: string, home: string) {
  const bases = [cwd, ...[...command.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)].map(m => normalizePath(m[1]!.replace(/^["']|["']$/g, ''), cwd, home))]
  const words = command.split(/[\s'"`;|&<>()=]+/).filter(w => w && (w.includes('/') || w.includes('.') || w.startsWith('~')))
  return new Set(words.flatMap(w => bases.map(b => normalizePath(w, b, home))))
}

// Adds the no-tool-calls nudge after the last user message's blocks
function withNudge(messages: ApiMsg[]) {
  const last = messages.at(-1)
  if (last?.role === 'user') last.content.push({ type: 'text', text: NO_TOOLS_NUDGE })
  return messages
}

// Built-in tools ToolSearch loaded earlier in the conversation (as tool_reference
// blocks) that have a schema here; MCP tools never do (see adaptMessages)
function loadedTools(messages: readonly { role: string; content: readonly unknown[] }[]) {
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

// Claude Code takes tool-call ids of letters, digits, _ and - only; some providers
// (Kimi's) send others, and an id it refuses fails the whole step
function safeToolId(id: string, index: number) {
  const clean = id.replace(/[^A-Za-z0-9_-]/g, '_')
  return clean || `toolu_openrouter_${index}`
}

// The agents as configured: each default with its model and effort options
// applied, plus the free `custom` slot when it names a model
function configuredAgents(options: Readonly<Record<string, unknown>>) {
  const opt = (key: string) => (typeof options[key] === 'string' ? (options[key] as string).trim() : '')
  const agents: Record<string, AgentDef> = {}
  for (const [name, def] of Object.entries(DEFAULT_AGENTS)) {
    const model = opt(`${name}Model`) || def.model
    agents[name] = {
      ...def,
      model,
      effort: opt(`${name}Effort`) || def.effort,
      // A model other than the default gets no pinned providers and a generic label
      ...(model === def.model ? {} : { label: model, providers: undefined }),
    }
  }
  const customModel = opt('customModel')
  if (customModel) {
    const label = opt('customLabel') || customModel
    agents.custom = {
      model: customModel,
      label,
      vision: true,
      effort: opt('customEffort') || 'medium',
      when: `Use when the user asks for ${label}, or for the custom agent.`,
    }
  }
  return agents
}

export const register: Register = (on, options) => {
  const lowBalanceUsd = Number(options.lowBalanceUsd ?? 5)
  const autoMode = String(options.autoMode ?? 'refuse')
  const agents = configuredAgents(options)
  // The session's folder and home, for the path guard (set again on a reload's session.start)
  let cwd = ''
  let home = ''
  // The agent whose transcript is on screen (from AbovePrompt's `view`), for the model notice
  let viewed: string | undefined
  // Agent tool_use_id -> the effort the call named, until its spawn picks it up
  const pendingEffort = new Map<string, string>()
  // `${turnId}:${step}` -> highest content block index yielded, for the error handler
  const lastBlock = new Map<string, number>()

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    home = (await $.env.get('HOME')) ?? ''
    for (const [name, a] of Object.entries(agents)) {
      await $.agent.register({
        name,
        description: `Subagent on ${a.label} via OpenRouter. ${a.when}`,
        // No `tools`: Claude Code grants the native subagent tool pool
        prompt: SUBAGENT_PROMPT,
      })
    }

    // In the background, so a slow OpenRouter never holds up the session: check the
    // configured models exist and whether they take images, and the balance
    void (async () => {
      const key = await $.env.get('OPENROUTER_API_KEY')
      if (!key) return
      const headers = { authorization: `Bearer ${key}` }
      const [models, credits, keyInfo] = await Promise.all([
        $.http.fetch(`${OPENROUTER}/models`, { headers }),
        $.http.fetch(`${OPENROUTER}/credits`, { headers }),
        $.http.fetch(`${OPENROUTER}/key`, { headers }),
      ])
      if (models.ok) {
        const listed = new Map(
          (JSON.parse(models.text).data as { id: string; architecture?: { input_modalities?: string[] } }[]).map(m => [m.id, m]),
        )
        const missing: string[] = []
        for (const [name, a] of Object.entries(agents)) {
          const m = listed.get(a.model)
          if (!m) missing.push(`${name} (${a.model})`)
          else if (m.architecture?.input_modalities) a.vision = m.architecture.input_modalities.includes('image')
        }
        if (missing.length) $.ui.toast(`OpenRouter has no model for: ${missing.join(', ')}. Check /plugin configure.`)
      }
      if (!(lowBalanceUsd > 0)) return
      const c = credits.ok ? JSON.parse(credits.text).data : undefined
      const k = keyInfo.ok ? JSON.parse(keyInfo.text).data : undefined
      const left = [
        c ? num(c.total_credits) - num(c.total_usage) : undefined,
        typeof k?.limit_remaining === 'number' ? k.limit_remaining : undefined,
      ].filter((v): v is number => v !== undefined)
      if (!left.length) return
      const remaining = Math.min(...left)
      if (remaining < lowBalanceUsd) {
        $.ui.toast(`OpenRouter balance is low: ${usd(remaining)} left. OpenRouter subagents may fail with 429s.`)
      }
    })().catch(() => {})

    return started
  })

  // Hooks below that only add to an event fail open (`.catch(... => next(e))`):
  // a state read that fails lets the spawn, notice or tool call go on as usual.

  // Auto mode's safety check runs server-side on Anthropic's responses. Steps
  // OpenRouter answered carry no verdict, so it refuses every tool call these
  // agents make, prompts included. By default refuse the spawn; with
  // `autoMode: allow` run them unreviewed (see tool.check and the report hooks).
  on('agent.spawn', async ($, e, next) => {
    const name = e.subagentType.startsWith(`${$.plugin.name}:`) ? e.subagentType.slice($.plugin.name.length + 1) : ''
    const agent = agents[name]
    const isAuto = agent !== undefined && e.permissionMode === 'auto'
    if (isAuto && autoMode !== 'allow') {
      return {
        deny:
          `${e.subagentType} can't run in auto mode: auto mode's safety check runs on Anthropic's side and refuses every ` +
          `tool call an OpenRouter subagent makes. Ask the user to switch to manual mode (or accept-edits) with Shift+Tab, ` +
          `or to set the openrouter-agents option autoMode to "allow" (/plugin configure), then try again.`,
      }
    }
    // Naming the OpenRouter model makes Claude Code label the subagent and its
    // messages with it. No request goes out under that name: turn.step answers them all.
    const spawned = await next(agent ? { ...e, model: agent.model } : e)
    if (agent && 'agentId' in spawned && spawned.agentId) {
      const effort = pendingEffort.get(e.tool_use_id)
      pendingEffort.delete(e.tool_use_id)
      const id = spawned.agentId
      await update($, runsAtom, runs => ({ ...runs, [id]: newRun(name, isAuto, effort) }))
    }
    return spawned
  }).catch(($, e, next) => next(e))

  // In auto mode, what the classifier would have reviewed is allowed. Deny rules
  // and anything core decides outright still stand.
  on('tool.check', async ($, e, next) => {
    const run = e.agentId !== undefined ? await runOf($, agents, e.agentId) : undefined
    // In auto mode the labelled report is the only way results reach the main
    // session; SendMessage would carry them there unlabelled
    if (run?.isAuto && e.tool === 'SendMessage') {
      return { decision: 'deny' as const, reason: 'SendMessage is off for OpenRouter subagents in auto mode. Put everything in your final report.' }
    }
    // A path a file tool was refused for stays off limits through Bash too,
    // however the command spells it (relative, ~/…, after a cd)
    if (run && run.deniedPaths.length && e.tool === 'Bash') {
      const command = String((e.input as { command?: unknown } | undefined)?.command ?? '')
      const named = pathsInCommand(command, cwd, home)
      const hit = run.deniedPaths.find(path => named.has(path) || command.includes(path))
      if (hit) {
        return { decision: 'deny' as const, reason: `${hit} was refused to a file tool earlier in this run; reaching it through Bash isn't allowed either. Say in your report what was refused.` }
      }
    }
    const verdict = await next(e)
    if (!run?.isAuto || verdict.decision !== 'ask') return verdict
    return { decision: 'allow' as const, reason: `${$.plugin.name}: auto mode can't review OpenRouter subagents; allowed unreviewed (autoMode: allow)` }
  }).catch(($, e, next) => (next.called ? next(e) : { decision: 'deny' as const, reason: 'openrouter-agents: permission check failed' }))

  // Deliver an auto-mode agent's report: the completion notice for a background
  // run, and the Agent tool's result for a foreground one, say no report came.
  const reportFor = (run: AgentRun) => {
    const label = agents[run.name]?.label ?? 'OpenRouter subagent'
    return `[Report from ${label} via OpenRouter, delivered by the openrouter-agents plugin. Auto mode did not review this report or the work behind it. ${toolSummary(run.toolNames)}]\n\n${run.report}`
  }

  on('prompt.submit', async ($, e, next) => {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(e.text)?.[1]
    if (!id || !e.text.includes('<result>')) return next(e)
    const run = await getRun($, id)
    if (!run?.isAuto || run.report === undefined) return next(e)
    const text = reportFor(run)
    await patchRun($, id, r => ({ ...r, report: undefined }))
    return next({ ...e, text: e.text.replace(/<result>[\s\S]*?<\/result>/, () => `<result>${text}</result>`) })
  }).catch(($, e, next) => next(e))

  // Record paths a file tool was refused for, as absolute paths
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    const key = FILE_TOOLS[e.tool]
    if (!key || e.agentId === undefined) return r
    const refused = r.deny !== undefined || (r.isError === true && REFUSAL.test(r.text ?? ''))
    const path = (e as unknown as Record<string, unknown>)[key]
    if (!refused || typeof path !== 'string' || !path) return r
    if (!(await runOf($, agents, e.agentId))) return r
    const absolute = normalizePath(path, cwd, home)
    await patchRun($, e.agentId, run => (run.deniedPaths.includes(absolute) ? run : { ...run, deniedPaths: [...run.deniedPaths, absolute] }))
    return r
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    // The spawn doesn't carry the call's effort; hand it over by the call's id
    const named = e.subagent_type?.startsWith(`${$.plugin.name}:`) ? e.subagent_type.slice($.plugin.name.length + 1) : ''
    if (agents[named] && e.effort) pendingEffort.set(e.tool_use_id, e.effort)
    const r = await next(e)
    pendingEffort.delete(e.tool_use_id)
    const result = r.result as { status?: string; agentId?: string; content?: unknown } | undefined
    if (r.deny !== undefined || r.isError || result?.status !== 'completed' || !result.agentId) return r
    const run = await getRun($, result.agentId)
    if (!run?.isAuto || run.report === undefined) return r
    const text = reportFor(run)
    await patchRun($, result.agentId, x => ({ ...x, report: undefined }))
    return { result: { ...result, content: [{ type: 'text' as const, text }] } as typeof r.result }
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) return yield* next(e)
    const agentId = e.agentId
    const run = await runOf($, agents, agentId)
    const agent = run ? agents[run.name] : undefined
    if (!run || !agent) return yield* next(e)
    const owner = run.name
    const stepKey = `${e.turnId}:${e.index}`
    const providers = new Set(run.providers)
    let stepCost = 0

    const showStatus = (what: string) =>
      $.ui.status(`${owner} · ${agent.label}: ${what} · ${run.steps} step${run.steps === 1 ? '' : 's'} · ${usd(run.usd + stepCost)}`)

    const done = (answer: string, stopReason: TurnStopReason, usage: TurnUsage | null, toolUses: TurnStepToolUse[] = []): TurnStepResult =>
      ({ turnId: e.turnId, index: e.index, answer, toolUses, stopReason, usage })

    // An answer the engine records as the subagent's reply
    async function* fail(why: string, stopReason: TurnStopReason = 'end_turn') {
      const text = `[${owner} via OpenRouter failed: ${why}]`
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason, usage: null }
      return done(text, stopReason, null)
    }

    const isAuto = run.isAuto
    const key = await $.env.get('OPENROUTER_API_KEY')
    if (!key) return yield* fail('OPENROUTER_API_KEY is not set in the environment claude started from')

    const messages = await $.session.messages({ agentId, as: 'api' })
    if (!Array.isArray(messages)) return yield* fail(messages.deny)

    // In auto mode the engine keeps asking for a SubagentHandback the classifier
    // would have to approve. The report is already kept; answer without a request.
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const isReminder = isAuto && run.report !== undefined && JSON.stringify(lastUser?.content ?? '').includes(HANDBACK_REMINDER)
    // A report with no tool calls behind it gets one chance to do the work first
    const nudge = isReminder && !run.toolNames.length && !run.isNudged
    if (nudge) await patchRun($, agentId, r => ({ ...r, isNudged: true, report: undefined }))
    if (isReminder && !nudge) {
      const text = REMINDER_REPLY
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return done(text, 'end_turn', null)
    }

    const session = await $.tool.list()
    const direct: ToolDef[] = session
      .filter(t => !t.mcp && TOOL_SCHEMAS[t.name])
      .map(t => ({ name: t.name, description: t.description, input_schema: TOOL_SCHEMAS[t.name]! }))
    const offered = new Set(direct.map(t => t.name))
    const loaded: ToolDef[] = loadedTools(messages)
      .filter(name => !offered.has(name))
      .map(name => ({ name, description: session.find(t => t.name === name)?.description ?? name, input_schema: TOOL_SCHEMAS[name]! }))
    // Claude Code gives a subagent SubagentHandback only in some sessions, and says so
    // in a reminder; offer it exactly then (never in auto mode, where only the
    // classifier may allow it)
    const engineOffersHandback = JSON.stringify(messages).includes('delivered through SubagentHandback')
    const tools = !isAuto && engineOffersHandback ? [...direct, ...loaded, HANDBACK_TOOL] : [...direct, ...loaded]
    // Environment, date, CLAUDE.md and the rest arrive in the messages, as for a
    // native subagent; the system prompt is the agent definition's own.
    // Tools come before it in the cached prefix, so its mark covers them too.
    // (A mark on a tool itself made DeepSeek's provider drop that tool.)
    const system = [{ type: 'text', text: SUBAGENT_PROMPT + (isAuto ? AUTO_REPORT_RULE : ''), cache_control: { type: 'ephemeral' } }]
    // The Agent call's own effort, else the agent's configured one
    const effort = run.effort ?? agent.effort
    const budget = THINKING_BUDGET[effort] ?? THINKING_BUDGET.medium!
    const body = JSON.stringify({
      model: agent.model,
      ...(agent.providers ? { provider: { order: agent.providers, allow_fallbacks: true } } : {}),
      max_tokens: budget + ANSWER_TOKENS,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: budget },
      system,
      messages: nudge ? withNudge(adaptMessages(messages, agent, isAuto)) : adaptMessages(messages, agent, isAuto),
      tools,
    })

    let answer = ''
    let stopReason: TurnStopReason = null
    let replyModel = agent.model
    const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const toolUses: TurnStepToolUse[] = []
    // Per content block: its tool call (if any) and the argument JSON so far
    const blocks = new Map<number, { tool?: { id: string; name: string }; json: string; handback?: true }>()
    let handbackReport: string | undefined
    let yielded = false

    showStatus(`step ${e.index + 1}`)
    try {
      for (let attempt = 0; ; attempt++) {
        // curl streams the SSE reply; $.http.fetch returns only whole bodies and
        // gives up after 30 s. The key goes in through the environment, not argv.
        const child = $.process.spawn({
          argv: [
            'curl', '-sSN', '--variable', '%OR_KEY',
            '--expand-header', 'authorization: Bearer {{OR_KEY}}',
            '-H', 'content-type: application/json',
            '-H', 'anthropic-version: 2023-06-01',
            '--data-binary', '@-',
            '-w', '\n__STATUS__%{http_code}\n',
            `${OPENROUTER}/messages`,
          ],
          env: { OR_KEY: key },
          input: body,
        })

        let buffer = ''
        let status = 0
        let errorText = ''
        let sawStream = false

        const events: StreamEvent[] = []
        const take = (line: string) => {
          if (line.startsWith('data: ')) {
            try {
              events.push(JSON.parse(line.slice(6)) as StreamEvent)
              sawStream = true
            } catch {
              errorText += line
            }
          } else if (line.startsWith('__STATUS__')) {
            status = Number(line.slice(10))
          } else if (line.trim() && !line.startsWith('event: ') && !line.startsWith(':')) {
            errorText += line
          }
        }

        for await (const chunk of child) {
          if (next.signal.aborted) break
          if (chunk.stream === 'stderr') {
            errorText += chunk.text
            continue
          }
          buffer += chunk.text
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          lines.forEach(take)

          for (const ev of events.splice(0)) {
            if (ev.type === 'message_start') {
              replyModel = ev.message?.model ?? replyModel
              if (ev.message?.provider) providers.add(ev.message.provider)
              addUsage(usage, ev.message?.usage)
            } else if (ev.type === 'content_block_start' && ev.index !== undefined) {
              const cb = ev.content_block
              lastBlock.set(stepKey, Math.max(lastBlock.get(stepKey) ?? -1, ev.index))
              if (isAuto && cb?.type === 'tool_use' && cb.name === HANDBACK_TOOL.name) {
                // Never reaches the classifier: its message is kept as the report
                blocks.set(ev.index, { json: '', handback: true })
              } else if (cb?.type === 'tool_use' && cb.id && cb.name) {
                const id = safeToolId(cb.id, ev.index)
                blocks.set(ev.index, { tool: { id, name: cb.name }, json: '' })
                yielded = true
                yield { kind: 'tool' as const, index: ev.index, id, name: cb.name }
              } else {
                blocks.set(ev.index, { json: '' })
              }
            } else if (ev.type === 'content_block_delta' && ev.index !== undefined) {
              const d = ev.delta
              if (d?.type === 'text_delta' && d.text) {
                answer += d.text
                yielded = true
                yield { kind: 'text' as const, index: ev.index, text: d.text }
              } else if (d?.type === 'thinking_delta' && d.thinking) {
                yielded = true
                yield { kind: 'thinking' as const, index: ev.index, text: d.thinking }
              } else if (d?.type === 'input_json_delta' && d.partial_json) {
                const b = blocks.get(ev.index)
                if (b?.handback) b.json += d.partial_json
                else if (b?.tool) {
                  b.json += d.partial_json
                  yield { kind: 'input' as const, index: ev.index, json: d.partial_json }
                }
              }
            } else if (ev.type === 'content_block_stop' && ev.index !== undefined) {
              const b = blocks.get(ev.index)
              if (b?.handback) {
                let message = ''
                try {
                  message = String((JSON.parse(b.json || '{}') as { message?: unknown }).message ?? '')
                } catch {}
                if (message.trim()) {
                  handbackReport = message.trim()
                  answer += message
                  yielded = true
                  yield { kind: 'text' as const, index: ev.index, text: message }
                }
              } else if (b?.tool) {
                if (!b.json) {
                  b.json = '{}'
                  yield { kind: 'input' as const, index: ev.index, json: '{}' }
                }
                let input: unknown = {}
                try {
                  input = JSON.parse(b.json)
                } catch {}
                toolUses.push({ name: b.tool.name, input })
              }
            } else if (ev.type === 'message_delta') {
              stopReason = (ev.delta?.stop_reason ?? stopReason) as TurnStopReason
              addUsage(usage, ev.usage)
              stepCost = Math.max(stepCost, num(ev.usage?.cost))
            } else if (ev.type === 'error') {
              errorText += ev.error?.message ?? 'stream error'
            }
          }
        }
        if (buffer) take(buffer)

        if (next.signal.aborted) return yield* fail('interrupted')
        if (CONTEXT_ERROR.test(errorText) && !yielded) {
          return yield* fail(`the conversation is too long for ${agent.model}`, 'model_context_window_exceeded')
        }
        const failed = status >= 400 || !sawStream || (errorText !== '' && stopReason === null)
        if (!failed) break
        if (yielded) {
          // Cut off mid-reply: keep what arrived and let the run go on. A tool call
          // whose arguments never finished fails like a model's broken JSON would,
          // and the next step sees that error.
          const note = `\n\n[OpenRouter stream ended early: ${errorText.slice(0, 200) || `HTTP ${status || '?'}`}]`
          answer += note
          yield { kind: 'text' as const, index: Math.max(-1, ...blocks.keys()) + 1, text: note }
          break
        }
        // An error event inside a 200 stream ("Provider returned error") is the
        // upstream provider failing; retry it like a 5xx when nothing was shown yet
        const inStreamError = status === 200 && errorText !== '' && stopReason === null
        const retryable = (status === 0 || status === 429 || status >= 500 || inStreamError) && attempt < RETRY_WAITS_MS.length
        if (!retryable) return yield* fail(`HTTP ${status || '?'}: ${errorText.slice(0, 300) || 'no reply'}`)
        showStatus(`retrying after HTTP ${status || 'network error'}`)
        await $.clock.sleep(RETRY_WAITS_MS[attempt] ?? 1000)
      }
    } catch (err) {
      return yield* fail(String(err).slice(0, 300))
    } finally {
      await patchRun($, agentId, r => ({ ...r, steps: r.steps + 1, usd: r.usd + stepCost, providers: [...providers] }))
      $.ui.status(`${owner} · ${agent.label}: waiting on tools · ${run.steps + 1} step${run.steps === 0 ? '' : 's'} · ${usd(run.usd + stepCost)}`)
    }

    const turnUsage: TurnUsage = { ...usage, model: replyModel }
    stopReason ??= toolUses.length ? 'tool_use' : 'end_turn'
    const report = isAuto ? (handbackReport ?? (!toolUses.length && answer.trim() ? answer.trim() : undefined)) : undefined
    await patchRun($, agentId, r => ({
      ...r,
      toolNames: [...r.toolNames, ...toolUses.map(t => t.name)],
      ...(report !== undefined ? { report } : {}),
    }))
    lastBlock.delete(stepKey)
    yield { kind: 'stop' as const, stopReason, usage: turnUsage }
    return done(answer, stopReason, turnUsage, toolUses)
  }).catch(async function* ($, e, next) {
    // Without this, a failed step is finished by the engine's own model (the
    // session's Opus) without a word. For our agents, end the step with the error.
    const run = e.agentId !== undefined ? await getRun($, e.agentId) : undefined
    if (!run || !agents[run.name]) return yield* next(e)
    const stepKey = `${e.turnId}:${e.index}`
    const index = (lastBlock.get(stepKey) ?? -1) + 1
    lastBlock.delete(stepKey)
    const text = `[${run.name} via OpenRouter: this step failed inside the openrouter-agents plugin. Stop and report what you have.]`
    yield { kind: 'text' as const, index, text }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  // A subagent's run ends: put its OpenRouter total in the transcript
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const run = e.agentId !== undefined ? await getRun($, e.agentId) : undefined
    if (run && run.steps > 0) {
      $.ui.status(undefined)
      const served = run.providers.length ? ` (served by ${run.providers.join(', ')})` : ''
      $.ui.log(`${run.name} · ${agents[run.name]?.label ?? ''} via OpenRouter${served}: ${run.steps} steps, ${usd(run.usd)}`)
    }
    return result
  })

  // Opening one of our agents' transcripts shows the session's model in the
  // header notice. Name the real one there and in the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = e.props.view.agentId
    if (id !== viewed) {
      viewed = id
      $.ui.invalidate('ui.render')
    }
    const run = id !== undefined ? (await read($, runsAtom))[id] : undefined
    const agent = run ? agents[run.name] : undefined
    if (!run || !agent) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>
          {run.name} · {agent.label} ({agent.model}) via OpenRouter
        </Text>
      </Box>
    )
  })

  // Claude Code sends up to three "report not delivered" reminders to an auto-mode
  // agent; the plugin answers each itself. Don't draw those answers.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.text.trim() !== REMINDER_REPLY) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    const run = viewed !== undefined ? (await read($, runsAtom))[viewed] : undefined
    const agent = run ? agents[run.name] : undefined
    if (!agent || !/^Using .+ \(from /.test(e.props.text)) return next(e)
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Using {agent.label} ({agent.model}) via OpenRouter · this subagent</Text>
  })

  on('session.end', async ($, e, next) => {
    pendingEffort.clear()
    lastBlock.clear()
    return next(e)
  })
}
