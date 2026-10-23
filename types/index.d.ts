// What the plugin keeps in session state ($.state), so a /reload-plugins in the
// middle of a run keeps its auto-mode delivery, guards and totals.

// One run of one of the plugin's agents, keyed by its agentId
export type AgentRun = {
  // The agent's name (`deepseek`, `kimi`, ..., `custom`)
  name: string
  // Spawned while the session was in auto mode
  isAuto: boolean
  // The Agent call's own `effort`, when it named one
  effort?: string
  // The final report an auto-mode run wrote, waiting to be delivered
  report?: string
  // The tools the model called, in order
  toolNames: string[]
  // Absolute paths a file tool was refused for
  deniedPaths: string[]
  // Whether the no-tool-calls nudge was sent
  isNudged: boolean
  steps: number
  usd: number
  // OpenRouter providers that served its steps
  providers: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'openrouter-agents': { runs: Shaped<Record<string, AgentRun>> }
  }
}
