import type { WorkflowDraft, WorkflowStatus, WorkflowTriggerType } from '@open-cowork/shared'
import type { HeadlessAgentStatus } from './control-plane-enums.ts'
import type { AuditActorInput } from './control-plane-account-inputs.ts'
import type { WorkflowRunQuota } from './control-plane-event-inputs.ts'

// The control-plane's headless-agent / workflow / thread-metadata operation
// input shapes, extracted from the 4k-line in-memory store. Pure types depending
// only on the headless-agent enum, the shared workflow draft/status/trigger
// contracts, the audit-actor input, and the workflow-run quota descriptor.

export type CreateHeadlessAgentInput = {
  agentId: string
  orgId: string
  tenantId: string
  profileName: string
  name: string
  status?: HeadlessAgentStatus
  managed?: boolean
  createdByAccountId?: string | null
  createdAt?: Date
}

export type UpdateHeadlessAgentInput = {
  orgId: string
  agentId: string
  profileName?: string
  name?: string
  status?: HeadlessAgentStatus
  managed?: boolean
  updatedAt?: Date
  actor?: AuditActorInput
}

export type CreateWorkflowInput = {
  tenantId: string
  userId: string
  workflowId: string
  draft: WorkflowDraft
  nextRunAt?: string | null
  createdAt?: Date
}

export type CreateWorkflowRunInput = {
  tenantId: string
  userId: string
  workflowId: string
  runId: string
  sessionId?: string | null
  triggerType: WorkflowTriggerType
  triggerPayload?: Record<string, unknown> | null
  claimedBy?: string | null
  leaseTtlMs?: number | null
  createdAt?: Date
  quota?: WorkflowRunQuota | null
}

export type UpdateWorkflowStatusInput = {
  tenantId: string
  userId: string
  workflowId: string
  status: WorkflowStatus
  nextRunAt?: string | null
  updatedAt?: Date
}

export type ClaimDueWorkflowRunInput = {
  runId: string
  sessionId?: string | null
  claimedBy?: string | null
  leaseTtlMs?: number | null
  now?: Date
  quota?: WorkflowRunQuota | null
}

export type AttachWorkflowRunSessionInput = {
  tenantId: string
  workflowId: string
  runId: string
  sessionId: string
  claimToken?: string | null
  startedAt?: Date
}

export type CompleteWorkflowRunInput = {
  tenantId: string
  workflowId: string
  runId: string
  summary: string | null
  nextStatus: WorkflowStatus
  nextRunAt: string | null
  leaseToken?: string | null
  finishedAt?: Date
}

export type FailWorkflowRunInput = {
  tenantId: string
  workflowId: string
  runId: string
  error: string
  nextStatus: WorkflowStatus
  nextRunAt: string | null
  leaseToken?: string | null
  finishedAt?: Date
}

export type CreateThreadTagInput = {
  tenantId: string
  tagId: string
  name: string
  color?: string | null
  createdAt?: Date
}

export type UpdateThreadTagInput = {
  tenantId: string
  tagId: string
  name?: string
  color?: string | null
  updatedAt?: Date
}

export type ThreadTagLinkInput = {
  tenantId: string
  sessionIds: string[]
  tagIds: string[]
  createdAt?: Date
}

export type CreateThreadSmartFilterInput = {
  tenantId: string
  filterId: string
  name: string
  query: Record<string, unknown>
  createdAt?: Date
}

export type UpdateThreadSmartFilterInput = {
  tenantId: string
  filterId: string
  name?: string
  query?: Record<string, unknown>
  updatedAt?: Date
}
