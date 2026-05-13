export const COWORK_OPERATION_SCHEMA_VERSION = 1
export const COWORK_WORKSPACE_PROFILE_SCHEMA_VERSION = 1
export const COWORK_FLEET_REGISTRY_SCHEMA_VERSION = 1

export type AutonomyLevel = 'observe' | 'draft' | 'approve' | 'supervised' | 'bounded-auto'
export type CapabilityRiskLevel = 'low' | 'medium' | 'high'
export type WorkspaceProfileKind = 'personal_sandbox' | 'project_workspace' | 'automation_workspace' | 'channel_sandbox' | 'high_risk_isolated'
export type OperationalRunKind = 'agent' | 'crew' | 'automation' | 'sop' | 'channel' | 'dream'
export type OperationalQueueStatus = 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'
export type OperationalQueueKind = 'agent' | 'crew' | 'project' | 'channel' | 'external_system'
export type FleetRegistryKind = 'agent' | 'crew' | 'automation' | 'capability'
export type FleetRegistryStatus =
  | 'draft'
  | 'active'
  | 'ready'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'archived'
  | 'retired'
  | 'disabled'
  | 'blocked'
  | 'waiting_review'
  | 'idle'
  | 'unknown'
export type FleetRegistryMetricTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'
export type FleetBulkActionKind =
  | 'pause'
  | 'resume'
  | 'archive'
  | 'tag'
  | 'untag'
  | 'duplicate'
  | 'open_dependency'
  | 'run'
  | 'test'

export interface OperationSchemaVersionedRecord {
  schemaVersion: number
}

export interface FleetRegistryMetric {
  id: string
  label: string
  value: number | string
  unit?: string | null
  tone?: FleetRegistryMetricTone
}

export interface FleetBulkAction {
  id: string
  kind: FleetBulkActionKind
  label: string
  supported: boolean
  disabledReason?: string | null
  destructive?: boolean
  requiresConfirmation?: boolean
  selection?: 'single' | 'multiple'
}

export interface FleetRegistryItem extends OperationSchemaVersionedRecord {
  id: string
  kind: FleetRegistryKind
  name: string
  description?: string | null
  typeLabel: string
  status: FleetRegistryStatus
  statusLabel: string
  source: string
  owner?: string | null
  provider?: string | null
  model?: string | null
  skillsCount: number
  toolsCount: number
  capabilitiesCount: number
  lastUsedAt?: string | null
  lastRunAt?: string | null
  activeRuns: number
  failedRuns: number
  costUsd?: number | null
  tokenCount?: number | null
  reviewBacklog: number
  approvalBacklog: number
  tags: string[]
  metrics: FleetRegistryMetric[]
  searchText: string
  bulkActions: FleetBulkAction[]
  metadata?: Record<string, string | number | boolean | null>
}

export interface CapabilityRiskMetadata extends OperationSchemaVersionedRecord {
  capabilityId: string
  toolPattern: string | null
  risk: CapabilityRiskLevel
  writeCapable: boolean
  approvalRequired: boolean
  reason: string
}

export interface WorkspaceAuthority extends OperationSchemaVersionedRecord {
  filesystem: {
    mode: 'none' | 'sandbox' | 'project' | 'external'
    roots: string[]
    writeAllowed: boolean
  }
  externalSystems: Array<{
    id: string
    displayName: string
    writeAllowed: boolean
    risk: CapabilityRiskLevel
  }>
  cleanup: {
    retentionDays: number
    deletesUnreferencedArtifacts: boolean
  }
  isolation: {
    projectBound: boolean
    channelBound: boolean
    highRiskIsolated: boolean
  }
}

export interface WorkspaceProfile extends OperationSchemaVersionedRecord {
  id: string
  kind: WorkspaceProfileKind
  name: string
  description: string
  authority: WorkspaceAuthority
  createdAt: string
  updatedAt: string
}

export interface OperationalQueueCaps extends OperationSchemaVersionedRecord {
  maxParallel: number
  maxRunDurationMinutes: number
  maxCostUsd: number | null
  maxRetries: number
}

export interface OperationalQueueItem extends OperationSchemaVersionedRecord {
  id: string
  runKind: OperationalRunKind
  runId: string
  title: string
  status: OperationalQueueStatus
  requestedAutonomy: AutonomyLevel
  effectiveAutonomy: AutonomyLevel
  workspaceProfileId: string
  authority: WorkspaceAuthority
  queueKeys: string[]
  caps: OperationalQueueCaps
  costUsd: number
  attempt: number
  createdAt: string
  updatedAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface OperationalQueueDraft {
  runKind: OperationalRunKind
  runId: string
  title: string
  requestedAutonomy: AutonomyLevel
  workspaceProfileId: string
  agentName?: string | null
  crewId?: string | null
  projectId?: string | null
  channelId?: string | null
  externalSystemIds?: string[]
  writeCapable: boolean
  globalMaxAutonomy?: AutonomyLevel
  caps?: Partial<Pick<OperationalQueueCaps, 'maxParallel' | 'maxRunDurationMinutes' | 'maxCostUsd' | 'maxRetries'>>
}

export interface OperationalQueueAlert extends OperationSchemaVersionedRecord {
  queueItemId: string
  severity: 'warning' | 'critical'
  kind: 'stuck_run' | 'budget_exceeded' | 'blocked_run'
  message: string
  createdAt: string
}
