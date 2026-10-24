import { expect, test } from 'claude-code/testing'
import { AGENT_ID, end, engine, sse, start, step, text, toolUse } from './helpers'

// What the model is sent, and the auto-mode report handling around it

const say = (t: string) => sse([start(), ...text(0, t), ...end('end_turn')])
const userBlocks = (...content: object[]) => [{ role: 'user', content }]

test('an image is replaced by a note for a model that can\'t read images', async ($, on) => {
  const requests = engine(on, [say('ok')], 'openrouter-agents:cheap', userBlocks({ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }))
  await step($)
  const content = JSON.parse(requests[0]!).messages[0].content
  expect(content.some((b: { type: string }) => b.type === 'image')).toBe(false)
  expect(JSON.stringify(content)).toMatch(/can't read images/)
})

test('an image goes as it is to a model that reads images', async ($, on) => {
  const requests = engine(on, [say('ok')], 'openrouter-agents:deepseek', userBlocks({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }))
  await step($)
  expect(JSON.parse(requests[0]!).messages[0].content[0].type).toBe('image')
})

test('ToolSearch results say which tools loaded and which can\'t be used', async ($, on) => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:WebFetch,mcp__x__y' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'tool_reference', tool_name: 'WebFetch' }, { type: 'tool_reference', tool_name: 'mcp__x__y' }] }] },
  ]
  const requests = engine(on, [say('ok')], 'openrouter-agents:cheap', messages)
  await step($)
  const body = JSON.parse(requests[0]!)
  const result = JSON.stringify(body.messages[2].content)
  expect(result).toMatch(/Loaded tool: WebFetch/)
  expect(result).toMatch(/mcp__x__y can't be used by this subagent/)
  // the loaded built-in is offered from this step on
  expect(body.tools.map((t: { name: string }) => t.name)).toContain('WebFetch')
})

test('the model-identity line names the OpenRouter model', async ($, on) => {
  const requests = engine(on, [say('ok')], 'openrouter-agents:kimi', userBlocks({ type: 'text', text: '<system-reminder>You are powered by the model named Opus 5.5. The exact model ID is claude-opus-5-5.</system-reminder>' }))
  await step($)
  const sent = JSON.stringify(JSON.parse(requests[0]!).messages)
  expect(sent).toMatch(/You are powered by the model named Kimi K3\. The exact model ID is moonshotai\/kimi-k3, reached through OpenRouter/)
  expect(sent).not.toMatch(/Opus 5\.5/)
})

test('SubagentHandback is offered only when Claude Code says the subagent has it', async ($, on) => {
  const requests = engine(on, [say('ok'), say('ok')], 'openrouter-agents:cheap', userBlocks({ type: 'text', text: 'Your final report is delivered through SubagentHandback.' }))
  await step($)
  expect(JSON.parse(requests[0]!).tools.map((t: { name: string }) => t.name)).toContain('SubagentHandback')
})

test('in auto mode a SubagentHandback call becomes the report, never a tool call', { options: { autoMode: 'allow' } }, async ($, on) => {
  engine(on, [sse([start(), ...toolUse(0, 'h1', 'SubagentHandback', { message: 'All checked.' }), ...end('tool_use')])], 'openrouter-agents:cheap', userBlocks({ type: 'text', text: 'Your final report is delivered through SubagentHandback.' }))
  on('agent.spawn', () => ({ model: 'deepseek/deepseek-v4-flash-0731', agentId: AGENT_ID }))
  let delivered = ''
  on('prompt.submit', (_$: unknown, e: { text: string }) => ((delivered = e.text), { text: e.text }))
  await $.agent.spawn({ prompt: 'x', subagentType: 'openrouter-agents:cheap', permissionMode: 'auto' } as never)
  const { chunks, result } = await step($)
  expect(chunks.some(c => c.kind === 'tool')).toBe(false)
  expect(result.toolUses).toHaveLength(0)
  await $.prompt.submit({ text: `<task-notification><task-id>${AGENT_ID}</task-id><result>none</result></task-notification>`, origin: { kind: 'task-notification' } } as never)
  expect(delivered).toMatch(/All checked\./)
})

test('auto mode: the engine\'s reminders are answered locally once a report is kept, after one nudge if no tools ran', { options: { autoMode: 'allow' } }, async ($, on) => {
  const reminder = [{ role: 'user', content: [{ type: 'text', text: '[handback-send-enforce] Your report has not been delivered.' }] }]
  const requests = engine(on, [say('My report.'), say('My report again.')], 'openrouter-agents:cheap', reminder)
  on('agent.spawn', () => ({ model: 'deepseek/deepseek-v4-flash-0731', agentId: AGENT_ID }))
  await $.agent.spawn({ prompt: 'x', subagentType: 'openrouter-agents:cheap', permissionMode: 'auto' } as never)
  await step($, 0) // the report, with no tool calls behind it
  await step($, 1) // first reminder: the nudge goes to the model
  expect(requests.length).toBe(2)
  expect(JSON.stringify(JSON.parse(requests[1]!).messages)).toMatch(/You have not made any tool calls/)
  const { result } = await step($, 2) // second reminder: answered locally
  expect(requests.length).toBe(2)
  expect(result.answer).toMatch(/My final report is my previous message/)
})

test('a mode change mid-run is seen from the next tool call', { options: { autoMode: 'allow' } }, async ($, on) => {
  engine(on, [say('x')], 'openrouter-agents:cheap')
  on('agent.spawn', () => ({ model: 'deepseek/deepseek-v4-flash-0731', agentId: AGENT_ID }))
  on('tool.check', () => ({ decision: 'ask' }))
  on('tool.call', () => ({ result: 'ran' }))
  on('classic.PostToolUse', () => ({}))
  await $.agent.spawn({ prompt: 'x', subagentType: 'openrouter-agents:cheap', permissionMode: 'default' } as never)
  await step($)
  const before: any = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: AGENT_ID } as never)
  expect(before.deny !== undefined || before.isError === true).toBe(true)
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1', agent_id: AGENT_ID, permission_mode: 'auto' } as never)
  const after: any = await $.tool.call({ tool: 'Bash', command: 'ls', agentId: AGENT_ID } as never)
  expect(after.deny).toBeUndefined()
  expect(after.isError).toBeUndefined()
})

test('the Agent call\'s effort sets the reasoning budget', async ($, on) => {
  const requests = engine(on, [say('ok')], 'openrouter-agents:kimi')
  on('agent.spawn', () => ({ model: 'moonshotai/kimi-k3', agentId: AGENT_ID }))
  // As the engine does: the Agent call starts the subagent while it runs
  on('tool.call', async (_$: unknown, e: { tool_use_id: string; subagent_type?: string }) => {
    await $.agent.spawn({ prompt: 'x', subagentType: e.subagent_type, tool_use_id: e.tool_use_id } as never)
    return { result: { status: 'async_launched', agentId: AGENT_ID } }
  })
  // Kimi's default effort is low (1,024 tokens); the call asks for high (8,000)
  await $.tool.call({ tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'openrouter-agents:kimi', effort: 'high' } as never)
  await step($)
  expect(JSON.parse(requests[0]!).thinking.budget_tokens).toBe(8000)
})
