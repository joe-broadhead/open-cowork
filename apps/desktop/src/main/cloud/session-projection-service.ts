import {
  normalizeCloudSessionProjectionView,
  reduceCloudSessionProjectionEvent,
} from '@open-cowork/shared'
import type { SessionEventRecord } from './control-plane-store.ts'
import type { ProjectionControlPlaneStore } from './control-plane-store-domains.ts'
import { CloudSessionEventBus, CloudWorkspaceEventBus } from './session-event-bus.ts'

export type AppendProjectedEventInput = {
  tenantId: string
  sessionId: string
  type: string
  payload?: Record<string, unknown>
  leaseToken?: string | null
  createdAt?: Date
}

export type CloudProjectionStore = ProjectionControlPlaneStore

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
  if (input.type === 'artifact.created') {
    return {
      entityType: 'artifact',
      entityId: eventPayloadId(payload, ['artifactId', 'cloudArtifactId', 'id'], input.sessionId),
      operation: 'create',
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
    const event = await this.store.appendSessionEvent({
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      type: input.type,
      payload: input.payload || {},
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
}
