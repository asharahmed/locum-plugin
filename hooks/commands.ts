// /locum and its subcommands, plus the two things they keep across
// sessions in $.store: the spend ledger and the models chosen with `use`.

import type { EngineInterface } from 'claude-code'
import type { AgentRun } from '../types'
import type { Settings } from './agents'
import { DEFAULT_AGENTS } from './agents'
import { toolSummary } from './messages'
import { OPENROUTER, balanceOf } from './openrouter'

export const TOP_UP = 'https://openrouter.ai/settings/credits'
const LEDGER = 'ledger-v1'
const OVERRIDES = 'model-overrides-v1'

// How a model has done this session: steps answered, their time, and failures
export type Health = { ok: number; ms: number; fails: number; streak: number; lastError?: string; skipUntil?: number }

export const usd = (v: number) => (v === 0 ? '$0.00' : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`)

// Spend by local day ("2026-10-23") and agent, kept across sessions
export type Ledger = Record<string, Record<string, number>>

const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export async function readLedger($: EngineInterface): Promise<Ledger> {
  const v = await $.store.get(LEDGER)
  return v && typeof v === 'object' ? (v as Ledger) : {}
}

// Ledger writes one after another, so agents finishing steps together don't
// overwrite each other's read-modify-write
let ledgerWrites: Promise<void> = Promise.resolve()

// Adds one step's cost to today's line for the agent
export async function addSpend($: EngineInterface, agent: string, amount: number) {
  if (!(amount > 0)) return
  const write = ledgerWrites.then(async () => {
    const ledger = await readLedger($)
    const day = dayOf(await $.clock.now())
    const today = { ...(ledger[day] ?? {}) }
    today[agent] = (today[agent] ?? 0) + amount
    await $.store.set(LEDGER, { ...ledger, [day]: today })
  })
  ledgerWrites = write.catch(() => {})
  return write
}

// Agent -> model chosen with `/locum use`, kept across sessions
export async function readOverrides($: EngineInterface): Promise<Record<string, string>> {
  const v = await $.store.get(OVERRIDES)
  return v && typeof v === 'object' ? (v as Record<string, string>) : {}
}

// Applies the `use` choices to the configured agents (a model other than the
// default gets no pinned providers and is labelled by its ID)
export function applyOverrides(settings: Settings, overrides: Record<string, string>) {
  for (const [name, model] of Object.entries(overrides)) {
    const agent = settings.agents[name]
    if (!agent || !model) continue
    const def = DEFAULT_AGENTS[name]
    settings.agents[name] = model === def?.model ? { ...agent, ...def, effort: agent.effort } : { ...agent, model, label: model, providers: undefined }
  }
}

type ListedModel = {
  id: string
  name?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
}

async function listModels($: EngineInterface, key: string): Promise<ListedModel[]> {
  const res = await $.http.fetch(`${OPENROUTER}/models`, { headers: { authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`OpenRouter's model list answered HTTP ${res.status}`)
  return (JSON.parse(res.text).data as ListedModel[]) ?? []
}

const perMillion = (v: string | undefined) => Number(v ?? 0) * 1e6

function spendLines(ledger: Ledger, now: number) {
  const days = Object.keys(ledger).sort()
  const today = dayOf(now)
  const weekAgo = dayOf(now - 6 * 86400000)
  const sum = (pick: (day: string) => boolean) => {
    const byAgent: Record<string, number> = {}
    for (const day of days.filter(pick)) for (const [a, v] of Object.entries(ledger[day]!)) byAgent[a] = (byAgent[a] ?? 0) + v
    const total = Object.values(byAgent).reduce((s, v) => s + v, 0)
    const parts = Object.entries(byAgent).sort(([, x], [, y]) => y - x).map(([a, v]) => `${a} ${usd(v)}`)
    return `${usd(total)}${parts.length ? ` (${parts.join(', ')})` : ''}`
  }
  return [
    `  Today:        ${sum(d => d === today)}`,
    `  Last 7 days:  ${sum(d => d >= weekAgo)}`,
    `  All recorded: ${sum(() => true)}${days.length ? ` since ${days[0]}` : ''}`,
  ]
}

// The main session's model, the /model picker entry, and the default-model guard
async function mainSessionLine($: EngineInterface, mainModel: string) {
  const current = mainModel || (await $.session.model().catch(() => ''))
  const onOpenRouter = current.includes('/') && !current.startsWith('arn:')
  const picker = await $.env.get('ANTHROPIC_CUSTOM_MODEL_OPTION')
  const guard = await $.env.get('ANTHROPIC_MODEL')
  return (
    `Main session: ${current || 'unknown'}${onOpenRouter ? ' via OpenRouter (switch back with /model opus)' : ''}.` +
    (picker ? ` /model picker entry: ${picker}.` : '') +
    (guard ? ` New sessions start on ${guard} (ANTHROPIC_MODEL).` : '')
  )
}

const HELP = [
  'Usage:',
  '  /locum                     balance, agents, settings, this session\'s runs and spend history',
  '  /locum models [search]     tool-capable OpenRouter models, cheapest first',
  '  /locum use <agent> <model> run an agent on another OpenRouter model (kept across sessions; takes effect after /reload-plugins)',
  '  /locum use <agent> default back to the configured model',
  '  /locum help                this list',
]

export async function runCommand(
  $: EngineInterface,
  args: string,
  settings: Settings,
  runs: [string, AgentRun][],
  version: string,
  mainModel: string,
  health: ReadonlyMap<string, Health> = new Map(),
): Promise<string> {
  const [sub = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const key = await $.env.get('OPENROUTER_API_KEY')

  if (sub === 'help') return HELP.join('\n')

  if (sub === 'models') {
    if (!key) return 'OPENROUTER_API_KEY is not set in the environment claude started from.'
    const query = rest.join(' ').toLowerCase()
    const models = (await listModels($, key))
      .filter(m => (m.supported_parameters ?? []).includes('tools') && !m.id.endsWith(':free') && !m.id.endsWith(':batch'))
      .filter(m => !query || m.id.toLowerCase().includes(query) || (m.name ?? '').toLowerCase().includes(query))
      .filter(m => perMillion(m.pricing?.prompt) > 0)
      .sort((a, b) => perMillion(a.pricing?.prompt) - perMillion(b.pricing?.prompt))
    if (!models.length) return `No tool-capable OpenRouter model matches "${query}".`
    const shown = models.slice(0, 15)
    const lines = [`Tool-capable OpenRouter models${query ? ` matching "${query}"` : ''}, cheapest input first ($ per million tokens in / out):`]
    for (const m of shown) {
      const img = (m.architecture?.input_modalities ?? []).includes('image') ? ' · images' : ''
      const reasoning = (m.supported_parameters ?? []).includes('reasoning') ? ' · reasoning' : ''
      const ctx = m.context_length ? ` · ${Math.round(m.context_length / 1000)}k ctx` : ''
      lines.push(`  ${m.id.padEnd(44)} $${perMillion(m.pricing?.prompt).toFixed(3)} / $${perMillion(m.pricing?.completion).toFixed(3)}${ctx}${img}${reasoning}`)
    }
    if (models.length > shown.length) lines.push(`  …and ${models.length - shown.length} more; narrow the search.`)
    lines.push('', 'Run an agent on one with /locum use <agent> <model>, or set customModel in /plugin configure.')
    return lines.join('\n')
  }

  if (sub === 'use') {
    const [agent, model] = rest
    if (!agent || !model) return HELP.join('\n')
    if (!settings.agents[agent]) return `There's no agent "${agent}". Agents: ${Object.keys(settings.agents).join(', ')}.`
    const overrides = await readOverrides($)
    if (model === 'default') {
      const { [agent]: _, ...others } = overrides
      await $.store.set(OVERRIDES, others)
      return `${agent} goes back to its configured model after /reload-plugins.`
    }
    if (key) {
      const known = (await listModels($, key).catch(() => [] as ListedModel[])).find(m => m.id === model)
      if (!known) return `OpenRouter has no model "${model}". Search with /locum models <name>.`
      if (!(known.supported_parameters ?? []).includes('tools')) return `${model} doesn't support tool calls, which subagents need.`
    }
    await $.store.set(OVERRIDES, { ...overrides, [agent]: model })
    return `${agent} will run on ${model} after /reload-plugins (kept across sessions; undo with /locum use ${agent} default).`
  }

  if (sub) return [`Unknown subcommand "${sub}".`, ...HELP].join('\n')

  // The overview
  const spent = runs.reduce((sum, [, r]) => sum + r.usd, 0)
  let money = 'Balance: OPENROUTER_API_KEY is not set in the environment claude started from.'
  if (key) {
    const { account, keyLeft } = await balanceOf($, key).catch(() => ({ account: undefined, keyLeft: undefined }))
    money =
      `Balance: ${account !== undefined ? `${usd(account)} on the account` : 'unknown'}` +
      (keyLeft !== undefined ? `, ${usd(keyLeft)} left on this key's limit` : '') +
      `. Top up at ${TOP_UP}`
  }
  const overrides = await readOverrides($)
  const lines = [
    `Locum${version ? ` ${version}` : ''}: Claude Code agents on OpenRouter models`,
    money,
    `This session: ${runs.length} run${runs.length === 1 ? '' : 's'}, ${usd(spent)} spent. Caps: ${settings.maxRunUsd > 0 ? usd(settings.maxRunUsd) : 'none'} per run, ${settings.maxSessionUsd > 0 ? usd(settings.maxSessionUsd) : 'none'} per session.`,
    `Settings: privacy ${settings.privacy}, auto mode ${settings.autoMode}, fallback model ${settings.fallbackModel}.`,
    await mainSessionLine($, mainModel),
    '',
    'Agents:',
    ...Object.entries(settings.agents).map(
      ([name, a]) =>
        `  ${name.padEnd(9)} ${a.model} · effort ${a.effort}${a.providers ? ` · providers ${a.providers.join(', ')}` : ''}${a.vision ? '' : ' · no images'}${overrides[name] ? ' · set with /locum use' : ''}`,
    ),
    '',
    'Spend history (all sessions):',
    ...spendLines(await readLedger($), await $.clock.now()),
  ]
  if (health.size) {
    const now = await $.clock.now()
    lines.push('', 'Model health this session:')
    for (const [model, h] of health) {
      const latency = h.ok ? ` · ${(h.ms / h.ok / 1000).toFixed(1)}s per step` : ''
      const failing = h.fails ? ` · ${h.fails} failed step${h.fails === 1 ? '' : 's'}${h.lastError ? ` (last: ${h.lastError.slice(0, 70)})` : ''}` : ''
      const skipping = h.skipUntil && h.skipUntil > now ? ` · skipped for ${Math.ceil((h.skipUntil - now) / 1000)}s more, steps go to the fallback` : ''
      lines.push(`  ${model}: ${h.ok} step${h.ok === 1 ? '' : 's'}${latency}${failing}${skipping}`)
    }
  }
  if (runs.length) {
    lines.push('', 'Runs this session (newest first):')
    for (const [, r] of runs.slice(0, 10)) {
      const flags = [r.isAuto ? 'auto mode' : '', r.isDone ? '' : 'running', r.fallbackSteps ? `${r.fallbackSteps} fallback steps` : ''].filter(Boolean)
      lines.push(
        `  ${r.name.padEnd(9)} ${r.steps} steps · ${usd(r.usd)}${r.providers.length ? ` · ${r.providers.join(', ')}` : ''}${flags.length ? ` · ${flags.join(', ')}` : ''}`,
        `            ${toolSummary(r.toolNames)}`,
      )
    }
    if (runs.length > 10) lines.push(`  …and ${runs.length - 10} earlier`)
  }
  lines.push('', '/locum help lists the subcommands. Settings: /plugin configure locum@ashar-local.')
  return lines.join('\n')
}
