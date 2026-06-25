import { clone, nowIso, optionalTrimmedText, stableJson, workspaceOperationFromType } from './store-helpers.ts'
import { workspaceEventCursor, type WorkspaceEventCursorRecord } from '../workspace-event-cursor.ts'
import type { AppendWorkspaceEventInput, WorkspaceEventRecord } from '../control-plane-store.ts'

// Workspace-event log extracted from in-memory-control-plane-store.ts. Owns the
// per-(tenant,user) append-only event stream (monotonic sequence) + the
// append/list-after/cursor lifecycle. Tenant-user + session validation arrive via
// the injected host. Behaviour-preserving; covered by the cloud-control-plane-store
// + cloud-http-server workspace-event suites.

type InMemoryWorkspaceEventsHost = {
  requireTenantUser(tenantId: string, userId: string): void
  assertSessionBelongsToUser(tenantId: string, sessionId: string, userId: string): void
}

export class InMemoryWorkspaceEventsDomain {
  private readonly workspaceEvents = new Map<string, { nextSequence: number, events: WorkspaceEventRecord[] }>()
  private readonly host: InMemoryWorkspaceEventsHost

  constructor(host: InMemoryWorkspaceEventsHost) {
    this.host = host
  }

  appendWorkspaceEvent(input: AppendWorkspaceEventInput): WorkspaceEventRecord {
    this.host.requireTenantUser(input.tenantId, input.userId)
    if (input.sessionId) {
      this.host.assertSessionBelongsToUser(input.tenantId, input.sessionId, input.userId)
    }
    const workspaceKey = `${input.tenantId}:${input.userId}`
    const state = this.workspaceEvents.get(workspaceKey) || { nextSequence: 0, events: [] }
    const payload = input.payload || {}
    const eventId = input.eventId || `${input.userId}:${state.nextSequence + 1}`
    const sequence = state.nextSequence + 1
    const entityType = optionalTrimmedText(input.entityType) || (input.sessionId ? 'session' : 'workspace')
    const entityId = optionalTrimmedText(input.entityId) || input.sessionId || input.userId
    const operation = optionalTrimmedText(input.operation) || workspaceOperationFromType(input.type)
    const projectionVersion = Number.isFinite(input.projectionVersion)
      ? Math.max(0, Math.floor(input.projectionVersion || 0))
      : sequence
    const existing = state.events.find((event) => event.eventId === eventId)
    if (existing) {
      const expectedProjectionVersion = Number.isFinite(input.projectionVersion)
        ? projectionVersion
        : existing.projectionVersion
      if (
        existing.type !== input.type
        || stableJson(existing.payload) !== stableJson(payload)
        || (existing.sessionId || null) !== (input.sessionId || null)
        || existing.entityType !== entityType
        || existing.entityId !== entityId
        || existing.operation !== operation
        || existing.projectionVersion !== expectedProjectionVersion
      ) {
        throw new Error(`Workspace event id ${eventId} was reused with different content.`)
      }
      return clone(existing)
    }
    const event: WorkspaceEventRecord = {
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId || null,
      eventId,
      sequence,
      entityType,
      entityId,
      operation,
      projectionVersion,
      type: input.type,
      payload,
      createdAt: nowIso(input.createdAt),
    }
    state.nextSequence = sequence
    state.events.push(event)
    this.workspaceEvents.set(workspaceKey, state)
    return clone(event)
  }

  listWorkspaceEvents(tenantId: string, userId: string, afterSequence = 0, limit?: number): WorkspaceEventRecord[] {
    this.host.requireTenantUser(tenantId, userId)
    const workspaceKey = `${tenantId}:${userId}`
    const matching = (this.workspaceEvents.get(workspaceKey)?.events || [])
      .filter((event) => event.sequence > afterSequence)
      .map((event) => clone(event))
    return Number.isInteger(limit) && (limit as number) > 0 ? matching.slice(0, limit) : matching
  }
  getWorkspaceEventCursor(tenantId: string, userId: string): WorkspaceEventCursorRecord {
    this.host.requireTenantUser(tenantId, userId)
    return workspaceEventCursor(this.workspaceEvents.get(`${tenantId}:${userId}`)?.events || [])
  }

  // Opt-in retention (P1-B): cloud_workspace_events is written 1:1 with cloud_session_events
  // (which got retention in P1-C3) but was missed. Remove the oldest rows created before the
  // cutoff, bounded by limit, oldest-first across workspaces — mirroring the session-event prune
  // and the postgres ctid `ORDER BY created_at LIMIT` delete.
  pruneExpiredWorkspaceEvents(input: { olderThan: Date, limit: number }): number {
    const limit = Math.max(1, Math.min(10_000, Math.floor(input.limit)))
    const cutoff = input.olderThan.toISOString()
    const stale = Array.from(this.workspaceEvents.entries())
      .flatMap(([key, state]) => state.events.map((event) => ({ key, event })))
      .filter(({ event }) => event.createdAt < cutoff)
      .sort((left, right) => left.event.createdAt.localeCompare(right.event.createdAt))
      .slice(0, limit)
    const removeByKey = new Map<string, Set<string>>()
    for (const { key, event } of stale) {
      const ids = removeByKey.get(key) || new Set<string>()
      ids.add(event.eventId)
      removeByKey.set(key, ids)
    }
    for (const [key, ids] of removeByKey) {
      const state = this.workspaceEvents.get(key)
      if (state) state.events = state.events.filter((event) => !ids.has(event.eventId))
    }
    return stale.length
  }
}
