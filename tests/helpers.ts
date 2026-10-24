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

const BASH = [{ name: 'Bash', description: 'Run a command', mcp: false }]

export function engine(on: any, replies: string[], type = 'locum:cheap', messages: object[] = TASK, store: Record<string, unknown> = {}, tools: object[] = BASH, sessionModel = 'claude-opus-5-5', env: Record<string, string> = {}) {
  const clock = mock.clock(on)
  mock.store(on, store)
  mock.env(on, {
    OPENROUTER_API_KEY: 'test-key',
    HOME: '/home/t',
    ANTHROPIC_MODEL: 'opus',
    ANTHROPIC_CUSTOM_MODEL_OPTION: 'deepseek/deepseek-v4.1-flash-1017',
    ...env,
  })
  on('session.model', () => ({ value: sessionModel }))
  on('agent.list', () => ({ value: [{ id: AGENT_ID, type, description: 'test', status: 'running' }] }))
  on('session.messages', () => ({ value: messages }))
  on('tool.list', () => ({ value: tools }))
  // The display calls the plugin makes; a headless engine answers them silently
  for (const call of ['ui.status', 'ui.log', 'ui.toast', 'ui.invalidate']) on(call, () => ({ value: undefined }))
  const requests: string[] = []
  // Each curl call's argv and environment, beside its body in `requests`
  const calls: { argv: string[]; env: Record<string, string> }[] = []
  on('process.spawn', async function* (_$: unknown, e: { input?: string; argv: string[]; env?: Record<string, string> }) {
    requests.push(e.input ?? '')
    calls.push({ argv: e.argv, env: e.env ?? {} })
    yield { stream: 'stdout', text: replies[Math.min(requests.length - 1, replies.length - 1)]! }
    return { value: { code: 0, signal: null } }
  })
  return Object.assign(requests, { clock, calls })
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

// Session start's calls: agent and command registration, and the model list
export function sessionStart(on: any, models: object[] = []) {
  on('session.start', (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('agent.register', (_$: unknown, e: { name: string }) => ({ value: { agent: `locum:${e.name}` } }))
  on('command.register', (_$: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('http.fetch', (_$: unknown, e: { url: string }) => ({
    value: e.url.endsWith('/models')
      ? { status: 200, ok: true, headers: {}, text: JSON.stringify({ data: models }) }
      : { status: 500, ok: false, headers: {}, text: '' },
  }))
}

export const MODELS = [
  { id: 'deepseek/deepseek-v4-flash-0731', pricing: { prompt: '0.000000044', completion: '0.000000133' }, context_length: 1048576, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'] },
  { id: 'openai/gpt-oss-20b', pricing: { prompt: '0.000000018', completion: '0.00000009' }, context_length: 131072, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools', 'reasoning'] },
  { id: 'google/gemma-4-26b-a4b-it', pricing: { prompt: '0.000000068', completion: '0.000000225' }, context_length: 262144, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
  { id: 'some/no-tools-model', pricing: { prompt: '0.00000001', completion: '0.00000001' }, supported_parameters: [] },
]
