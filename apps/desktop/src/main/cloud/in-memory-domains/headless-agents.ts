import { clone, normalizeText, nowIso } from './store-helpers.ts'
import type {
  AuditEventRecord,
  CreateHeadlessAgentInput,
  HeadlessAgentRecord,
  RecordAuditEventInput,
  UpdateHeadlessAgentInput,
} from '../control-plane-store.ts'

// Headless-agent domain extracted from in-memory-control-plane-store.ts. Owns the
// headless-agent records and the create/update/get/list lifecycle. Cross-domain
// needs (org/account existence, tenant validation, audit) arrive via the injected
// host; the channel binding/session/interaction methods that previously read this
// map directly now go through the store's getHeadlessAgent delegate.
// Behaviour-preserving; covered by the cloud-http-server headless-agent suite.

const CHANNEL_TEXT_MAX_LENGTH = 256

type InMemoryHeadlessAgentsHost = {
  orgExists(orgId: string): boolean
  accountExists(accountId: string): boolean
  requireTenant(tenantId: string): void
  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord
}

export class InMemoryHeadlessAgentsDomain {
  private readonly headlessAgents = new Map<string, HeadlessAgentRecord>()
  private readonly host: InMemoryHeadlessAgentsHost

  constructor(host: InMemoryHeadlessAgentsHost) {
    this.host = host
  }

  createHeadlessAgent(input: CreateHeadlessAgentInput): HeadlessAgentRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    this.host.requireTenant(input.tenantId)
    if (input.createdByAccountId && !this.host.accountExists(input.createdByAccountId)) {
      throw new Error(`Unknown account ${input.createdByAccountId}.`)
    }
    const existing = this.headlessAgents.get(input.agentId)
    if (existing) return clone(existing)
    const now = nowIso(input.createdAt)
    const record: HeadlessAgentRecord = {
      agentId: normalizeText(input.agentId, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent id'),
      orgId: input.orgId,
      tenantId: input.tenantId,
      profileName: normalizeText(input.profileName, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent profile'),
      name: normalizeText(input.name, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent name'),
      status: input.status || 'active',
      managed: input.managed === true,
      createdByAccountId: input.createdByAccountId || null,
      createdAt: now,
      updatedAt: now,
    }
    this.headlessAgents.set(record.agentId, record)
    this.host.recordAuditEvent({
      orgId: record.orgId,
      accountId: record.createdByAccountId,
      actorType: 'system',
      actorId: 'headless_agent.create',
      eventType: 'headless_agent.created',
      targetType: 'headless_agent',
      targetId: record.agentId,
      metadata: { name: record.name, profileName: record.profileName, managed: record.managed },
      createdAt: input.createdAt,
    })
    return clone(record)
  }

  updateHeadlessAgent(input: UpdateHeadlessAgentInput): HeadlessAgentRecord | null {
    const existing = this.headlessAgents.get(input.agentId)
    if (!existing || existing.orgId !== input.orgId) return null
    const updatedAt = nowIso(input.updatedAt)
    existing.profileName = input.profileName === undefined ? existing.profileName : normalizeText(input.profileName, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent profile')
    existing.name = input.name === undefined ? existing.name : normalizeText(input.name, CHANNEL_TEXT_MAX_LENGTH, 'Headless agent name')
    existing.status = input.status || existing.status
    existing.managed = input.managed === undefined ? existing.managed : input.managed
    existing.updatedAt = updatedAt
    this.host.recordAuditEvent({
      orgId: input.orgId,
      accountId: input.actor?.accountId || null,
      actorType: input.actor?.actorType || 'system',
      actorId: input.actor?.actorId || null,
      eventType: 'headless_agent.updated',
      targetType: 'headless_agent',
      targetId: existing.agentId,
      metadata: {
        profileName: existing.profileName,
        name: existing.name,
        status: existing.status,
        managed: existing.managed,
      },
      createdAt: input.updatedAt,
    })
    return clone(existing)
  }

  getHeadlessAgent(orgId: string, agentId: string): HeadlessAgentRecord | null {
    const agent = this.headlessAgents.get(agentId)
    return agent && agent.orgId === orgId ? clone(agent) : null
  }

  listHeadlessAgents(orgId: string): HeadlessAgentRecord[] {
    return Array.from(this.headlessAgents.values())
      .filter((agent) => agent.orgId === orgId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.agentId.localeCompare(right.agentId))
      .map((agent) => clone(agent))
  }
}
