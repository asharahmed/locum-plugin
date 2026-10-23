import type { Register, TurnStepResult, TurnStepToolUse, TurnStopReason, TurnUsage } from 'claude-code'
import type { AgentRun } from '../types'
import type { AgentDef } from './agents'
import { agentName, fallbackModelFor, readSettings } from './agents'
import { FILE_TOOLS, REFUSAL, normalizePath, refusedPathIn } from './guard'
import {
  AUTO_REPORT_RULE,
  HANDBACK_REMINDER,
  HANDBACK_TOOL,
  REMINDER_REPLY,
  SUBAGENT_PROMPT,
  adaptMessages,
  engineOffersHandback,
  toolSummary,
  toolsFor,
  withNudge,
} from './messages'
import type { StepOutcome } from './openrouter'
import { balanceOf, streamStep } from './openrouter'
import { allRuns, getRun, newRun, patchRun, putRun, runOf, sessionUsd } from './state'

// Reasoning budget per effort level; the answer gets ANSWER_TOKENS beyond it
const THINKING_BUDGET: Record<string, number> = { low: 1024, medium: 4000, high: 8000, xhigh: 12000, max: 16000 }
const ANSWER_TOKENS = 12000
const TOP_UP = 'https://openrouter.ai/settings/credits'

const usd = (v: number) => (v === 0 ? '$0.00' : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`)

export const register: Register = (on, options) => {
  const settings = readSettings(options)
  const { agents } = settings
  // The session's folder and home, for the path guard (set again on a reload's session.start)
  let cwd = ''
  let home = ''
  // The agent whose transcript is on screen (from AbovePrompt's `view`), for the model notice
  let viewed: string | undefined
  // Agent tool_use_id -> the effort the call named, until its spawn picks it up
  const pendingEffort = new Map<string, string>()
  // `${turnId}:${step}` -> highest content block index yielded, for the error handler
  const lastBlock = new Map<string, number>()

  // The model a failing step moves to: never the agent's own, never a Claude model
  const fallbackFor = (agent: AgentDef): AgentDef => {
    const model = fallbackModelFor(agent.model, settings.fallbackModel)
    return { ...agent, model, label: model, vision: false, providers: undefined }
  }

  // The OpenRouter request for one step
  const requestBody = (agent: AgentDef, messages: unknown[], tools: unknown[], effort: string, isAuto: boolean) => {
    const budget = THINKING_BUDGET[effort] ?? THINKING_BUDGET.medium!
    const provider = { ...(agent.providers ? { order: agent.providers, allow_fallbacks: true } : {}), ...settings.privacyPrefs }
    return {
      model: agent.model,
      ...(Object.keys(provider).length ? { provider } : {}),
      max_tokens: budget + ANSWER_TOKENS,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: budget },
      // Environment, date, CLAUDE.md and the rest arrive in the messages, as for a
      // native subagent; the system prompt is the agent definition's own. Tools
      // come before it in the cached prefix, so its mark covers them too. (A mark
      // on a tool itself made DeepSeek's provider drop that tool.)
      system: [{ type: 'text', text: SUBAGENT_PROMPT + (isAuto ? AUTO_REPORT_RULE : ''), cache_control: { type: 'ephemeral' } }],
      messages,
      tools,
    }
  }

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
    await $.command.register({ name: 'openrouter', description: "OpenRouter subagents: balance, agents, settings and this session's runs" })

    // In the background, so a slow OpenRouter never holds up the session: check the
    // configured models exist and whether they take images, and the balance
    void (async () => {
      const key = await $.env.get('OPENROUTER_API_KEY')
      if (!key) return
      const models = await $.http.fetch('https://openrouter.ai/api/v1/models', { headers: { authorization: `Bearer ${key}` } })
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
        if (!listed.has(settings.fallbackModel)) missing.push(`fallbackModel (${settings.fallbackModel})`)
        if (missing.length) $.ui.toast(`OpenRouter has no model for: ${missing.join(', ')}. Check /plugin configure.`)
      }
      if (!(settings.lowBalanceUsd > 0)) return
      const { account, keyLeft } = await balanceOf($, key)
      const left = [account, keyLeft].filter((v): v is number => v !== undefined)
      if (left.length && Math.min(...left) < settings.lowBalanceUsd) {
        $.ui.toast(`OpenRouter balance is low: ${usd(Math.min(...left))} left. OpenRouter subagents may fail. Top up at ${TOP_UP}`)
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
    const name = agentName(e.subagentType, $.plugin.name)
    const agent = agents[name]
    if (!agent) return next(e)
    const isAuto = e.permissionMode === 'auto'
    if (isAuto && settings.autoMode !== 'allow') {
      return {
        deny:
          `${e.subagentType} can't run in auto mode: auto mode's safety check runs on Anthropic's side and refuses every ` +
          `tool call an OpenRouter subagent makes. Ask the user to switch to manual mode (or accept-edits) with Shift+Tab, ` +
          `or to set the openrouter-agents option autoMode to "allow" (/plugin configure), then try again.`,
      }
    }
    if (settings.maxSessionUsd > 0) {
      const spent = await sessionUsd($)
      if (spent >= settings.maxSessionUsd) {
        return {
          deny:
            `OpenRouter subagents have spent ${usd(spent)} this session, at the ${usd(settings.maxSessionUsd)} session cap. ` +
            `Ask the user whether to raise maxSessionUsd in /plugin configure.`,
        }
      }
    }
    // Naming the OpenRouter model makes Claude Code label the subagent and its
    // messages with it. No request goes out under that name: turn.step answers them all.
    const spawned = await next({ ...e, model: agent.model })
    if ('agentId' in spawned && spawned.agentId) {
      const effort = pendingEffort.get(e.tool_use_id)
      pendingEffort.delete(e.tool_use_id)
      await putRun($, spawned.agentId, newRun(name, agent.model, isAuto, await $.clock.now(), effort))
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
    if (run && e.tool === 'Bash') {
      const command = String((e.input as { command?: unknown } | undefined)?.command ?? '')
      const hit = refusedPathIn(command, run.deniedPaths, cwd, home)
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
    const fellBack = run.fallbackSteps ? ` ${run.fallbackSteps} step(s) ran on the fallback model.` : ''
    return `[Report from ${label} via OpenRouter, delivered by the openrouter-agents plugin. Auto mode did not review this report or the work behind it. ${toolSummary(run.toolNames)}${fellBack}]\n\n${run.report}`
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
    if (agents[agentName(e.subagent_type, $.plugin.name)] && e.effort) pendingEffort.set(e.tool_use_id, e.effort)
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
    if (!run) return yield* next(e)
    const agent = agents[run.name]
    // A run of an agent the settings no longer have (the custom slot cleared, say)
    // must not carry on on the session's own model
    if (!agent) {
      const text = `[${run.name} via OpenRouter: this agent is no longer configured (check /plugin configure), so the run stops here.]`
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }
    const owner = run.name
    const stepKey = `${e.turnId}:${e.index}`
    const isAuto = run.isAuto
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

    const withHandback = !isAuto && engineOffersHandback(messages)

    // Over the run's or the session's spend cap, the run ends here, with a report saying so
    const spentSession = settings.maxSessionUsd > 0 ? await sessionUsd($) : 0
    const capped =
      settings.maxRunUsd > 0 && run.usd >= settings.maxRunUsd
        ? `this run reached the openrouter-agents spend cap of ${usd(settings.maxRunUsd)} per run (spent ${usd(run.usd)} over ${run.steps} steps). Raise maxRunUsd`
        : settings.maxSessionUsd > 0 && spentSession >= settings.maxSessionUsd
          ? `OpenRouter subagents reached the ${usd(settings.maxSessionUsd)} session cap (spent ${usd(spentSession)} this session). Raise maxSessionUsd`
          : undefined
    if (capped) {
      const text = `Stopped: ${capped} in /plugin configure to allow more. The work above is as far as it got.`
      if (withHandback) {
        yield { kind: 'tool' as const, index: 0, id: `toolu_openrouter_cap_${e.index}`, name: HANDBACK_TOOL.name }
        yield { kind: 'input' as const, index: 0, json: JSON.stringify({ message: text }) }
        yield { kind: 'stop' as const, stopReason: 'tool_use' as const, usage: null }
        return done('', 'tool_use', null, [{ name: HANDBACK_TOOL.name, input: { message: text } }])
      }
      if (isAuto) await patchRun($, agentId, r => ({ ...r, report: text }))
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return done(text, 'end_turn', null)
    }

    const tools = toolsFor(await $.tool.list(), messages, withHandback)
    // The Agent call's own effort, else the agent's configured one
    const effort = run.effort ?? agent.effort
    const request = (a: AgentDef) => {
      const adapted = adaptMessages(messages, a, isAuto)
      return streamStep($, {
        key,
        body: requestBody(a, nudge ? withNudge(adapted) : adapted, tools, effort, isAuto),
        isAuto,
        signal: next.signal,
        onBlock: index => lastBlock.set(stepKey, Math.max(lastBlock.get(stepKey) ?? -1, index)),
        onRetry: why => showStatus(`retrying after ${why}`),
      })
    }

    showStatus(`step ${e.index + 1}`)
    let outcome: StepOutcome
    let usedFallback = false
    const providers = new Set(run.providers)
    try {
      outcome = yield* request(agent)
      stepCost += outcome.cost
      if (outcome.provider) providers.add(outcome.provider)
      // A step its own model can't answer moves to the fallback model, once
      const first = outcome.failure
      if (first && !outcome.yielded && (first.kind === 'retryable' || first.kind === 'other' || first.kind === 'creditCheck')) {
        const fallback = fallbackFor(agent)
        showStatus(`${agent.model} failing; trying ${fallback.model}`)
        const second = yield* request(fallback)
        stepCost += second.cost
        if (second.provider) providers.add(second.provider)
        if (!second.failure) {
          usedFallback = true
          $.ui.log(`${owner}: step ${e.index + 1} answered by fallback ${fallback.model} after ${agent.model} failed (${first.message.slice(0, 80)})`)
          outcome = second
        } else {
          outcome = { ...second, failure: { ...second.failure, message: `${first.message}; fallback ${fallback.model}: ${second.failure.message}` } }
        }
      }
    } catch (err) {
      return yield* fail(String(err).slice(0, 300))
    } finally {
      await patchRun($, agentId, r => ({
        ...r,
        steps: r.steps + 1,
        usd: r.usd + stepCost,
        providers: [...providers],
        fallbackSteps: r.fallbackSteps + (usedFallback ? 1 : 0),
      }))
    }
    // What the run does next: its tools run, or it is finishing
    const waiting = outcome.failure ? 'stopped' : outcome.toolUses.length ? 'running tools' : 'finishing'
    $.ui.status(`${owner} · ${agent.label}: ${waiting} · ${run.steps + 1} step${run.steps === 0 ? '' : 's'} · ${usd(run.usd + stepCost)}`)

    const failure = outcome.failure
    if (failure) {
      if (failure.kind === 'interrupted') return yield* fail('interrupted')
      if (failure.kind === 'policy') {
        return yield* fail(
          `no OpenRouter provider of ${agent.model} meets the privacy setting "${settings.privacy}". ` +
            `Pick another model for this agent, or change the openrouter-agents privacy option (/plugin configure)`,
        )
      }
      if (failure.kind === 'context') return yield* fail(`the conversation is too long for ${agent.model}`, 'model_context_window_exceeded')
      if (failure.kind === 'credits') return yield* fail(`the OpenRouter balance is too low for this request. Top up at ${TOP_UP}`)
      if (failure.kind === 'creditCheck') {
        return yield* fail(
          `OpenRouter couldn't confirm the balance covers this request, through every retry and the fallback model. ` +
            `It does this when the balance is low; top up at ${TOP_UP}, or run fewer OpenRouter agents at once`,
        )
      }
      return yield* fail(failure.message)
    }

    const turnUsage: TurnUsage = { ...outcome.usage, model: outcome.model }
    const stopReason = outcome.stopReason ?? (outcome.toolUses.length ? 'tool_use' : 'end_turn')
    const report = isAuto ? (outcome.handbackReport ?? (!outcome.toolUses.length && outcome.answer.trim() ? outcome.answer.trim() : undefined)) : undefined
    const toolUses = outcome.toolUses
    await patchRun($, agentId, r => ({
      ...r,
      toolNames: [...r.toolNames, ...toolUses.map(t => t.name)],
      ...(report !== undefined ? { report } : {}),
    }))
    lastBlock.delete(stepKey)
    yield { kind: 'stop' as const, stopReason, usage: turnUsage }
    return done(outcome.answer, stopReason, turnUsage, toolUses)
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
    if (run && e.agentId !== undefined && run.steps > 0) {
      await patchRun($, e.agentId, r => ({ ...r, isDone: true }))
      $.ui.status(undefined)
      const served = run.providers.length ? ` (served by ${run.providers.join(', ')})` : ''
      const fellBack = run.fallbackSteps ? `, ${run.fallbackSteps} on the fallback model` : ''
      $.ui.log(`${run.name} · ${agents[run.name]?.label ?? ''} via OpenRouter${served}: ${run.steps} steps${fellBack}, ${usd(run.usd)}`)
    }
    return result
  })

  // /openrouter: what the plugin is set to and what it has spent
  on('command.run', { command: 'openrouter' }, async $ => {
    const runs = Object.entries(await allRuns($)).sort(([, a], [, b]) => b.startedAt - a.startedAt)
    const spent = runs.reduce((sum, [, r]) => sum + r.usd, 0)
    const key = await $.env.get('OPENROUTER_API_KEY')
    let money = 'Balance: OPENROUTER_API_KEY is not set in the environment claude started from.'
    if (key) {
      const { account, keyLeft } = await balanceOf($, key).catch(() => ({ account: undefined, keyLeft: undefined }))
      money =
        `Balance: ${account !== undefined ? `${usd(account)} on the account` : 'unknown'}` +
        (keyLeft !== undefined ? `, ${usd(keyLeft)} left on this key's limit` : '') +
        `. Top up at ${TOP_UP}`
    }
    const version = await $.fs
      .read('.claude-plugin/plugin.json')
      .then(t => String((JSON.parse(String(t)) as { version?: unknown }).version ?? ''))
      .catch(() => '')
    const lines = [
      `OpenRouter subagents${version ? ` ${version}` : ''}`,
      money,
      `This session: ${runs.length} run${runs.length === 1 ? '' : 's'}, ${usd(spent)} spent. Caps: ${settings.maxRunUsd > 0 ? usd(settings.maxRunUsd) : 'none'} per run, ${settings.maxSessionUsd > 0 ? usd(settings.maxSessionUsd) : 'none'} per session.`,
      `Settings: privacy ${settings.privacy}, auto mode ${settings.autoMode}, fallback model ${settings.fallbackModel}.`,
      '',
      'Agents:',
      ...Object.entries(agents).map(
        ([name, a]) =>
          `  ${name.padEnd(9)} ${a.model} · effort ${a.effort}${a.providers ? ` · providers ${a.providers.join(', ')}` : ''}${a.vision ? '' : ' · no images'}`,
      ),
    ]
    if (runs.length) {
      lines.push('', 'Runs (newest first):')
      for (const [, r] of runs.slice(0, 10)) {
        const flags = [r.isAuto ? 'auto mode' : '', r.isDone ? '' : 'running', r.fallbackSteps ? `${r.fallbackSteps} fallback steps` : ''].filter(Boolean)
        lines.push(
          `  ${r.name.padEnd(9)} ${r.steps} steps · ${usd(r.usd)}${r.providers.length ? ` · ${r.providers.join(', ')}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`,
          `            ${toolSummary(r.toolNames)}`,
        )
      }
      if (runs.length > 10) lines.push(`  …and ${runs.length - 10} earlier`)
    }
    lines.push('', 'Change settings with /plugin configure openrouter-agents@ashar-local.')
    return { text: lines.join('\n') }
  })

  // Opening one of our agents' transcripts shows the session's model in the
  // header notice. Name the real one there and in the band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const id = e.props.view.agentId
    if (id !== viewed) {
      viewed = id
      $.ui.invalidate('ui.render')
    }
    const run = id !== undefined ? (await allRuns($))[id] : undefined
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
    const run = viewed !== undefined ? (await allRuns($))[viewed] : undefined
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
