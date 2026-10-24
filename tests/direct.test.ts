import { expect, test } from 'claude-code/testing'
import { deepseekPeak, directRoute, priceNow } from '../hooks/providers'
import { MODELS, end, engine, sessionStart, sse, start, step, text } from './helpers'

const OK = sse([start('DeepSeek'), ...text(0, 'done'), ...end('end_turn', 0)])
const DIRECT = { options: { direct: 'deepseek, zai' } }
const begin = ($: any) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false } as never)

test('a model a direct provider serves goes to that lab, with its own model ID and key', DIRECT, async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'ds-key' })
  sessionStart(on, MODELS)
  await begin($)
  const { result } = await step($)
  expect(result.answer).toBe('done')
  expect(requests.length).toBe(1)
  const { argv, env } = requests.calls[0]!
  expect(argv.at(-1)).toBe('https://api.deepseek.com/anthropic/v1/messages')
  expect(argv).toContain('x-api-key: {{LOCUM_KEY}}')
  // The key is passed in the environment, never on the command line
  expect(env.LOCUM_KEY).toBe('ds-key')
  expect(argv.join(' ')).not.toMatch(/ds-key/)
  const body = JSON.parse(requests[0]!)
  expect(body.model).toBe('deepseek-flash')
  expect(body.provider).toBeUndefined()
})

test('Z.ai takes a bearer token', DIRECT, async ($, on) => {
  const requests = engine(on, [OK], 'locum:glm', undefined, {}, undefined, undefined, { ZAI_API_KEY: 'z-key' })
  sessionStart(on, MODELS)
  await begin($)
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://api.z.ai/api/anthropic/v1/messages')
  expect(requests.calls[0]!.argv).toContain('authorization: Bearer {{LOCUM_KEY}}')
  expect(JSON.parse(requests[0]!).model).toBe('glm-5.3')
})

test('a failed direct request is retried on OpenRouter with the same model', DIRECT, async ($, on) => {
  const refused = '{"error":{"message":"Authentication Fails, Your api key is invalid"}}\n__STATUS__401\n'
  const requests = engine(on, [refused, OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'bad' })
  sessionStart(on, MODELS)
  await begin($)
  const { result } = await step($)
  expect(result.answer).toBe('done')
  expect(requests.length).toBe(2)
  expect(requests.calls[1]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
  expect(requests.calls[1]!.env.LOCUM_KEY).toBe('test-key')
  expect(JSON.parse(requests[1]!).model).toBe('deepseek/deepseek-v4.1-flash-1017')
})

test('without its key, or without the option, a model goes through OpenRouter', DIRECT, async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek')
  sessionStart(on, MODELS)
  await begin($)
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
  expect(directRoute('deepseek/deepseek-v4.1-flash-1017', [], { DEEPSEEK_API_KEY: 'k' })).toBeUndefined()
  // A model no enabled provider serves stays on OpenRouter too
  expect(directRoute('moonshotai/kimi-k3', ['deepseek'], { DEEPSEEK_API_KEY: 'k' })).toBeUndefined()
})

test('/locum names each agent\'s route and the providers missing a key', DIRECT, async ($, on) => {
  engine(on, [], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS)
  await begin($)
  const out = String(((await $.command.run({ command: 'locum', args: '' } as never)) as any).text)
  expect(out).toMatch(/deepseek .*direct via DeepSeek \(deepseek-flash\), then OpenRouter/)
  expect(out).toMatch(/no key for zai \(set ZAI_API_KEY\)/)
})

test('DeepSeek doubles its price at peak hours, and a workspace URL replaces Alibaba\'s default', async () => {
  // Wednesday 07:00 UTC is peak; Saturday at the same hour is not
  expect(deepseekPeak(new Date('2026-10-21T07:00:00Z'))).toBe(true)
  expect(deepseekPeak(new Date('2026-10-24T07:00:00Z'))).toBe(false)
  expect(deepseekPeak(new Date('2026-10-21T04:30:00Z'))).toBe(false)
  const route = directRoute('deepseek/deepseek-v4.1-flash-1017', ['deepseek'], { DEEPSEEK_API_KEY: 'k' })!
  expect(priceNow(route, new Date('2026-10-21T07:00:00Z')).output * 1e6).toBe(1.2)
  expect(priceNow(route, new Date('2026-10-24T07:00:00Z')).output * 1e6).toBe(0.6)
  const qwen = directRoute('qwen/qwen3.8-flash', ['dashscope'], { DASHSCOPE_API_KEY: 'k' }, { dashscope: 'https://ws1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/' })!
  expect(qwen.url).toBe('https://ws1.ap-southeast-1.maas.aliyuncs.com/apps/anthropic/v1/messages')
  expect(qwen.model).toBe('qwen3.8-flash')
})
