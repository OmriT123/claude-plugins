export type Running = { client: string; start: number; note: string }

declare module 'claude-code' {
  interface PluginState {
    billing: { running: Running | null; tick: number }
  }
}
