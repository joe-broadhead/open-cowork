export type WorkspaceKind = 'local' | 'cloud'

export type WorkspaceStatus = 'online' | 'offline' | 'auth_required' | 'disabled' | 'error'

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
  policyCode?: string
}

export type WorkspaceApiSupportStatus =
  | 'supported'
  | 'read_only'
  | 'blocked_by_policy'
  | 'not_supported'
  | 'deferred'

export type WorkspaceApiSupport = {
  api: string
  status: WorkspaceApiSupportStatus
  verdict?: WorkspaceActionVerdict
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
