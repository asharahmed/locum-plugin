import { expect, test } from 'claude-code/testing'
import { RETRYABLE, end, engine, sse, start, step, text, toolUse } from './helpers'

test('a Kimi-style tool id is cleaned, and the call streams through', async ($, on) => {
  engine(on, [sse([start(), ...toolUse(0, 'functions.Bash:0', 'Bash', { command: 'echo hi' }), ...end('tool_use')])], 'openrouter-agents:kimi')
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
  const requests = engine(on, ['{"error":{"message":"OpenRouter could not verify available credits for this request in time."}}\n__STATUS__402\n'])
  const { result } = await step($)
  expect(requests.length).toBe(1)
  expect(result.answer).toMatch(/balance is too low.*Top up at https:\/\/openrouter\.ai/)
})

test('a fallback setting equal to the agent\'s own model moves on to the next model', { options: { fallbackModel: 'deepseek/deepseek-v4.1-flash-1017' } }, async ($, on) => {
  const requests = engine(on, [RETRYABLE, RETRYABLE, RETRYABLE, sse([start(), ...text(0, 'ok'), ...end('end_turn')])], 'openrouter-agents:deepseek')
  const pending = step($)
  await requests.clock.settle()
  await requests.clock.advance(1000)
  await requests.clock.settle()
  await requests.clock.advance(2000)
  await pending
  expect(JSON.parse(requests[0]!).model).toBe('deepseek/deepseek-v4.1-flash-1017')
  expect(JSON.parse(requests[3]!).model).toBe('deepseek/deepseek-v4-flash-0731')
})
