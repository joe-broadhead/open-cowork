import type { ArtifactKind, ArtifactStatus, CloudProjectSourceSummary, PendingApproval, PendingQuestion } from '@open-cowork/shared'
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
  // Bounded has-more probe, NOT an exact total: at most `limit + 1`. A value of `limit + 1`
  // means "more than `limit` sessions remain after the cursor" (page it); any smaller value is
  // the exact remaining count. Both stores cap it identically so the paged UI behaves the same
  // on Postgres and in-memory — computing a true total would require an unbounded COUNT (#915).
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

export type CloudArtifactIndexRecord = {
  tenantId: string
  userId: string
  sessionId: string
  sessionTitle: string | null
  artifactId: string
  filename: string
  contentType: string | null
  size: number
  key: string
  kind: ArtifactKind
  status: ArtifactStatus
  authorAgentId: string | null
  projectId: string | null
  taskId: string | null
  statusUpdatedBy: string | null
  statusUpdatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type UpsertCloudArtifactIndexInput = Omit<CloudArtifactIndexRecord, 'sessionTitle'>

export type ListCloudArtifactIndexInput = {
  tenantId: string
  userId: string
  sessionId?: string | null
  projectId?: string | null
  taskId?: string | null
  taskIds?: string[] | null
  status?: ArtifactStatus | null
  kind?: ArtifactKind | null
  limit?: number | null
}

export type ListCloudArtifactIndexResult = {
  items: CloudArtifactIndexRecord[]
  totalEstimate: number
  truncated: boolean
}

export type CloudLaunchpadSessionSummaryRecord = {
  tenantId: string
  userId: string
  sessionId: string
  sessionTitle: string | null
  createdAt: string
  updatedAt: string
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
}

export type UpsertCloudLaunchpadSessionSummaryInput = Omit<CloudLaunchpadSessionSummaryRecord, 'sessionTitle' | 'createdAt'>

export type ListCloudLaunchpadSessionSummariesInput = {
  tenantId: string
  userId: string
  limit?: number | null
}

export type ListCloudLaunchpadSessionSummariesResult = {
  items: CloudLaunchpadSessionSummaryRecord[]
  totalEstimate: number
  truncated: boolean
}

export type WorkerLeaseRecord = {
  tenantId: string
  sessionId: string
  leasedBy: string
  leaseToken: string
  leaseExpiresAt: number
  checkpointVersion: number
}
