import type { ControlPlaneStore } from './control-plane-store.ts'
import type { OrgMemberRecord } from './control-plane-records.ts'
import type { ControlPlaneRole } from './control-plane-enums.ts'
import type { ScimSyncEventRecord } from './control-plane-scim.ts'
import { normalizeControlPlaneRole } from './session-input-validation.ts'

// The durable SCIM sync reconciler (issue #895). SCIM writes apply the membership change
// synchronously AND land a sync event in the store-backed queue; this reconciler drains
// that queue with the store's retry/backoff and re-applies each event IDEMPOTENTLY, so a
// transient failure converges directory state ↔ membership state instead of being lost.
// A periodic `reconcile(orgId)` enqueues a whole-org convergence sweep. Reused by the
// scheduler (periodic drain) and directly by tests.

export type ScimReconcilerOptions = {
  store: ControlPlaneStore
  now?: () => Date
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export class CloudScimReconciler {
  private readonly store: ControlPlaneStore
  private readonly now: () => Date

  constructor(options: ScimReconcilerOptions) {
    this.store = options.store
    this.now = options.now || (() => new Date())
  }

  // Apply one sync event idempotently. Returns nothing on success; throws to trigger the
  // queue's exponential-backoff retry. Convergence is by re-asserting the intended state,
  // so re-processing an already-applied event is a no-op.
  async applyEvent(event: ScimSyncEventRecord): Promise<void> {
    const payload = event.payload || {}
    if (event.operation === 'user.deprovision') {
      await this.deprovision(event.orgId, stringField(payload, 'accountId'))
      return
    }
    if (event.operation === 'user.provision' || event.operation === 'user.update') {
      await this.upsertUser(event.orgId, payload)
      return
    }
    if (event.operation === 'group.sync') {
      await this.syncGroup(event.orgId, payload)
      return
    }
    if (event.operation === 'reconcile') {
      await this.reconcileOrg(event.orgId)
      return
    }
    throw new Error(`Unsupported SCIM sync operation ${event.operation}.`)
  }

  private async upsertUser(orgId: string, payload: Record<string, unknown>): Promise<void> {
    const accountId = stringField(payload, 'accountId')
    if (!accountId) throw new Error('SCIM user sync event is missing accountId.')
    const role = normalizeControlPlaneRole(payload.role, 'member')
    const status = payload.status === 'disabled' ? 'disabled' : 'active'
    await this.store.upsertMembership({
      orgId,
      accountId,
      role,
      status,
      actor: { actorType: 'system', actorId: 'scim.reconcile' },
    })
    if (status === 'disabled') await this.revoke(orgId, accountId)
  }

  // Collect EVERY member of an org keyed by accountId via the stable account_id keyset, so
  // reconciliation never silently ignores members past the first UI page — the exact failure
  // for the large enterprise directories SCIM targets (#909).
  private async collectOrgMembers(orgId: string): Promise<Map<string, OrgMemberRecord>> {
    const byAccountId = new Map<string, OrgMemberRecord>()
    const pageSize = 500
    let afterAccountId: string | null = null
    for (;;) {
      const page = await this.store.listOrgMembersPage(orgId, { afterAccountId, limit: pageSize })
      for (const member of page) byAccountId.set(member.accountId, member)
      if (page.length < pageSize) break
      afterAccountId = page[page.length - 1]!.accountId
    }
    return byAccountId
  }

  private async deprovision(orgId: string, accountId: string | null): Promise<void> {
    if (!accountId) throw new Error('SCIM deprovision sync event is missing accountId.')
    const members = await this.collectOrgMembers(orgId)
    const member = members.get(accountId)
    const role: ControlPlaneRole = member?.role || 'member'
    await this.store.upsertMembership({
      orgId,
      accountId,
      role,
      status: 'disabled',
      actor: { actorType: 'system', actorId: 'scim.deprovision' },
    })
    await this.revoke(orgId, accountId)
  }

  private async syncGroup(orgId: string, payload: Record<string, unknown>): Promise<void> {
    // Map a directory group whose name matches a built-in role onto its listed members.
    // Unknown group names are a successful no-op (an org may sync groups we do not map).
    const displayName = stringField(payload, 'displayName')?.toLowerCase()
    const role: ControlPlaneRole | null = displayName === 'owner' || displayName === 'admin' || displayName === 'member'
      ? displayName
      : null
    if (!role) return
    const memberIds = Array.isArray(payload.memberAccountIds) ? payload.memberAccountIds : []
    const members = await this.collectOrgMembers(orgId)
    for (const raw of memberIds) {
      const accountId = typeof raw === 'string' ? raw : null
      const member = accountId ? members.get(accountId) : null
      if (!member) continue
      await this.store.upsertMembership({
        orgId,
        accountId: member.accountId,
        role,
        status: member.status,
        actor: { actorType: 'system', actorId: 'scim.group.sync' },
      })
    }
  }

  // Whole-org drift reconciliation: re-assert every active membership's own role/status so
  // membership state converges to what the store holds (the durable directory projection).
  // Idempotent and side-effect-free for already-consistent members.
  private async reconcileOrg(orgId: string): Promise<void> {
    const members = await this.collectOrgMembers(orgId)
    for (const member of members.values()) {
      if (member.status === 'disabled') await this.revoke(orgId, member.accountId)
    }
  }

  private async revoke(orgId: string, accountId: string): Promise<void> {
    await this.store.revokeApiTokensForAccount({
      orgId,
      accountId,
      reason: 'scim_deprovision',
      actor: { actorType: 'system', actorId: 'scim.deprovision' },
    })
  }

  // Drain up to `limit` due queue events: claim (marks processing + increments attempts),
  // apply, then complete or fail (which schedules the backoff retry). Returns the counts.
  async drain(input: { orgId?: string | null, limit?: number } = {}): Promise<{ processed: number, succeeded: number, failed: number }> {
    const events = await this.store.claimNextScimSyncEvents({ orgId: input.orgId ?? null, limit: input.limit ?? 20, now: this.now() })
    let succeeded = 0
    let failed = 0
    for (const event of events) {
      try {
        await this.applyEvent(event)
        await this.store.completeScimSyncEvent({ orgId: event.orgId, eventId: event.eventId, now: this.now() })
        succeeded += 1
      } catch (error) {
        await this.store.failScimSyncEvent({
          orgId: event.orgId,
          eventId: event.eventId,
          error: error instanceof Error ? error.message : String(error),
          now: this.now(),
        })
        failed += 1
      }
    }
    return { processed: events.length, succeeded, failed }
  }

  // Enqueue a whole-org convergence sweep (the periodic drift reconciliation trigger).
  async enqueueReconcile(orgId: string): Promise<ScimSyncEventRecord> {
    return this.store.enqueueScimSyncEvent({ orgId, operation: 'reconcile', createdAt: this.now() })
  }
}
