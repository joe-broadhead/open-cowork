import {
  createHttpSseCloudTransportAdapter,
  type ChannelActorInput,
  type ChannelDeliveryRecord,
  type ChannelIdentityRecord,
  type ChannelSessionBindingRecord,
  type CloudChannelProviderId,
  type SessionArtifactAttachment,
  type CloudSessionView,
  type CloudTransportAdapter,
  type CloudTransportSessionEvent,
  type CloudTransportSubscription,
  type IssuedChannelInteractionRecord,
  type SessionCommandRecord,
} from '@open-cowork/cloud-client'

import type { GatewayCloudConnectionConfig } from './config.js'

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
  getSession(sessionId: string): Promise<CloudSessionView>
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
  readArtifactAttachment?(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
  artifactUrl(sessionId: string, artifactId: string): string
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
  listDeliveries?(input?: {
    status?: ChannelDeliveryRecord['status'] | null
    channelBindingId?: string | null
    limit?: number | null
  }): Promise<ChannelDeliveryRecord[]>
  retryDelivery?(deliveryId: string): Promise<ChannelDeliveryRecord | null>
  deadLetterDelivery?(deliveryId: string, input?: { lastError?: string | null }): Promise<ChannelDeliveryRecord | null>
}

export function createCloudGateway(connection: GatewayCloudConnectionConfig, adapter = createCloudAdapter(connection)): CloudGateway {
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
    getSession(sessionId) {
      return adapter.getSession(sessionId)
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
    readArtifactAttachment(sessionId, filePathOrArtifactId) {
      assertMethod(adapter.readArtifactAttachment, 'readArtifactAttachment')
      return adapter.readArtifactAttachment(sessionId, filePathOrArtifactId)
    },
    artifactUrl(sessionId, artifactId) {
      return `${normalizeBaseUrl(connection.baseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`
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
    async listDeliveries(input = {}) {
      assertMethod(adapter.listChannelDeliveries, 'listChannelDeliveries')
      return adapter.listChannelDeliveries(input)
    },
    async retryDelivery(deliveryId) {
      assertMethod(adapter.retryChannelDelivery, 'retryChannelDelivery')
      return adapter.retryChannelDelivery(deliveryId)
    },
    async deadLetterDelivery(deliveryId, input = {}) {
      assertMethod(adapter.deadLetterChannelDelivery, 'deadLetterChannelDelivery')
      return adapter.deadLetterChannelDelivery(deliveryId, input)
    },
  }
}

function createCloudAdapter(connection: GatewayCloudConnectionConfig): CloudTransportAdapter {
  return createHttpSseCloudTransportAdapter({
    baseUrl: connection.baseUrl,
    requestTimeoutMs: connection.requestTimeoutMs,
    headers: {
      authorization: `Bearer ${connection.serviceToken}`,
    },
  })
}

function normalizeBaseUrl(value: string) {
  let normalized = value.trim()
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

function assertMethod<T>(method: T, name: string): asserts method is NonNullable<T> {
  if (!method) throw new Error(`Cloud client does not support ${name}.`)
}
