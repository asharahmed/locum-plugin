import { expect, test } from 'claude-code/testing'
import { choose, endpointsByModel, openRouterEndpoint, stepCost } from '../hooks/pricing'
import { directRoute, priceNow } from '../hooks/providers'
import { MODELS, end, endpoint, engine, sessionStart, sse, start, step, text } from './helpers'

const DS = 'deepseek/deepseek-v4.1-flash-1017'
const OK = sse([start(), ...text(0, 'done'), ...end('end_turn', 0)])
const begin = ($: any) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false } as never)
// OpenRouter's endpoint lists: the zero-retention one, and the model's own (with DeepSeek's listing)
const prices = (deepinfraIn: number, deepinfraOut: number) => ({
  '/endpoints/zdr': { data: [endpoint(DS, 'DeepInfra', deepinfraIn, deepinfraOut, deepinfraIn / 10), endpoint(DS, 'Fireworks', 0.3, 1.2)] },
  [`/models/${DS}/endpoints`]: { data: { endpoints: [endpoint(DS, 'DeepSeek', 0.15, 0.6, 0.003), endpoint(DS, 'DeepInfra', 0.08, 0.24)] } },
})

test('a step goes through OpenRouter first when its qualifying provider is cheaper than the lab', async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS, prices(0.02, 0.1))
  await begin($)
  await requests.clock.settle()
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
  const out = String(((await $.command.run({ command: 'locum', args: '' } as never)) as any).text)
  expect(out).toMatch(/deepseek .*OpenRouter \(DeepInfra\) \$0\.\d+, then DeepSeek direct \$0\.070 \(cheaper through OpenRouter \(DeepInfra\)\)/)
})

test('a step goes to the lab first when it is cheaper, at the price OpenRouter lists for the lab', async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS, prices(1, 4))
  await begin($)
  await requests.clock.settle()
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://api.deepseek.com/anthropic/v1/messages')
})

test('when OpenRouter goes first and fails, the lab answers the step', async ($, on) => {
  const policy = '{"error":{"message":"No endpoints found matching your data policy (Zero data retention)"}}\n__STATUS__404\n'
  const requests = engine(on, [policy, OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS, prices(0.02, 0.1))
  await begin($)
  await requests.clock.settle()
  const { result } = await step($)
  expect(result.answer).toBe('done')
  expect(requests.calls.map(c => new URL(c.argv.at(-1)!).host)).toEqual(['openrouter.ai', 'api.deepseek.com'])
})

test('direct: always sends a step to the lab first whatever the prices', { options: { direct: 'always' } }, async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS, prices(0.02, 0.1))
  await begin($)
  await requests.clock.settle()
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://api.deepseek.com/anthropic/v1/messages')
})

test('a main session on a lab model compacts through the lab when there is no OpenRouter key', async ($, on) => {
  const summary = sse([start(), ...text(0, 'The user is building a parser.'), ...end('end_turn', 0)])
  const requests = engine(on, [summary], undefined, undefined, {}, undefined, DS, { OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS)
  await begin($)
  const compacted: any = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'build a parser', toolUses: [] }] } as never)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://api.deepseek.com/anthropic/v1/messages')
  expect(JSON.parse(requests[0]!).model).toBe('deepseek-flash')
  expect(compacted.messages[0].text).toMatch(/building a parser/)
})

test('prices: pins match OpenRouter\'s provider names, peak hours can flip the choice, and the fee counts', async () => {
  const list = endpointsByModel([endpoint(DS, 'Sail Research', 0.1, 0.15), endpoint(DS, 'Relace', 0.07, 0.5), { model_id: DS, provider_name: 'Broken', pricing: {} }]).get(DS)!
  expect(list).toHaveLength(2)
  expect(openRouterEndpoint(list, ['sail-research'])!.provider).toBe('Sail Research')
  expect(openRouterEndpoint(list)!.provider).toBe('Relace')
  const route = directRoute(DS, ['deepseek'], { DEEPSEEK_API_KEY: 'k' })!
  const rival = { provider: 'Rival', price: { input: 0.15e-6, cacheRead: 0.01e-6, output: 0.6e-6 } }
  // Off-peak DeepSeek beats an OpenRouter provider at about its price, once the fee is added
  expect(choose('cheapest', priceNow(route, new Date('2026-10-24T12:00:00Z')), rival, true).directFirst).toBe(true)
  // At peak (Wednesday 07:00 UTC) DeepSeek doubles, and OpenRouter goes first
  expect(choose('cheapest', priceNow(route, new Date('2026-10-21T07:00:00Z')), rival, true).directFirst).toBe(false)
  // No OpenRouter key, or no qualifying provider: the lab
  expect(choose('cheapest', route.price, rival, false).directFirst).toBe(true)
  expect(choose('cheapest', route.price, undefined, true).directFirst).toBe(true)
  expect(stepCost({ input: 1, cacheRead: 0, output: 0 })).toBe(0.25)
})
