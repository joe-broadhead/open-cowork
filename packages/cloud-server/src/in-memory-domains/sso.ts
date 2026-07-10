import { randomUUID } from 'node:crypto'
import { clone, nowIso, normalizeNullableText } from './store-helpers.ts'
import { verifyScimTokenHash } from '../control-plane-tokens.ts'
import {
  mergeOrgSsoConfig,
  type OrgSsoConfigRecord,
  type UpsertOrgSsoConfigInput,
} from '../control-plane-sso.ts'
import {
  normalizeScimSyncOperation,
  scimRetryDelayMs,
  SCIM_SYNC_DEFAULT_MAX_ATTEMPTS,
  type ClaimScimSyncEventsInput,
  type CompleteScimSyncEventInput,
  type EnqueueScimSyncEventInput,
  type FailScimSyncEventInput,
  type ListScimSyncEventsInput,
  type ScimSyncEventRecord,
} from '../control-plane-scim.ts'
import type { AuditEventRecord, RecordAuditEventInput } from '../control-plane-store.ts'

// Enterprise SSO + SCIM domain (issue #895): the org-scoped SSO config table and the
// durable SCIM sync-event queue. The Postgres peer (postgres-store-domains/sso.ts) is
// behaviour-identical; both are covered by the shared control-plane store contract.

type InMemorySsoHost = {
  orgExists(orgId: string): boolean
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

const SCIM_ERROR_MAX_LENGTH = 512

export class InMemorySsoDomain {
  private readonly configs = new Map<string, OrgSsoConfigRecord>()
  private readonly scimEvents = new Map<string, ScimSyncEventRecord>()
  private readonly host: InMemorySsoHost

  constructor(host: InMemorySsoHost) {
    this.host = host
  }

  getOrgSsoConfig(orgId: string): OrgSsoConfigRecord | null {
    const record = this.configs.get(orgId)
    return record ? clone(record) : null
  }

  upsertOrgSsoConfig(input: UpsertOrgSsoConfigInput): OrgSsoConfigRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const now = nowIso(input.updatedAt)
    const existing = this.configs.get(input.orgId) ?? null
    const next = mergeOrgSsoConfig(existing, input, now)
    this.configs.set(input.orgId, next)
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: existing ? 'sso_config.updated' : 'sso_config.created',
      targetType: 'sso_config',
      targetId: input.orgId,
      metadata: { protocol: next.protocol, enabled: next.enabled, enforced: next.enforced, scimEnabled: next.scimEnabled },
      createdAt: input.updatedAt,
    })
    return clone(next)
  }

  deleteOrgSsoConfig(orgId: string): boolean {
    if (!this.configs.delete(orgId)) return false
    this.host.recordAuditEvent({
      orgId,
      actorType: 'system',
      actorId: 'sso_config.delete',
      eventType: 'sso_config.deleted',
      targetType: 'sso_config',
      targetId: orgId,
      metadata: {},
    })
    return true
  }

  async findOrgSsoConfigByScimToken(plaintext: string): Promise<OrgSsoConfigRecord | null> {
    if (!plaintext) return null
    for (const record of this.configs.values()) {
      if (record.scimEnabled && record.scimTokenHash && await verifyScimTokenHash(plaintext, record.scimTokenHash)) {
        return clone(record)
      }
    }
    return null
  }

  findOrgSsoConfigByDomain(domain: string): OrgSsoConfigRecord | null {
    const normalized = domain.trim().toLowerCase()
    if (!normalized) return null
    for (const record of this.configs.values()) {
      if (record.enabled && record.verifiedDomains.includes(normalized)) return clone(record)
    }
    return null
  }

  enqueueScimSyncEvent(input: EnqueueScimSyncEventInput): ScimSyncEventRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const now = nowIso(input.createdAt)
    const record: ScimSyncEventRecord = {
      eventId: input.eventId?.trim() || randomUUID(),
      orgId: input.orgId,
      operation: normalizeScimSyncOperation(input.operation),
      externalId: input.externalId?.trim() || null,
      payload: input.payload ? clone(input.payload) : {},
      status: 'pending',
      attempts: 0,
      maxAttempts: Math.max(1, Math.floor(input.maxAttempts ?? SCIM_SYNC_DEFAULT_MAX_ATTEMPTS)),
      nextAttemptAt: (input.availableAt || input.createdAt || new Date()).toISOString(),
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }
    this.scimEvents.set(record.eventId, record)
    return clone(record)
  }

  claimNextScimSyncEvents(input: ClaimScimSyncEventsInput = {}): ScimSyncEventRecord[] {
    const now = input.now || new Date()
    const nowIsoValue = now.toISOString()
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)))
    const due = [...this.scimEvents.values()]
      .filter((event) => event.status === 'pending'
        && (!input.orgId || event.orgId === input.orgId)
        && event.nextAttemptAt <= nowIsoValue)
      .sort((left, right) => left.nextAttemptAt.localeCompare(right.nextAttemptAt) || left.createdAt.localeCompare(right.createdAt))
      .slice(0, limit)
    for (const event of due) {
      event.status = 'processing'
      event.attempts += 1
      event.updatedAt = nowIsoValue
    }
    return due.map((event) => clone(event))
  }

  completeScimSyncEvent(input: CompleteScimSyncEventInput): ScimSyncEventRecord | null {
    const event = this.scimEvents.get(input.eventId)
    if (!event || event.orgId !== input.orgId) return null
    event.status = 'succeeded'
    event.lastError = null
    event.updatedAt = (input.now || new Date()).toISOString()
    return clone(event)
  }

  failScimSyncEvent(input: FailScimSyncEventInput): ScimSyncEventRecord | null {
    const event = this.scimEvents.get(input.eventId)
    if (!event || event.orgId !== input.orgId) return null
    const now = input.now || new Date()
    event.lastError = normalizeNullableText(input.error, SCIM_ERROR_MAX_LENGTH, 'SCIM sync error')
    event.updatedAt = now.toISOString()
    if (event.attempts >= event.maxAttempts) {
      event.status = 'failed'
      event.nextAttemptAt = event.updatedAt
    } else {
      event.status = 'pending'
      event.nextAttemptAt = new Date(now.getTime() + scimRetryDelayMs(event.attempts)).toISOString()
    }
    return clone(event)
  }

  listScimSyncEvents(input: ListScimSyncEventsInput): ScimSyncEventRecord[] {
    const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)))
    return [...this.scimEvents.values()]
      .filter((event) => event.orgId === input.orgId && (!input.status || event.status === input.status))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.eventId.localeCompare(right.eventId))
      .slice(0, limit)
      .map((event) => clone(event))
  }
}
