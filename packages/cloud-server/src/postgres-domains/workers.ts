import type {
  ManagedWorkerCredentialRecord,
  ManagedWorkerHeartbeatRecord,
  ManagedWorkerPoolRecord,
  ManagedWorkerRecord,
} from '../control-plane-store.ts'
import { iso, isoOrNull, jsonRecord, jsonStringArray, numberValue, stringOrNull, type QueryRow } from './shared.ts'

export function managedWorkerPoolFromRow(row: QueryRow): ManagedWorkerPoolRecord {
  return {
    poolId: String(row.pool_id),
    orgId: String(row.org_id),
    tenantId: stringOrNull(row.tenant_id),
    name: String(row.name),
    mode: String(row.mode) as ManagedWorkerPoolRecord['mode'],
    status: String(row.status) as ManagedWorkerPoolRecord['status'],
    region: stringOrNull(row.region),
    capabilities: jsonRecord(row.capabilities),
    maxWorkers: row.max_workers === null || row.max_workers === undefined ? null : numberValue(row.max_workers),
    maxConcurrentWork: row.max_concurrent_work === null || row.max_concurrent_work === undefined
      ? null
      : numberValue(row.max_concurrent_work),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function managedWorkerFromRow(row: QueryRow): ManagedWorkerRecord {
  return {
    workerId: String(row.worker_id),
    orgId: String(row.org_id),
    tenantId: stringOrNull(row.tenant_id),
    poolId: String(row.pool_id),
    displayName: String(row.display_name),
    status: String(row.status) as ManagedWorkerRecord['status'],
    version: stringOrNull(row.version),
    capabilities: jsonRecord(row.capabilities),
    lastHeartbeatAt: isoOrNull(row.last_heartbeat_at),
    lastErrorCode: stringOrNull(row.last_error_code),
    lastErrorSummary: stringOrNull(row.last_error_summary),
    currentLoad: numberValue(row.current_load),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    revokedAt: isoOrNull(row.revoked_at),
  }
}

export function managedWorkerCredentialFromRow(row: QueryRow): ManagedWorkerCredentialRecord {
  return {
    credentialId: String(row.credential_id),
    orgId: String(row.org_id),
    workerId: String(row.worker_id),
    poolId: String(row.pool_id),
    tokenHash: String(row.token_hash),
    scopes: jsonStringArray(row.scopes) as ManagedWorkerCredentialRecord['scopes'],
    last4: String(row.last4),
    expiresAt: iso(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    lastUsedAt: isoOrNull(row.last_used_at),
    rotatedFromCredentialId: stringOrNull(row.rotated_from_credential_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function managedWorkerHeartbeatFromRow(row: QueryRow): ManagedWorkerHeartbeatRecord {
  return {
    workerId: String(row.worker_id),
    orgId: String(row.org_id),
    tenantId: stringOrNull(row.tenant_id),
    poolId: String(row.pool_id),
    version: stringOrNull(row.version),
    capabilities: jsonRecord(row.capabilities),
    currentLoad: numberValue(row.current_load),
    activeWorkIds: jsonStringArray(row.active_work_ids),
    lastErrorCode: stringOrNull(row.last_error_code),
    lastErrorSummary: stringOrNull(row.last_error_summary),
    heartbeatSequence: row.heartbeat_sequence === null || row.heartbeat_sequence === undefined
      ? null
      : numberValue(row.heartbeat_sequence),
    receivedAt: iso(row.received_at),
  }
}
