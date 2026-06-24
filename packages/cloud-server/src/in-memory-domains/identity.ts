import { clone, key, nowIso } from './store-helpers.ts'
import type {
  AccountRecord,
  AuditEventRecord,
  ControlPlaneRole,
  CreateAccountInput,
  MembershipRecord,
  OrgMemberRecord,
  OrgRecord,
  PrincipalMembershipRecord,
  RecordAuditEventInput,
  TenantRecord,
  UpsertMembershipInput,
  UserRecord,
} from '../control-plane-store.ts'

// Identity-root domain extracted from in-memory-control-plane-store.ts. Owns the
// tenant / user / org / account / membership records + their lookup indexes, and the
// full create/ensure/find/upsert/list/resolve lifecycle plus the existence &
// require checks every other domain depends on. Audit recording arrives via the
// host. This is the control-plane *foundation*; the store now reaches it only
// through this domain's accessors (orgExists/accountExists/requireTenant/… are thin
// delegates). Behaviour-preserving; covered by the cloud-control-plane-store suite.

type InMemoryIdentityHost = {
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryIdentityDomain {
  private readonly tenants = new Map<string, TenantRecord>()
  private readonly users = new Map<string, UserRecord>()
  private readonly orgs = new Map<string, OrgRecord>()
  private readonly orgsByTenant = new Map<string, string>()
  private readonly accounts = new Map<string, AccountRecord>()
  private readonly accountsBySubject = new Map<string, string>()
  private readonly accountsByEmail = new Map<string, string>()
  private readonly memberships = new Map<string, MembershipRecord>()
  private readonly host: InMemoryIdentityHost

  constructor(host: InMemoryIdentityHost) {
    this.host = host
  }

  orgIdForTenant(tenantId: string) {
    return this.orgsByTenant.get(tenantId) || tenantId
  }

  // The tenant an org belongs to (the org→tenant read every non-identity caller
  // needs) — centralized so the org map can later move into an identity domain.
  orgTenantId(orgId: string): string | null {
    return this.orgs.get(orgId)?.tenantId || null
  }

  // The org id for a tenant, or null when neither a mapped org nor the tenant-as-org
  // exists (the lease-reaper's lookup) — centralized over the orgsByTenant index.
  resolveOrgIdOrNull(tenantId: string): string | null {
    return this.orgsByTenant.get(tenantId) || (this.orgExists(tenantId) ? tenantId : null)
  }

  createTenant(input: { tenantId: string, name: string, orgId?: string, createdAt?: Date }): TenantRecord {
    const existing = this.tenants.get(input.tenantId)
    if (existing) {
      this.ensureOrgForTenant({ tenantId: input.tenantId, name: existing.name, orgId: input.orgId, createdAt: input.createdAt })
      return clone(existing)
    }
    const record: TenantRecord = {
      tenantId: input.tenantId,
      name: input.name,
      createdAt: nowIso(input.createdAt),
    }
    this.tenants.set(input.tenantId, record)
    this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.name, orgId: input.orgId, createdAt: input.createdAt })
    return clone(record)
  }

  ensureUser(input: {
    tenantId: string
    userId: string
    email: string
    role?: ControlPlaneRole
    createdAt?: Date
  }): UserRecord {
    this.requireTenant(input.tenantId)
    const userKey = key(input.tenantId, input.userId)
    const existing = this.users.get(userKey)
    if (existing) return clone(existing)
    const record: UserRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      email: input.email,
      role: input.role || 'member',
      createdAt: nowIso(input.createdAt),
    }
    this.users.set(userKey, record)
    const org = this.ensureOrgForTenant({ tenantId: input.tenantId, name: input.tenantId, createdAt: input.createdAt })
    const account = this.createAccount({
      accountId: input.userId,
      idpSubject: input.userId,
      email: input.email,
      createdAt: input.createdAt,
    })
    this.upsertMembership({
      orgId: org.orgId,
      accountId: account.accountId,
      role: input.role || 'member',
      status: 'active',
      updatedAt: input.createdAt,
      actor: { actorType: 'system', actorId: 'compat.ensureUser' },
    })
    return clone(record)
  }

  ensureOrgForTenant(input: { tenantId: string, name: string, orgId?: string, planKey?: string | null, status?: string, createdAt?: Date }): OrgRecord {
    const existingOrgId = this.orgsByTenant.get(input.tenantId)
    if (existingOrgId) return clone(this.orgs.get(existingOrgId) as OrgRecord)
    const createdAt = nowIso(input.createdAt)
    const orgId = input.orgId || input.tenantId
    const record: OrgRecord = {
      orgId,
      tenantId: input.tenantId,
      name: input.name,
      planKey: input.planKey ?? null,
      status: input.status || 'active',
      createdAt,
      updatedAt: createdAt,
    }
    this.orgs.set(orgId, record)
    this.orgsByTenant.set(input.tenantId, orgId)
    return clone(record)
  }

  createAccount(input: CreateAccountInput): AccountRecord {
    const bySubject = input.idpSubject ? this.accountsBySubject.get(input.idpSubject) : null
    const byEmail = this.accountsByEmail.get(input.email.toLowerCase())
    const existing = this.accounts.get(bySubject || byEmail || input.accountId)
    if (existing) {
      let changed = false
      if (input.idpSubject && !existing.idpSubject) {
        existing.idpSubject = input.idpSubject
        this.accountsBySubject.set(input.idpSubject, existing.accountId)
        changed = true
      }
      if (input.displayName && !existing.displayName) {
        existing.displayName = input.displayName
        changed = true
      }
      if (changed) existing.updatedAt = nowIso(input.createdAt)
      return clone(existing)
    }
    const createdAt = nowIso(input.createdAt)
    const record: AccountRecord = {
      accountId: input.accountId,
      idpSubject: input.idpSubject || null,
      email: input.email.toLowerCase(),
      displayName: input.displayName || null,
      createdAt,
      updatedAt: createdAt,
    }
    this.accounts.set(record.accountId, record)
    if (record.idpSubject) this.accountsBySubject.set(record.idpSubject, record.accountId)
    this.accountsByEmail.set(record.email, record.accountId)
    return clone(record)
  }

  findAccountBySubject(idpSubject: string): AccountRecord | null {
    const accountId = this.accountsBySubject.get(idpSubject)
    return accountId ? clone(this.accounts.get(accountId) || null) : null
  }

  findAccountByEmail(email: string): AccountRecord | null {
    const accountId = this.accountsByEmail.get(email.toLowerCase())
    return accountId ? clone(this.accounts.get(accountId) || null) : null
  }

  upsertMembership(input: UpsertMembershipInput): MembershipRecord {
    const org = this.orgs.get(input.orgId)
    if (!org) throw new Error(`Unknown org ${input.orgId}.`)
    if (!this.accountExists(input.accountId)) throw new Error(`Unknown account ${input.accountId}.`)
    const membershipKey = key(input.orgId, input.accountId)
    const existing = this.memberships.get(membershipKey)
    const now = nowIso(input.updatedAt)
    const record: MembershipRecord = {
      orgId: input.orgId,
      accountId: input.accountId,
      role: input.role,
      status: input.status || 'active',
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    this.memberships.set(membershipKey, record)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.accountId,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: existing ? 'membership.updated' : 'membership.created',
      targetType: 'membership',
      targetId: membershipKey,
      metadata: { role: record.role, status: record.status },
      createdAt: input.updatedAt,
    })
    return clone(record)
  }

  listOrgMembers(orgId: string, input: { query?: string | null, limit?: number | null } = {}): OrgMemberRecord[] {
    if (!this.orgExists(orgId)) throw new Error(`Unknown org ${orgId}.`)
    const queryText = input.query?.trim().toLowerCase() || ''
    const limit = Math.max(1, Math.min(input.limit || 100, 500))
    return Array.from(this.memberships.values())
      .filter((membership) => membership.orgId === orgId)
      .map((membership) => {
        const account = this.accounts.get(membership.accountId)
        if (!account) return null
        return {
          orgId: membership.orgId,
          accountId: membership.accountId,
          email: account.email,
          displayName: account.displayName,
          role: membership.role,
          status: membership.status,
          createdAt: membership.createdAt,
          updatedAt: membership.updatedAt,
        } satisfies OrgMemberRecord
      })
      .filter((member): member is OrgMemberRecord => Boolean(member))
      .filter((member) => {
        if (!queryText) return true
        return [
          member.accountId,
          member.email,
          member.displayName,
          member.role,
          member.status,
        ].filter(Boolean).join(' ').toLowerCase().includes(queryText)
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.email.localeCompare(right.email))
      .slice(0, limit)
      .map((member) => clone(member))
  }

  listMembershipsForAccount(accountId: string): MembershipRecord[] {
    return Array.from(this.memberships.values())
      .filter((membership) => membership.accountId === accountId)
      .map((membership) => clone(membership))
  }

  resolvePrincipalMembership(input: { tenantId: string, userId?: string | null, accountId?: string | null, idpSubject?: string | null, email?: string | null }): PrincipalMembershipRecord | null {
    const orgId = this.orgsByTenant.get(input.tenantId) || (this.orgExists(input.tenantId) ? input.tenantId : undefined)
    if (!orgId) return null
    const org = this.orgs.get(orgId)
    const account = (input.accountId ? this.accounts.get(input.accountId) : null)
      || (input.idpSubject ? this.findAccountBySubject(input.idpSubject) : null)
      || (input.email ? this.findAccountByEmail(input.email) : null)
      || (input.userId ? this.accounts.get(input.userId) : null)
    if (!org || !account) return null
    const membership = this.memberships.get(key(org.orgId, account.accountId))
    return membership ? { org: clone(org), account: clone(account), membership: clone(membership) } : null
  }

  orgExists(orgId: string): boolean {
    return this.orgs.has(orgId)
  }

  accountExists(accountId: string): boolean {
    return this.accounts.has(accountId)
  }

  requireTenant(tenantId: string) {
    const tenant = this.tenants.get(tenantId)
    if (!tenant) throw new Error(`Unknown tenant ${tenantId}.`)
    return tenant
  }

  requireTenantUser(tenantId: string, userId: string) {
    this.requireTenant(tenantId)
    const user = this.users.get(key(tenantId, userId))
    if (!user) throw new Error(`User ${userId} does not belong to tenant ${tenantId}.`)
    return user
  }

}
