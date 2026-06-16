import type { CloudProjectSourceSummary } from '@open-cowork/shared'
import type { ControlPlaneSessionStatus } from './control-plane-enums.ts'

// The control-plane's session / event / projection / lease record shapes,
// extracted from the 4k-line in-memory store. Pure types depending only on the
// session-status enum and the shared project-source summary contract.

export type SessionRecord = {
  tenantId: string
  userId: string
  sessionId: string
  opencodeSessionId: string
  profileName: string
  status: ControlPlaneSessionStatus
  title: string | null
  createdAt: string
  updatedAt: string
  projectSource?: CloudProjectSourceSummary | null
}

export type ListSessionsPageInput = {
  tenantId: string
  userId: string
  limit?: number | null
  cursor?: string | null
  status?: ControlPlaneSessionStatus | null
  profileName?: string | null
  query?: string | null
}

export type ListSessionsPageRecord = {
  items: SessionRecord[]
  nextCursor: string | null
  totalEstimate: number
}

export type SessionEventRecord = {
  tenantId: string
  sessionId: string
  eventId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type WorkspaceEventRecord = {
  tenantId: string
  userId: string
  sessionId: string | null
  eventId: string
  sequence: number
  entityType: string
  entityId: string
  operation: string
  projectionVersion: number
  type: string
  payload: Record<string, unknown>
  createdAt: string
}

export type SessionProjectionRecord = {
  tenantId: string
  sessionId: string
  sequence: number
  view: Record<string, unknown>
  updatedAt: string
}

export type WorkerLeaseRecord = {
  tenantId: string
  sessionId: string
  leasedBy: string
  leaseToken: string
  leaseExpiresAt: number
  checkpointVersion: number
}
