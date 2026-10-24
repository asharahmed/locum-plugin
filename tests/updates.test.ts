import { expect, mock, test } from 'claude-code/testing'
import { install, isNewer } from '../hooks/updates'
import { MODELS, sessionStart } from './helpers'

const RELEASE = { tag_name: 'v9.9.10', body: '- Routes by price\n- Updates', html_url: 'https://github.com/asharahmed/locum-plugin/releases/tag/v9.9.10' }

// A session start with Locum 9.9.9 installed, keeping the notices it shows
function setup(on: any, release: object | undefined = RELEASE) {
  const clock = mock.clock(on)
  mock.store(on, {})
  mock.env(on, { OPENROUTER_API_KEY: 'k', HOME: '/home/t' })
  sessionStart(on, MODELS, release ? { '/releases/latest': release } : {})
  on('fs.read', () => ({ value: '{"version":"9.9.9"}' }))
  const toasts: string[] = []
  on('ui.toast', (_$: unknown, e: any) => {
    toasts.push(String(e?.text ?? e?.message ?? e))
    return { value: undefined }
  })
  for (const call of ['ui.status', 'ui.log', 'ui.invalidate']) on(call, () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  return Object.assign(toasts, { clock })
}
const begin = ($: any) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false } as never)

test('versions compare numerically', async () => {
  expect(isNewer('1.2.0', '1.1.10')).toBe(true)
  expect(isNewer('v1.1.10', '1.1.9')).toBe(true)
  expect(isNewer('1.1.3', '1.1.3')).toBe(false)
  expect(isNewer('1.1.2', '1.1.3')).toBe(false)
  expect(isNewer('nonsense', '1.0.0')).toBe(false)
})

test('a newer release gets one notice, not one every session', async ($, on) => {
  const toasts = setup(on)
  await begin($)
  await toasts.clock.settle()
  expect(toasts.filter(t => /9\.9\.10 is out/.test(t))).toHaveLength(1)
  await begin($)
  await toasts.clock.settle()
  expect(toasts.filter(t => /9\.9\.10 is out/.test(t))).toHaveLength(1)
})

test('updates: off makes no check', { options: { updates: 'off' } }, async ($, on) => {
  const toasts = setup(on)
  await begin($)
  await toasts.clock.settle()
  expect(toasts.some(t => /is out/.test(t))).toBe(false)
})

test('/locum update shows what changed; only the person can install it', async ($, on) => {
  setup(on)
  await begin($)
  const shown = String(((await $.command.run({ command: 'locum', args: 'update' } as never)) as any).text)
  expect(shown).toMatch(/Locum 9\.9\.10 is out; you have 9\.9\.9/)
  expect(shown).toMatch(/Routes by price/)
  const byModel = String(((await $.command.run({ command: 'locum', args: 'update install', origin: { kind: 'plugin', name: 'x' } } as never)) as any).text)
  expect(byModel).toMatch(/Only you can install an update/)
})

test('/locum update says so when this is the latest release', async ($, on) => {
  setup(on, { ...RELEASE, tag_name: 'v9.9.9' })
  await begin($)
  const shown = String(((await $.command.run({ command: 'locum', args: 'update' } as never)) as any).text)
  expect(shown).toMatch(/9\.9\.9 is the latest release/)
})

test('installing refreshes the marketplace, then updates the plugin, and stops at a failure', async () => {
  const ran: string[][] = []
  let failAt = -1
  // Only the one call install makes, standing in for the engine
  const $ = {
    process: {
      spawn: ({ argv }: { argv: string[] }) =>
        (async function* () {
          ran.push(argv)
          yield { stream: 'stdout', text: 'ok' }
          return { code: ran.length - 1 === failAt ? 1 : 0, signal: null }
        })(),
    },
  }
  expect((await install($ as never)).ok).toBe(true)
  expect(ran).toEqual([
    ['claude', 'plugin', 'marketplace', 'update', 'asharahmed'],
    ['claude', 'plugin', 'update', 'locum@asharahmed'],
  ])
  ran.length = 0
  failAt = 0
  const failed = await install($ as never)
  expect(failed.ok).toBe(false)
  expect(ran).toHaveLength(1)
})
