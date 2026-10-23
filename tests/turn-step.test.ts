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
const TASK = [{ role: 'user', content: [{ type: 'text', text: 'Do the task.' }] }]

function engine(on: any, replies: string[], type = 'openrouter-agents:cheap', messages: object[] = TASK) {
  const clock = mock.clock(on)
  mock.env(on, { OPENROUTER_API_KEY: 'test-key', HOME: '/home/t' })
  on('agent.list', () => ({ value: [{ id: AGENT_ID, type, description: 'test', status: 'running' }] }))
  on('session.messages', () => ({ value: messages }))
  on('tool.list', () => ({ value: [{ name: 'Bash', description: 'Run a command', mcp: false }] }))
  // The display calls the plugin makes; a headless engine answers them silently
  for (const call of ['ui.status', 'ui.log', 'ui.toast', 'ui.invalidate']) on(call, () => ({ value: undefined }))
  const requests: string[] = []
  on('process.spawn', async function* (_$: unknown, e: { input?: string }) {
    requests.push(e.input ?? '')
    yield { stream: 'stdout', text: replies[Math.min(requests.length - 1, replies.length - 1)]! }
    return { value: { code: 0, signal: null } }
  })
  return Object.assign(requests, { clock })
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

const RETRYABLE = '{"error":{"message":"upstream overloaded"}}\n__STATUS__503\n'

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

test('/openrouter shows the balance, the agents and the runs', async ($, on) => {
  engine(on, [sse([start('Relace'), ...text(0, 'x'), ...end('end_turn', 0.0042)])])
  on('http.fetch', (_$: unknown, e: { url: string }) => ({
    value: {
      status: 200, ok: true, headers: {},
      text: e.url.endsWith('/credits') ? '{"data":{"total_credits":10,"total_usage":7.5}}' : '{"data":{"limit_remaining":4}}',
    },
  }))
  on('fs.read', () => ({ value: '{"version":"9.9.9"}' }))
  await step($)
  const out: any = await $.command.run({ command: 'openrouter', args: '' } as never)
  const shown = String(out.text ?? out.value?.text ?? '')
  expect(shown).toMatch(/^OpenRouter subagents 9\.9\.9$/m)
  expect(shown).toMatch(/\$2\.50 on the account/)
  expect(shown).toMatch(/cheap +deepseek\/deepseek-v4-flash-0731/)
  expect(shown).toMatch(/kimi +moonshotai\/kimi-k3 · effort low/)
  expect(shown).toMatch(/1 run, \$0\.0042 spent/)
  expect(shown).toMatch(/Relace/)
})

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
  await $.prompt.submit({ text: `<task-notification><task-id>${AGENT_ID}</task-id><result>The subagent ended without delivering a report.</result></task-notification>` } as never)
  expect(delivered).toMatch(/Auto mode did not review this report/)
  expect(delivered).toMatch(/All done: 3 files checked\./)
  expect(delivered).toMatch(/Tool calls this run: none\./)
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
