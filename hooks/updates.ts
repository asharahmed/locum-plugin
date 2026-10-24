// New releases: checking GitHub for one, and installing it through Claude Code's
// own plugin commands. Installing only ever happens because the person asked:
// they typed `/locum update install`, or chose `updates: auto` in the settings.

import type { EngineInterface } from 'claude-code'

export const REPO = 'asharahmed/claude-locum'
export const MARKETPLACE = 'asharahmed'
export const PLUGIN_ID = 'locum@asharahmed'
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`
// Checked at most this often; the answer is kept in the store in between
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000
const STORE_KEY = 'update-check-v1'

export type Release = { version: string; notes: string; url: string }
// `at`: when GitHub was last asked (absent: never)
type Checked = { at?: number; latest?: Release; notified?: string }

// Whether version a is newer than b ("1.2.0" > "1.1.10"); anything unparsable is not
export function isNewer(a: string, b: string) {
  const parse = (v: string) => (/^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim()) ?? []).slice(1).map(Number)
  const x = parse(a)
  const y = parse(b)
  if (x.length !== 3 || y.length !== 3) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!
  return false
}

// The latest release, from the store when it was checked recently, else from
// GitHub (undefined when GitHub can't be reached or the repository is private)
export async function latestRelease($: EngineInterface, force = false): Promise<Release | undefined> {
  const now = await $.clock.now()
  const kept = ((await $.store.get(STORE_KEY).catch(() => undefined)) ?? {}) as Checked
  if (!force && kept.at !== undefined && now - kept.at < CHECK_EVERY_MS) return kept.latest
  const res = await $.http.fetch(LATEST, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'locum-plugin' } }).catch(() => undefined)
  let latest: Release | undefined
  if (res?.ok) {
    const r = JSON.parse(res.text) as { tag_name?: string; body?: string; html_url?: string }
    if (r.tag_name) latest = { version: r.tag_name.replace(/^v/, ''), notes: String(r.body ?? ''), url: String(r.html_url ?? '') }
  }
  await $.store.set(STORE_KEY, { ...kept, at: now, latest: latest ?? kept.latest }).catch(() => {})
  return latest ?? kept.latest
}

// Whether the notice for this version was shown already, and mark it shown
export async function firstNotice($: EngineInterface, version: string) {
  const kept = ((await $.store.get(STORE_KEY).catch(() => undefined)) ?? {}) as Checked
  if (kept.notified === version) return false
  await $.store.set(STORE_KEY, { ...kept, notified: version }).catch(() => {})
  return true
}

// A plugin installed from a marketplace runs from Claude Code's plugin cache; one
// read from a folder (a clone, while developing) is updated with git instead
export const isFolderInstall = (root: string) => !root.includes('/.claude/plugins/')

// Runs one command and collects what it printed
export async function runCli($: EngineInterface, argv: string[]) {
  const child = $.process.spawn({ argv })
  let out = ''
  let code: number | null = null
  for (;;) {
    const r = await child.next()
    if (r.done) {
      const v = r.value as { code?: number | null; value?: { code?: number | null } } | undefined
      code = v?.code ?? v?.value?.code ?? null
      break
    }
    out += (r.value as { text?: string }).text ?? ''
  }
  return { code, out: out.trim() }
}

// Refreshes the marketplace, then updates the plugin from it. No -y: a release
// that brought a marketplace-declared command would need the person to see it,
// so it fails here and says so rather than being accepted silently.
export async function install($: EngineInterface): Promise<{ ok: boolean; text: string }> {
  const refresh = await runCli($, ['claude', 'plugin', 'marketplace', 'update', MARKETPLACE])
  if (refresh.code !== 0) return { ok: false, text: `Refreshing the ${MARKETPLACE} marketplace failed: ${refresh.out.slice(-400) || `exit ${refresh.code}`}` }
  const update = await runCli($, ['claude', 'plugin', 'update', PLUGIN_ID])
  if (update.code !== 0) return { ok: false, text: `Updating ${PLUGIN_ID} failed: ${update.out.slice(-400) || `exit ${update.code}`}` }
  return { ok: true, text: update.out.slice(-400) }
}

// The first lines of a release's notes, for /locum update
export const notesExcerpt = (notes: string, lines = 12) => {
  const all = notes.replace(/\r/g, '').split('\n').filter(l => l.trim())
  return all.slice(0, lines).map(l => `  ${l}`).join('\n') + (all.length > lines ? `\n  …the rest is in the release notes.` : '')
}

// The installed version, from the plugin's own manifest
export async function pluginVersion($: EngineInterface) {
  return $.fs
    .read(`${$.plugin.root}/.claude-plugin/plugin.json`)
    .then(t => String((JSON.parse(String(t)) as { version?: unknown }).version ?? ''))
    .catch(() => '')
}

// /locum update [install]. `origin` is where the command came from: an install
// runs only for one the person typed (at the terminal or through Remote Control),
// never for the model or another plugin running the command.
export async function updateCommand($: EngineInterface, arg: string, origin: string, current: string) {
  const latest = await latestRelease($, true)
  const folder = isFolderInstall($.plugin.root)
  if (!latest) return `Couldn't read the latest release of ${REPO} from GitHub. You have Locum ${current || 'of an unknown version'}.`
  if (!isNewer(latest.version, current)) return `Locum ${current} is the latest release.`
  const gitNote = `This copy is read from ${$.plugin.root}, so it updates with git: run git pull there, then /reload-plugins.`
  if (arg !== 'install') {
    return [
      `Locum ${latest.version} is out; you have ${current}.`,
      '',
      'What changed:',
      notesExcerpt(latest.notes),
      ...(latest.url ? ['', latest.url] : []),
      '',
      folder ? gitNote : 'Install it with /locum update install, then run /reload-plugins.',
    ].join('\n')
  }
  if (origin !== 'composer' && origin !== 'bridge') return 'Only you can install an update: type /locum update install yourself.'
  if (folder) return gitNote
  const r = await install($)
  return r.ok ? `Installed Locum ${latest.version}. Run /reload-plugins to load it (or restart Claude Code if /locum still says ${current}).` : r.text
}
