import type { ControlPlaneStore } from '../control-plane-store.ts'
import type { OrgMemberRecord } from '../control-plane-records.ts'
import type { ScimSyncEventRecord } from '../control-plane-scim.ts'
import { CloudServiceError } from '../cloud-service-error.ts'
import { stableCloudId } from '../session-input-validation.ts'
import type { CloudScimReconciler } from '../scim-reconciler.ts'
import type { ScimGroupInput, ScimUserInput, ScimUserPatch } from '../scim-schema.ts'

// SCIM 2.0 provisioning service (issue #895). Authenticates by the per-org SCIM bearer
// token (matched against the salted hash the store holds), then maps SCIM User/Group
// operations onto accounts/memberships/roles. Every write ALSO lands a durable sync
// event and re-applies it through the reconciler immediately, so the request reflects
// the converged state AND the event stays queued (with backoff) if a side-effect fails.
// Deprovision (active=false / DELETE) suspends the membership and revokes the member's
// credentials at once, reusing the same revocation primitive as RBAC downgrades (#894).

export type ScimAuthContext = { orgId: string }

export type CloudScimServiceOptions = {
  store: ControlPlaneStore
  reconciler: CloudScimReconciler
}

export class CloudScimService {
  private readonly store: ControlPlaneStore
  private readonly reconciler: CloudScimReconciler

  constructor(options: CloudScimServiceOptions) {
    this.store = options.store
    this.reconciler = options.reconciler
  }

  // Resolve the org from a presented SCIM bearer token, or fail closed (401).
  async authenticate(bearerToken: string | null): Promise<ScimAuthContext> {
    const token = bearerToken?.trim() || ''
    if (!token) throw new CloudServiceError(401, 'SCIM authorization is required.')
    const config = await this.store.findOrgSsoConfigByScimToken(token)
    if (!config || !config.scimEnabled) throw new CloudServiceError(401, 'SCIM token is invalid.')
    return { orgId: config.orgId }
  }

  // Enqueue an event and re-apply it synchronously so the SCIM response reflects the
  // converged state. On failure the event stays queued (pending, with backoff) for the
  // periodic reconciler, and we surface the error to the caller.
  private async applyNow(event: ScimSyncEventRecord): Promise<void> {
    try {
      await this.reconciler.applyEvent(event)
      await this.store.completeScimSyncEvent({ orgId: event.orgId, eventId: event.eventId })
    } catch (error) {
      await this.store.failScimSyncEvent({
        orgId: event.orgId,
        eventId: event.eventId,
        error: error instanceof Error ? error.message : String(error),
      })
      throw new CloudServiceError(502, 'SCIM provisioning could not be applied; it has been queued for retry.')
    }
  }

  private accountId(orgId: string, email: string): string {
    return stableCloudId('account', orgId, email)
  }

  async listMembers(orgId: string, filter: { email?: string | null } = {}): Promise<OrgMemberRecord[]> {
    const members = await this.store.listOrgMembers(orgId, { limit: 500 })
    const email = filter.email?.trim().toLowerCase() || null
    return email ? members.filter((member) => member.email.toLowerCase() === email) : members
  }

  async getMember(orgId: string, accountId: string): Promise<OrgMemberRecord | null> {
    const members = await this.store.listOrgMembers(orgId, { limit: 500 })
    return members.find((member) => member.accountId === accountId) || null
  }

  private async requireMember(orgId: string, accountId: string): Promise<OrgMemberRecord> {
    const member = await this.getMember(orgId, accountId)
    if (!member) throw new CloudServiceError(404, 'SCIM user was not found.')
    return member
  }

  // Provision (or reactivate) a user: establish the account, then converge the membership
  // to the requested active state via the durable queue. Idempotent by email.
  async createUser(orgId: string, input: ScimUserInput): Promise<OrgMemberRecord> {
    const accountId = this.accountId(orgId, input.email)
    await this.store.createAccount({
      accountId,
      idpSubject: input.externalId,
      email: input.email,
      displayName: input.displayName,
    })
    const event = await this.store.enqueueScimSyncEvent({
      orgId,
      operation: 'user.provision',
      externalId: input.externalId,
      payload: { accountId, email: input.email, role: 'member', status: input.active ? 'active' : 'disabled' },
    })
    await this.applyNow(event)
    return this.requireMember(orgId, accountId)
  }

  async replaceUser(orgId: string, accountId: string, input: ScimUserInput): Promise<OrgMemberRecord> {
    const member = await this.requireMember(orgId, accountId)
    const event = await this.store.enqueueScimSyncEvent({
      orgId,
      operation: 'user.update',
      externalId: input.externalId,
      payload: { accountId, email: input.email, role: member.role, status: input.active ? 'active' : 'disabled' },
    })
    await this.applyNow(event)
    return this.requireMember(orgId, accountId)
  }

  async patchUser(orgId: string, accountId: string, patch: ScimUserPatch): Promise<OrgMemberRecord> {
    const member = await this.requireMember(orgId, accountId)
    const nextActive = patch.active === undefined ? member.status === 'active' : patch.active
    if (!nextActive) return this.deprovisionUser(orgId, accountId)
    const event = await this.store.enqueueScimSyncEvent({
      orgId,
      operation: 'user.update',
      payload: { accountId, email: member.email, role: member.role, status: 'active' },
    })
    await this.applyNow(event)
    return this.requireMember(orgId, accountId)
  }

  // Deprovision: suspend the membership AND revoke the member's credentials immediately
  // (the reconciler's deprovision path reuses #894's revokeApiTokensForAccount).
  async deprovisionUser(orgId: string, accountId: string): Promise<OrgMemberRecord> {
    await this.requireMember(orgId, accountId)
    const event = await this.store.enqueueScimSyncEvent({
      orgId,
      operation: 'user.deprovision',
      payload: { accountId },
    })
    await this.applyNow(event)
    return this.requireMember(orgId, accountId)
  }

  // Sync a directory group: resolve its members to accounts and enqueue a group.sync
  // event (the reconciler maps a group named for a built-in role onto those members).
  async syncGroup(orgId: string, input: ScimGroupInput): Promise<{ id: string, displayName: string }> {
    const memberAccountIds: string[] = []
    for (const externalId of input.memberExternalIds) {
      const account = await this.store.findAccountBySubject(externalId)
      if (account) memberAccountIds.push(account.accountId)
    }
    const event = await this.store.enqueueScimSyncEvent({
      orgId,
      operation: 'group.sync',
      externalId: input.externalId,
      payload: { displayName: input.displayName, memberAccountIds },
    })
    await this.applyNow(event)
    return { id: input.externalId || stableCloudId('group', orgId, input.displayName), displayName: input.displayName }
  }
}
