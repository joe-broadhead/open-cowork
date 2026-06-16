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

interface CapabilitySkillBundleFile {
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

interface CoworkSchemaVersionedRecord {
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

type CapabilityRelationshipNodeKind = 'tool' | 'skill' | 'mcp' | 'agent' | 'workflow'
type CapabilityRelationshipEdgeKind = 'uses' | 'requires' | 'inherits' | 'exposes'
type CapabilityAccessPolicyState = 'allowed' | 'denied' | 'inherited' | 'unknown' | 'credential_missing'
type CapabilityCredentialHealthState = 'ready' | 'missing' | 'disabled' | 'not_required' | 'unknown'

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

export const CAPABILITY_BUNDLE_FORMAT = 'open-cowork-capability-bundle-v1' as const

export type CapabilityBundleProductMode =
  | 'desktop-local'
  | 'desktop-cloud'
  | 'cloud-web'
  | 'cloud-channel-gateway'
  | 'standalone-gateway'
  | 'paired-desktop'
  | 'headless-host'

export type CapabilityBundleCompatibilityTier = 'supported' | 'experimental' | 'blocked' | 'unsupported'
export type CapabilityBundleResourceKind =
  | 'opencode-plugin'
  | 'skill'
  | 'agent'
  | 'mcp'
  | 'provider'
  | 'workflow'
  | 'command'
  | 'native-helper'
export type CapabilityBundlePermissionKind =
  | 'provider'
  | 'filesystem'
  | 'mcp'
  | 'shell'
  | 'workflow'
  | 'plugin'
  | 'network'
  | 'credential'

export interface CapabilityBundleResource {
  kind: CapabilityBundleResourceKind
  id: string
  title?: string
  source?: string
  ownedByBundle?: boolean
  productModes?: CapabilityBundleProductMode[]
  compatibilityTier?: CapabilityBundleCompatibilityTier
  url?: string
  command?: string
}

export interface CapabilityBundleResourceIdentity {
  kind: CapabilityBundleResourceKind
  id: string
}

export type CapabilityBundleResourceSelector = string | CapabilityBundleResourceIdentity

export interface CapabilityBundlePermission {
  kind: CapabilityBundlePermissionKind
  id: string
  reason: string
  required?: boolean
}

export interface CapabilityBundleManifest {
  format: typeof CAPABILITY_BUNDLE_FORMAT
  name: string
  version: string
  owner: string
  compatibility?: {
    opencode?: string
    productModes?: Partial<Record<CapabilityBundleProductMode, CapabilityBundleCompatibilityTier>>
  }
  resources: CapabilityBundleResource[]
  permissions: CapabilityBundlePermission[]
  uninstall?: {
    removes?: CapabilityBundleResourceSelector[]
    preserves?: CapabilityBundleResourceSelector[]
  }
}

export interface CapabilityBundleIssue {
  code: string
  message: string
  resourceId?: string
}

export interface CapabilityBundleManifestNormalizeOptions {
  /**
   * Compatibility mode for legacy manifests written before the public schema
   * required explicit resources/permissions arrays. Runtime callers should
   * leave this false so normalization matches the schema contract.
   */
  allowMissingCollections?: boolean
}

export interface CapabilityBundleInstallPlanAction {
  action: 'install' | 'review_permission' | 'preserve_user_resource' | 'remove_bundle_resource' | 'block'
  kind: CapabilityBundleResourceKind | CapabilityBundlePermissionKind | 'bundle'
  id: string
  reason: string
}

export interface CapabilityBundleRiskSummary {
  level: CapabilityRiskLevel
  resourceCount: number
  permissionCount: number
  reasons: string[]
}

export interface CapabilityBundleInstallPlan {
  format: typeof CAPABILITY_BUNDLE_FORMAT
  bundleName: string
  productMode: CapabilityBundleProductMode
  blocked: boolean
  blockers: CapabilityBundleIssue[]
  actions: CapabilityBundleInstallPlanAction[]
  risk: CapabilityBundleRiskSummary
}

export interface CapabilityBundleUninstallPlan {
  format: typeof CAPABILITY_BUNDLE_FORMAT
  bundleName: string
  blocked: boolean
  blockers: CapabilityBundleIssue[]
  actions: CapabilityBundleInstallPlanAction[]
  risk: CapabilityBundleRiskSummary
}

export interface CapabilityBundleUpdatePlan {
  format: typeof CAPABILITY_BUNDLE_FORMAT
  bundleName: string
  previousVersion: string
  nextVersion: string
  productMode: CapabilityBundleProductMode
  blocked: boolean
  blockers: CapabilityBundleIssue[]
  actions: CapabilityBundleInstallPlanAction[]
  risk: CapabilityBundleRiskSummary
}

export type CapabilityBundleLifecycleOwner = 'bundle' | 'user'
export type CapabilityBundleLifecycleAction = 'install' | 'update' | 'uninstall'
export type CapabilityBundleLifecycleOutcome = 'installed' | 'updated' | 'removed' | 'preserved' | 'reviewed' | 'blocked'

export interface CapabilityBundleLifecycleResource {
  kind: CapabilityBundleResourceKind
  id: string
  owner: CapabilityBundleLifecycleOwner
  bundleName: string | null
  installedAt: string
  updatedAt: string
  manifestResource: CapabilityBundleResource
}

export interface CapabilityBundleLifecycleBundle {
  name: string
  version: string
  owner: string
  productMode: CapabilityBundleProductMode
  manifest: CapabilityBundleManifest
  installedAt: string
  updatedAt: string
  resources: Array<{
    kind: CapabilityBundleResourceKind
    id: string
    owner: CapabilityBundleLifecycleOwner
  }>
}

export interface CapabilityBundleLifecycleState {
  bundles: CapabilityBundleLifecycleBundle[]
  resources: CapabilityBundleLifecycleResource[]
}

export interface CapabilityBundleLifecycleAuditEvent {
  action: CapabilityBundleLifecycleAction
  outcome: CapabilityBundleLifecycleOutcome
  bundleName: string
  kind: CapabilityBundleInstallPlanAction['kind']
  id: string
  reason: string
}

export interface CapabilityBundleLifecycleApplyResult<Plan> {
  applied: boolean
  plan: Plan
  state: CapabilityBundleLifecycleState
  audit: CapabilityBundleLifecycleAuditEvent[]
}

export type CapabilityBundleRuntimeSupportStatus = 'supported' | 'experimental' | 'blocked'

export interface CapabilityBundleRuntimeResourceCheck {
  kind: CapabilityBundleResourceKind
  id: string
  status: CapabilityBundleRuntimeSupportStatus
  reason: string
  compatibilityTier?: CapabilityBundleCompatibilityTier
  productModes?: CapabilityBundleProductMode[]
}

export interface CapabilityBundleRuntimeBundleCheck {
  bundleName: string
  version: string
  productMode: CapabilityBundleProductMode
  runtimeStartAllowed: boolean
  blockers: CapabilityBundleIssue[]
  warnings: CapabilityBundleIssue[]
  resources: CapabilityBundleRuntimeResourceCheck[]
}

export interface CapabilityBundleRuntimeSupportReport {
  format: typeof CAPABILITY_BUNDLE_FORMAT
  productMode: CapabilityBundleProductMode
  runtimeStartAllowed: boolean
  blockers: CapabilityBundleIssue[]
  warnings: CapabilityBundleIssue[]
  bundles: CapabilityBundleRuntimeBundleCheck[]
}

