export interface CapabilityToolEntry {
  id: string
  description: string
}

export interface CapabilityTool {
  id: string
  name: string
  icon?: string
  description: string
  kind: 'mcp' | 'built-in'
  source: 'builtin' | 'custom'
  origin?: 'opencode' | 'open-cowork' | 'custom'
  scope?: 'machine' | 'project' | null
  namespace?: string | null
  patterns: string[]
  availableTools?: CapabilityToolEntry[]
  agentNames: string[]
  // Per-tool credential fields rendered in the Capabilities detail
  // panel. Values persist to `integrationCredentials[integrationId][key]`
  // via the `settings:set` IPC. The shape mirrors `CredentialField` in
  // ./index.ts — re-declared inline to avoid a cross-cutting circular
  // import (index.ts already imports from this module). Keep in sync.
  credentials?: Array<{
    key: string
    runtimeKey?: string
    label: string
    description: string
    placeholder?: string
    secret?: boolean
    required?: boolean
    env?: string
  }>
  // The key the renderer uses when calling `settings.set(
  //   { integrationCredentials: { [integrationId]: { [key]: value } } })`.
  // For MCP-backed tools this is the MCP name.
  integrationId?: string
}

export interface CapabilitySkill {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: 'machine' | 'project' | null
  location?: string | null
  toolIds?: string[]
  agentNames: string[]
}

export interface CapabilitySkillBundleFile {
  path: string
}

export interface CapabilitySkillBundle {
  name: string
  source: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: 'machine' | 'project' | null
  location?: string | null
  content: string | null
  files: CapabilitySkillBundleFile[]
}
