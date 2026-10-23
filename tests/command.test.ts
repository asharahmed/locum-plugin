import { expect, test } from 'claude-code/testing'
import { end, engine, sse, start, step, text } from './helpers'

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
