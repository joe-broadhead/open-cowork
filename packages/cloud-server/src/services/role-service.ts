import type {
  ControlPlaneStore,
  CustomRoleRecord,
  MemberPermissionResolution,
} from '../control-plane-store.ts'
import {
  CONTROL_PLANE_PERMISSIONS,
  normalizeControlPlanePermissions,
  normalizeCustomRoleKey,
  permissionsRemoved,
  type ControlPlanePermission,
} from '../control-plane-permissions.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import type { AuditActorInput } from '../control-plane-account-inputs.ts'
import type { CloudPrincipal } from '../session-service-types.ts'

// Custom-role management service: the permission-map surface an org uses to define
// roles beyond owner/admin/member, assign one to a member, and resolve a member's
// effective permissions. Enforces authorization via the effective permission set
// (roles:manage / members:manage), and revokes a member's issued credentials the
// moment a role change strips permissions so the downgrade takes effect immediately.
// SSO/SCIM/admin-ready: every method takes a typed principal + typed inputs.

export type CloudRoleServiceOptions = {
  store: ControlPlaneStore
  ensurePrincipal: (principal: CloudPrincipal) => Promise<unknown> | unknown
  assertPermission: (principal: CloudPrincipal, permission: ControlPlanePermission) => void
  principalOrgId: (principal: CloudPrincipal) => string
  auditActor: (principal: CloudPrincipal) => AuditActorInput
}

export type CreateCustomRoleRequest = {
  roleKey: string
  name: string
  description?: string | null
  baseRole?: 'owner' | 'admin' | 'member' | null
  permissions: readonly string[]
}

export type UpdateCustomRoleRequest = {
  name?: string | null
  description?: string | null
  baseRole?: 'owner' | 'admin' | 'member' | null
  permissions?: readonly string[] | null
}

export class CloudRoleService {
  private readonly store: ControlPlaneStore
  private readonly ensurePrincipal: CloudRoleServiceOptions['ensurePrincipal']
  private readonly assertPermission: CloudRoleServiceOptions['assertPermission']
  private readonly principalOrgId: CloudRoleServiceOptions['principalOrgId']
  private readonly auditActor: CloudRoleServiceOptions['auditActor']

  constructor(options: CloudRoleServiceOptions) {
    this.store = options.store
    this.ensurePrincipal = options.ensurePrincipal
    this.assertPermission = options.assertPermission
    this.principalOrgId = options.principalOrgId
    this.auditActor = options.auditActor
  }

  // The assignable permission catalog — admin/SCIM surfaces render roles against this.
  listPermissionCatalog(): ControlPlanePermission[] {
    return [...CONTROL_PLANE_PERMISSIONS]
  }

  async listCustomRoles(principal: CloudPrincipal): Promise<CustomRoleRecord[]> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'roles:manage')
    return this.store.listCustomRoles(this.principalOrgId(principal))
  }

  async createCustomRole(principal: CloudPrincipal, input: CreateCustomRoleRequest): Promise<CustomRoleRecord> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'roles:manage')
    return this.store.createCustomRole({
      orgId: this.principalOrgId(principal),
      roleKey: normalizeCustomRoleKey(input.roleKey),
      name: input.name,
      description: input.description ?? null,
      baseRole: input.baseRole || 'member',
      permissions: normalizeControlPlanePermissions(input.permissions),
      actor: this.auditActor(principal),
    })
  }

  async updateCustomRole(
    principal: CloudPrincipal,
    roleKey: string,
    input: UpdateCustomRoleRequest,
  ): Promise<CustomRoleRecord> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'roles:manage')
    const orgId = this.principalOrgId(principal)
    const key = normalizeCustomRoleKey(roleKey)
    const before = await this.store.getCustomRole(orgId, key)
    if (!before) throw new CloudServiceError(404, 'Custom role was not found.')
    const updated = await this.store.updateCustomRole({
      orgId,
      roleKey: key,
      name: input.name ?? undefined,
      description: input.description === undefined ? undefined : input.description,
      baseRole: input.baseRole ?? undefined,
      permissions: input.permissions == null ? undefined : normalizeControlPlanePermissions(input.permissions),
      actor: this.auditActor(principal),
    })
    if (!updated) throw new CloudServiceError(404, 'Custom role was not found.')
    // If the role's permission set shrank, every member holding it just lost access —
    // revoke their issued credentials so the change is enforced on the next request.
    if (permissionsRemoved(before.permissions, updated.permissions).length > 0) {
      await this.revokeCredentialsForRole(orgId, key, principal, 'custom_role_permissions_reduced')
    }
    return updated
  }

  async deleteCustomRole(principal: CloudPrincipal, roleKey: string): Promise<boolean> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'roles:manage')
    const orgId = this.principalOrgId(principal)
    const key = normalizeCustomRoleKey(roleKey)
    // Members assigned this role fall back to their built-in role map. Revoke their
    // credentials so any capability the (now-removed) custom role granted beyond the
    // built-in map cannot linger on an issued token.
    await this.revokeCredentialsForRole(orgId, key, principal, 'custom_role_deleted')
    return this.store.deleteCustomRole(orgId, key)
  }

  // Assign (roleKey) or clear (null) a member's custom role. Preserves the base
  // membership role/status; revokes credentials if the assignment strips permissions.
  async assignMemberRole(
    principal: CloudPrincipal,
    accountId: string,
    input: { roleKey: string | null },
  ): Promise<MemberPermissionResolution> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'members:manage')
    const orgId = this.principalOrgId(principal)
    const members = await this.store.listOrgMembers(orgId, { limit: 500 })
    const member = members.find((entry) => entry.accountId === accountId)
    if (!member) throw new CloudServiceError(404, 'Org member was not found.')
    const roleKey = input.roleKey === null ? null : normalizeCustomRoleKey(input.roleKey)
    if (roleKey) {
      const role = await this.store.getCustomRole(orgId, roleKey)
      if (!role) throw new CloudServiceError(404, `Custom role ${roleKey} was not found.`)
    }
    const before = await this.store.resolveMemberPermissions(orgId, accountId)
    await this.store.upsertMembership({
      orgId,
      accountId,
      role: member.role,
      status: member.status,
      customRoleKey: roleKey,
      actor: this.auditActor(principal),
    })
    const after = await this.store.resolveMemberPermissions(orgId, accountId)
    if (before && after && permissionsRemoved(before.permissions, after.permissions).length > 0) {
      await this.store.revokeApiTokensForAccount({
        orgId,
        accountId,
        reason: 'member_role_assignment_downgraded',
        actor: this.auditActor(principal),
      })
    }
    if (!after) throw new CloudServiceError(404, 'Org member was not found.')
    return after
  }

  async resolveMemberPermissions(principal: CloudPrincipal, accountId: string): Promise<MemberPermissionResolution> {
    await this.ensurePrincipal(principal)
    this.assertPermission(principal, 'members:read')
    const orgId = this.principalOrgId(principal)
    const resolution = await this.store.resolveMemberPermissions(orgId, accountId)
    if (!resolution) throw new CloudServiceError(404, 'Org member was not found.')
    return resolution
  }

  private async revokeCredentialsForRole(
    orgId: string,
    roleKey: string,
    principal: CloudPrincipal,
    reason: string,
  ): Promise<number> {
    const members = await this.store.listOrgMembers(orgId, { limit: 500 })
    let revoked = 0
    for (const member of members) {
      if (member.customRoleKey !== roleKey) continue
      revoked += await this.store.revokeApiTokensForAccount({
        orgId,
        accountId: member.accountId,
        reason,
        actor: this.auditActor(principal),
      })
    }
    return revoked
  }
}
