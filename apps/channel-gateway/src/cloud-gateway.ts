import {
  createHttpSseCloudTransportAdapter,
} from '@open-cowork/cloud-client'
import type {
  ChannelActorInput,
  ChannelCursorUpdateResult,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelSessionBindingRecord,
  CloudChannelInteractionMutationResponse,
  CloudChannelProviderEventStatus,
  CloudChannelProviderEventType,
  CloudChannelProviderId,
  CloudChannelPromptMutationResponse,
  IssuedChannelInteractionRecord,
} from '@open-cowork/cloud-client/domains/channels'
import type { CloudSessionView } from '@open-cowork/cloud-client/domains/sessions'
import type {
  SessionArtifactAttachment,
} from '@open-cowork/cloud-client/domains/artifacts'
import type {
  CloudTransportAdapter,
  CloudTransportSessionEvent,
  CloudTransportSubscription,
} from '@open-cowork/cloud-client/domains/transport'

import type { GatewayCloudConnectionConfig } from './config.js'

export type CloudGateway = {
  resolveIdentity(input: {
    provider: CloudChannelProviderId
    externalUserId: string
    channelBindingId?: string | null
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
  getSession(sessionBindingId: string): Promise<CloudSessionView>
  prompt(input: ChannelActorInput & {
    bindingId: string
    text: string
    agent?: string | null
  }): Promise<CloudChannelPromptMutationResponse>
  claimProviderEvent(input: {
    provider: CloudChannelProviderId
    providerInstanceId: string
    channelBindingId?: string | null
    externalWorkspaceId?: string | null
    providerEventId: string
    eventType: CloudChannelProviderEventType
    claimedBy: string
    ttlMs?: number | null
    metadata?: Record<string, unknown>
  }): Promise<ChannelProviderEventClaimResult>
  completeProviderEvent(eventId: string, input: {
    channelBindingId?: string | null
    claimedBy: string
    status: Extract<CloudChannelProviderEventStatus, 'processed' | 'failed'>
    retryable?: boolean
    lastError?: string | null
  }): Promise<ChannelProviderEventRecord | null>
  resolveChannelInteraction(input: ChannelActorInput & {
    token?: string | null
    externalInteractionId?: string | null
    response?: unknown
    answers?: unknown[]
    reject?: boolean
  }): Promise<CloudChannelInteractionMutationResponse>
  createChannelInteraction(input: {
    agentId: string
    sessionBindingId: string
    sessionId: string
    provider: CloudChannelProviderId
    kind: 'permission' | 'question'
    targetId: string
    externalInteractionId?: string | null
    expiresAt?: string | null
    interactionId?: string | null
  }): Promise<IssuedChannelInteractionRecord>
  readArtifactAttachment?(sessionBindingId: string, artifactId: string): Promise<SessionArtifactAttachment>
  artifactUrl(sessionBindingId: string, artifactId: string): string
  subscribeSessionEvents(input: {
    sessionBindingId: string
    afterSequence?: number
    onEvent: (event: CloudTransportSessionEvent) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  subscribeDeliveries(input: {
    claimedBy?: string
    ttlMs?: number
    channelBindingIds?: readonly string[]
    onDelivery: (delivery: ChannelDeliveryRecord) => void
    onError?: (error: unknown) => void
    onClose?: () => void
  }): CloudTransportSubscription
  updateCursor(input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelCursorUpdateResult>
  ackDelivery(deliveryId: string, input: {
    channelBindingId?: string | null
    claimedBy?: string | null
    status: 'sent' | 'failed' | 'dead'
    lastError?: string | null
    nextAttemptAt?: string | null
  }): Promise<ChannelDeliveryRecord | null>
  listDeliveries?(input?: {
    deliveryId?: string | null
    status?: ChannelDeliveryRecord['status'] | null
    channelBindingId?: string | null
    limit?: number | null
  }): Promise<ChannelDeliveryRecord[]>
  retryDelivery?(deliveryId: string, input?: { channelBindingId?: string | null }): Promise<ChannelDeliveryRecord | null>
  deadLetterDelivery?(deliveryId: string, input?: { channelBindingId?: string | null, lastError?: string | null }): Promise<ChannelDeliveryRecord | null>
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
    getSession(sessionBindingId) {
      assertMethod(adapter.getChannelSessionSnapshot, 'getChannelSessionSnapshot')
      return adapter.getChannelSessionSnapshot(sessionBindingId)
    },
    async prompt(input) {
      assertMethod(adapter.promptChannelSession, 'promptChannelSession')
      return adapter.promptChannelSession(input)
    },
    async claimProviderEvent(input) {
      assertMethod(adapter.claimChannelProviderEvent, 'claimChannelProviderEvent')
      return adapter.claimChannelProviderEvent(input)
    },
    async completeProviderEvent(eventId, input) {
      assertMethod(adapter.completeChannelProviderEvent, 'completeChannelProviderEvent')
      return adapter.completeChannelProviderEvent(eventId, input)
    },
    async resolveChannelInteraction(input) {
      assertMethod(adapter.resolveChannelInteraction, 'resolveChannelInteraction')
      return adapter.resolveChannelInteraction(input)
    },
    async createChannelInteraction(input) {
      assertMethod(adapter.createChannelInteraction, 'createChannelInteraction')
      return adapter.createChannelInteraction(input)
    },
    readArtifactAttachment(sessionBindingId, artifactId) {
      assertMethod(adapter.readChannelArtifactAttachment, 'readChannelArtifactAttachment')
      return adapter.readChannelArtifactAttachment(sessionBindingId, artifactId)
    },
    artifactUrl(sessionBindingId, artifactId) {
      return `${normalizeBaseUrl(connection.baseUrl)}/api/channels/sessions/${encodeURIComponent(sessionBindingId)}/artifacts/${encodeURIComponent(artifactId)}`
    },
    subscribeSessionEvents(input) {
      assertMethod(adapter.subscribeChannelSessionEvents, 'subscribeChannelSessionEvents')
      return adapter.subscribeChannelSessionEvents(input.sessionBindingId, {
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
    async retryDelivery(deliveryId, input = {}) {
      assertMethod(adapter.retryChannelDelivery, 'retryChannelDelivery')
      return adapter.retryChannelDelivery(deliveryId, input)
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
