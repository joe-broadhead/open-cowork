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
  // The auth scheme the backing MCP uses. The renderer uses this to
  // pick the right CTA — `oauth` integrations show an "Enable &
  // Sign In" toggle that flips `integrationEnabled[integrationId]`,
  // `api_token` integrations show credential fields, `none` shows
  // neither. Absent for non-MCP tools.
  authMode?: 'none' | 'oauth' | 'api_token'
  // Whether the user has explicitly enabled this integration via the
  // per-MCP toggle. `undefined` means "defer to the implicit
  // readiness heuristic" (credential presence for api_token, Google
  // sign-in for googleAuth, off for oauth). The renderer doesn't need
  // to interpret this directly — it just renders the toggle's current
  // position.
  enabled?: boolean
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
