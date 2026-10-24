import { expect, test } from 'claude-code/testing'
import { end, engine, sse, start, text, toolUse } from './helpers'

// The main session and inherited subagents on an OpenRouter model (`/model <id>`)

const LUNA = 'openai/gpt-6-luna'
const TOOLS = [
  { name: 'Bash', description: 'Run a command', mcp: false },
  { name: 'Agent', description: 'Start a subagent', mcp: false },
  { name: 'AskUserQuestion', description: 'Ask the user', mcp: false },
  { name: 'mcp__finance__quote', description: 'A quote', mcp: true },
]

async function mainStep($: any, model = LUNA, agentId?: string) {
  const stream = $.turn.step({ turnId: 'm1', index: 0, model, messageCount: 1, ...(agentId ? { agentId } : {}) })
  const chunks: any[] = []
  for (let r = await stream.next(); ; r = await stream.next()) {
    if (r.done) return { chunks, result: r.value }
    chunks.push(r.value)
  }
}

test('the main session on an OpenRouter model is answered through OpenRouter, with every built-in tool', async ($, on) => {
  const requests = engine(on, [sse([start(), ...toolUse(0, 'c1', 'Agent', { description: 'x', prompt: 'y' }), ...end('tool_use')])], undefined, undefined, undefined, TOOLS)
  const { result } = await mainStep($)
  expect(requests.length).toBe(1)
  const body = JSON.parse(requests[0]!)
  expect(body.model).toBe(LUNA)
  expect(body.tools.map((t: { name: string }) => t.name).sort()).toEqual(['Agent', 'AskUserQuestion', 'Bash'])
  // nothing captured from Claude Code yet: the plain fallback prompt
  expect(body.system[0].text).toMatch(/You are Claude Code/)
  expect(result.toolUses[0].name).toBe('Agent')
})

test('the main session on a Claude model passes straight through', async ($, on) => {
  const requests = engine(on, [])
  let beneath = 0
  on('turn.step', async function* (_$: unknown, e: { turnId: string; index: number }) {
    beneath++
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await mainStep($, 'claude-opus-5-5')
  expect(beneath).toBe(1)
  expect(requests.length).toBe(0)
})

test('a built-in subagent that inherited an OpenRouter model gets the subagent tool set', async ($, on) => {
  const requests = engine(on, [sse([start(), ...text(0, 'done'), ...end('end_turn')])], 'general-purpose', undefined, undefined, TOOLS)
  await mainStep($, LUNA, 'a1')
  const body = JSON.parse(requests[0]!)
  expect(body.model).toBe(LUNA)
  expect(body.tools.map((t: { name: string }) => t.name)).toEqual(['Bash'])
  expect(body.system[0].text).toMatch(/You are a subagent in Claude Code/)
})

test("the main session keeps Claude Code's own system prompt, with the model named", async ($, on) => {
  const requests = engine(on, [sse([start(), ...text(0, 'hi'), ...end('end_turn')])])
  on('prompt.compose', () => ({
    sections: [
      { id: 'intro', text: 'You are Claude Code, the real prompt.', scope: 'shared' },
      { id: 'env', text: 'You are powered by the model named Opus 5.5.', scope: 'session' },
    ],
  }))
  await $.prompt.compose({ model: LUNA, promptModel: LUNA, surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  await mainStep($)
  const system = JSON.parse(requests[0]!).system[0].text
  expect(system).toMatch(/the real prompt/)
  expect(system).toMatch(/You are powered by the model named openai\/gpt-6-luna/)
  expect(system).not.toMatch(/Opus 5\.5/)
})

test('the main session in auto mode is refused unless autoMode allows it', async ($, on) => {
  const requests = engine(on, [sse([start(), ...text(0, 'hi'), ...end('end_turn')])])
  on('classic.UserPromptSubmit', () => ({}))
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: 'auto' } as never)
  const { result } = await mainStep($)
  expect(requests.length).toBe(0)
  expect(result.answer).toMatch(/auto mode can't review openai\/gpt-6-luna/)
})

test('a conversation on an OpenRouter model is compacted by the same model', async ($, on) => {
  const requests = engine(on, [
    sse([start(), ...text(0, 'hi'), ...end('end_turn')]),
    sse([start(), ...text(0, 'The user is building a parser; tests pass.'), ...end('end_turn')]),
  ])
  await mainStep($)
  const compacted: any = await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user', text: 'build a parser', toolUses: [] }, { role: 'assistant', text: 'done', toolUses: [] }],
  } as never)
  expect(requests.length).toBe(2)
  expect(JSON.parse(requests[1]!).model).toBe(LUNA)
  expect(compacted.messages[0].text).toMatch(/building a parser; tests pass/)
})
