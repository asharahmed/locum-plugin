import { expect, test } from 'claude-code/testing'
import { deepseekPeak, directRoute, priceNow } from '../hooks/providers'
import { MODELS, end, engine, sessionStart, sse, start, step, text } from './helpers'

const OK = sse([start('DeepSeek'), ...text(0, 'done'), ...end('end_turn', 0)])
// Direct is on by default: any lab with a key
const DIRECT = {}
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

test('a refused key goes on to OpenRouter with the same model, and isn\'t tried again', DIRECT, async ($, on) => {
  const refused = '{"error":{"message":"Authentication Fails, Your api key is invalid"}}\n__STATUS__401\n'
  const requests = engine(on, [refused, OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'bad' })
  sessionStart(on, MODELS)
  await begin($)
  const { result } = await step($)
  expect(result.answer).toBe('done')
  expect(requests.length).toBe(2)
  expect(requests.calls[1]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
  expect(requests.calls[1]!.env.LOCUM_KEY).toBe('test-key')
  expect(JSON.parse(requests[1]!).model).toBe('deepseek/deepseek-v4.1-flash-1017')  // The refused key isn't tried again this session
  await step($, 1)
  expect(requests.length).toBe(3)
  expect(requests.calls[2]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
})

test('without its key a model goes through OpenRouter', DIRECT, async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek')
  sessionStart(on, MODELS)
  await begin($)
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
  expect(directRoute('deepseek/deepseek-v4.1-flash-1017', [], { DEEPSEEK_API_KEY: 'k' })).toBeUndefined()
  // A model no enabled provider serves stays on OpenRouter too
  expect(directRoute('moonshotai/kimi-k3', ['deepseek'], { DEEPSEEK_API_KEY: 'k' })).toBeUndefined()
})

test('/locum names each agent\'s route and which keys are set', DIRECT, async ($, on) => {
  engine(on, [], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS)
  await begin($)
  const out = String(((await $.command.run({ command: 'locum', args: '' } as never)) as any).text)
  expect(out).toMatch(/deepseek .*direct via DeepSeek \(deepseek-flash\), then OpenRouter/)
  expect(out).toMatch(/Keys: OpenRouter set · DeepSeek set · Z\.ai not set/)
  expect(out).toMatch(/\/locum setup says how/)
  expect(out).toMatch(/privacy setting doesn't cover them/)
})

test('a key entered in the config dialog is used ahead of the environment\'s', { options: { deepseekApiKey: 'from-dialog' } }, async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'from-env' })
  sessionStart(on, MODELS)
  await begin($)
  await step($)
  expect(requests.calls[0]!.env.LOCUM_KEY).toBe('from-dialog')
})

test('with direct off, a lab key is left unused', { options: { direct: 'off' } }, async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS)
  await begin($)
  await step($)
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://openrouter.ai/api/v1/messages')
})

test('a key one region refuses is tried at the next, and the one that took it is used from then on', { options: { dashscopeApiKey: 'beijing-key' } }, async ($, on) => {
  const refused = '{"error":{"message":"Invalid API-key provided."}}\n__STATUS__401\n'
  const requests = engine(on, [refused, refused, OK, OK], 'locum:qwen')
  sessionStart(on, MODELS)
  await begin($)
  const { result } = await step($)
  expect(result.answer).toBe('done')
  const hosts = requests.calls.map(c => new URL(c.argv.at(-1)!).host)
  expect(hosts).toEqual(['dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'dashscope.aliyuncs.com'])
  await step($, 1)
  expect(new URL(requests.calls[3]!.argv.at(-1)!).host).toBe('dashscope.aliyuncs.com')
})

test('with only a lab\'s key, its models run and the others say which key to add', async ($, on) => {
  const requests = engine(on, [OK], 'locum:deepseek', undefined, {}, undefined, undefined, { OPENROUTER_API_KEY: '', DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS)
  await begin($)
  const { result } = await step($)
  expect(result.answer).toBe('done')
  expect(requests.calls[0]!.argv.at(-1)).toBe('https://api.deepseek.com/anthropic/v1/messages')
})

test('with no key at all, a step says where to add one and sends nothing', async ($, on) => {
  const requests = engine(on, [OK], 'locum:kimi', undefined, {}, undefined, undefined, { OPENROUTER_API_KEY: '' })
  sessionStart(on, MODELS)
  await begin($)
  const { result } = await step($)
  expect(requests.length).toBe(0)
  expect(result.answer).toMatch(/plugin configure locum@ashar-local/)
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

test('/locum setup marks which keys are set and says where to get the others', async ($, on) => {
  engine(on, [], 'locum:deepseek', undefined, {}, undefined, undefined, { DEEPSEEK_API_KEY: 'k' })
  sessionStart(on, MODELS)
  await begin($)
  const out = String(((await $.command.run({ command: 'locum', args: 'setup' } as never)) as any).text)
  expect(out).toMatch(/\[set\] +OpenRouter API key/)
  expect(out).toMatch(/\[set\] +DeepSeek API key/)
  expect(out).toMatch(/\[not set\] Alibaba Model Studio API key: .*https:\/\/modelstudio/)
  expect(out).toMatch(/--values-stdin/)
})
