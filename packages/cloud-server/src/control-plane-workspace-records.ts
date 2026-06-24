import type { WorkflowRun, WorkflowSummary } from '@open-cowork/shared'
import type { ControlPlaneSessionStatus } from './control-plane-enums.ts'

// The control-plane's settings / thread-metadata / workflow record shapes,
// extracted from the 4k-line in-memory store. Pure types depending only on the
// session-status enum and the shared workflow summary/run contracts.

export type SettingMetadataRecord = {
  tenantId: string
  userId: string | null
  key: string
  value: Record<string, unknown>
  updatedAt: string
}

export type ThreadTagRecord = {
  tenantId: string
  tagId: string
  name: string
  color: string
  createdAt: string
  updatedAt: string
}

export type ThreadSmartFilterRecord = {
  tenantId: string
  filterId: string
  name: string
  query: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ThreadMetadataRecord = {
  tenantId: string
  userId: string
  sessionId: string
  title: string | null
  profileName: string
  status: ControlPlaneSessionStatus
  createdAt: string
  updatedAt: string
  tags: ThreadTagRecord[]
}

export type CloudWorkflowRecord = WorkflowSummary & {
  tenantId: string
  userId: string
}

export type CloudWorkflowRunRecord = WorkflowRun & {
  tenantId: string
  userId: string
  claimedBy: string | null
  claimToken: string | null
  claimExpiresAt: string | null
  attemptCount: number
  idempotencyKey: string | null
  checkpointVersion: number
  lastErrorCode: string | null
  lastErrorSummary: string | null
}

export type ClaimedWorkflowRunRecord = {
  workflow: CloudWorkflowRecord
  run: CloudWorkflowRunRecord
}

export type SchemaMigrationRecord = {
  id: string
  appliedAt: string
}
