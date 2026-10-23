import { expect, mock, test } from 'claude-code/testing'
import { end, engine, sse, start, step, text } from './helpers'

test('another plugin\'s subagent is looked up once, then passed through', async ($, on) => {
  mock.clock(on)
  let lookups = 0
  on('agent.list', () => {
    lookups++
    return { value: [{ id: 'native1', type: 'general-purpose', description: 'x', status: 'running' }] }
  })
  let beneath = 0
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    beneath++
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  for (const index of [0, 1, 2]) {
    const s = $.turn.step({ turnId: 't', index, model: 'claude-opus-5-5', messageCount: 1, agentId: 'native1' } as never)
    for (let r = await s.next(); !r.done; r = await s.next()) {}
  }
  expect(beneath).toBe(3)
  expect(lookups).toBe(1)
})

test('a run of an agent the settings no longer have stops instead of falling to the session model', async ($, on) => {
  const requests = engine(on, [sse([start(), ...text(0, 'x'), ...end('end_turn')])], 'openrouter-agents:custom')
  const { result } = await step($)
  expect(requests.length).toBe(0)
  expect(result.answer).toMatch(/no longer configured/)
})
