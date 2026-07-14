import type {
  ControlPlaneMembershipStatus,
  ControlPlanePermission,
  ControlPlaneRole,
  ControlPlaneStore,
} from '../control-plane-store.ts'
import { builtinRolePermissions, hasPermission } from '../control-plane-permissions.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import {
  DEFAULT_SINGLE_ORG_ID,
  DEFAULT_SINGLE_ORG_NAME,
  resolvedOrgMode,
  resolvedSignupMode,
  type CloudIdentityPolicy,
} from './api-token-policy.ts'
import { principalCanManageOrg, principalEmailDomain } from '../session-principal-access.ts'
import { importAuditActor, type CloudPrincipal } from '../session-service-types.ts'

export type CloudPrincipalServiceDeps = {
  store: ControlPlaneStore
  identityPolicy: CloudIdentityPolicy
}

export class CloudPrincipalService {
  private readonly store: ControlPlaneStore
  private readonly identityPolicy: CloudIdentityPolicy
  // Per-(tenant,account) "already bootstrapped" markers. The org-active and
  // membership-active gates still run on EVERY request via
  // resolvePrincipalMembership (a read); this only lets a request SKIP the
  // idempotent bootstrap WRITES (createTenant / ensureOrgForTenant /
  // createAccount / ensureUser / upsertMembership) once a principal has been
  // bootstrapped within the short TTL. No principal/role is cached, so a revoked
  // token, deactivated org, or inactive membership is still rejected on the very
  // next request — there is no revocation window.
  private readonly bootstrappedPrincipals = new Map<string, number>()

  constructor(deps: CloudPrincipalServiceDeps) {
    this.store = deps.store
    this.identityPolicy = deps.identityPolicy
  }

  // In single-org (self-host) mode every principal is funneled into the one
  // auto-bootstrapped org: force the tenant/org identity before any membership
  // resolution so an incoming tenant claim can't select a different tenant. No-op
  // in multi-org mode. The org itself is materialised by the existing
  // createTenant / ensureOrgForTenant bootstrap below.
  private applySingleOrgMode(principal: CloudPrincipal) {
    if (resolvedOrgMode(this.identityPolicy) !== 'single-org') return
    const orgId = this.identityPolicy.singleOrgId?.trim() || DEFAULT_SINGLE_ORG_ID
    principal.tenantId = orgId
    principal.orgId = orgId
    principal.tenantName = this.identityPolicy.singleOrgName?.trim() || DEFAULT_SINGLE_ORG_NAME
  }

  // Resolve and attach the member's effective permission set (custom-role map when
  // assigned, else the built-in role map) so authorization can consult it. Falls
  // back to the built-in role map if the membership row can't be resolved.
  private async applyEffectivePermissions(principal: CloudPrincipal) {
    const orgId = principal.orgId || principal.tenantId
    const accountId = principal.accountId || principal.userId
    const resolution = await this.store.resolveMemberPermissions(orgId, accountId)
    if (resolution) {
      principal.permissions = resolution.permissions
      principal.customRoleKey = resolution.customRoleKey
      return
    }
    principal.permissions = builtinRolePermissions(principal.role || 'member')
    principal.customRoleKey = null
  }

  async ensurePrincipal(principal: CloudPrincipal) {
    this.applySingleOrgMode(principal)
    const signupMode = resolvedSignupMode(this.identityPolicy)
    const allowedDomains = (this.identityPolicy.allowedEmailDomains || [])
      .map((domain) => domain.trim().toLowerCase())
      .filter(Boolean)
    if (principal.authSource !== 'local' && signupMode === 'domain' && allowedDomains.length > 0) {
      const emailDomain = principalEmailDomain(principal.email)
      if (!emailDomain || !allowedDomains.includes(emailDomain)) {
        throw new CloudServiceError(403, 'Cloud signup is restricted to approved email domains.')
      }
    }
    const existingMembership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    const requiresExistingMembership = principal.authSource !== 'local' && principal.authSource !== 'api_token'
      && (!this.identityPolicy.allowSelfServiceSignup || signupMode === 'disabled' || signupMode === 'invite')
    if (requiresExistingMembership) {
      const acceptableStatuses: ControlPlaneMembershipStatus[] = signupMode === 'invite'
        ? ['active', 'invited']
        : ['active']
      if (
        !existingMembership
        || !acceptableStatuses.includes(existingMembership.membership.status)
      ) {
        throw new CloudServiceError(403, 'Cloud membership is not active.')
      }
    }
    // Fast path: once a (tenant, account) has been bootstrapped within the TTL,
    // skip the idempotent bootstrap WRITES below. Every security gate is still
    // enforced on THIS request from the fresh `existingMembership` read above —
    // org must be active, membership must be active — so a deactivated org or
    // revoked/expired membership is rejected on the very next request. Nothing
    // is mutated server-side; only the redundant upserts are avoided.
    const bootstrapKey = `${principal.tenantId}\u0000${principal.accountId || principal.userId}`
    const bootstrappedUntil = this.bootstrappedPrincipals.get(bootstrapKey)
    if (
      bootstrappedUntil !== undefined
      && bootstrappedUntil > Date.now()
      && existingMembership
      && existingMembership.membership.status === 'active'
      && (principal.authSource === 'local' || existingMembership.org.status === 'active')
    ) {
      principal.tenantId = existingMembership.org.tenantId
      principal.orgId = existingMembership.org.orgId
      principal.tenantName = existingMembership.org.name
      principal.accountId = existingMembership.account.accountId
      principal.email = existingMembership.account.email
      principal.role = existingMembership.membership.role
      await this.applyEffectivePermissions(principal)
      return
    }
    await this.store.createTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
      orgId: principal.orgId,
    })
    const org = await this.store.ensureOrgForTenant({
      tenantId: principal.tenantId,
      name: principal.tenantName || principal.tenantId,
      orgId: principal.orgId,
    })
    if (principal.authSource !== 'local' && org.status !== 'active') {
      throw new CloudServiceError(403, 'Cloud org is not active.')
    }
    const account = await this.store.createAccount({
      accountId: existingMembership?.account.accountId || principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    const role = existingMembership?.membership.role || principal.role || 'member'
    const user = await this.store.ensureUser({
      tenantId: principal.tenantId,
      userId: principal.userId,
      email: principal.email,
      role,
    })
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: account.accountId,
      email: account.email,
    })
    let effectiveRole: ControlPlaneRole
    if (!membership) {
      if (requiresExistingMembership) {
        throw new CloudServiceError(403, 'Cloud membership is not active.')
      }
      const createdMembership = await this.store.upsertMembership({
        orgId: org.orgId,
        accountId: account.accountId,
        role: principal.role || user.role,
        status: 'active',
        actor: { actorType: 'system', actorId: 'principal.bootstrap' },
      })
      effectiveRole = createdMembership.role
    } else if (membership.membership.status === 'invited' && principal.authSource === 'user' && signupMode === 'invite') {
      const activatedMembership = await this.store.upsertMembership({
        orgId: org.orgId,
        accountId: account.accountId,
        role: membership.membership.role,
        status: 'active',
        actor: { actorType: 'system', actorId: 'membership.invite.accepted' },
      })
      effectiveRole = activatedMembership.role
    } else if (membership.membership.status !== 'active') {
      throw new CloudServiceError(403, 'Cloud membership is not active.')
    } else {
      effectiveRole = membership.membership.role
    }
    principal.tenantId = org.tenantId
    principal.orgId = org.orgId
    principal.tenantName = org.name
    principal.accountId = account.accountId
    principal.email = account.email
    principal.role = effectiveRole
    await this.applyEffectivePermissions(principal)
    // Mark bootstrapped so subsequent requests within the TTL take the fast path
    // above and skip these idempotent writes (the gates still re-run each time).
    this.bootstrappedPrincipals.set(bootstrapKey, Date.now() + 60_000)
  }

  principalOrgId(principal: CloudPrincipal) {
    return principal.orgId || principal.tenantId
  }

  async principalIsActiveWorkspaceMember(principal: CloudPrincipal) {
    const membership = await this.store.resolvePrincipalMembership({
      tenantId: principal.tenantId,
      accountId: principal.accountId || principal.userId,
      idpSubject: principal.userId,
      email: principal.email,
    })
    return membership?.membership.status === 'active'
  }

  // Effective permissions attached during ensurePrincipal. Local principals bypass
  // the permission model; otherwise the resolved set (custom-role-aware) is used,
  // falling back to the built-in role map if ensurePrincipal has not populated it.
  principalPermissions(principal: CloudPrincipal): ControlPlanePermission[] {
    if (principal.permissions) return principal.permissions
    return builtinRolePermissions(principal.role || 'member')
  }

  principalHasPermission(principal: CloudPrincipal, permission: ControlPlanePermission): boolean {
    if (principal.authSource === 'local') return true
    return hasPermission(this.principalPermissions(principal), permission)
  }

  principalHasAnyPermission(principal: CloudPrincipal, permissions: readonly ControlPlanePermission[]): boolean {
    if (principal.authSource === 'local') return true
    const effectivePermissions = this.principalPermissions(principal)
    return permissions.some((permission) => hasPermission(effectivePermissions, permission))
  }

  assertPermission(principal: CloudPrincipal, permission: ControlPlanePermission) {
    if (!this.principalHasPermission(principal, permission)) {
      throw new CloudServiceError(403, `This action requires the "${permission}" permission.`)
    }
  }

  assertAnyPermission(principal: CloudPrincipal, permissions: readonly ControlPlanePermission[], message?: string) {
    if (!this.principalHasAnyPermission(principal, permissions)) {
      throw new CloudServiceError(403, message || `This action requires one of: ${permissions.map((permission) => `"${permission}"`).join(', ')}.`)
    }
  }

  assertOrgAdmin(principal: CloudPrincipal) {
    // When a custom role is in effect its permission map is authoritative — this is
    // how a custom role can DOWNGRADE a base admin below org-management, or UPGRADE a
    // base member to it. With no custom role, the built-in role/scope gate applies so
    // existing behaviour is unchanged.
    if (principal.customRoleKey) {
      if (principal.authSource === 'local') return
      if (hasPermission(this.principalPermissions(principal), 'org:manage') || hasPermission(this.principalPermissions(principal), 'members:manage')) {
        return
      }
      throw new CloudServiceError(403, 'Org administration requires the "org:manage" or "members:manage" permission.')
    }
    if (!principalCanManageOrg(principal)) {
      throw new CloudServiceError(403, 'Org administration requires an org admin or admin-scoped API token.')
    }
  }

  auditActor(principal: CloudPrincipal) {
    return importAuditActor(principal)
  }
}
