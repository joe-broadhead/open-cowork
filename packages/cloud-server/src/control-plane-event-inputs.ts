import type { QuotaPolicyCode } from './control-plane-errors.ts'
import type { ControlPlaneCommandKind } from './control-plane-enums.ts'
import type {
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  WorkspaceEventRecord,
} from './control-plane-session-records.ts'
import type { ConsumeUsageQuotaInput } from './control-plane-usage-inputs.ts'

// The control-plane's event-append / projection / command-enqueue input shapes
// (plus the command-queue and workflow-run quota descriptors they carry),
// extracted from the 4k-line in-memory store. Pure types depending only on the
// command-kind enum, the quota-policy-code contract, and the usage-quota input.

export type AppendEventInput = {
  tenantId: string
  sessionId: string
  eventId?: string
  type: string
  payload?: Record<string, unknown>
  leaseToken?: string | null
  createdAt?: Date
}

export type AppendWorkspaceEventInput = {
  tenantId: string
  userId: string
  sessionId?: string | null
  eventId?: string
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: string
  payload?: Record<string, unknown>
  createdAt?: Date
}

export type WriteProjectionInput = {
  tenantId: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  leaseToken?: string | null
  updatedAt?: Date
}

export type AppendProjectedSessionEventInput = AppendEventInput & {
  workspace: (input: {
    session: SessionRecord
    event: SessionEventRecord
  }) => {
    eventId: string
    entityType: string
    entityId: string
    operation: string
    projectionVersion: number
  }
  project: (input: {
    session: SessionRecord
    event: SessionEventRecord
    currentProjection: SessionProjectionRecord | null
  }) => {
    view: Record<string, unknown>
    updatedAt?: Date
  }
}

export type AppendProjectedSessionEventResult = {
  event: SessionEventRecord
  workspaceEvent: WorkspaceEventRecord
  projection: SessionProjectionRecord
  session: SessionRecord
  sessionEventCreated: boolean
  workspaceEventCreated: boolean
  projectionAdvanced: boolean
}

export type CommandQueueQuota = {
  orgId?: string | null
  maxQueuedCommandsPerOrg?: number | null
  maxQueueAgeMs?: number | null
  policyCode?: QuotaPolicyCode | string
  queueAgePolicyCode?: QuotaPolicyCode | string
}

export type WorkflowRunQuota = {
  orgId?: string | null
  maxConcurrentWorkflowRunsPerOrg?: number | null
  maxWorkflowRunsPerHour?: number | null
  policyCode?: QuotaPolicyCode | string
  workflowRunsPolicyCode?: QuotaPolicyCode | string
}

export type EnqueueCommandInput = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: ControlPlaneCommandKind
  payload?: Record<string, unknown>
  targetLeaseToken?: string | null
  createdAt?: Date
  quota?: CommandQueueQuota | null
  usageQuotas?: ConsumeUsageQuotaInput[]
}
