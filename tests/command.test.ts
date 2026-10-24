import { expect, test } from 'claude-code/testing'
import { MODELS, end, engine, sessionStart, sse, start, step, text } from './helpers'

test('/locum shows the balance, the agents and the runs', async ($, on) => {
  engine(on, [sse([start('Relace'), ...text(0, 'x'), ...end('end_turn', 0.0042)])])
  on('http.fetch', (_$: unknown, e: { url: string }) => ({
    value: {
      status: 200, ok: true, headers: {},
      text: e.url.endsWith('/credits') ? '{"data":{"total_credits":10,"total_usage":7.5}}' : '{"data":{"limit_remaining":4}}',
    },
  }))
  on('fs.read', () => ({ value: '{"version":"9.9.9"}' }))
  await step($)
  const out: any = await $.command.run({ command: 'locum', args: '' } as never)
  const shown = String(out.text ?? out.value?.text ?? '')
  expect(shown).toMatch(/^Locum 9\.9\.9: Claude Code agents on other labs' models$/m)
  expect(shown).toMatch(/\$2\.50 on the account/)
  expect(shown).toMatch(/cheap +deepseek\/deepseek-v4-flash-0731/)
  expect(shown).toMatch(/kimi +moonshotai\/kimi-k3 · effort low/)
  expect(shown).toMatch(/1 run, \$0\.0042 spent/)
  expect(shown).toMatch(/Relace/)
  expect(shown).toMatch(/Main session: claude-opus-5-5\. \/model picker entry: deepseek\/deepseek-v4\.1-flash-1017\. New sessions start on opus/)
})

test('the spend history adds up across steps and shows per agent', async ($, on) => {
  engine(on, [sse([start(), ...text(0, 'x'), ...end('end_turn', 0.003)])])
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }))
  on('fs.read', () => ({ value: '{"version":"0.8.0"}' }))
  await step($, 0)
  await step($, 1)
  const out: any = await $.command.run({ command: 'locum', args: '' } as never)
  const shown = String(out.text ?? '')
  expect(shown).toMatch(/Today: +\$0\.0060 \(cheap \$0\.0060\)/)
  expect(shown).toMatch(/Last 7 days: +\$0\.0060/)
})

test('/locum models lists tool-capable models, cheapest first', async ($, on) => {
  engine(on, [])
  sessionStart(on, MODELS)
  const out: any = await $.command.run({ command: 'locum', args: 'models' } as never)
  const rows = String(out.text ?? '').split('\n').filter(l => l.startsWith('  ') && l.includes('/'))
  expect(rows[0]).toMatch(/^  openai\/gpt-oss-20b/)
  expect(rows.join('\n')).not.toMatch(/no-tools-model/)
  expect(rows.find(r => r.includes('gemma'))).toMatch(/images/)
  const filtered: any = await $.command.run({ command: 'locum', args: 'models gemma' } as never)
  expect(String(filtered.text).split('\n').filter(l => l.startsWith('  ') && l.includes('/'))).toHaveLength(1)
})

test('/locum use checks the model, and the choice applies at the next session start', async ($, on) => {
  const requests = engine(on, [sse([start(), ...text(0, 'x'), ...end('end_turn')])])
  sessionStart(on, MODELS)
  const unknown: any = await $.command.run({ command: 'locum', args: 'use cheap nobody/nothing' } as never)
  expect(String(unknown.text)).toMatch(/OpenRouter has no model "nobody\/nothing"/)
  const noTools: any = await $.command.run({ command: 'locum', args: 'use cheap some/no-tools-model' } as never)
  expect(String(noTools.text)).toMatch(/doesn't support tool calls/)
  const set: any = await $.command.run({ command: 'locum', args: 'use cheap openai/gpt-oss-20b' } as never)
  expect(String(set.text)).toMatch(/after \/reload-plugins/)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false } as never)
  await step($)
  const body = JSON.parse(requests[0]!)
  expect(body.model).toBe('openai/gpt-oss-20b')
  // a model other than the default isn't pinned to the default's providers
  expect(body.provider).toEqual({ zdr: true })
})

test('/locum help lists the subcommands', async ($, on) => {
  engine(on, [])
  const out: any = await $.command.run({ command: 'locum', args: 'help' } as never)
  expect(String(out.text)).toMatch(/\/locum models \[search\]/)
  expect(String(out.text)).toMatch(/\/locum use <agent> <model>/)
})
