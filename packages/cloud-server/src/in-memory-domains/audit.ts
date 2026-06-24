import { createHash } from 'node:crypto'
import { clone, nowIso, pruneOldestByCreatedAt } from './store-helpers.ts'
import { redactAuditMetadata } from '../audit-redaction.ts'
import type { AuditEventRecord, RecordAuditEventInput } from '../control-plane-store.ts'

// Audit-event log extracted from in-memory-control-plane-store.ts. Owns the audit
// records and the record (with metadata redaction) / list-by-org lifecycle. Org
// existence arrives via the host. recordAuditEvent is the cross-cutting write every
// other domain already calls through its injected host, so this is purely an
// implementation move behind the store's delegate. Behaviour-preserving; covered
// broadly (most mutating suites assert audit side-effects).

type InMemoryAuditHost = {
  orgExists(orgId: string): boolean
}

export class InMemoryAuditDomain {
  private readonly auditEvents = new Map<string, AuditEventRecord>()
  private readonly host: InMemoryAuditHost

  constructor(host: InMemoryAuditHost) {
    this.host = host
  }

  recordAuditEvent(input: RecordAuditEventInput): AuditEventRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const eventId = input.eventId || stableId('audit', input.orgId, input.eventType, String(this.auditEvents.size + 1), nowIso(input.createdAt))
    const existing = this.auditEvents.get(eventId)
    if (existing) return clone(existing)
    const record: AuditEventRecord = {
      eventId,
      orgId: input.orgId,
      accountId: input.accountId || null,
      actorType: input.actorType,
      actorId: input.actorId || null,
      eventType: input.eventType,
      targetType: input.targetType || null,
      targetId: input.targetId || null,
      metadata: redactAuditMetadata(input.metadata),
      createdAt: nowIso(input.createdAt),
    }
    this.auditEvents.set(eventId, record)
    return clone(record)
  }

  listAuditEvents(orgId: string, limit = 100): AuditEventRecord[] {
    if (!this.host.orgExists(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.auditEvents.values())
      .filter((event) => event.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((event) => clone(event))
  }

  // Opt-in retention (P1-C3): delete the oldest audit records created before the cutoff, bounded.
  pruneStale(cutoffIso: string, limit: number): number {
    return pruneOldestByCreatedAt(this.auditEvents, (event) => event.createdAt, cutoffIso, limit)
  }
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}
