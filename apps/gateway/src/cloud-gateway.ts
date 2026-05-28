import {
  createHttpSseCloudTransportAdapter,
  type ChannelActorInput,
  type ChannelDeliveryRecord,
  type ChannelIdentityRecord,
  type ChannelSessionBindingRecord,
  type CloudChannelProviderId,
  type CloudSessionView,
  type CloudTransportAdapter,
  type CloudTransportSessionEvent,
  type CloudTransportSubscription,
  type IssuedChannelInteractionRecord,
  type SessionCommandRecord,
} from '@open-cowork/cloud-client'

import type { GatewayConfig } from './config.js'

export type CloudGateway = {
  resolveIdentity(input: {
    provider: CloudChannelProviderId
    externalUserId: string
    externalWorkspaceId?: string | null
    metadata?: Record<string, unknown>
  }): Promise<ChannelIdentityRecord>
  bindSession(input: ChannelActorInput & {
    channelBindingId: string
    provider: CloudChannelProviderId
    externalChatId: string
    externalThreadId: string
    sessionId?: string | null
    title?: string | null
  }): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView }>
  findSessionByThread(input: {
    provider: CloudChannelProviderId
    externalWorkspaceId?: string | null
    externalChatId: string
    externalThreadId: string
  }): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView } | null>
  prompt(input: ChannelActorInput & {
    bindingId: string
    text: string
    agent?: string | null
  }): Promise<{ binding: ChannelSessionBindingRecord, command: SessionCommandRecord, processed: number }>
  resolveChannelInteraction(input: ChannelActorInput & {
    token?: string | null
    externalInteractionId?: string | null
    response?: unknown
    answers?: unknown[]
    reject?: boolean
  }): Promise<{ interaction: unknown, command: SessionCommandRecord, processed: number }>
  createChannelInteraction(input: {
    agentId: string
    sessionId: string
    provider: CloudChannelProviderId
    kind: 'permission' | 'question'
    targetId: string
    externalInteractionId?: string | null
    createdByIdentityId?: string | null
    expiresAt?: string | null
    interactionId?: string | null
  }): Promise<IssuedChannelInteractionRecord>
  abortSession(sessionId: string): Promise<{ command: SessionCommandRecord, processed: number, view: CloudSessionView }>
  respondToPermission(sessionId: string, input: { permissionId: string, response: unknown }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  replyToQuestion(sessionId: string, input: { requestId: string, answers: unknown[] }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  rejectQuestion(sessionId: string, input: { requestId: string }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  subscribeSessionEvents(input: {
    sessionId: string
    afterSequence?: number
    onEvent: (event: CloudTransportSessionEvent) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  subscribeDeliveries(input: {
    claimedBy?: string
    ttlMs?: number
    onDelivery: (delivery: ChannelDeliveryRecord) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  updateCursor(input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelSessionBindingRecord | null>
  ackDelivery(deliveryId: string, input: {
    claimedBy?: string | null
    status: 'sent' | 'failed' | 'dead'
    lastError?: string | null
    nextAttemptAt?: string | null
  }): Promise<ChannelDeliveryRecord | null>
}

export function createCloudGateway(config: GatewayConfig, adapter = createCloudAdapter(config)): CloudGateway {
  return {
    async resolveIdentity(input) {
      assertMethod(adapter.resolveChannelIdentity, 'resolveChannelIdentity')
      return adapter.resolveChannelIdentity(input)
    },
    async bindSession(input) {
      assertMethod(adapter.bindChannelSession, 'bindChannelSession')
      return adapter.bindChannelSession(input)
    },
    async findSessionByThread(input) {
      assertMethod(adapter.getChannelSessionByThread, 'getChannelSessionByThread')
      return adapter.getChannelSessionByThread(input)
    },
    async prompt(input) {
      assertMethod(adapter.promptChannelSession, 'promptChannelSession')
      return adapter.promptChannelSession(input)
    },
    async resolveChannelInteraction(input) {
      assertMethod(adapter.resolveChannelInteraction, 'resolveChannelInteraction')
      return adapter.resolveChannelInteraction(input)
    },
    async createChannelInteraction(input) {
      assertMethod(adapter.createChannelInteraction, 'createChannelInteraction')
      return adapter.createChannelInteraction(input)
    },
    abortSession(sessionId) {
      return adapter.abortSession(sessionId)
    },
    respondToPermission(sessionId, input) {
      return adapter.respondToPermission(sessionId, input)
    },
    replyToQuestion(sessionId, input) {
      return adapter.replyToQuestion(sessionId, input)
    },
    rejectQuestion(sessionId, input) {
      return adapter.rejectQuestion(sessionId, input)
    },
    subscribeSessionEvents(input) {
      return adapter.subscribeSessionEvents(input.sessionId, {
        afterSequence: input.afterSequence,
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
    subscribeDeliveries(input) {
      assertMethod(adapter.subscribeChannelDeliveries, 'subscribeChannelDeliveries')
      return adapter.subscribeChannelDeliveries(input)
    },
    async updateCursor(input) {
      assertMethod(adapter.updateChannelCursor, 'updateChannelCursor')
      return adapter.updateChannelCursor(input)
    },
    async ackDelivery(deliveryId, input) {
      assertMethod(adapter.ackChannelDelivery, 'ackChannelDelivery')
      return adapter.ackChannelDelivery(deliveryId, input)
    },
  }
}

function createCloudAdapter(config: GatewayConfig): CloudTransportAdapter {
  return createHttpSseCloudTransportAdapter({
    baseUrl: config.cloud.baseUrl,
    headers: {
      authorization: `Bearer ${config.cloud.serviceToken}`,
    },
  })
}

function assertMethod<T>(method: T, name: string): asserts method is NonNullable<T> {
  if (!method) throw new Error(`Cloud client does not support ${name}.`)
}
