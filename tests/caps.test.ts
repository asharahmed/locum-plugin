import { expect, test } from 'claude-code/testing'
import { end, engine, sse, start, step, text, toolUse } from './helpers'

test('a run over its spend cap stops without another request', { options: { maxRunUsd: 0.001 } }, async ($, on) => {
  const requests = engine(on, [sse([start(), ...toolUse(0, 'call_1', 'Bash', { command: 'ls' }), ...end('tool_use', 0.002)])])
  await step($, 0)
  const { result } = await step($, 1)
  expect(requests.length).toBe(1)
  expect(result.answer).toMatch(/spend cap of \$0\.0010/)
})

test('the session cap stops a run', { options: { maxSessionUsd: 0.001, maxRunUsd: 0 } }, async ($, on) => {
  const requests = engine(on, [sse([start(), ...toolUse(0, 'call_1', 'Bash', { command: 'ls' }), ...end('tool_use', 0.002)])])
  await step($, 0)
  const { result } = await step($, 1)
  expect(requests.length).toBe(1)
  expect(result.answer).toMatch(/session cap/)
})

test('a capped run hands back through SubagentHandback when Claude Code offers it', { options: { maxRunUsd: 0.001 } }, async ($, on) => {
  const offered = [{ role: 'user', content: [{ type: 'text', text: 'Do the task.' }, { type: 'text', text: 'Your final report is delivered through SubagentHandback.' }] }]
  const requests = engine(on, [sse([start(), ...toolUse(0, 'call_1', 'Bash', { command: 'ls' }), ...end('tool_use', 0.002)])], 'openrouter-agents:cheap', offered)
  await step($, 0)
  const { chunks, result } = await step($, 1)
  expect(requests.length).toBe(1)
  expect(chunks.find(c => c.kind === 'tool')?.name).toBe('SubagentHandback')
  expect(result.toolUses[0].input.message).toMatch(/spend cap/)
})
