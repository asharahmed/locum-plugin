import { expect, test } from 'claude-code/testing'
import { AGENT_ID, CWD, end, engine, sse, start, step, text } from './helpers'

test('a path refused to Write is refused to Bash too, however it is spelled', async ($, on) => {
  engine(on, [sse([start(), ...text(0, 'x'), ...end('end_turn')])])
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.register', (_$: unknown, e: { name: string }) => ({ value: { agent: `openrouter-agents:${e.name}` } }))
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  on('tool.call', (_$: unknown, e: { tool: string }) => (e.tool === 'Write' ? { deny: 'Permission to write denied' } : { result: {} }))
  await $.session.start({ cwd: CWD, surface: null, isInteractive: false } as never)
  await step($)
  await $.tool.call({ tool: 'Write', file_path: '/home/t/secret.txt', content: 'x', agentId: AGENT_ID } as never)
  const viaTilde: any = await $.tool.call({ tool: 'Bash', command: 'cat ~/secret.txt', agentId: AGENT_ID } as never)
  const viaCd: any = await $.tool.call({ tool: 'Bash', command: 'cd .. && cat ../secret.txt', agentId: AGENT_ID } as never)
  const unrelated: any = await $.tool.call({ tool: 'Bash', command: 'ls /home/t', agentId: AGENT_ID } as never)
  expect(String(viaTilde.text ?? viaTilde.deny)).toMatch(/was refused to a file tool/)
  expect(String(viaCd.text ?? viaCd.deny)).toMatch(/was refused to a file tool/)
  expect(unrelated.deny).toBeUndefined()
})
