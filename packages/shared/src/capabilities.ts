import type { CredentialField } from './providers.js'

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
  // via the `settings:set` IPC.
  credentials?: CredentialField[]
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
  // Whether required integration credentials are present. This is
  // separate from `enabled` because API-token integrations can be
  // readiness-driven without a persisted user toggle override.
  credentialReady?: boolean
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

export type CapabilityRiskLevel = 'low' | 'medium' | 'high'

export interface CoworkSchemaVersionedRecord {
  schemaVersion: number
}

export interface CapabilityRiskMetadata extends CoworkSchemaVersionedRecord {
  capabilityId: string
  toolPattern: string | null
  risk: CapabilityRiskLevel
  writeCapable: boolean
  approvalRequired: boolean
  reason: string
}

export type CapabilityRelationshipNodeKind = 'tool' | 'skill' | 'mcp' | 'agent' | 'workflow'
export type CapabilityRelationshipEdgeKind = 'uses' | 'requires' | 'inherits' | 'exposes'
export type CapabilityAccessPolicyState = 'allowed' | 'denied' | 'inherited' | 'unknown' | 'credential_missing'
export type CapabilityCredentialHealthState = 'ready' | 'missing' | 'disabled' | 'not_required' | 'unknown'

export interface CapabilityConsumer extends CoworkSchemaVersionedRecord {
  id: string
  kind: CapabilityRelationshipNodeKind
  name: string
  source: string
}

export interface CapabilityAccessPolicy extends CoworkSchemaVersionedRecord {
  state: CapabilityAccessPolicyState
  inheritedFrom?: string | null
  reason: string
}

export interface CapabilityCredentialHealth extends CoworkSchemaVersionedRecord {
  state: CapabilityCredentialHealthState
  label: string
  detail?: string | null
}

export interface CapabilityRelationshipNode extends CoworkSchemaVersionedRecord {
  id: string
  kind: CapabilityRelationshipNodeKind
  label: string
  risk: CapabilityRiskLevel
  credentialHealth: CapabilityCredentialHealth
  accessPolicy: CapabilityAccessPolicy
}

export interface CapabilityRelationshipEdge extends CoworkSchemaVersionedRecord {
  fromId: string
  toId: string
  kind: CapabilityRelationshipEdgeKind
  label: string
}
