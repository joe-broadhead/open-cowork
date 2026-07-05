import { createHash } from 'node:crypto'
import { clone, normalizePositiveInteger, nowIso, pruneOldestByCreatedAt } from './store-helpers.ts'
import { redactAuditMetadata } from '../audit-redaction.ts'
import type { RecordUsageEventInput, UsageEventRecord } from '../control-plane-store.ts'

// Usage-event domain extracted from in-memory-control-plane-store.ts. Owns the
// usage-event records and the record/list lifecycle (idempotent on eventId).
// Org existence is the only cross-domain need, via the injected host.
// Behaviour-preserving; covered by the cloud-http-server usage suite.

type InMemoryUsageHost = {
  orgExists(orgId: string): boolean
}

export class InMemoryUsageDomain {
  private readonly usageEvents = new Map<string, UsageEventRecord>()
  private readonly host: InMemoryUsageHost

  constructor(host: InMemoryUsageHost) {
    this.host = host
  }

  recordUsageEvent(input: RecordUsageEventInput): UsageEventRecord {
    if (!this.host.orgExists(input.orgId)) throw new Error(`Unknown org ${input.orgId}.`)
    const eventId = input.eventId || stableId('usage', input.orgId, input.eventType, String(this.usageEvents.size + 1), nowIso(input.createdAt))
    const existing = this.usageEvents.get(eventId)
    if (existing) return clone(existing)
    const record: UsageEventRecord = {
      eventId,
      orgId: input.orgId,
      accountId: input.accountId || null,
      eventType: input.eventType,
      quantity: normalizePositiveInteger(input.quantity || 1, 'Usage quantity'),
      unit: input.unit || 'count',
      metadata: redactAuditMetadata(input.metadata),
      createdAt: nowIso(input.createdAt),
    }
    this.usageEvents.set(eventId, record)
    return clone(record)
  }

  listUsageEvents(orgId: string, limit = 100): UsageEventRecord[] {
    if (!this.host.orgExists(orgId)) throw new Error(`Unknown org ${orgId}.`)
    return Array.from(this.usageEvents.values())
      .filter((event) => event.orgId === orgId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((event) => clone(event))
  }

  // Opt-in retention (P1-C3): delete the oldest usage records created before the cutoff, bounded.
  pruneStale(cutoffIso: string, limit: number): number {
    return pruneOldestByCreatedAt(this.usageEvents, (event) => event.createdAt, cutoffIso, limit)
  }
}

function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}
