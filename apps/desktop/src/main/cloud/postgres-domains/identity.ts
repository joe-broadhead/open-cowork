import type {
  AccountRecord,
  ApiTokenRecord,
  AuditEventRecord,
  CloudAuthBackoffRecord,
  ControlPlaneRole,
  MembershipRecord,
  OrgRecord,
  TenantRecord,
  UserRecord,
} from '../control-plane-store.ts'
import { iso, isoOrNull, jsonRecord, jsonStringArray, numberValue, stringOrNull, type QueryRow } from './shared.ts'

export function tenantFromRow(row: QueryRow): TenantRecord {
  return {
    tenantId: String(row.tenant_id),
    name: String(row.name),
    createdAt: iso(row.created_at),
  }
}

export function userFromRow(row: QueryRow): UserRecord {
  return {
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    email: String(row.email),
    role: String(row.role) as ControlPlaneRole,
    createdAt: iso(row.created_at),
  }
}

export function orgFromRow(row: QueryRow): OrgRecord {
  return {
    orgId: String(row.org_id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    planKey: stringOrNull(row.plan_key),
    status: String(row.status),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function accountFromRow(row: QueryRow): AccountRecord {
  return {
    accountId: String(row.account_id),
    idpSubject: stringOrNull(row.idp_subject),
    email: String(row.email),
    displayName: stringOrNull(row.display_name),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function membershipFromRow(row: QueryRow): MembershipRecord {
  return {
    orgId: String(row.org_id),
    accountId: String(row.account_id),
    role: String(row.role) as ControlPlaneRole,
    status: String(row.status) as MembershipRecord['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function apiTokenFromRow(row: QueryRow): ApiTokenRecord {
  return {
    tokenId: String(row.token_id),
    orgId: String(row.org_id),
    accountId: stringOrNull(row.account_id),
    name: String(row.name),
    tokenHash: String(row.token_hash),
    scopes: jsonStringArray(row.scopes) as ApiTokenRecord['scopes'],
    last4: String(row.last4),
    expiresAt: isoOrNull(row.expires_at),
    revokedAt: isoOrNull(row.revoked_at),
    lastUsedAt: isoOrNull(row.last_used_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function auditEventFromRow(row: QueryRow): AuditEventRecord {
  return {
    eventId: String(row.event_id),
    orgId: String(row.org_id),
    accountId: stringOrNull(row.account_id),
    eventType: String(row.event_type),
    actorType: String(row.actor_type) as AuditEventRecord['actorType'],
    actorId: stringOrNull(row.actor_id),
    targetType: stringOrNull(row.target_type),
    targetId: stringOrNull(row.target_id),
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
  }
}

export function cloudAuthBackoffFromRow(row: QueryRow, nowMs: number): CloudAuthBackoffRecord {
  const blockedUntilMs = numberValue(row.blocked_until_ms)
  return {
    allowed: blockedUntilMs <= nowMs,
    scope: String(row.scope),
    source: String(row.source),
    failureCount: numberValue(row.auth_failure_count),
    blockedUntilMs,
    retryAfterMs: Math.max(0, blockedUntilMs - nowMs),
  }
}
