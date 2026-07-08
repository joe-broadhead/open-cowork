import type {
  ControlPlaneCommandKind,
  ControlPlaneCommandStatus,
  WorkerRole,
  WorkReaperAction,
} from './control-plane-enums.ts'
import type { WorkerLeaseRecord } from './control-plane-session-records.ts'

// The control-plane's worker-runtime input/record shapes — runnable-session
// claims, lease/workflow reaping, session commands, and worker heartbeats —
// extracted from the 4k-line in-memory store. Pure types depending only on the
// enum vocabulary and the worker-lease record.

export type ListRunnableSessionsInput = { limit?: number | null, now?: Date }
export type RunnableSessionRecord = { tenantId: string, sessionId: string }
export type RunnableSessionListRecord = { sessions: RunnableSessionRecord[], pendingSessionCountEstimate: number }

export type ReapExpiredSessionLeasesInput = {
  now?: Date
  maxCommandAttempts?: number | null
  limit?: number | null
}

export type ReapedSessionLeaseRecord = {
  tenantId: string
  sessionId: string
  leaseToken: string
  leasedBy: string
  action: WorkReaperAction
  retriedCommandIds: string[]
  failedCommandIds: string[]
  reapedAt: string
}

export type ReapExpiredWorkflowClaimsInput = {
  now?: Date
  maxAttempts?: number | null
  limit?: number | null
}

export type ReapedWorkflowClaimRecord = {
  tenantId: string
  workflowId: string
  runId: string
  claimToken: string
  claimedBy: string
  action: WorkReaperAction
  reapedAt: string
}

export type SessionCommandRecord = {
  commandId: string
  tenantId: string
  userId: string
  sessionId: string
  kind: ControlPlaneCommandKind
  payload: Record<string, unknown>
  targetLeaseToken: string | null
  createdSequence: number
  createdAt: string
  status: ControlPlaneCommandStatus
  claimedBy: string | null
  claimedLeaseToken: string | null
  attemptCount: number
  availableAt: string | null
  lastErrorCode: string | null
  lastErrorSummary: string | null
  ackedAt: string | null
  error: string | null
}

export type WorkerHeartbeatRecord = {
  workerId: string
  role: WorkerRole
  activeSessionIds: string[]
  lastSeenAt: string
}
