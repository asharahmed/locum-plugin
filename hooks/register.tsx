import type { Register, TurnStepResult, TurnStepToolUse, TurnStopReason, TurnUsage } from 'claude-code'
import type { AgentRun } from '../types'
import type { AgentDef } from './agents'
import { MAIN_RUN, agentName, fallbackModelFor, isOpenRouterModel, loopAgent, readSettings } from './agents'
import type { Health } from './commands'
import { TOP_UP, addSpend, applyOverrides, readOverrides, runCommand, usd } from './commands'
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
  withIdentity,
  withNudge,
} from './messages'
import type { StepOutcome } from './openrouter'
import { CONFIGURE, NO_KEY, balanceOf, completeText, openRouterKey, streamStep } from './openrouter'
import type { Endpoint } from './pricing'
import { choose, loadPrices, openRouterEndpoint, withPrice } from './pricing'
import { firstNotice, install, isFolderInstall, isNewer, latestRelease, pluginVersion, updateCommand } from './updates'
import type { Price, Route } from './providers'
import { PROVIDERS, directRoute, priceNow } from './providers'
import { SUBAGENT_TOOLS } from './schemas'
import { allRuns, getRun, loopRunOf, newRun, patchRun, putRun, runOf, sessionUsd } from './state'

// Reasoning budget per effort level; the answer gets ANSWER_TOKENS beyond it
const THINKING_BUDGET: Record<string, number> = { low: 1024, medium: 4000, high: 8000, xhigh: 12000, max: 16000 }
const ANSWER_TOKENS = 12000
// After this many failed steps in a row a model is skipped (steps go straight to
// the fallback) for SKIP_MS, then tried again
const SKIP_AFTER = 3
const SKIP_MS = 120_000
// The main session's system prompt when none was captured from Claude Code's own
const MAIN_PROMPT_FALLBACK =
  'You are Claude Code, an interactive coding assistant working in the user\'s terminal. Use the tools available to do ' +
  'what the user asks, check your work, and keep replies concise.'
const COMPACT_PROMPT =
  'Summarize the conversation below so the work can continue from the summary alone. Keep: the user\'s goals and ' +
  'requests, decisions made, files and code touched (with paths), commands run and their outcomes, errors and how they ' +
  'were resolved, and what remains to do. Write it as a plain, complete summary.'

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
  // What each OpenRouter model can do, from the model list at session start
  const modelInfo = new Map<string, { vision: boolean; tools: boolean; reasoning: boolean; price?: { input: number; output: number; cacheRead: number } }>()

  // A step's cost: what OpenRouter reported, else an estimate from its tokens (or,
  // for a reply cut off before its usage, the request's size) at the listed prices,
  // so a provider that leaves cost out can't slip past the caps
  const costOf = (model: string, outcome: StepOutcome, requestChars: number, directPrice?: { input: number; output: number; cacheRead: number }) => {
    if (outcome.cost > 0) return outcome.cost
    const price = directPrice ?? modelInfo.get(model)?.price
    if (!price) return 0
    const u = outcome.usage
    const input = u.input_tokens || (outcome.yielded || outcome.failure?.kind === 'interrupted' ? Math.ceil(requestChars / 4) : 0)
    const output = u.output_tokens || Math.ceil(outcome.answer.length / 4)
    return input * price.input + u.cache_read_input_tokens * price.cacheRead + output * price.output
  }
  // The permission mode of each loop ('' for the main session), from the classic
  // hook events that carry it
  const modeOfLoop = new Map<string, string>()
  // The main session's model as its last step named it
  let mainModel = ''
  // Claude Code's own system prompt for each model, as prompt.compose rendered it
  const composed = new Map<string, string>()
  // The direct providers' keys by env name, read at session start
  const directKeys: Record<string, string | undefined> = {}
  // The endpoint that last took each provider's key (keys are bound to a region)
  const workingUrl: Record<string, string> = {}
  // Providers whose key every endpoint refused this session: OpenRouter from then on
  const refusedKey = new Set<string>()
  // Prices at session start (pricing.ts): each routable model's OpenRouter
  // providers that meet the privacy setting, and the lab's own listed price
  const orEndpoints = new Map<string, Endpoint[]>()
  const labPrices = new Map<string, Price>()
  const routeFor = (model: string) => {
    const route = directRoute(model, settings.direct.filter(id => !refusedKey.has(id)), directKeys, settings.baseUrls, workingUrl)
    return route && withPrice(route, labPrices.get(model))
  }
  // Which of the lab and OpenRouter goes first for an agent's step now
  const choiceFor = (a: AgentDef, route: Route, now: number, hasOpenRouterKey: boolean) =>
    choose(settings.directMode, priceNow(route, new Date(now)), openRouterEndpoint(orEndpoints.get(a.model), a.providers), hasOpenRouterKey)
  // A request body for the lab: its own model ID, no OpenRouter-only preferences
  const forLab = (body: Record<string, unknown>, route: Route) => {
    const { provider: _, ...rest } = body
    return { ...rest, model: route.model }
  }
  // How a model is reached, for descriptions and headers
  const via = (model: string) => {
    const route = routeFor(model)
    return route ? `via ${route.provider.label}'s API` : 'via OpenRouter'
  }
  // Each model's record this session, for skipping one that keeps failing and for /locum
  const health = new Map<string, Health>()
  const healthOf = (model: string) => {
    let h = health.get(model)
    if (!h) health.set(model, (h = { ok: 0, ms: 0, fails: 0, streak: 0 }))
    return h
  }


  // The model a failing step moves to: never the agent's own, never a Claude model
  const fallbackFor = (agent: AgentDef): AgentDef => {
    const model = fallbackModelFor(agent.model, settings.fallbackModel)
    return { ...agent, model, label: model, vision: false, providers: undefined }
  }

  // The OpenRouter request for one step
  const requestBody = (agent: AgentDef, messages: unknown[], tools: unknown[], budget: number, systemText: string) => {
    // A model OpenRouter lists without reasoning support gets no thinking budget
    const canReason = modelInfo.get(agent.model)?.reasoning ?? true
    const provider = { ...(agent.providers ? { order: agent.providers, allow_fallbacks: true } : {}), ...settings.privacyPrefs }
    return {
      model: agent.model,
      ...(Object.keys(provider).length ? { provider } : {}),
      max_tokens: (canReason ? budget : 0) + ANSWER_TOKENS,
      stream: true,
      ...(canReason ? { thinking: { type: 'enabled', budget_tokens: budget } } : {}),
      // Environment, date, CLAUDE.md and the rest arrive in the messages, as for a
      // native subagent; the system prompt is the agent definition's own. Tools
      // come before it in the cached prefix, so its mark covers them too. (A mark
      // on a tool itself made DeepSeek's provider drop that tool.)
      system: [{ type: 'text', text: withIdentity(systemText, agent), cache_control: { type: 'ephemeral' } }],
      messages,
      tools,
    }
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd
    home = (await $.env.get('HOME')) ?? ''
    // A key entered in the config dialog, else the environment's (literal names,
    // so the validator can list what the plugin reads)
    const k = settings.keys
    directKeys.DEEPSEEK_API_KEY = k.DEEPSEEK_API_KEY || (await $.env.get('DEEPSEEK_API_KEY'))
    directKeys.ZAI_API_KEY = k.ZAI_API_KEY || (await $.env.get('ZAI_API_KEY'))
    directKeys.DASHSCOPE_API_KEY = k.DASHSCOPE_API_KEY || (await $.env.get('DASHSCOPE_API_KEY'))
    directKeys.MINIMAX_API_KEY = k.MINIMAX_API_KEY || (await $.env.get('MINIMAX_API_KEY'))
    // Models chosen with `/locum use` win over the configured ones
    applyOverrides(settings, await readOverrides($).catch(() => ({})))
    for (const [name, a] of Object.entries(agents)) {
      await $.agent.register({
        name,
        description: `Subagent on ${a.label} ${via(a.model)}. ${a.when}`,
        // No `tools`: Claude Code grants the native subagent tool pool
        prompt: SUBAGENT_PROMPT,
      })
    }
    await $.command.register({ name: 'locum', description: 'OpenRouter subagents: balance, agents, spend, models (/locum help)' })

    // In the background, so a slow OpenRouter never holds up the session: check the
    // configured models exist and whether they take images, and the balance
    void (async () => {
      const key = await openRouterKey($, settings.keys)
      if (!key && !Object.values(directKeys).some(Boolean)) {
        $.ui.toast(`Locum needs an API key: run /locum setup, or add one in ${CONFIGURE}`)
        return
      }
      // The model list is public; it gives capabilities and prices with or without a key
      const models = await $.http.fetch('https://openrouter.ai/api/v1/models', key ? { headers: { authorization: `Bearer ${key}` } } : {})
      if (models.ok) {
        const listed = new Map(
          (
            JSON.parse(models.text).data as {
              id: string
              architecture?: { input_modalities?: string[] }
              supported_parameters?: string[]
              pricing?: { prompt?: string; completion?: string; input_cache_read?: string }
            }[]
          ).map(m => [m.id, m]),
        )
        for (const [id, m] of listed) {
          const params = m.supported_parameters ?? []
          modelInfo.set(id, {
            vision: (m.architecture?.input_modalities ?? []).includes('image'),
            tools: params.includes('tools'),
            reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
            ...(m.pricing
              ? {
                  price: {
                    input: Number(m.pricing.prompt ?? 0),
                    output: Number(m.pricing.completion ?? 0),
                    cacheRead: Number(m.pricing.input_cache_read ?? m.pricing.prompt ?? 0),
                  },
                }
              : {}),
          })
        }
        const missing: string[] = []
        for (const [name, a] of Object.entries(agents)) {
          const m = listed.get(a.model)
          if (!m) missing.push(`${name} (${a.model})`)
          else if (m.architecture?.input_modalities) a.vision = m.architecture.input_modalities.includes('image')
        }
        if (!listed.has(settings.fallbackModel)) missing.push(`fallbackModel (${settings.fallbackModel})`)
        if (missing.length) $.ui.toast(`OpenRouter has no model for: ${missing.join(', ')}. Check /plugin configure.`)
      }
      const routable = [...new Set([...Object.values(agents).map(a => a.model), settings.fallbackModel])].flatMap(m => {
        const route = routeFor(m)
        return route ? [{ model: m, labName: route.provider.orName }] : []
      })
      await loadPrices($, routable, settings.privacy !== 'off', orEndpoints, labPrices).catch(() => {})
      if (!key || !(settings.lowBalanceUsd > 0)) return
      const { account, keyLeft } = await balanceOf($, key)
      const left = [account, keyLeft].filter((v): v is number => v !== undefined)
      if (left.length && Math.min(...left) < settings.lowBalanceUsd) {
        $.ui.toast(`OpenRouter balance is low: ${usd(Math.min(...left))} left. OpenRouter subagents may fail. Top up at ${TOP_UP}`)
      }
    })().catch(() => {})

    // New releases: a notice once per version, or an install when the person
    // chose `updates: auto` (a copy read from a folder is left to git)
    void (async () => {
      if (settings.updates === 'off') return
      const current = await pluginVersion($)
      const latest = await latestRelease($)
      if (!latest || !current || !isNewer(latest.version, current)) return
      if (settings.updates === 'auto' && !isFolderInstall($.plugin.root)) {
        const r = await install($)
        $.ui.toast(r.ok ? `Locum updated itself to ${latest.version}. Run /reload-plugins to load it.` : `Locum ${latest.version} is out, but installing it failed. /locum update says more.`)
        return
      }
      if (await firstNotice($, latest.version)) $.ui.toast(`Locum ${latest.version} is out (you have ${current}). /locum update shows what changed and installs it.`)
    })().catch(() => {})

    return started
  })

  // Hooks below that only add to an event fail open (`.catch(... => next(e))`):
  // a state read that fails lets the spawn, notice or tool call go on as usual.

  // The permission mode, which only the classic hook events carry: the main
  // session's at each prompt, a subagent's as it starts, and either's after each
  // tool call (so Shift+Tab mid-turn counts from the next call)
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.permission_mode) modeOfLoop.set('', e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.SubagentStart', async ($, e, next) => {
    if (e.permission_mode && e.agent_id) modeOfLoop.set(e.agent_id, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))
  on('classic.PostToolUse', async ($, e, next) => {
    if (e.permission_mode) modeOfLoop.set(e.agent_id ?? '', e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))

  // Claude Code's own system prompt for a model, kept for the main session's
  // OpenRouter requests (the last render for that model wins)
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (isOpenRouterModel(e.model)) composed.set(e.model, result.sections.map(section => section.text).join('\n\n'))
    return result
  }).catch(($, e, next) => next(e))

  // A loop on an OpenRouter model can't be compacted by Claude Code (it would ask
  // Anthropic for that model), so the same model writes the summary
  on('session.compact', async ($, e, next) => {
    // The session's model as Claude Code has it: a resumed session compacts before any step has named it
    // The session's model as Claude Code has it now (a resumed session compacts
    // before any step has named it; a stale record would send a Claude session's
    // transcript to OpenRouter)
    const model = e.agentId !== undefined ? (await getRun($, e.agentId))?.model : await $.session.model().catch(() => mainModel)
    if (!isOpenRouterModel(model) || e.trigger === 'precompute') return next(e)
    const runKey = e.agentId ?? MAIN_RUN
    if (settings.maxSessionUsd > 0 && (await sessionUsd($)) >= settings.maxSessionUsd) {
      return { skip: `the OpenRouter session cap of ${usd(settings.maxSessionUsd)} is reached, so ${model} won't compact this conversation (raise maxSessionUsd in /plugin configure)` }
    }
    const key = await openRouterKey($, settings.keys)
    const route = routeFor(model)
    if (!key && !route) return { skip: `compacting needs an OpenRouter key; ${NO_KEY}` }
    const agent = e.agentId !== undefined ? (agents[(await getRun($, e.agentId))?.name ?? ''] ?? loopAgent(model, false)) : loopAgent(model, false)
    const transcript = e.messages
      .map(m => `${m.role.toUpperCase()}: ${m.text}${m.toolUses.length ? `\n[tools: ${m.toolUses.map(t => `${t.tool}${t.isError ? ' (error)' : ''}`).join(', ')}]` : ''}`)
      .join('\n\n')
      .slice(-400000)
    const body = requestBody(agent, [{ role: 'user', content: [{ type: 'text', text: `${e.instructions ? `${e.instructions}\n\n` : ''}${transcript}` }] }], [], THINKING_BUDGET.low!, COMPACT_PROMPT)
    // The cheaper route first, the other if it fails, as for a step
    const now = await $.clock.now()
    const ways = !route ? ['openrouter'] : choiceFor(agent, route, now, !!key).directFirst ? ['lab', 'openrouter'] : ['openrouter', 'lab']
    let outcome: StepOutcome | undefined
    let cost = 0
    let servedBy = 'OpenRouter'
    for (const way of ways) {
      if (way === 'openrouter' && !key) continue
      if (way === 'lab') {
        const labBody = forLab(body, route!)
        outcome = await completeText($, directKeys[route!.provider.keyEnv]!, labBody, new AbortController().signal, { url: route!.url, auth: route!.provider.auth })
        cost += costOf(model, outcome, JSON.stringify(labBody).length, priceNow(route!, new Date(now)))
        servedBy = `${route!.provider.label} direct`
      } else {
        outcome = await completeText($, key!, body, new AbortController().signal)
        cost += costOf(model, outcome, JSON.stringify(body).length)
        servedBy = 'OpenRouter'
      }
      if (!outcome.failure && outcome.answer.trim()) break
    }
    if (!outcome) return { skip: `compacting needs an OpenRouter key; ${NO_KEY}` }
    // Compaction counts toward the caps like any step
    if (!(await getRun($, runKey))) await putRun($, runKey, newRun(e.agentId !== undefined ? 'subagent' : 'main', model, false, await $.clock.now()))
    await patchRun($, runKey, r => ({ ...r, usd: r.usd + cost }))
    await addSpend($, e.agentId !== undefined ? 'subagent' : 'main', cost).catch(() => {})
    if (outcome.failure || !outcome.answer.trim()) return { skip: `compacting on ${model} via ${servedBy} failed: ${outcome.failure?.message ?? 'empty summary'}` }
    const summary = `This session is being continued from an earlier conversation that was compacted. Summary of it:\n\n${outcome.answer.trim()}`
    return { messages: [{ role: 'user' as const, text: summary, toolUses: [] }] }
  }).catch(($, e, next) => next(e))

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
          `or to set the Locum option autoMode to "allow" (/plugin configure), then try again.`,
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
    const run = await loopRunOf($, agents, e.agentId, isOpenRouterModel(mainModel))
    const isSubagent = e.agentId !== undefined
    // In auto mode the labelled report is the only way results reach the main
    // session; SendMessage would carry them there unlabelled
    if (isSubagent && run?.isAuto && e.tool === 'SendMessage') {
      return { decision: 'deny' as const, reason: 'SendMessage is off for OpenRouter subagents in auto mode. Put everything in your final report.' }
    }
    // A path a file tool was refused for stays off limits through Bash too,
    // however the command spells it (relative, ~/…, after a cd)
    if (isSubagent && run && e.tool === 'Bash') {
      const command = String((e.input as { command?: unknown } | undefined)?.command ?? '')
      const hit = refusedPathIn(command, run.deniedPaths, cwd, home)
      if (hit) {
        return { decision: 'deny' as const, reason: `${hit} was refused to a file tool earlier in this run; reaching it through Bash isn't allowed either. Say in your report what was refused.` }
      }
    }
    const verdict = await next(e)
    // The loop's mode as last seen, else the run's own at its start
    const loopMode = modeOfLoop.get(e.agentId ?? '')
    const isAuto = loopMode !== undefined ? loopMode === 'auto' : run?.isAuto
    if (!run || !isAuto || settings.autoMode !== 'allow' || verdict.decision !== 'ask') return verdict
    // Only the ask the mode itself raised (what the classifier would review): an
    // ask rule, a hook's, another plugin's, a setting's or an admin ceiling stands
    if (verdict.rule || verdict.hook || verdict.plugin || verdict.setting || e.ceiling === 'ask') return verdict
    return { decision: 'allow' as const, reason: `${$.plugin.name}: auto mode can't review OpenRouter models; allowed unreviewed (autoMode: allow)` }
  }).catch(($, e, next) => (next.called ? next(e) : { decision: 'deny' as const, reason: 'locum: permission check failed' }))

  // Deliver an auto-mode agent's report: the completion notice for a background
  // run, and the Agent tool's result for a foreground one, say no report came.
  const reportFor = (run: AgentRun) => {
    const label = agents[run.name]?.label ?? run.model
    const fellBack = run.fallbackSteps ? ` ${run.fallbackSteps} step(s) ran on the fallback model.` : ''
    // Unreviewed model output: its "<" is escaped, so it can't close the notice
    // around it or forge another one outside the label
    const report = (run.report ?? '').replace(/</g, '&lt;')
    return `[Report from ${label} via OpenRouter, delivered by the Locum plugin. Auto mode did not review this report or the work behind it. ${toolSummary(run.toolNames)}${fellBack}]\n\n${report}`
  }

  on('prompt.submit', async ($, e, next) => {
    // Only a background task's own notice, not a pasted or peer-sent look-alike
    if (e.origin?.kind !== 'task-notification') return next(e)
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
    if (!(await loopRunOf($, agents, e.agentId, isOpenRouterModel(mainModel)))) return r
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
    const isSubagent = e.agentId !== undefined
    // Every main step records its model, so /model back to Claude ends OpenRouter
    // handling (permissions, compaction) at once
    if (!isSubagent) mainModel = e.model
    if (!isSubagent && !isOpenRouterModel(e.model)) return yield* next(e)
    const runKey = e.agentId ?? MAIN_RUN
    let run = isSubagent ? await runOf($, agents, runKey) : undefined
    // A loop that isn't one of our agents but runs on an OpenRouter model: the main
    // session after /model, or a subagent that inherited that model
    const isLoop = !run
    if (isLoop) {
      if (!isOpenRouterModel(e.model)) return yield* next(e)
      const isAutoNow = (modeOfLoop.get(isSubagent ? runKey : '') ?? modeOfLoop.get('')) === 'auto'
      const existing = await getRun($, runKey)
      run = existing
        ? { ...existing, model: e.model, ...(isSubagent ? {} : { isAuto: isAutoNow }) }
        : newRun(isSubagent ? 'subagent' : 'main', e.model, isAutoNow, await $.clock.now())
      await putRun($, runKey, run)
    }
    if (!run) return yield* next(e)
    const agent = isLoop ? loopAgent(e.model, modelInfo.get(e.model)?.vision ?? false) : agents[run.name]
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
    const agentId = runKey
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

    // Without an OpenRouter key only a model a lab with a key serves can run
    const key = await openRouterKey($, settings.keys)
    if (!key && !routeFor(agent.model)) return yield* fail(`${NO_KEY}, or a key for the lab that serves ${agent.model}`)
    // Claude Code can't work without tool calls; say so before spending anything
    if (modelInfo.get(agent.model)?.tools === false) {
      return yield* fail(`${agent.model} doesn't support tool calls, which Claude Code needs. Pick another model (/locum models lists ones that do)`)
    }

    const messages = isSubagent ? await $.session.messages({ agentId: runKey, as: 'api' }) : await $.session.messages({ as: 'api' })
    if (!Array.isArray(messages)) return yield* fail(messages.deny)

    // The main session in auto mode can't have its tool calls reviewed either
    if (!isSubagent && isAuto && settings.autoMode !== 'allow') {
      return yield* fail(
        `auto mode can't review ${e.model}'s tool calls (its safety check runs on Anthropic's responses). Switch to manual mode ` +
          `or accept-edits with Shift+Tab, set the Locum option autoMode to "allow", or go back to a Claude model with /model`,
      )
    }

    // In auto mode the engine keeps asking for a SubagentHandback the classifier
    // would have to approve. The report is already kept; answer without a request.
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const isReminder = isSubagent && isAuto && run.report !== undefined && JSON.stringify(lastUser?.content ?? '').includes(HANDBACK_REMINDER)
    // A report with no tool calls behind it gets one chance to do the work first
    const nudge = isReminder && !run.toolNames.length && !run.isNudged
    if (nudge) await patchRun($, agentId, r => ({ ...r, isNudged: true, report: undefined }))
    if (isReminder && !nudge) {
      const text = REMINDER_REPLY
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return done(text, 'end_turn', null)
    }

    const withHandback = isSubagent && !isAuto && engineOffersHandback(messages)

    // Over the run's or the session's spend cap, the run ends here, with a report saying so
    const spentSession = settings.maxSessionUsd > 0 ? await sessionUsd($) : 0
    const capped =
      isSubagent && settings.maxRunUsd > 0 && run.usd >= settings.maxRunUsd
        ? `this run reached the Locum spend cap of ${usd(settings.maxRunUsd)} per run (spent ${usd(run.usd)} over ${run.steps} steps). Raise maxRunUsd`
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
      if (isSubagent && isAuto) await patchRun($, agentId, r => ({ ...r, report: text }))
      yield { kind: 'text' as const, index: 0, text }
      yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
      return done(text, 'end_turn', null)
    }

    // The main session gets every built-in; a subagent the native subagent set
    const tools = toolsFor(await $.tool.list(), messages, withHandback, isSubagent ? SUBAGENT_TOOLS : undefined)
    // The Agent call's own effort, else the agent's configured one; a loop on a
    // model of its own uses the effort the request names
    const effort = isLoop ? e.effort : (run.effort ?? agent.effort)
    const budget = typeof effort === 'number' ? effort : (THINKING_BUDGET[effort ?? 'medium'] ?? THINKING_BUDGET.medium!)
    // The main session keeps Claude Code's own system prompt; a subagent the agent definition's
    const systemText = isSubagent ? SUBAGENT_PROMPT + (isAuto ? AUTO_REPORT_RULE : '') : (composed.get(e.model) ?? MAIN_PROMPT_FALLBACK)
    let requestChars = 0
    const request = (a: AgentDef, route?: Route) => {
      const adapted = adaptMessages(messages, a, isSubagent && isAuto)
      const openRouterBody: Record<string, unknown> = requestBody(a, nudge ? withNudge(adapted) : adapted, tools, budget, systemText)
      const body = route ? forLab(openRouterBody, route) : openRouterBody
      requestChars = JSON.stringify(body).length
      return streamStep($, {
        key: route ? directKeys[route.provider.keyEnv]! : key!,
        ...(route ? { url: route.url, auth: route.provider.auth } : {}),
        body,
        isAuto: isSubagent && isAuto,
        signal: next.signal,
        onBlock: index => lastBlock.set(stepKey, Math.max(lastBlock.get(stepKey) ?? -1, index)),
        onRetry: why => showStatus(`retrying after ${why}`),
      })
    }

    showStatus(`step ${e.index + 1}`)
    let outcome: StepOutcome
    let usedFallback = false
    const providers = new Set(run.providers)
    // Times one request and records how its model (on that route) did
    const timed = async function* (a: AgentDef, route?: Route) {
      const started = await $.clock.now()
      const result: StepOutcome = yield* request(a, route)
      const h = healthOf(route ? `${a.model} via ${route.provider.label}` : a.model)
      if (!result.failure || result.yielded) {
        h.ok++
        h.ms += (await $.clock.now()) - started
        h.streak = 0
        delete h.skipUntil
      } else if (result.failure.kind !== 'interrupted') {
        h.fails++
        h.streak++
        h.lastError = result.failure.message
        if (h.streak >= SKIP_AFTER) h.skipUntil = (await $.clock.now()) + SKIP_MS
      }
      return result
    }
    // One model's attempt over its routes, the cheaper first (pricing.ts): the
    // lab's own API and OpenRouter. A failure before any output (an outage, a
    // refused key, no provider meeting the privacy setting) moves to the other
    // route; output already shown, an interruption or a full context stops there.
    let directUsed: Route | undefined
    const viaLab = async function* (a: AgentDef, route: Route) {
      let direct!: StepOutcome
      for (const url of route.urls) {
        direct = yield* timed(a, { ...route, url })
        stepCost += costOf(a.model, direct, requestChars, priceNow(route, new Date(await $.clock.now())))
        if (!direct.failure) workingUrl[route.provider.id] = url
        // A key refused at one region's endpoint may be another region's
        const refused = direct.failure?.status === 401 || direct.failure?.status === 403
        if (!refused || direct.yielded) break
      }
      const f = direct.failure
      if ((f?.status === 401 || f?.status === 403) && !direct.yielded && !refusedKey.has(route.provider.id)) {
        refusedKey.add(route.provider.id)
        $.ui.toast(`${route.provider.label} refused its API key, so Locum uses OpenRouter for its models this session. Fix the key in ${CONFIGURE}.`)
      }
      if (!f) directUsed = route
      return direct
    }
    const viaOpenRouter = async function* (a: AgentDef) {
      const outcome: StepOutcome = yield* timed(a)
      stepCost += costOf(a.model, outcome, requestChars)
      return outcome
    }
    const attempt = async function* (a: AgentDef) {
      const route = routeFor(a.model)
      const now = await $.clock.now()
      const labUsable = !!route && (healthOf(`${a.model} via ${route.provider.label}`).skipUntil ?? 0) <= now
      const order = !route ? ['openrouter'] : choiceFor(a, route, now, !!key).directFirst ? ['lab', 'openrouter'] : ['openrouter', 'lab']
      let last: StepOutcome | undefined
      for (const way of order) {
        if ((way === 'lab' && !labUsable) || (way === 'openrouter' && !key)) continue
        if (last) $.ui.log(`${owner}: ${a.model} failed (${last.failure!.message.slice(0, 80)}); trying ${way === 'lab' ? `${route!.provider.label} direct` : 'OpenRouter'}`)
        const outcome: StepOutcome = way === 'lab' ? yield* viaLab(a, route!) : yield* viaOpenRouter(a)
        const f = outcome.failure
        if (!f || outcome.yielded || f.kind === 'interrupted' || f.kind === 'context') return outcome
        last = outcome
      }
      return (
        last ?? {
          yielded: false, answer: '', stopReason: null, toolUses: [], model: a.model, cost: 0,
          usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          failure: { kind: 'other', message: `${NO_KEY}, or a key for the lab that serves ${a.model}` },
        } satisfies StepOutcome
      )
    }

    try {
      // A model that failed its last few steps is skipped for a while: straight to the fallback
      const skipping = (healthOf(agent.model).skipUntil ?? 0) > (await $.clock.now())
      const fallback = fallbackFor(agent)
      if (skipping) {
        showStatus(`${agent.model} is failing; using ${fallback.model}`)
        outcome = yield* attempt(fallback)
        if (outcome.provider) providers.add(outcome.provider)
        if (!outcome.failure) usedFallback = true
      } else {
        outcome = yield* attempt(agent)
        if (outcome.provider) providers.add(outcome.provider)
      }
      // A step its own model can't answer moves to the fallback model, once
      const first = outcome.failure
      // (not a model OpenRouter doesn't know: a typo shouldn't be hidden behind another model)
      if (!skipping && first && !outcome.yielded && (first.kind === 'retryable' || first.kind === 'other' || first.kind === 'creditCheck')) {
        showStatus(`${agent.model} failing; trying ${fallback.model}`)
        const second = yield* attempt(fallback)
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
      if (directUsed) providers.add(`${directUsed.provider.label} (direct)`)
      await addSpend($, owner, stepCost).catch(() => {})
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
            `Pick another model for this agent, or change the Locum privacy option (/plugin configure)`,
        )
      }
      if (failure.kind === 'context') return yield* fail(`the conversation is too long for ${agent.model}`, 'model_context_window_exceeded')
      if (failure.kind === 'unknownModel') {
        return yield* fail(`OpenRouter doesn't know the model "${agent.model}". Check the ID with /locum models <name>`)
      }
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
    const report = isSubagent && isAuto ? (outcome.handbackReport ?? (!outcome.toolUses.length && outcome.answer.trim() ? outcome.answer.trim() : undefined)) : undefined
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
    const isOurs = run !== undefined && (agents[run.name] !== undefined || isOpenRouterModel(run.model))
    if (!isOurs && !isOpenRouterModel(e.model)) return yield* next(e)
    const name = run?.name ?? 'main'
    const stepKey = `${e.turnId}:${e.index}`
    const index = (lastBlock.get(stepKey) ?? -1) + 1
    lastBlock.delete(stepKey)
    const text = `[${name} via OpenRouter: this step failed inside the Locum plugin. Stop and report what you have.]`
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
      $.ui.log(`${run.name} · ${agents[run.name]?.label ?? run.model} via OpenRouter${served}: ${run.steps} steps${fellBack}, ${usd(run.usd)}`)
    }
    return result
  })

  // /locum: what the plugin is set to and what it has spent, plus subcommands
  on('command.run', { command: 'locum' }, async ($, e) => {
    const runs = Object.entries(await allRuns($)).sort(([, a], [, b]) => b.startedAt - a.startedAt)
    const version = await pluginVersion($)
    const [sub, arg] = (e.args ?? '').trim().split(/\s+/)
    if (sub === 'update') return { text: await updateCommand($, arg ?? '', e.origin?.kind ?? '', version) }
    const routes: Record<string, string> = {}
    const now = await $.clock.now()
    const hasKey = !!(await openRouterKey($, settings.keys))
    const perM = (v: number | undefined) => (v === undefined ? 'price unknown' : `$${v.toFixed(3)}`)
    for (const [name, a] of Object.entries(settings.agents)) {
      const route = routeFor(a.model)
      if (!route) continue
      const c = choiceFor(a, route, now, hasKey)
      const lab = `${route.provider.label} direct ${perM(c.directPerM)}`
      const viaOr = `OpenRouter${c.openRouterProvider ? ` (${c.openRouterProvider})` : ''} ${perM(c.openRouterPerM)}`
      routes[name] = `${c.directFirst ? `${lab}, then ${viaOr}` : `${viaOr}, then ${lab}`} (${c.why})`
    }
    const latest = settings.updates === 'off' ? undefined : await latestRelease($).catch(() => undefined)
    const updateLine = latest && version && isNewer(latest.version, version) ? `Update: Locum ${latest.version} is out (you have ${version}). /locum update shows what changed and installs it.` : ''
    const labKeys = Object.fromEntries(Object.values(PROVIDERS).map(p => [p.id, !!directKeys[p.keyEnv]]))
    return { text: await runCommand($, e.args ?? '', settings, runs, version, mainModel, health, routes, labKeys, updateLine) }
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
    if (!run || !isOpenRouterModel(run.model)) return next(e)
    const label = agents[run.name]?.label ?? run.model
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>
          {run.name} · {label} ({run.model}) {via(run.model)}
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
    if (!run || !isOpenRouterModel(run.model) || !/^Using .+ \(from /.test(e.props.text)) return next(e)
    const label = agents[run.name]?.label ?? run.model
    const { Text } = $.ui.resolve(e)
    return <Text dimColor>Using {label} ({run.model}) {via(run.model)} · this subagent</Text>
  })

  on('session.end', async ($, e, next) => {
    pendingEffort.clear()
    lastBlock.clear()
    return next(e)
  })
}
