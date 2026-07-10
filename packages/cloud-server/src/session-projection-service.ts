import {
  createCloudProjectionCheckpoint,
  waitForCloudProjectionFence,
  isCloudProjectedSessionEventType,
  normalizeCloudSessionProjectionView,
  reduceCloudSessionProjectionEvent,
  type CloudProjectionFenceToken,
  type CloudProjectionFenceWaitResult,
  type CloudProjectedSessionEventType,
  type CloudSessionProjectionView,
} from '@open-cowork/shared'
import type { SessionEventRecord } from './control-plane-store.ts'
import type { ProjectionControlPlaneStore } from './control-plane-store-domains.ts'
import { CloudSessionEventBus, CloudWorkspaceEventBus } from './session-event-bus.ts'

// Keyset batch size for the projection rebuild fold — bounds the per-query result set
// and memory regardless of total session-event-log size.
const PROJECTION_REBUILD_BATCH = 1000

export type AppendProjectedEventInput = {
  tenantId: string
  sessionId: string
  eventId?: string
  type: CloudProjectedSessionEventType
  payload?: Record<string, unknown>
  leaseToken?: string | null
  createdAt?: Date
}

export type CloudProjectionStore = ProjectionControlPlaneStore

export type RepairSessionProjectionInput = {
  tenantId: string
  sessionId: string
  leaseToken?: string | null
}

export type RepairSessionProjectionResult = {
  repaired: boolean
  eventCount: number
  workspaceEventCount: number
  latestEventSequence: number
  priorProjectionSequence: number
  projectionSequence: number
  lag: number
}

export type WaitForSessionProjectionFenceInput = {
  fence: CloudProjectionFenceToken
  timeoutMs: number
  intervalMs?: number
  nowMs?: () => number
  sleep?: (durationMs: number) => Promise<void>
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function eventPayloadId(payload: Record<string, unknown>, keys: string[], fallback: string) {
  for (const key of keys) {
    const value = readString(payload[key])
    if (value) return value
  }
  return fallback
}

function workspaceOperationFromEventType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}

function workspaceEntityForProjectedEvent(input: AppendProjectedEventInput, event: SessionEventRecord) {
  const payload = input.payload || {}
  if (input.type === 'artifact.created' || input.type === 'artifact.updated') {
    return {
      entityType: 'artifact',
      entityId: eventPayloadId(payload, ['artifactId', 'cloudArtifactId', 'id'], input.sessionId),
      operation: input.type === 'artifact.created' ? 'create' : 'update',
      projectionVersion: event.sequence,
    }
  }
  return {
    entityType: 'session',
    entityId: input.sessionId,
    operation: workspaceOperationFromEventType(input.type),
    projectionVersion: event.sequence,
  }
}

// Rough byte size of a value via its JSON length (UTF-16 code units ~ bytes for mostly-ASCII
// transcripts). Used only to bound the view cache; accuracy is not load-bearing.
function approxJsonBytes(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

export class CloudSessionProjectionService {
  private readonly store: CloudProjectionStore
  private readonly sessionEvents: CloudSessionEventBus
  private readonly workspaceEvents: CloudWorkspaceEventBus
  // Cache of the last normalized projection view per session, validated by the stored sequence.
  // Reusing it lets the append path skip re-normalizing (deep-validating) the ENTIRE accumulated
  // view from JSON on every event — that was O(view-size) per event and O(N^2) over a long session
  // (#913). Sequence validation keeps it correct across worker/instance handoff (a mismatch falls
  // back to a fresh normalize); LRU-bounded so one process can't retain a view per session forever.
  private readonly viewCache = new Map<string, { sequence: number, view: CloudSessionProjectionView, bytes: number }>()
  private readonly maxCachedViews = 512
  // Also cap total cached bytes: a few very large transcripts (multi-MB views) could otherwise pin
  // gigabytes of worker heap even well under the 512-entry count cap. Size is estimated cheaply — a
  // full measure only on the rare cold-normalize path, an O(payload) delta on the hot warm path.
  private readonly maxCachedBytes = 256 * 1024 * 1024
  private totalCachedBytes = 0

  constructor(
    store: CloudProjectionStore,
    sessionEvents: CloudSessionEventBus,
    workspaceEvents: CloudWorkspaceEventBus,
  ) {
    this.store = store
    this.sessionEvents = sessionEvents
    this.workspaceEvents = workspaceEvents
  }

  private cacheView(key: string, sequence: number, view: CloudSessionProjectionView, bytes: number) {
    // Move-to-most-recent (delete+set) then evict the oldest once over the entry OR byte cap, so an
    // actively streamed session stays warm and idle sessions are dropped first.
    const prev = this.viewCache.get(key)
    if (prev) this.totalCachedBytes -= prev.bytes
    this.viewCache.delete(key)
    this.viewCache.set(key, { sequence, view, bytes })
    this.totalCachedBytes += bytes
    while (
      this.viewCache.size > this.maxCachedViews
      || (this.totalCachedBytes > this.maxCachedBytes && this.viewCache.size > 1)
    ) {
      const oldest = this.viewCache.keys().next().value
      if (oldest === undefined) break
      const evicted = this.viewCache.get(oldest)
      this.viewCache.delete(oldest)
      if (evicted) this.totalCachedBytes -= evicted.bytes
    }
  }

  async appendProjectedEvent(input: AppendProjectedEventInput) {
    if (!isCloudProjectedSessionEventType(input.type)) {
      throw new Error(`Unsupported cloud projection event type: ${input.type}`)
    }
    const cacheKey = `${input.tenantId}\0${input.sessionId}`
    let projectedView: CloudSessionProjectionView | null = null
    let projectedBytes = 0
    const result = await this.store.appendProjectedSessionEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      eventId: input.eventId,
      type: input.type,
      payload: input.payload || {},
      leaseToken: input.leaseToken,
      createdAt: input.createdAt,
      workspace: ({ event }) => {
        const workspaceEntity = workspaceEntityForProjectedEvent(input, event)
        return {
          eventId: event.eventId.startsWith(`${input.sessionId}:`)
            ? event.eventId
            : `${input.sessionId}:${event.eventId}`,
          ...workspaceEntity,
        }
      },
      project: ({ session, event, currentProjection }) => {
        const cached = this.viewCache.get(cacheKey)
        // Reuse the cached, already-normalized view when it matches the stored sequence (the common
        // case: one worker folds a session's events in order). Otherwise re-normalize the stored view
        // — cold cache, or another instance advanced the projection.
        const warm = Boolean(cached && currentProjection && cached.sequence === currentProjection.sequence)
        const currentView = warm && cached
          ? cached.view
          : normalizeCloudSessionProjectionView(currentProjection?.view, session)
        projectedView = reduceCloudSessionProjectionEvent(session, currentView, event)
        // Warm path: carry the cached size forward plus the new event payload (O(payload)). Cold
        // path (cache miss / instance handoff): measure the whole view once. A conservative
        // over-estimate is fine — it only evicts slightly earlier.
        projectedBytes = warm && cached
          ? cached.bytes + approxJsonBytes(input.payload)
          : approxJsonBytes(projectedView)
        return {
          view: projectedView,
          updatedAt: new Date(event.createdAt),
        }
      },
    })
    const summaryView = projectedView || normalizeCloudSessionProjectionView(result.projection.view, result.session)
    const summaryBytes = projectedView ? projectedBytes : approxJsonBytes(summaryView)
    this.cacheView(
      cacheKey,
      result.projection.sequence,
      summaryView,
      summaryBytes,
    )
    await this.store.upsertCloudLaunchpadSessionSummary({
      tenantId: input.tenantId,
      userId: result.session.userId,
      sessionId: input.sessionId,
      pendingApprovals: summaryView.pendingApprovals,
      pendingQuestions: summaryView.pendingQuestions,
      updatedAt: summaryView.updatedAt || result.event.createdAt,
    })
    if (result.sessionEventCreated) this.sessionEvents.publish(result.event)
    if (result.workspaceEventCreated) this.workspaceEvents.publish(result.workspaceEvent)
    return result.event
  }

  async repairSessionProjection(input: RepairSessionProjectionInput): Promise<RepairSessionProjectionResult> {
    const session = await this.store.getSessionForTenant(input.tenantId, input.sessionId)
    if (!session) throw new Error(`Unknown session ${input.sessionId}.`)

    const priorProjection = await this.store.getSessionProjection(input.tenantId, input.sessionId)
    const priorProjectionSequence = priorProjection?.sequence || 0

    // Fold the event log into the projection in bounded keyset batches rather than one
    // unbounded SELECT — a long-lived session can have an enormous log, and the prior
    // single read materialized all of it into memory and could pin a pooled connection.
    // The reducer is a sequential fold, so batching by sequence is identical.
    let view = normalizeCloudSessionProjectionView(null, session)
    let afterSequence = 0
    let latestEventSequence = 0
    let latestCreatedAt: SessionEventRecord['createdAt'] | null = null
    let eventCount = 0
    let workspaceEventCount = 0
    for (;;) {
      const batch = await this.store.listSessionEvents(input.tenantId, input.sessionId, afterSequence, PROJECTION_REBUILD_BATCH)
      if (batch.length === 0) break
      for (const event of batch) {
        eventCount += 1
        latestEventSequence = event.sequence
        latestCreatedAt = event.createdAt
        if (!isCloudProjectedSessionEventType(event.type)) continue
        const projectedEventInput = {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          type: event.type,
          payload: event.payload,
          leaseToken: input.leaseToken,
        }
        const workspaceEntity = workspaceEntityForProjectedEvent(projectedEventInput, event)
        await this.store.appendWorkspaceEvent({
          tenantId: input.tenantId,
          userId: session.userId,
          sessionId: input.sessionId,
          eventId: event.eventId.startsWith(`${input.sessionId}:`)
            ? event.eventId
            : `${input.sessionId}:${event.eventId}`,
          ...workspaceEntity,
          type: event.type,
          payload: event.payload,
          createdAt: new Date(event.createdAt),
        })
        workspaceEventCount += 1
        view = reduceCloudSessionProjectionEvent(session, view, event)
      }
      afterSequence = batch[batch.length - 1]!.sequence
      if (batch.length < PROJECTION_REBUILD_BATCH) break
    }

    if (eventCount === 0) {
      return {
        repaired: false,
        eventCount: 0,
        workspaceEventCount: 0,
        latestEventSequence: 0,
        priorProjectionSequence,
        projectionSequence: priorProjectionSequence,
        lag: 0,
      }
    }

    const projection = await this.store.writeSessionProjection({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sequence: latestEventSequence,
      view,
      leaseToken: input.leaseToken,
      updatedAt: new Date(latestCreatedAt || session.updatedAt),
    })
    await this.store.upsertCloudLaunchpadSessionSummary({
      tenantId: input.tenantId,
      userId: session.userId,
      sessionId: input.sessionId,
      pendingApprovals: view.pendingApprovals,
      pendingQuestions: view.pendingQuestions,
      updatedAt: view.updatedAt || latestCreatedAt || session.updatedAt,
    })

    return {
      repaired: projection.sequence > priorProjectionSequence,
      eventCount,
      workspaceEventCount,
      latestEventSequence,
      priorProjectionSequence,
      projectionSequence: projection.sequence,
      lag: Math.max(0, latestEventSequence - projection.sequence),
    }
  }

  async waitForProjectionFence(input: WaitForSessionProjectionFenceInput): Promise<CloudProjectionFenceWaitResult> {
    if (input.fence.scope !== 'session') {
      return {
        ok: false,
        code: 'projection_fence_identity_mismatch',
        fence: input.fence,
        checkpoint: null,
        error: {
          kind: 'projection',
          code: 'projection_fence_identity_mismatch',
          message: 'CloudSessionProjectionService can only wait for session-scoped fences.',
          retryable: false,
        },
        waitedMs: 0,
      }
    }

    return waitForCloudProjectionFence({
      fence: input.fence,
      timeoutMs: input.timeoutMs,
      intervalMs: input.intervalMs,
      nowMs: input.nowMs,
      sleep: input.sleep,
      readCheckpoint: async () => {
        const projection = await this.store.getSessionProjection(input.fence.tenantId, input.fence.sessionId || '')
        if (!projection) return null
        return createCloudProjectionCheckpoint({
          scope: 'session',
          tenantId: input.fence.tenantId,
          sessionId: input.fence.sessionId,
          sequence: projection.sequence,
          projectionVersion: projection.sequence,
          updatedAt: projection.updatedAt,
        })
      },
    })
  }
}
