import { expect, test } from 'claude-code/testing'
import { RETRYABLE, end, engine, sse, start, step, text, toolUse } from './helpers'

test('a Kimi-style tool id is cleaned, and the call streams through', async ($, on) => {
  engine(on, [sse([start(), ...toolUse(0, 'functions.Bash:0', 'Bash', { command: 'echo hi' }), ...end('tool_use')])], 'locum:kimi')
  const { chunks, result } = await step($)
  const tool = chunks.find(c => c.kind === 'tool')
  expect(tool.id).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(tool.name).toBe('Bash')
  expect(chunks.filter(c => c.kind === 'input').map(c => c.json).join('')).toBe('{"command":"echo hi"}')
  expect(result.stopReason).toBe('tool_use')
  expect(result.toolUses).toEqual([{ name: 'Bash', input: { command: 'echo hi' } }])
})

test('the request carries the privacy and provider preferences', async ($, on) => {
  const requests = engine(on, [sse([start(), ...text(0, 'done'), ...end('end_turn')])])
  await step($)
  const body = JSON.parse(requests[0]!)
  expect(body.model).toBe('deepseek/deepseek-v4-flash-0731')
  expect(body.provider).toEqual({ order: ['relace', 'reka'], allow_fallbacks: true, zdr: true })
  expect(body.stream).toBe(true)
})

test('a 429 before any output is retried', async ($, on) => {
  const requests = engine(on, [
    '{"error":{"message":"rate limited"}}\n__STATUS__429\n',
    sse([start(), ...text(0, 'ok after retry'), ...end('end_turn')]),
  ])
  const pending = step($)
  await requests.clock.settle()
  await requests.clock.advance(1000)
  const { result } = await pending
  expect(requests.length).toBe(2)
  expect(result.answer).toBe('ok after retry')
})

test('a model with no provider meeting the privacy setting fails clearly', async ($, on) => {
  engine(on, ['{"error":{"message":"No endpoints found matching your data policy (Zero data retention)."}}\n__STATUS__404\n'])
  const { result } = await step($)
  expect(result.answer).toMatch(/privacy setting "zero-retention"/)
  expect(result.stopReason).toBe('end_turn')
})

test('a stream cut off mid-reply keeps what arrived', async ($, on) => {
  engine(on, [sse([start(), ...text(0, 'partial answer'), { type: 'error', error: { message: 'upstream reset' } }])])
  const { result } = await step($)
  expect(result.answer).toMatch(/^partial answer/)
  expect(result.answer).toMatch(/stream ended early: upstream reset/)
  expect(result.stopReason).toBe('end_turn')
})

test('a step whose model keeps failing is answered by the fallback model', async ($, on) => {
  const requests = engine(on, [RETRYABLE, RETRYABLE, RETRYABLE, sse([start('Fallback'), ...text(0, 'fallback answer'), ...end('end_turn')])])
  const pending = step($)
  await requests.clock.settle()
  await requests.clock.advance(1000)
  await requests.clock.settle()
  await requests.clock.advance(2000)
  const { result } = await pending
  expect(requests.length).toBe(4)
  expect(JSON.parse(requests[0]!).model).toBe('deepseek/deepseek-v4-flash-0731')
  // cheap's own model is the default fallback, so it moves to the second choice
  expect(JSON.parse(requests[3]!).model).toBe('deepseek/deepseek-v4.1-flash-1017')
  expect(JSON.parse(requests[3]!).provider).toEqual({ zdr: true })
  expect(result.answer).toBe('fallback answer')
})

test('a low balance gets the top-up message and no fallback', async ($, on) => {
  const requests = engine(on, ['{"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits"}}\n__STATUS__402\n'])
  const { result } = await step($)
  expect(requests.length).toBe(1)
  expect(result.answer).toMatch(/balance is too low.*Top up at https:\/\/openrouter\.ai/)
})

test('a fallback setting equal to the agent\'s own model moves on to the next model', { options: { fallbackModel: 'deepseek/deepseek-v4.1-flash-1017' } }, async ($, on) => {
  const requests = engine(on, [RETRYABLE, RETRYABLE, RETRYABLE, sse([start(), ...text(0, 'ok'), ...end('end_turn')])], 'locum:deepseek')
  const pending = step($)
  await requests.clock.settle()
  await requests.clock.advance(1000)
  await requests.clock.settle()
  await requests.clock.advance(2000)
  await pending
  expect(JSON.parse(requests[0]!).model).toBe('deepseek/deepseek-v4.1-flash-1017')
  expect(JSON.parse(requests[3]!).model).toBe('deepseek/deepseek-v4-flash-0731')
})

const CREDIT_CHECK = '{"error":{"message":"OpenRouter could not verify available credits for this request in time. Retry shortly."}}\n__STATUS__429\n'

test('a credit-check failure is retried with a lower output cap', async ($, on) => {
  const requests = engine(on, [CREDIT_CHECK, sse([start(), ...text(0, 'passed the check'), ...end('end_turn')])], 'locum:kimi')
  const pending = step($)
  await requests.clock.settle()
  await requests.clock.advance(1000)
  const { result } = await pending
  expect(requests.length).toBe(2)
  const [first, second] = requests.map(r => JSON.parse(r))
  expect(second.max_tokens).toBe(first.max_tokens / 2)
  expect(second.thinking.budget_tokens).toBeLessThan(second.max_tokens)
  expect(result.answer).toBe('passed the check')
})

test('a credit check that never passes ends with the low-balance advice', async ($, on) => {
  const requests = engine(on, [CREDIT_CHECK], 'locum:kimi')
  const pending = step($)
  for (const ms of [1000, 2000, 1000, 2000]) {
    await requests.clock.settle()
    await requests.clock.advance(ms)
  }
  const { result } = await pending
  // three tries on Kimi, then three on the fallback model
  expect(requests.length).toBe(6)
  expect(JSON.parse(requests[3]!).model).toBe('deepseek/deepseek-v4-flash-0731')
  expect(result.answer).toMatch(/couldn't confirm the balance.*top up/)
})

test('a model that keeps failing is skipped for a while, so steps go straight to the fallback', async ($, on) => {
  const ok = sse([start(), ...text(0, 'fallback answer'), ...end('end_turn')])
  // three steps: each fails three times on its own model, then the fallback answers
  const replies = [RETRYABLE, RETRYABLE, RETRYABLE, ok, RETRYABLE, RETRYABLE, RETRYABLE, ok, RETRYABLE, RETRYABLE, RETRYABLE, ok, ok]
  const requests = engine(on, replies)
  for (const index of [0, 1, 2]) {
    const pending = step($, index)
    for (const ms of [1000, 2000]) {
      await requests.clock.settle()
      await requests.clock.advance(ms)
    }
    await pending
  }
  expect(requests.length).toBe(12)
  // the fourth step skips the failing model: one request, to the fallback
  const { result } = await step($, 3)
  expect(requests.length).toBe(13)
  expect(JSON.parse(requests[12]!).model).toBe('deepseek/deepseek-v4.1-flash-1017')
  expect(result.answer).toBe('fallback answer')
  const out: any = await $.command.run({ command: 'locum', args: '' } as never)
  expect(String(out.text)).toMatch(/deepseek\/deepseek-v4-flash-0731 via OpenRouter: 0 steps · 3 failed steps .*skipped for \d+s more/)
})
