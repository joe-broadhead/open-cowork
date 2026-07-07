import type { AuditEventRecord } from './control-plane-auth-records.ts'
import type { AuditQueryCursor, QueryAuditEventsInput } from './control-plane-account-inputs.ts'

// Pure filter/keyset helpers shared by BOTH control-plane stores so the audit
// query behaves identically in-memory and in Postgres (contract parity). The
// in-memory store filters + sorts + slices with these; the Postgres store mirrors
// the same predicate set in SQL and reuses normalizeAuditQueryLimit + nextCursor.

const DEFAULT_AUDIT_QUERY_LIMIT = 100
export const MAX_AUDIT_QUERY_LIMIT = 500

export function normalizeAuditQueryLimit(limit: number | null | undefined): number {
  const value = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_AUDIT_QUERY_LIMIT
  return Math.max(1, Math.min(value, MAX_AUDIT_QUERY_LIMIT))
}

function resultTag(event: AuditEventRecord): string | null {
  const value = event.metadata?.result
  return typeof value === 'string' ? value : null
}

// Descending (createdAt, eventId) — newest first, eventId as the stable tiebreaker
// so equal timestamps keep a total order the keyset cursor can page through.
export function compareAuditEventsDescending(left: AuditEventRecord, right: AuditEventRecord): number {
  if (left.createdAt !== right.createdAt) return right.createdAt.localeCompare(left.createdAt)
  return right.eventId.localeCompare(left.eventId)
}

// True when the event sorts strictly AFTER the cursor tuple in descending order
// (i.e. it belongs on a later page). Matches the Postgres keyset predicate
// (created_at, event_id) < (cursor.createdAt, cursor.eventId).
export function isAuditEventAfterCursor(event: AuditEventRecord, cursor: AuditQueryCursor): boolean {
  if (event.createdAt !== cursor.createdAt) return event.createdAt < cursor.createdAt
  return event.eventId < cursor.eventId
}

export function auditEventMatchesQuery(event: AuditEventRecord, input: QueryAuditEventsInput): boolean {
  if (input.actorId && event.actorId !== input.actorId) return false
  if (input.actorType && event.actorType !== input.actorType) return false
  if (input.eventTypePrefix && !event.eventType.startsWith(input.eventTypePrefix)) return false
  if (input.targetType && event.targetType !== input.targetType) return false
  if (input.targetId && event.targetId !== input.targetId) return false
  if (input.result && resultTag(event) !== input.result) return false
  if (input.from && event.createdAt < input.from.toISOString()) return false
  if (input.to && event.createdAt > input.to.toISOString()) return false
  return true
}

// Given the rows a store fetched with `limit + 1` (already ordered descending and
// cursor-filtered), trim to the page and derive the next cursor from the extra row.
export function paginateAuditEvents(
  ordered: AuditEventRecord[],
  limit: number,
): { events: AuditEventRecord[], nextCursor: AuditQueryCursor | null } {
  if (ordered.length <= limit) return { events: ordered, nextCursor: null }
  const events = ordered.slice(0, limit)
  const last = events[events.length - 1]
  return {
    events,
    nextCursor: last ? { createdAt: last.createdAt, eventId: last.eventId } : null,
  }
}
