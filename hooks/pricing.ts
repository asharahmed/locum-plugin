// Which route serves a step more cheaply: OpenRouter or the lab's own API.
// Prices come from OpenRouter's endpoint lists at session start; the lab's own
// price is OpenRouter's listing of the lab as a provider (OpenRouter charges the
// lab's per-token price there), else the table in providers.ts.

import type { EngineInterface } from 'claude-code'
import { OPENROUTER } from './openrouter'
import type { Price, Route } from './providers'

// OpenRouter's fee on credit purchases, paid on everything that goes through it
export const OPENROUTER_FEE = 0.055

// The cost of a typical agent step per input token: most of the prompt is the
// cached prefix of the conversation so far, and the reply is short beside it
export const stepCost = (p: Price) => 0.25 * p.input + 0.75 * p.cacheRead + 0.05 * p.output

export type Endpoint = { provider: string; price: Price }

const num = (v: unknown) => (v === undefined || v === null || v === '' ? NaN : Number(v))

// OpenRouter's endpoint rows ({model_id, provider_name, pricing}) by model ID.
// A row without a usable input and output price is left out.
export function endpointsByModel(rows: readonly unknown[]): Map<string, Endpoint[]> {
  const out = new Map<string, Endpoint[]>()
  for (const row of rows) {
    const r = row as { model_id?: unknown; provider_name?: unknown; pricing?: Record<string, unknown> }
    if (typeof r.model_id !== 'string' || typeof r.provider_name !== 'string') continue
    const input = num(r.pricing?.prompt)
    const output = num(r.pricing?.completion)
    if (!Number.isFinite(input) || !Number.isFinite(output)) continue
    const cache = num(r.pricing?.input_cache_read)
    const list = out.get(r.model_id) ?? []
    list.push({ provider: r.provider_name, price: { input, output, cacheRead: Number.isFinite(cache) ? cache : input } })
    out.set(r.model_id, list)
  }
  return out
}

// 'DeepInfra', 'deepinfra' and 'Sail Research' / 'sail-research' name the same provider
export const sameProvider = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]/g, '') === b.toLowerCase().replace(/[^a-z0-9]/g, '')

// What OpenRouter will most likely charge: an agent pinned to providers goes to
// the first of them that qualifies, anything else to the cheapest that does
export function openRouterEndpoint(endpoints: readonly Endpoint[] | undefined, pins?: readonly string[]): Endpoint | undefined {
  if (!endpoints?.length) return undefined
  for (const pin of pins ?? []) {
    const found = endpoints.find(e => sameProvider(e.provider, pin))
    if (found) return found
  }
  return [...endpoints].sort((a, b) => stepCost(a.price) - stepCost(b.price))[0]
}

// The lab's own listing among a model's endpoints
export const labEndpoint = (endpoints: readonly Endpoint[] | undefined, labName: string) => endpoints?.find(e => sameProvider(e.provider, labName))

export type Choice = {
  // Direct first (then OpenRouter), or OpenRouter first (then direct)
  directFirst: boolean
  // The step cost per million input tokens of each, when known, for /locum
  directPerM?: number
  openRouterPerM?: number
  openRouterProvider?: string
  why: string
}

// Which route goes first for one step. `direct` is the lab's price at this
// moment (peak pricing applied); `openRouter` what OpenRouter would charge,
// before its fee; undefined when no endpoint qualifies or prices are unknown.
export function choose(mode: 'cheapest' | 'always', direct: Price, openRouter: Endpoint | undefined, hasOpenRouterKey: boolean): Choice {
  const directPerM = stepCost(direct) * 1e6
  const openRouterPerM = openRouter ? stepCost(openRouter.price) * (1 + OPENROUTER_FEE) * 1e6 : undefined
  const known = { directPerM, ...(openRouterPerM !== undefined ? { openRouterPerM, openRouterProvider: openRouter!.provider } : {}) }
  if (!hasOpenRouterKey) return { directFirst: true, ...known, why: 'no OpenRouter key' }
  if (mode === 'always') return { directFirst: true, ...known, why: 'direct is set to always' }
  if (openRouterPerM === undefined) return { directFirst: true, ...known, why: 'no OpenRouter provider qualifies, or its prices are unknown' }
  return directPerM <= openRouterPerM
    ? { directFirst: true, ...known, why: 'cheaper direct' }
    : { directFirst: false, ...known, why: `cheaper through OpenRouter (${openRouter!.provider})` }
}

// A route with its price replaced by a live one
export const withPrice = (route: Route, price: Price | undefined): Route => (price ? { ...route, price } : route)

// Each routable model's prices from OpenRouter's public endpoint lists: the
// providers that meet the privacy setting into `orEndpoints`, the lab's own
// listing into `labPrices`. OpenRouter lists its zero-retention endpoints; under
// no-data-collection that list is a subset of what qualifies, so OpenRouter may
// come out a little dearer than it is.
export async function loadPrices(
  $: EngineInterface,
  models: readonly { model: string; labName: string }[],
  privacyFiltered: boolean,
  orEndpoints: Map<string, Endpoint[]>,
  labPrices: Map<string, Price>,
) {
  if (!models.length) return
  const wanted = new Set(models.map(m => m.model))
  if (privacyFiltered) {
    const zdr = await $.http.fetch(`${OPENROUTER}/endpoints/zdr`)
    if (zdr.ok) for (const [m, list] of endpointsByModel((JSON.parse(zdr.text) as { data: unknown[] }).data)) if (wanted.has(m)) orEndpoints.set(m, list)
  }
  for (const { model, labName } of models) {
    const res = await $.http.fetch(`${OPENROUTER}/models/${model}/endpoints`)
    if (!res.ok) continue
    const list = endpointsByModel((JSON.parse(res.text) as { data: { endpoints: unknown[] } }).data.endpoints).get(model) ?? []
    if (!privacyFiltered) orEndpoints.set(model, list)
    const lab = labEndpoint(list, labName)
    if (lab) labPrices.set(model, lab.price)
  }
}
