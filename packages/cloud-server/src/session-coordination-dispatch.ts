// Coordination-watch fan-out, carved out of the CloudSessionService god class (ARCH
// god-class). When a projected session event lands, this maps it to a coordination
// watch event and delivers it to matching watches as system channel deliveries. Moved
// verbatim so behavior is byte-identical; CloudSessionService's appendProjectedEvent
// composes projections + this dispatcher, and the coordination service's delivery
// callback delegates here.
import { createHash } from 'crypto'
import type {
  CoordinationTarget,
  CoordinationWatch,
  CoordinationWatchEvent,
} from '@open-cowork/shared'
import { coordinationWatchRecipientCanReceive } from '@open-cowork/shared'
import { log } from '@open-cowork/shared/node'
import type {
  ControlPlaneStore,
  CreateChannelDeliveryInput,
  SessionEventRecord,
} from './control-plane-store.ts'
import type { AppendProjectedEventInput } from './session-projection-service.ts'
import { normalizeChannelProviderId } from './channel-provider-utils.ts'
import { asRecord, readString } from './session-input-validation.ts'

export type CloudCoordinationDispatchServiceOptions = {
  store: ControlPlaneStore
  resolveOrgIdForTenant: (tenantId: string) => Promise<string>
}

export class CloudCoordinationDispatchService {
  private readonly store: ControlPlaneStore
  private readonly resolveOrgIdForTenant: CloudCoordinationDispatchServiceOptions['resolveOrgIdForTenant']

  constructor(options: CloudCoordinationDispatchServiceOptions) {
    this.store = options.store
    this.resolveOrgIdForTenant = options.resolveOrgIdForTenant
  }

  dispatchCloudCoordinationWatchEvent(input: AppendProjectedEventInput, event: SessionEventRecord) {
    const watchEvent = this.coordinationWatchEventFromProjectedEvent(input, event)
    if (!watchEvent) return
    void this.deliverCloudCoordinationWatchEvent(watchEvent).catch((error: unknown) => {
      log('coordination', `Cloud watch event dispatch failed event=${input.type} session=${input.sessionId}: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  async deliverCloudCoordinationWatchEvent(event: CoordinationWatchEvent) {
    const workspaceId = event.workspaceId?.trim() || 'cloud:default'
    const watches = await this.store.listMatchingCloudCoordinationWatches({
      workspaceId,
      eventType: event.eventType,
      targets: this.cloudWatchRelatedTargets(event),
    })
    if (watches.length === 0) return

    const tenantId = workspaceId.startsWith('cloud:') ? workspaceId.slice('cloud:'.length) : workspaceId
    const normalizedTenantId = tenantId.trim() || 'default'
    const orgId = await this.resolveOrgIdForTenant(normalizedTenantId)

    for (const watch of watches) {
      if (!coordinationWatchRecipientCanReceive(watch.recipient?.role, event.eventType)) continue
      try {
        await this.createSystemChannelDelivery({
          orgId,
          agentId: watch.channel.agentId,
          channelBindingId: watch.channel.channelBindingId,
          sessionBindingId: watch.channel.sessionBindingId || null,
          provider: normalizeChannelProviderId(watch.channel.provider),
          target: watch.channel.target,
          eventType: event.eventType,
          payload: this.cloudWatchPayload(watch, event),
          deliveryId: this.cloudWatchDeliveryId(watch, event),
        })
      } catch (error) {
        log('coordination', `Cloud watch delivery failed watch=${watch.id} event=${event.eventType}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private async createSystemChannelDelivery(input: CreateChannelDeliveryInput) {
    await this.store.createChannelDelivery(input)
  }

  private cloudWatchRelatedTargets(event: CoordinationWatchEvent): CoordinationTarget[] {
    return [event.target, ...(event.relatedTargets || [])]
  }

  private cloudWatchPayload(watch: CoordinationWatch, event: CoordinationWatchEvent): Record<string, unknown> {
    return {
      watchId: watch.id,
      eventType: event.eventType,
      target: event.target,
      relatedTargets: event.relatedTargets || [],
      title: event.title || null,
      message: event.message || null,
      severity: event.severity || 'info',
      occurredAt: event.occurredAt || new Date().toISOString(),
      metadata: event.metadata || {},
    }
  }

  private cloudWatchDeliveryId(watch: CoordinationWatch, event: CoordinationWatchEvent) {
    const timestampScopedEvent = event.eventType === 'task.moved'
      || event.eventType === 'task.review_ready'
      || event.eventType === 'run.finished'
      || event.eventType === 'daily_summary'
    const eventKey = {
      watchId: watch.id,
      eventType: event.eventType,
      target: event.target,
      relatedTargets: event.relatedTargets || [],
      metadata: event.metadata || {},
      occurredAt: timestampScopedEvent ? event.occurredAt || null : null,
    }
    const digest = createHash('sha256').update(JSON.stringify(eventKey)).digest('hex').slice(0, 40)
    return `watch:${event.eventType}:${digest}`
  }

  private coordinationWatchEventFromProjectedEvent(
    input: AppendProjectedEventInput,
    event: SessionEventRecord,
  ): CoordinationWatchEvent | null {
    const workspaceId = `cloud:${input.tenantId}`
    const sessionTarget = { kind: 'session' as const, id: input.sessionId }
    const conversationTarget = { kind: 'conversation' as const, id: input.sessionId }
    const payload = input.payload || {}
    const occurredAt = event.createdAt
    if (input.type === 'session.idle') {
      return {
        eventType: 'run.finished',
        workspaceId,
        target: sessionTarget,
        relatedTargets: [conversationTarget],
        title: 'Run finished',
        message: 'OpenCode finished processing the cloud run.',
        severity: 'success',
        occurredAt,
        metadata: {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          runtimeSessionId: readString(payload.sessionId) || null,
          cloudEventType: input.type,
        },
      }
    }
    if (input.type === 'permission.requested') {
      const requestId = readString(payload.permissionId) || readString(payload.id) || readString(payload.requestId) || null
      return {
        eventType: 'needs_input',
        workspaceId,
        target: conversationTarget,
        relatedTargets: [sessionTarget],
        title: 'Approval needed',
        message: readString(payload.description) || readString(payload.tool) || 'A cloud run needs approval.',
        severity: 'warning',
        occurredAt,
        metadata: {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          requestId,
          kind: input.type,
          tool: readString(payload.tool) || null,
        },
      }
    }
    if (input.type === 'question.asked') {
      const requestId = readString(payload.requestId) || readString(payload.id) || null
      const questions = Array.isArray(payload.questions) ? payload.questions : []
      const firstQuestion = readString(asRecord(questions[0]).question)
      return {
        eventType: 'needs_input',
        workspaceId,
        target: conversationTarget,
        relatedTargets: [sessionTarget],
        title: 'Question needs an answer',
        message: firstQuestion || 'A cloud run needs an answer.',
        severity: 'warning',
        occurredAt,
        metadata: {
          tenantId: input.tenantId,
          sessionId: input.sessionId,
          requestId,
          kind: input.type,
        },
      }
    }
    return null
  }
}
