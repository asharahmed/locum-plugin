import { expect, mock, test } from 'claude-code/testing'

// Recorded-stream tests: each hook on `on` stands for the engine beneath the
// plugin, and process.spawn answers with OpenRouter SSE text in place of curl.

const AGENT_ID = 'a1'
const CWD = '/home/t/proj'

const sse = (events: object[], status = 200) =>
  events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + `\n__STATUS__${status}\n`

const start = (provider = 'TestProvider') => ({ type: 'message_start', message: { model: 'm', provider, usage: { input_tokens: 10, output_tokens: 0 } } })
const text = (index: number, t: string) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index },
]
const toolUse = (index: number, id: string, name: string, input: object) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index },
]
const end = (stop_reason: string, cost = 0.001) => [
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5, cost } },
  { type: 'message_stop' },
]

// The engine as one of the plugin's agents sees it: an agent `a1` of the given
// type, a one-message conversation, Bash as the only tool, and curl's output
// taken from `replies`, one per request
function engine(on: any, replies: string[], type = 'openrouter-agents:cheap') {
  mock.env(on, { OPENROUTER_API_KEY: 'test-key', HOME: '/home/t' })
  on('agent.list', () => ({ value: [{ id: AGENT_ID, type, description: 'test', status: 'running' }] }))
  on('session.messages', () => ({ value: [{ role: 'user', content: [{ type: 'text', text: 'Do the task.' }] }] }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Run a command', mcp: false }] }))
  // The display calls the plugin makes; a headless engine answers them silently
  for (const call of ['ui.status', 'ui.log', 'ui.toast', 'ui.invalidate']) on(call, () => ({ value: undefined }))
  const requests: string[] = []
  on('process.spawn', async function* (_$: unknown, e: { input?: string }) {
    requests.push(e.input ?? '')
    yield { stream: 'stdout', text: replies[Math.min(requests.length - 1, replies.length - 1)]! }
    return { value: { code: 0, signal: null } }
  })
  return requests
}

async function step($: any, index = 0) {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1, agentId: AGENT_ID })
  const chunks: any[] = []
  for (let r = await stream.next(); ; r = await stream.next()) {
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

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
  const clock = mock.clock(on)
  const requests = engine(on, [
    '{"error":{"message":"rate limited"}}\n__STATUS__429\n',
    sse([start(), ...text(0, 'ok after retry'), ...end('end_turn')]),
  ])
  const pending = step($)
  await clock.settle()
  await clock.advance(1000)
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

test('a run over its spend cap stops without another request', { options: { maxRunUsd: 0.001 } }, async ($, on) => {
  const requests = engine(on, [sse([start(), ...toolUse(0, 'call_1', 'Bash', { command: 'ls' }), ...end('tool_use', 0.002)])])
  await step($, 0)
  const { result } = await step($, 1)
  expect(requests.length).toBe(1)
  expect(result.answer).toMatch(/spend cap of \$0\.0010/)
})

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
