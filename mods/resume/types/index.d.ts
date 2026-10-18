export type Parked = {
  at: number
  cwd: string
  branch: string
  head: string
  dirty: number
  note: string
  lastPrompt: string
}

declare module 'claude-code' {
  interface PluginState {
    resume: { banner: Parked | null }
  }
}
