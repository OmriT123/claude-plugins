export type VaultEntries = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    guardrail: { vault: VaultEntries }
  }
}
