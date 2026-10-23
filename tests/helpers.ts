import { mock } from 'claude-code/testing'

// Shared stand-ins for the tests: each hook on `on` stands for the engine beneath
// the plugin, and process.spawn answers with OpenRouter SSE text in place of curl.

export const AGENT_ID = 'a1'
export const CWD = '/home/t/proj'

export const sse = (events: object[], status = 200) =>
  events.map(e => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('') + `\n__STATUS__${status}\n`

export const start = (provider = 'TestProvider') => ({ type: 'message_start', message: { model: 'm', provider, usage: { input_tokens: 10, output_tokens: 0 } } })
export const text = (index: number, t: string) => [
  { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index },
]
export const toolUse = (index: number, id: string, name: string, input: object) => [
  { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index },
]
export const end = (stop_reason: string, cost = 0.001) => [
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5, cost } },
  { type: 'message_stop' },
]

// The engine as one of the plugin's agents sees it: an agent `a1` of the given
// type, a one-message conversation, Bash as the only tool, and curl's output
// taken from `replies`, one per request
export const TASK = [{ role: 'user', content: [{ type: 'text', text: 'Do the task.' }] }]

export function engine(on: any, replies: string[], type = 'openrouter-agents:cheap', messages: object[] = TASK) {
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

export async function step($: any, index = 0) {
  const stream = $.turn.step({ turnId: 't1', index, model: 'claude-opus-5-5', messageCount: 1, agentId: AGENT_ID })
  const chunks: any[] = []
  for (let r = await stream.next(); ; r = await stream.next()) {
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

export const RETRYABLE = '{"error":{"message":"upstream overloaded"}}\n__STATUS__503\n'
