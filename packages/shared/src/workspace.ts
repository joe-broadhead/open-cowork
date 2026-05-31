export type WorkspaceKind = 'local' | 'cloud'

export type WorkspaceStatus = 'online' | 'offline' | 'auth_required' | 'disabled' | 'error'

export const WORKSPACE_API_SUPPORT_STATUSES = [
  'supported',
  'read_only',
  'blocked_by_policy',
  'not_supported',
  'deferred',
] as const

export type WorkspaceApiSupportStatus = typeof WORKSPACE_API_SUPPORT_STATUSES[number]

export const WORKSPACE_PRODUCT_SURFACES = [
  'desktop_local',
  'desktop_cloud',
  'cloud_web',
  'gateway_channel',
  'admin_operator',
] as const

export type WorkspaceProductSurface = typeof WORKSPACE_PRODUCT_SURFACES[number]

export const WORKSPACE_CONTRACT_REASON_CODES = [
  'workspace.auth_required',
  'workspace.offline_read_only',
  'workspace.local_only',
  'workspace.cloud_only',
  'workspace.policy_disabled',
  'workspace.quota_denied',
  'workspace.capacity_denied',
  'workspace.billing_denied',
  'workspace.not_supported',
  'workspace.deferred',
] as const

export type WorkspaceContractReasonCode = typeof WORKSPACE_CONTRACT_REASON_CODES[number]

export type WorkspaceInfo = {
  id: string
  kind: WorkspaceKind
  label: string
  status: WorkspaceStatus
  active: boolean
  tenantId?: string
  userId?: string
  baseUrl?: string
  profileName?: string
  lastSyncedAt?: string | null
  error?: string | null
}

export type WorkspaceRef = {
  workspaceId: string
  sessionId?: string
}

export type WorkspaceScoped<T> = T & {
  workspaceId?: string
}

export type WorkspaceOptions = {
  workspaceId?: string
}

export type WorkspacePolicy = {
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
  localFiles: 'enabled' | 'disabled'
  localStdioMcps: 'enabled' | 'disabled' | 'allowlisted'
  machineRuntimeConfig: 'disabled' | 'allowlisted'
}

export type WorkspaceActionVerdict = {
  allowed: boolean
  reason: string | null
  policyCode?: WorkspaceContractReasonCode | string
}

export type WorkspaceApiSupport = {
  api: string
  status: WorkspaceApiSupportStatus
  verdict?: WorkspaceActionVerdict
}

export type WorkspaceSurfaceSupport = {
  surface: WorkspaceProductSurface
  api: string
  status: WorkspaceApiSupportStatus
  reasonCode?: WorkspaceContractReasonCode | string
  notes?: string
}

export type AddCloudWorkspaceInput = {
  baseUrl: string
  label?: string
}

export type WorkspaceSyncResult = {
  ok: true
  syncedAt: string
}

export type WorkspaceSessionsUpdatedEvent = {
  workspaceId: string
  sessions: Array<import('./session.js').SessionInfo>
  lastEventSequence?: number | null
  syncedAt: string
}

export interface SkillImportSelection {
  token: string
  directory: string
}

export interface SandboxStorageStats {
  root: string
  totalBytes: number
  workspaceCount: number
  referencedWorkspaceCount: number
  unreferencedWorkspaceCount: number
  staleWorkspaceCount: number
  staleThresholdDays: number
}

export interface SandboxCleanupResult {
  mode: 'old-unreferenced' | 'all-unreferenced'
  removedWorkspaces: number
  removedBytes: number
}
