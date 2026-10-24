// One model request to OpenRouter's Anthropic-compatible endpoint, streamed
// through curl and passed on as the turn.step chunks Claude Code expects.

import type { EngineInterface, TurnStepToolUse, TurnStopReason } from 'claude-code'
import { HANDBACK_TOOL, safeToolId } from './messages'

export const OPENROUTER = 'https://openrouter.ai/api/v1'
// Waits before retrying a 429/5xx/network error that came before any output;
// a hook's sleeps count against its 10 s budget
const RETRY_WAITS_MS = [1000, 2000]
const CONTEXT_ERROR = /context (length|window)|too many tokens|prompt is too long|maximum context/i
// OpenRouter's answer when no provider meets the privacy setting
const POLICY_ERROR = /No endpoints found matching your data policy/i
// OpenRouter's answers when the balance can't cover the request
const CREDITS_ERROR = /insufficient credits|requires more credits|add more credits/i
// OpenRouter's timing check against a request's worst-case cost ("could not verify
// available credits for this request in time. Retry shortly"): it trips when the
// balance is low and requests arrive together, and passes on a retry, more so
// with a smaller output cap
const CREDIT_CHECK = /could not verify available credits/i
// OpenRouter's answers for a model ID it doesn't know (a typo in /model, say);
// its data-policy answer also says "No endpoints found", so that one is checked first
const UNKNOWN_MODEL = /is not a valid model ID|model not found|No endpoints found for /i
// The smallest output cap a credit-check retry lowers max_tokens to
const MIN_MAX_TOKENS = 4096

// One server-sent event of a streamed Messages API reply
type StreamEvent = {
  type: string
  index?: number
  message?: { model?: string; usage?: Record<string, unknown>; provider?: string }
  content_block?: { type: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string | null }
  usage?: Record<string, unknown>
  error?: { message?: string }
}

export type Failure = {
  // policy: no provider meets the privacy setting; context: the conversation is
  // too long; credits: the balance is too low; creditCheck: OpenRouter couldn't
  // confirm the balance covers the request in time, through every retry;
  // retryable: 429/5xx/network that outlasted the retries; other: anything else
  // unknownModel: OpenRouter doesn't know the model ID
  kind: 'policy' | 'context' | 'credits' | 'creditCheck' | 'unknownModel' | 'retryable' | 'other' | 'interrupted'
  message: string
  // The HTTP status, when there was one
  status?: number
}

export type StepOutcome = {
  // Something was passed on to the engine (a failed step can't be retried then)
  yielded: boolean
  answer: string
  stopReason: TurnStopReason
  toolUses: TurnStepToolUse[]
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
  model: string
  cost: number
  provider?: string
  // An auto-mode SubagentHandback call's message, kept as the report
  handbackReport?: string
  failure?: Failure
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0)

// Streamed usage arrives in pieces (message_start, then message_delta); keep the largest seen
function addUsage(into: Record<string, number>, from: Record<string, unknown> | undefined) {
  for (const k of Object.keys(into)) into[k] = Math.max(into[k] ?? 0, num(from?.[k]))
}

function classify(errorText: string, status: number): Failure['kind'] {
  if (CREDIT_CHECK.test(errorText)) return 'creditCheck'
  if (POLICY_ERROR.test(errorText)) return 'policy'
  if (UNKNOWN_MODEL.test(errorText)) return 'unknownModel'
  if (CONTEXT_ERROR.test(errorText)) return 'context'
  if (CREDITS_ERROR.test(errorText) || status === 402) return 'credits'
  if (status === 0 || status === 429 || status >= 500 || (status === 200 && errorText !== '')) return 'retryable'
  return 'other'
}

export type StepRequest = {
  key: string
  // Where the request goes and how the key is sent: OpenRouter by default, or a
  // lab's own Anthropic-compatible API (see providers.ts)
  url?: string
  auth?: 'bearer' | 'x-api-key'
  body: Record<string, unknown>
  // In auto mode a SubagentHandback call becomes text and the report
  isAuto: boolean
  signal: AbortSignal
  // Each content block index as it starts (for the error handler's next index)
  onBlock: (index: number) => void
  onRetry: (why: string) => void
}

// Streams one request. Yields text, thinking and tool chunks as they arrive and
// resolves to what happened; a failure before any output is returned, not shown.
export async function* streamStep($: EngineInterface, req: StepRequest) {
  const out: StepOutcome = {
    yielded: false,
    answer: '',
    stopReason: null,
    toolUses: [],
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    model: String(req.body.model),
    cost: 0,
  }
  // Per content block: its tool call (if any) and the argument JSON so far
  const blocks = new Map<number, { tool?: { id: string; name: string }; json: string; handback?: true }>()
  // Rebuilt when a credit-check retry lowers the output cap
  const body = { ...req.body }

  for (let attempt = 0; ; attempt++) {
    // curl streams the SSE reply; $.http.fetch returns only whole bodies and
    // gives up after 30 s. The key goes in through the environment, not argv.
    const child = $.process.spawn({
      argv: [
        'curl', '-sSN', '--variable', '%LOCUM_KEY',
        '--expand-header', req.auth === 'x-api-key' ? 'x-api-key: {{LOCUM_KEY}}' : 'authorization: Bearer {{LOCUM_KEY}}',
        '-H', 'content-type: application/json',
        '-H', 'anthropic-version: 2023-06-01',
        '--data-binary', '@-',
        '-w', '\n__STATUS__%{http_code}\n',
        req.url ?? `${OPENROUTER}/messages`,
      ],
      env: { LOCUM_KEY: req.key },
      input: JSON.stringify(body),
    })

    let buffer = ''
    let status = 0
    let errorText = ''
    let sawStream = false
    const events: StreamEvent[] = []
    const take = (line: string) => {
      if (line.startsWith('data: ')) {
        try {
          events.push(JSON.parse(line.slice(6)) as StreamEvent)
          sawStream = true
        } catch {
          errorText += line
        }
      } else if (line.startsWith('__STATUS__')) {
        status = Number(line.slice(10))
      } else if (line.trim() && !line.startsWith('event: ') && !line.startsWith(':')) {
        errorText += line
      }
    }

    for await (const chunk of child) {
      if (req.signal.aborted) break
      if (chunk.stream === 'stderr') {
        errorText += chunk.text
        continue
      }
      buffer += chunk.text
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(take)

      for (const ev of events.splice(0)) {
        if (ev.type === 'message_start') {
          out.model = ev.message?.model ?? out.model
          if (ev.message?.provider) out.provider = ev.message.provider
          addUsage(out.usage, ev.message?.usage)
        } else if (ev.type === 'content_block_start' && ev.index !== undefined) {
          const cb = ev.content_block
          req.onBlock(ev.index)
          if (req.isAuto && cb?.type === 'tool_use' && cb.name === HANDBACK_TOOL.name) {
            // Never reaches the classifier: its message is kept as the report
            blocks.set(ev.index, { json: '', handback: true })
          } else if (cb?.type === 'tool_use' && cb.id && cb.name) {
            const id = safeToolId(cb.id, ev.index)
            blocks.set(ev.index, { tool: { id, name: cb.name }, json: '' })
            out.yielded = true
            yield { kind: 'tool' as const, index: ev.index, id, name: cb.name }
          } else {
            blocks.set(ev.index, { json: '' })
          }
        } else if (ev.type === 'content_block_delta' && ev.index !== undefined) {
          const d = ev.delta
          if (d?.type === 'text_delta' && d.text) {
            out.answer += d.text
            out.yielded = true
            yield { kind: 'text' as const, index: ev.index, text: d.text }
          } else if (d?.type === 'thinking_delta' && d.thinking) {
            out.yielded = true
            yield { kind: 'thinking' as const, index: ev.index, text: d.thinking }
          } else if (d?.type === 'input_json_delta' && d.partial_json) {
            const b = blocks.get(ev.index)
            if (b?.handback) b.json += d.partial_json
            else if (b?.tool) {
              b.json += d.partial_json
              yield { kind: 'input' as const, index: ev.index, json: d.partial_json }
            }
          }
        } else if (ev.type === 'content_block_stop' && ev.index !== undefined) {
          const b = blocks.get(ev.index)
          if (b?.handback) {
            let message = ''
            try {
              message = String((JSON.parse(b.json || '{}') as { message?: unknown }).message ?? '')
            } catch {}
            if (message.trim()) {
              out.handbackReport = message.trim()
              out.answer += message
              out.yielded = true
              yield { kind: 'text' as const, index: ev.index, text: message }
            }
          } else if (b?.tool) {
            if (!b.json) {
              b.json = '{}'
              yield { kind: 'input' as const, index: ev.index, json: '{}' }
            }
            let parsed: unknown = {}
            try {
              parsed = JSON.parse(b.json)
            } catch {}
            out.toolUses.push({ name: b.tool.name, input: parsed })
          }
        } else if (ev.type === 'message_delta') {
          out.stopReason = (ev.delta?.stop_reason ?? out.stopReason) as TurnStopReason
          addUsage(out.usage, ev.usage)
          out.cost = Math.max(out.cost, num(ev.usage?.cost))
        } else if (ev.type === 'error') {
          errorText += ev.error?.message ?? 'stream error'
        }
      }
    }
    if (buffer) take(buffer)

    if (req.signal.aborted) return { ...out, failure: { kind: 'interrupted' as const, message: 'interrupted' } }
    const failed = status >= 400 || !sawStream || (errorText !== '' && out.stopReason === null)
    if (!failed) return out
    if (out.yielded) {
      // Cut off mid-reply: keep what arrived and let the run go on. A tool call
      // whose arguments never finished fails like a model's broken JSON would,
      // and the next step sees that error.
      const note = `\n\n[OpenRouter stream ended early: ${errorText.slice(0, 200) || `HTTP ${status || '?'}`}]`
      out.answer += note
      yield { kind: 'text' as const, index: Math.max(-1, ...blocks.keys()) + 1, text: note }
      return out
    }
    const kind = classify(errorText, status)
    const message = `HTTP ${status || '?'}: ${errorText.slice(0, 300) || 'no reply'}`
    if ((kind !== 'retryable' && kind !== 'creditCheck') || attempt >= RETRY_WAITS_MS.length) return { ...out, failure: { kind, message, status } }
    if (kind === 'creditCheck') {
      // Halve the worst case OpenRouter checks the balance against
      const cap = Math.max(MIN_MAX_TOKENS, Math.floor(Number(body.max_tokens ?? MIN_MAX_TOKENS * 2) / 2))
      body.max_tokens = cap
      const thinking = body.thinking as { type: string; budget_tokens: number } | undefined
      if (thinking) body.thinking = { ...thinking, budget_tokens: Math.max(1024, Math.min(thinking.budget_tokens, cap - 2048)) }
      req.onRetry('a credit check (lowering the output cap)')
    } else req.onRetry(`HTTP ${status || 'network error'}`)
    await $.clock.sleep(RETRY_WAITS_MS[attempt] ?? 1000)
  }
}

// OpenRouter's account balance and this key's remaining limit; undefined where unknown
// Where a key is entered: the plugin's config dialog, which keeps it in the keychain
export const CONFIGURE = '/plugin configure locum@asharahmed'
export const NO_KEY = `no OpenRouter key: add one in ${CONFIGURE} (or set OPENROUTER_API_KEY)`

// The OpenRouter key: the one entered in the config dialog, else the environment's
export async function openRouterKey($: EngineInterface, keys: Readonly<Record<string, string>>) {
  return keys.OPENROUTER_API_KEY || (await $.env.get('OPENROUTER_API_KEY'))
}

export async function balanceOf($: EngineInterface, key: string) {
  const headers = { authorization: `Bearer ${key}` }
  const [credits, keyInfo] = await Promise.all([
    $.http.fetch(`${OPENROUTER}/credits`, { headers }),
    $.http.fetch(`${OPENROUTER}/key`, { headers }),
  ])
  const c = credits.ok ? JSON.parse(credits.text).data : undefined
  const k = keyInfo.ok ? JSON.parse(keyInfo.text).data : undefined
  const account: number | undefined = c ? num(c.total_credits) - num(c.total_usage) : undefined
  const keyLeft: number | undefined = typeof k?.limit_remaining === 'number' ? k.limit_remaining : undefined
  return { account, keyLeft }
}

// One request run to the end with nothing shown: its text, or the failure
export async function completeText($: EngineInterface, key: string, body: Record<string, unknown>, signal: AbortSignal) {
  const stream = streamStep($, { key, body, isAuto: false, signal, onBlock: () => {}, onRetry: () => {} })
  for (;;) {
    const r = await stream.next()
    if (r.done) return r.value
  }
}
