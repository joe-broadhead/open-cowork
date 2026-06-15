import type {
  WorkflowRunStatus,
  WorkflowStatus,
  WorkflowTrigger,
  WorkflowTriggerType,
} from '@open-cowork/shared'
import { normalizeWorkflowSteps } from '@open-cowork/shared'
import type { CloudWorkflowRecord, CloudWorkflowRunRecord } from '../control-plane-store.ts'
import { iso, isoOrNull, jsonRecord, jsonStringArray, stringOrNull, type QueryRow } from './shared.ts'

function workflowTriggers(value: unknown): WorkflowTrigger[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is WorkflowTrigger => Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)))
    : []
}

export function workflowFromRow(row: QueryRow): CloudWorkflowRecord {
  const instructions = String(row.instructions)
  const agentName = String(row.agent_name || 'build')
  const skillNames = jsonStringArray(row.skill_names)
  const toolIds = jsonStringArray(row.tool_ids)
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    id: String(row.workflow_id),
    title: String(row.title),
    instructions,
    agentName,
    skillNames,
    toolIds,
    steps: normalizeWorkflowSteps(row.steps, {
      instructions,
      agentName,
      skillNames,
      toolIds,
    }),
    projectDirectory: stringOrNull(row.project_directory),
    draftSessionId: stringOrNull(row.draft_session_id),
    triggers: workflowTriggers(row.triggers),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    nextRunAt: isoOrNull(row.next_run_at),
    lastRunAt: isoOrNull(row.last_run_at),
    latestRunId: stringOrNull(row.latest_run_id),
    latestRunStatus: row.latest_run_status ? String(row.latest_run_status) as WorkflowRunStatus : null,
    latestRunSessionId: stringOrNull(row.latest_run_session_id),
    latestRunSummary: stringOrNull(row.latest_run_summary),
    status: String(row.status) as WorkflowStatus,
    webhookUrl: null,
  }
}

export function workflowRunFromRow(row: QueryRow): CloudWorkflowRunRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    id: String(row.run_id),
    workflowId: String(row.workflow_id),
    sessionId: stringOrNull(row.session_id),
    triggerType: String(row.trigger_type) as WorkflowTriggerType,
    triggerPayload: row.trigger_payload ? jsonRecord(row.trigger_payload) : null,
    status: String(row.status) as WorkflowRunStatus,
    title: String(row.title),
    summary: stringOrNull(row.summary),
    error: stringOrNull(row.error),
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    claimedBy: stringOrNull(row.claimed_by),
    claimToken: stringOrNull(row.claim_token),
    claimExpiresAt: isoOrNull(row.claim_expires_at),
    attemptCount: row.attempt_count === undefined ? 0 : Number(row.attempt_count),
    idempotencyKey: stringOrNull(row.idempotency_key),
    checkpointVersion: row.checkpoint_version === undefined ? 0 : Number(row.checkpoint_version),
    lastErrorCode: stringOrNull(row.last_error_code),
    lastErrorSummary: stringOrNull(row.last_error_summary),
  }
}
