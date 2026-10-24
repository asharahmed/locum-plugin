import { expect, test } from 'claude-code/testing'
import { AGENT_ID, end, engine, sse, start, step, text } from './helpers'

test('in auto mode the report reaches the completion notice, labelled', { options: { autoMode: 'allow' } }, async ($, on) => {
  engine(on, [sse([start(), ...text(0, 'All done: 3 files checked.'), ...end('end_turn')])])
  on('agent.spawn', () => ({ model: 'deepseek/deepseek-v4-flash-0731', agentId: AGENT_ID }))
  let delivered = ''
  on('prompt.submit', (_$: unknown, e: { text: string }) => {
    delivered = e.text
    return { text: e.text }
  })
  await $.agent.spawn({ prompt: 'check files', subagentType: 'openrouter-agents:cheap', permissionMode: 'auto' } as never)
  await step($)
  await $.prompt.submit({ text: `<task-notification><task-id>${AGENT_ID}</task-id><result>The subagent ended without delivering a report.</result></task-notification>`, origin: { kind: 'task-notification' } } as never)
  expect(delivered).toMatch(/Auto mode did not review this report/)
  expect(delivered).toMatch(/All done: 3 files checked\./)
  expect(delivered).toMatch(/Tool calls this run: none\./)
})
