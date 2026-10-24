// Per-run state, kept in $.state so a /reload-plugins mid-run keeps auto-mode
// delivery, the guards and the totals.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { AgentRun } from '../types'
import type { AgentDef } from './agents'
import { MAIN_RUN, agentName } from './agents'

// Every run of our agents this session, by agentId. Bump the shape tag when
// AgentRun changes: the old value is then read as absent.
export const runsAtom = atom({ plugin: 'locum', key: 'runs' } as const, {} as Record<string, AgentRun>, { shape: 'runs-2' })

export function newRun(name: string, model: string, isAuto: boolean, startedAt: number, effort?: string): AgentRun {
  return {
    name,
    model,
    isAuto,
    startedAt,
    ...(effort ? { effort } : {}),
    toolNames: [],
    deniedPaths: [],
    isNudged: false,
    isDone: false,
    steps: 0,
    usd: 0,
    providers: [],
    fallbackSteps: 0,
  }
}

export async function allRuns($: EngineInterface) {
  return read($, runsAtom)
}

export async function getRun($: EngineInterface, agentId: string): Promise<AgentRun | undefined> {
  return (await read($, runsAtom))[agentId]
}

export async function putRun($: EngineInterface, agentId: string, run: AgentRun) {
  await update($, runsAtom, runs => ({ ...runs, [agentId]: run }))
}

export async function patchRun($: EngineInterface, agentId: string, change: (run: AgentRun) => AgentRun) {
  await update($, runsAtom, runs => {
    const run = runs[agentId]
    return run ? { ...runs, [agentId]: change(run) } : runs
  })
}

// What every run this session has spent
export async function sessionUsd($: EngineInterface) {
  return Object.values(await read($, runsAtom)).reduce((sum, r) => sum + r.usd, 0)
}

// Agents seen not to be ours, so their every step and tool check skips the
// agent list (a reload clears it, which only costs one lookup each)
const notOurs = new Set<string>()

// The run of one of our agents, created on first sight for one spawned before
// this code loaded (its type still names it); undefined for anyone else's agent
export async function runOf($: EngineInterface, agents: Record<string, AgentDef>, agentId: string) {
  if (notOurs.has(agentId)) return undefined
  const run = await getRun($, agentId)
  if (run) return run
  const info = (await $.agent.list()).find(a => a.id === agentId)
  const name = agentName(info?.type, $.plugin.name)
  // An agent the list doesn't know yet may still be starting; only a known one is ruled out
  if (!name) {
    if (info) notOurs.add(agentId)
    return undefined
  }
  // Ours even when the settings no longer have it, so its steps never fall to the
  // session's model (turn.step stops such a run)
  const created = newRun(name, agents[name]?.model ?? '', false, await $.clock.now())
  await update($, runsAtom, runs => (runs[agentId] ? runs : { ...runs, [agentId]: created }))
  return (await getRun($, agentId)) ?? created
}

// The run behind a loop: one of our agents' runs, a subagent's on an OpenRouter
// model of its own, or the main session's while it runs on one
export async function loopRunOf($: EngineInterface, agents: Record<string, AgentDef>, agentId: string | undefined, mainOnOpenRouter: boolean) {
  if (agentId !== undefined) return (await runOf($, agents, agentId)) ?? (await getRun($, agentId))
  return mainOnOpenRouter ? getRun($, MAIN_RUN) : undefined
}
