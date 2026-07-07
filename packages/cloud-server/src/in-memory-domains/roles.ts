import { clone, key, nowIso, normalizeNullableText, normalizeText } from './store-helpers.ts'
import {
  normalizeControlPlanePermissions,
  normalizeCustomRoleKey,
  type CreateCustomRoleInput,
  type CustomRoleRecord,
  type UpdateCustomRoleInput,
} from '../control-plane-permissions.ts'
import type { ControlPlaneRole, RecordAuditEventInput, AuditEventRecord } from '../control-plane-store.ts'

// Custom-roles domain: org-defined named permission maps beyond owner/admin/member.
// Owns the (org, roleKey) → CustomRoleRecord table and its create/list/get/update/
// delete lifecycle. Org existence + audit recording arrive via the injected host,
// mirroring the other in-memory domains. Behaviour-preserving with the Postgres peer;
// covered by the cloud-control-plane-store contract + RBAC suites.

type InMemoryRolesHost = {
  orgExists(orgId: string): boolean
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

const ROLE_NAME_MAX_LENGTH = 96
const ROLE_DESCRIPTION_MAX_LENGTH = 512

export class InMemoryRolesDomain {
  private readonly roles = new Map<string, CustomRoleRecord>()
  private readonly host: InMemoryRolesHost

  constructor(host: InMemoryRolesHost) {
    this.host = host
  }

  private normalizeBaseRole(role: ControlPlaneRole | null | undefined): ControlPlaneRole {
    return role === 'owner' || role === 'admin' ? role : 'member'
  }

  createCustomRole(input: CreateCustomRoleInput): CustomRoleRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const roleKey = normalizeCustomRoleKey(input.roleKey)
    const roleMapKey = key(input.orgId, roleKey)
    if (this.roles.has(roleMapKey)) throw new Error(`Custom role ${roleKey} already exists.`)
    const now = nowIso(input.createdAt)
    const record: CustomRoleRecord = {
      orgId: input.orgId,
      roleKey,
      name: normalizeText(input.name, ROLE_NAME_MAX_LENGTH, 'Custom role name'),
      description: normalizeNullableText(input.description, ROLE_DESCRIPTION_MAX_LENGTH, 'Custom role description'),
      baseRole: this.normalizeBaseRole(input.baseRole),
      permissions: normalizeControlPlanePermissions(input.permissions),
      createdAt: now,
      updatedAt: now,
    }
    this.roles.set(roleMapKey, record)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'custom_role.created',
      targetType: 'custom_role',
      targetId: roleKey,
      metadata: { name: record.name, baseRole: record.baseRole, permissions: record.permissions },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  listCustomRoles(orgId: string): CustomRoleRecord[] {
    return [...this.roles.values()]
      .filter((role) => role.orgId === orgId)
      .sort((left, right) => left.roleKey.localeCompare(right.roleKey))
      .map((role) => clone(role))
  }

  getCustomRole(orgId: string, roleKey: string): CustomRoleRecord | null {
    const record = this.roles.get(key(orgId, roleKey))
    return record && record.orgId === orgId ? clone(record) : null
  }

  updateCustomRole(input: UpdateCustomRoleInput): CustomRoleRecord | null {
    const existing = this.roles.get(key(input.orgId, input.roleKey))
    if (!existing || existing.orgId !== input.orgId) return null
    if (input.name !== undefined && input.name !== null) existing.name = normalizeText(input.name, ROLE_NAME_MAX_LENGTH, 'Custom role name')
    if (input.description !== undefined) existing.description = normalizeNullableText(input.description, ROLE_DESCRIPTION_MAX_LENGTH, 'Custom role description')
    if (input.baseRole !== undefined && input.baseRole !== null) existing.baseRole = this.normalizeBaseRole(input.baseRole)
    if (input.permissions !== undefined && input.permissions !== null) existing.permissions = normalizeControlPlanePermissions(input.permissions)
    existing.updatedAt = nowIso(input.updatedAt)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'custom_role.updated',
      targetType: 'custom_role',
      targetId: existing.roleKey,
      metadata: { name: existing.name, baseRole: existing.baseRole, permissions: existing.permissions },
      createdAt: input.updatedAt,
    })
    return clone(existing)
  }

  deleteCustomRole(orgId: string, roleKey: string): boolean {
    const roleMapKey = key(orgId, roleKey)
    const existing = this.roles.get(roleMapKey)
    if (!existing || existing.orgId !== orgId) return false
    this.roles.delete(roleMapKey)
    this.host.recordAuditEvent({
      orgId,
      actorType: 'system',
      actorId: 'custom_role.delete',
      eventType: 'custom_role.deleted',
      targetType: 'custom_role',
      targetId: roleKey,
      metadata: {},
    })
    return true
  }
}
