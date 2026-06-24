import {
  createCloudProjectionCheckpoint,
  waitForCloudProjectionFence,
  isCloudProjectedSessionEventType,
  normalizeCloudSessionProjectionView,
  reduceCloudSessionProjectionEvent,
  type CloudProjectionFenceToken,
  type CloudProjectionFenceWaitResult,
  type CloudProjectedSessionEventType,
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

export class CloudSessionProjectionService {
  private readonly store: CloudProjectionStore
  private readonly sessionEvents: CloudSessionEventBus
  private readonly workspaceEvents: CloudWorkspaceEventBus

  constructor(
    store: CloudProjectionStore,
    sessionEvents: CloudSessionEventBus,
    workspaceEvents: CloudWorkspaceEventBus,
  ) {
    this.store = store
    this.sessionEvents = sessionEvents
    this.workspaceEvents = workspaceEvents
  }

  async appendProjectedEvent(input: AppendProjectedEventInput) {
    if (!isCloudProjectedSessionEventType(input.type)) {
      throw new Error(`Unsupported cloud projection event type: ${input.type}`)
    }
    const event = await this.store.appendSessionEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload || {},
      leaseToken: input.leaseToken,
      createdAt: input.createdAt,
    })
    const session = await this.store.getSessionForTenant(input.tenantId, input.sessionId)
    if (!session) throw new Error(`Unknown session ${input.sessionId}.`)
    const workspaceEntity = workspaceEntityForProjectedEvent(input, event)
    const workspaceEvent = await this.store.appendWorkspaceEvent({
      tenantId: input.tenantId,
      userId: session.userId,
      sessionId: input.sessionId,
      eventId: event.eventId.startsWith(`${input.sessionId}:`)
        ? event.eventId
        : `${input.sessionId}:${event.eventId}`,
      ...workspaceEntity,
      type: input.type,
      payload: input.payload || {},
      createdAt: new Date(event.createdAt),
    })
    const currentProjection = await this.store.getSessionProjection(input.tenantId, input.sessionId)
    const currentView = normalizeCloudSessionProjectionView(currentProjection?.view, session)
    const nextView = reduceCloudSessionProjectionEvent(session, currentView, event)
    await this.store.writeSessionProjection({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      sequence: event.sequence,
      view: nextView,
      leaseToken: input.leaseToken,
      updatedAt: new Date(event.createdAt),
    })
    this.sessionEvents.publish(event)
    this.workspaceEvents.publish(workspaceEvent)
    return event
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
    for (;;) {
      const batch = await this.store.listSessionEvents(input.tenantId, input.sessionId, afterSequence, PROJECTION_REBUILD_BATCH)
      if (batch.length === 0) break
      for (const event of batch) {
        eventCount += 1
        latestEventSequence = event.sequence
        latestCreatedAt = event.createdAt
        if (!isCloudProjectedSessionEventType(event.type)) continue
        view = reduceCloudSessionProjectionEvent(session, view, event)
      }
      afterSequence = batch[batch.length - 1]!.sequence
      if (batch.length < PROJECTION_REBUILD_BATCH) break
    }

    if (eventCount === 0) {
      return {
        repaired: false,
        eventCount: 0,
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

    return {
      repaired: projection.sequence > priorProjectionSequence,
      eventCount,
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
