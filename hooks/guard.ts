// The workaround guard, best-effort: a path refused to a file tool stays off
// limits to Bash commands that name it (absolute, relative, ~/…, after a cd).
// A command that builds the path (variables, globs, a script) isn't caught.

// A refused file tool call: Claude Code's own refusals and other hooks', not a
// file error such as EACCES "permission denied" or a missing file
export const REFUSAL = /haven't granted|requested permissions|denied by|not allowed by|was rejected|doesn't want to proceed|classifier/i
export const FILE_TOOLS: Record<string, string> = { Write: 'file_path', Edit: 'file_path', Read: 'file_path', NotebookEdit: 'notebook_path' }

// An absolute, normalized path: `~` is home, a relative path is taken from `base`
export function normalizePath(path: string, base: string, home: string) {
  let p = path
  if (home && (p === '~' || p.startsWith('~/'))) p = home + p.slice(1)
  if (!p.startsWith('/')) p = `${base.replace(/\/+$/, '')}/${p}`
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

// The paths a shell command may name: each word that looks like a path, taken
// from the session's folder and from any folder the command `cd`s into
export function pathsInCommand(command: string, cwd: string, home: string) {
  const bases = [cwd, ...[...command.matchAll(/\bcd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)].map(m => normalizePath(m[1]!.replace(/^["']|["']$/g, ''), cwd, home))]
  const words = command.split(/[\s'"`;|&<>()=]+/).filter(w => w && (w.includes('/') || w.includes('.') || w.startsWith('~')))
  return new Set(words.flatMap(w => bases.map(b => normalizePath(w, b, home))))
}

// The refused path a Bash command names, if any
export function refusedPathIn(command: string, deniedPaths: readonly string[], cwd: string, home: string) {
  if (!deniedPaths.length) return undefined
  const named = pathsInCommand(command, cwd, home)
  // A literal mention counts only as the whole path (so a refused .env doesn't block .env.example)
  return deniedPaths.find(path => named.has(path) || new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w.-])`).test(command))
}
