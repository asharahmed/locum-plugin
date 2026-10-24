// Direct routes to the labs' own Anthropic-compatible APIs, used ahead of
// OpenRouter for the models they serve when the `direct` option names them and
// their key is set. A direct request that fails goes to OpenRouter next.

export type Price = { input: number; cacheRead: number; output: number }

export type Provider = {
  id: string
  label: string
  // How OpenRouter names the lab among a model's providers (its listing there
  // carries the lab's own price)
  orName: string
  // Anthropic-compatible base URLs; `/v1/messages` is appended. Keys are bound
  // to a region, so a key the first refuses is tried at the others in turn.
  baseUrls: string[]
  keyEnv: string
  // The plugin option (stored in the keychain) that holds the key, and where to get one
  keyOption: string
  keyPage: string
  // What a key there is worth, for /locum setup
  why: string
  // How the key is sent: DeepSeek documents x-api-key, the others take a bearer token
  auth: 'x-api-key' | 'bearer'
  // OpenRouter model ID -> the provider's own model ID and USD-per-token price
  models: Record<string, { id: string; price: Price }>
  // A price multiplier at this moment (DeepSeek doubles its prices at peak hours)
  priceFactor?: (now: Date) => number
}

const perM = (input: number, cacheRead: number, output: number): Price => ({ input: input / 1e6, cacheRead: cacheRead / 1e6, output: output / 1e6 })

// DeepSeek's peak hours: 01:00-04:00 and 06:00-10:00 UTC, Monday to Friday
// (its docs also exempt Chinese public holidays, which this doesn't know)
export function deepseekPeak(now: Date) {
  const day = now.getUTCDay()
  const h = now.getUTCHours()
  return day >= 1 && day <= 5 && ((h >= 1 && h < 4) || (h >= 6 && h < 10))
}

// Prices from each lab's own pricing page (October 2026). Cached-input prices
// marked "est." weren't published and are estimates at a fifth of input.
export const PROVIDERS: Record<string, Provider> = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    orName: 'DeepSeek',
    baseUrls: ['https://api.deepseek.com/anthropic'],
    keyEnv: 'DEEPSEEK_API_KEY',
    keyOption: 'deepseekApiKey',
    keyPage: 'https://platform.deepseek.com/api_keys',
    why: 'the deepseek agent: a second route, taken when it costs less than OpenRouter',
    auth: 'x-api-key',
    models: {
      'deepseek/deepseek-v4.1-flash-1017': { id: 'deepseek-flash', price: perM(0.15, 0.003, 0.6) },
      'deepseek/deepseek-v4.1-flash': { id: 'deepseek-flash', price: perM(0.15, 0.003, 0.6) },
      'deepseek/deepseek-v4-pro-0813': { id: 'deepseek-v4-pro', price: perM(0.66, 0.022, 1.98) },
      'deepseek/deepseek-v4-pro': { id: 'deepseek-v4-pro', price: perM(0.66, 0.022, 1.98) },
    },
    priceFactor: now => (deepseekPeak(now) ? 2 : 1),
  },
  zai: {
    id: 'zai',
    label: 'Z.ai',
    orName: 'Z.AI',
    // International, then Zhipu's mainland endpoint; a GLM Coding Plan key works at the same URLs
    baseUrls: ['https://api.z.ai/api/anthropic', 'https://open.bigmodel.cn/api/anthropic'],
    keyEnv: 'ZAI_API_KEY',
    keyOption: 'zaiApiKey',
    keyPage: 'https://z.ai/manage-apikey/apikey-list',
    why: 'the glm agent: worth it with a GLM Coding Plan (then set direct to always), since OpenRouter hosts GLM for less per token',
    auth: 'bearer',
    models: {
      'z-ai/glm-5.3': { id: 'glm-5.3', price: perM(1.4, 0.26, 4.4) },
      'z-ai/glm-5.3-flash': { id: 'glm-5.3-flash', price: perM(0.15, 0.03 /* est. */, 0.5) },
    },
  },
  dashscope: {
    id: 'dashscope',
    label: 'Alibaba Model Studio',
    orName: 'Alibaba',
    // Singapore, Virginia, Beijing, Hong Kong, then the Coding Plan's host. A
    // workspace URL can replace them all (option `dashscopeBaseUrl`).
    baseUrls: [
      'https://dashscope-intl.aliyuncs.com/apps/anthropic',
      'https://dashscope-us.aliyuncs.com/apps/anthropic',
      'https://dashscope.aliyuncs.com/apps/anthropic',
      'https://cn-hongkong.dashscope.aliyuncs.com/apps/anthropic',
      'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
    ],
    keyEnv: 'DASHSCOPE_API_KEY',
    keyOption: 'dashscopeApiKey',
    keyPage: 'https://modelstudio.console.alibabacloud.com (API Key page)',
    why: 'the qwen agent; with zero-retention privacy it only runs this way (any region works)',
    auth: 'bearer',
    models: {
      'qwen/qwen3.8-flash': { id: 'qwen3.8-flash', price: perM(0.15, 0.03 /* est. */, 0.47) },
      'qwen/qwen3.8-max-0902': { id: 'qwen3.8-max', price: perM(2, 0.4 /* est. */, 6) },
    },
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    orName: 'Minimax',
    // International, then mainland China
    baseUrls: ['https://api.minimax.io/anthropic', 'https://api.minimaxi.com/anthropic'],
    keyEnv: 'MINIMAX_API_KEY',
    keyOption: 'minimaxApiKey',
    keyPage: 'https://platform.minimax.io (API Keys)',
    why: 'the minimax agent: a second route, taken when it costs less than OpenRouter',
    auth: 'bearer',
    models: {
      // MiniMax's docs and guides disagree on this ID; a wrong one falls to OpenRouter
      'minimax/minimax-m3.1-flash': { id: 'MiniMax-M3.1-Flash', price: perM(0.15, 0.015, 0.6) },
    },
  },
}

// `urls` are the endpoints to try, best first; `url` is the first
export type Route = { provider: Provider; model: string; price: Price; url: string; urls: string[] }

const messagesUrl = (base: string) => `${base.replace(/\/+$/, '')}/v1/messages`

// The direct route for an OpenRouter model ID, if an enabled provider with a
// key serves it; undefined means OpenRouter. `working` holds the endpoint that
// last took each provider's key, tried first.
export function directRoute(
  model: string,
  enabled: readonly string[],
  keys: Readonly<Record<string, string | undefined>>,
  baseUrls: Readonly<Record<string, string>> = {},
  working: Readonly<Record<string, string>> = {},
): Route | undefined {
  for (const id of enabled) {
    const provider = PROVIDERS[id]
    const entry = provider?.models[model]
    if (!provider || !entry || !keys[provider.keyEnv]) continue
    const all = baseUrls[id] ? [messagesUrl(baseUrls[id]!)] : provider.baseUrls.map(messagesUrl)
    const first = working[id] && all.includes(working[id]!) ? working[id]! : all[0]!
    const urls = [first, ...all.filter(u => u !== first)]
    return { provider, model: entry.id, price: entry.price, url: first, urls }
  }
  return undefined
}

// The price of a direct route at this moment
export function priceNow(route: Route, now: Date): Price {
  const f = route.provider.priceFactor?.(now) ?? 1
  return { input: route.price.input * f, cacheRead: route.price.cacheRead * f, output: route.price.output * f }
}
