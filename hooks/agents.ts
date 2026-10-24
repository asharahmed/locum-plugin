// The agents this plugin answers, and how the plugin's options shape them.

export type AgentDef = {
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
// can be changed in /plugin configure (`<name>Model`, `<name>Effort`). Provider
// pins are the cheapest zero-retention providers measured on 2026-10-23.
export const DEFAULT_AGENTS: Record<string, AgentDef> = {
  deepseek: {
    model: 'deepseek/deepseek-v4.1-flash-1017',
    label: 'DeepSeek V4.1 Flash',
    vision: true,
    effort: 'medium',
    // These two cache prompts; unpinned, runs landed on a provider that didn't
    // (a cached second call cost ~1/12 of the first)
    providers: ['deepinfra', 'cloudflare'],
    when: 'Default OpenRouter subagent for delegated coding, research and multi-step tasks; cheap, fast, 1M context.',
  },
  kimi: {
    model: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    vision: true,
    // Its output costs ~$10.80 per million tokens, and reasoning is output
    effort: 'low',
    // Cheapest zero-retention providers (first call ~$0.0023 against Fireworks'
    // $0.0147), then the cheapest once cached
    providers: ['wafer', 'inference-net', 'sail-research'],
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
    // Cheapest zero-retention providers, both caching (first call ~$0.0003
    // against CoreWeave's $0.0009)
    providers: ['relace', 'reka'],
    when: 'Very low cost ($0.044/$0.133 per million tokens). Use when the user asks for the cheap agent, or for tests and simple tasks.',
  },
}

// The model a step moves to when its own keeps failing on OpenRouter (never a
// Claude model: the point of these agents is that their steps stay off Anthropic)
export const DEFAULT_FALLBACK = 'deepseek/deepseek-v4-flash-0731'
export const FALLBACK_FOR_FALLBACK = 'deepseek/deepseek-v4.1-flash-1017'

// The first fallback that isn't the failing model itself
export function fallbackModelFor(model: string, configured: string) {
  return [configured, DEFAULT_FALLBACK, FALLBACK_FOR_FALLBACK].find(m => m !== model) ?? FALLBACK_FOR_FALLBACK
}

// The `privacy` option as OpenRouter provider preferences: refuse providers that
// may store or train on prompts, or allow zero-data-retention providers only
export const PRIVACY: Record<string, Record<string, unknown>> = {
  off: {},
  'no-data-collection': { data_collection: 'deny' },
  'zero-retention': { zdr: true },
}

export type Settings = {
  agents: Record<string, AgentDef>
  autoMode: string
  privacy: string
  privacyPrefs: Record<string, unknown>
  lowBalanceUsd: number
  maxRunUsd: number
  maxSessionUsd: number
  fallbackModel: string
}

// Everything the options decide: each default agent with its model and effort
// options applied, the free `custom` slot when it names a model, and the limits
export function readSettings(options: Readonly<Record<string, unknown>>): Settings {
  const opt = (key: string) => (typeof options[key] === 'string' ? (options[key] as string).trim() : '')
  const amount = (key: string, fallback: number) => {
    const v = Number(options[key] ?? fallback)
    return Number.isFinite(v) && v >= 0 ? v : fallback
  }
  // No prototype, so a name like `constructor` or `__proto__` is just a missing agent
  const agents: Record<string, AgentDef> = Object.create(null)
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
  const privacy = opt('privacy') || 'zero-retention'
  return {
    agents,
    autoMode: opt('autoMode') || 'refuse',
    privacy,
    privacyPrefs: PRIVACY[privacy] ?? PRIVACY['zero-retention']!,
    lowBalanceUsd: amount('lowBalanceUsd', 5),
    maxRunUsd: amount('maxRunUsd', 0.5),
    maxSessionUsd: amount('maxSessionUsd', 3),
    fallbackModel: opt('fallbackModel') || DEFAULT_FALLBACK,
  }
}

// The run key of the main session when it runs on an OpenRouter model
export const MAIN_RUN = 'main-session'

// An OpenRouter model ID: Claude Code's own model IDs have no "/" (a Bedrock ARN
// is the only other kind that does)
export function isOpenRouterModel(model: string | undefined): model is string {
  return !!model && model.includes('/') && !model.startsWith('arn:')
}

// The definition for a loop that runs on an OpenRouter model it was given rather
// than one of the plugin's agents: the main session after /model, or a subagent
// that inherited that model. A default agent's model keeps its label and pins.
export function loopAgent(model: string, vision: boolean): AgentDef {
  const known = Object.values(DEFAULT_AGENTS).find(a => a.model === model)
  return { model, label: known?.label ?? model, when: '', vision, effort: 'medium', ...(known?.providers ? { providers: known.providers } : {}) }
}

// The agent's name inside `openrouter-agents:<name>`, or '' for any other type
export function agentName(subagentType: string | undefined, plugin: string) {
  return subagentType?.startsWith(`${plugin}:`) ? subagentType.slice(plugin.length + 1) : ''
}
