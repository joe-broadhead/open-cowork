import { normalizeCloudProjectSource, summarizeCloudProjectSource } from '@open-cowork/shared'
import type {
  ControlPlaneSessionStatus,
  ControlPlaneCommandStatus,
  CloudArtifactIndexRecord,
  CloudLaunchpadSessionSummaryRecord,
  SessionCommandRecord,
  SessionEventRecord,
  SessionProjectionRecord,
  SessionRecord,
  SettingMetadataRecord,
  WorkerHeartbeatRecord,
  WorkerLeaseRecord,
  WorkerRole,
  WorkspaceEventRecord,
} from '../control-plane-store.ts'
import { iso, isoOrNull, jsonRecord, numberValue, stringOrNull, type QueryRow } from './shared.ts'

export function sessionFromRow(row: QueryRow): SessionRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    opencodeSessionId: String(row.opencode_session_id),
    profileName: String(row.profile_name),
    title: stringOrNull(row.title),
    status: String(row.status) as ControlPlaneSessionStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function sessionFromRowWithProjectSource(row: QueryRow): SessionRecord {
  const session = sessionFromRow(row)
  const source = normalizeCloudProjectSource(row.projection_project_source)
  return {
    ...session,
    projectSource: summarizeCloudProjectSource(source),
  }
}

export function eventFromRow(row: QueryRow): SessionEventRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    eventId: String(row.event_id),
    sequence: numberValue(row.sequence),
    type: String(row.type),
    payload: jsonRecord(row.payload),
    createdAt: iso(row.created_at),
  }
}

export function workspaceEventFromRow(row: QueryRow): WorkspaceEventRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: stringOrNull(row.session_id),
    eventId: String(row.event_id),
    sequence: numberValue(row.sequence),
    operation: String(row.operation) as WorkspaceEventRecord['operation'],
    entityType: String(row.entity_type),
    entityId: String(row.entity_id),
    projectionVersion: numberValue(row.projection_version),
    type: String(row.type),
    payload: jsonRecord(row.payload),
    createdAt: iso(row.created_at),
  }
}

export function projectionFromRow(row: QueryRow): SessionProjectionRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    sequence: numberValue(row.sequence),
    view: jsonRecord(row.view),
    updatedAt: iso(row.updated_at),
  }
}

export function artifactIndexFromRow(row: QueryRow): CloudArtifactIndexRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    sessionTitle: stringOrNull(row.session_title),
    artifactId: String(row.artifact_id),
    filename: String(row.filename),
    contentType: stringOrNull(row.content_type),
    size: numberValue(row.size_bytes),
    key: String(row.object_key),
    kind: String(row.kind) as CloudArtifactIndexRecord['kind'],
    status: String(row.status) as CloudArtifactIndexRecord['status'],
    authorAgentId: stringOrNull(row.author_agent_id),
    projectId: stringOrNull(row.project_id),
    taskId: stringOrNull(row.task_id),
    statusUpdatedBy: stringOrNull(row.status_updated_by),
    statusUpdatedAt: isoOrNull(row.status_updated_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function launchpadSessionSummaryFromRow(row: QueryRow): CloudLaunchpadSessionSummaryRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    sessionTitle: stringOrNull(row.session_title),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    pendingApprovals: Array.isArray(row.pending_approvals) ? row.pending_approvals as CloudLaunchpadSessionSummaryRecord['pendingApprovals'] : [],
    pendingQuestions: Array.isArray(row.pending_questions) ? row.pending_questions as CloudLaunchpadSessionSummaryRecord['pendingQuestions'] : [],
  }
}

export function leaseFromRow(row: QueryRow): WorkerLeaseRecord {
  return {
    tenantId: String(row.tenant_id),
    sessionId: String(row.session_id),
    leasedBy: String(row.leased_by),
    leaseToken: String(row.lease_token),
    leaseExpiresAt: numberValue(row.lease_expires_at_ms),
    checkpointVersion: numberValue(row.checkpoint_version),
  }
}

export function commandFromRow(row: QueryRow): SessionCommandRecord {
  return {
    commandId: String(row.command_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    sessionId: String(row.session_id),
    kind: String(row.kind) as SessionCommandRecord['kind'],
    payload: jsonRecord(row.payload),
    targetLeaseToken: stringOrNull(row.target_lease_token),
    createdSequence: numberValue(row.created_sequence),
    createdAt: iso(row.created_at),
    status: String(row.status) as ControlPlaneCommandStatus,
    claimedBy: stringOrNull(row.claimed_by),
    claimedLeaseToken: stringOrNull(row.claimed_lease_token),
    attemptCount: numberValue(row.attempt_count),
    availableAt: row.available_at ? iso(row.available_at) : null,
    lastErrorCode: stringOrNull(row.last_error_code),
    lastErrorSummary: stringOrNull(row.last_error_summary),
    ackedAt: row.acked_at ? iso(row.acked_at) : null,
    error: stringOrNull(row.error),
  }
}

export function heartbeatFromRow(row: QueryRow): WorkerHeartbeatRecord {
  return {
    workerId: String(row.worker_id),
    role: String(row.role) as WorkerRole,
    activeSessionIds: Array.isArray(row.active_session_ids)
      ? row.active_session_ids.map(String)
      : [],
    lastSeenAt: iso(row.last_seen_at),
  }
}

export function settingFromRow(row: QueryRow): SettingMetadataRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: stringOrNull(row.user_id),
    key: String(row.key),
    value: jsonRecord(row.value),
    updatedAt: iso(row.updated_at),
  }
}
