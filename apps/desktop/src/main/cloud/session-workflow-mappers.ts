import { createHash } from 'node:crypto'
import type { WorkflowRun } from '@open-cowork/shared'
import type { CloudWorkflowRecord, CloudWorkflowRunRecord } from './control-plane-store.ts'
import type { WorkflowWebhookAuth } from '../workflow/workflow-webhook-server.ts'

// Pure mappers from the control-plane's stored workflow records to the public
// API shapes (stripping tenant/claim/internal fields), plus the run-terminal
// predicate and the signature-webhook replay key. Extracted from
// session-service.ts; no service state.

export function toWorkflowSummary(record: CloudWorkflowRecord) {
  const { tenantId: _tenantId, userId: _userId, ...workflow } = record
  return workflow
}

export function toWorkflowRun(record: CloudWorkflowRunRecord): WorkflowRun {
  const {
    tenantId: _tenantId,
    userId: _userId,
    claimedBy: _claimedBy,
    claimToken: _claimToken,
    claimExpiresAt: _claimExpiresAt,
    attemptCount: _attemptCount,
    idempotencyKey: _idempotencyKey,
    checkpointVersion: _checkpointVersion,
    lastErrorCode: _lastErrorCode,
    lastErrorSummary: _lastErrorSummary,
    ...run
  } = record
  return run
}

export function workflowRunTerminal(status: WorkflowRun['status']) {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function workflowWebhookReplayKey(workflowId: string, auth: Extract<WorkflowWebhookAuth, { kind: 'signature' }>) {
  const workflowKey = createHash('sha256').update(workflowId).digest('hex').slice(0, 16)
  return `${workflowKey}:${auth.timestamp}:${auth.signature}`
}
