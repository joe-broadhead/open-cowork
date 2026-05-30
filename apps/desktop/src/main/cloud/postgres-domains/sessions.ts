import type {
  ControlPlaneSessionStatus,
  ControlPlaneCommandStatus,
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
import { iso, jsonRecord, numberValue, stringOrNull, type QueryRow } from './shared.ts'

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
