// Direct routes to the labs' own Anthropic-compatible APIs, used ahead of
// OpenRouter for the models they serve when the `direct` option names them and
// their key is set. A direct request that fails goes to OpenRouter next.

export type Price = { input: number; cacheRead: number; output: number }

export type Provider = {
  id: string
  label: string
  // Anthropic-compatible base URL; `/v1/messages` is appended
  baseUrl: string
  keyEnv: string
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
    baseUrl: 'https://api.deepseek.com/anthropic',
    keyEnv: 'DEEPSEEK_API_KEY',
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
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyEnv: 'ZAI_API_KEY',
    auth: 'bearer',
    models: {
      'z-ai/glm-5.3': { id: 'glm-5.3', price: perM(1.4, 0.26, 4.4) },
      'z-ai/glm-5.3-flash': { id: 'glm-5.3-flash', price: perM(0.15, 0.03 /* est. */, 0.5) },
    },
  },
  dashscope: {
    id: 'dashscope',
    label: 'Alibaba Model Studio',
    // International default; a workspace URL can replace it (option `dashscopeBaseUrl`)
    baseUrl: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    keyEnv: 'DASHSCOPE_API_KEY',
    auth: 'bearer',
    models: {
      'qwen/qwen3.8-flash': { id: 'qwen3.8-flash', price: perM(0.15, 0.03 /* est. */, 0.47) },
      'qwen/qwen3.8-max-0902': { id: 'qwen3.8-max', price: perM(2, 0.4 /* est. */, 6) },
    },
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    keyEnv: 'MINIMAX_API_KEY',
    auth: 'bearer',
    models: {
      // MiniMax's docs and guides disagree on this ID; a wrong one falls to OpenRouter
      'minimax/minimax-m3.1-flash': { id: 'MiniMax-M3.1-Flash', price: perM(0.15, 0.015, 0.6) },
    },
  },
}

export type Route = { provider: Provider; model: string; price: Price; url: string }

// The direct route for an OpenRouter model ID, if an enabled provider with a
// key serves it; undefined means OpenRouter
export function directRoute(model: string, enabled: readonly string[], keys: Readonly<Record<string, string | undefined>>, baseUrls: Readonly<Record<string, string>> = {}): Route | undefined {
  for (const id of enabled) {
    const provider = PROVIDERS[id]
    const entry = provider?.models[model]
    if (!provider || !entry || !keys[provider.keyEnv]) continue
    const base = (baseUrls[id] || provider.baseUrl).replace(/\/+$/, '')
    return { provider, model: entry.id, price: entry.price, url: `${base}/v1/messages` }
  }
  return undefined
}

// The price of a direct route at this moment
export function priceNow(route: Route, now: Date): Price {
  const f = route.provider.priceFactor?.(now) ?? 1
  return { input: route.price.input * f, cacheRead: route.price.cacheRead * f, output: route.price.output * f }
}
