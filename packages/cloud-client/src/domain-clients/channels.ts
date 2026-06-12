export type {
  ChannelActorInput,
  ChannelBindingRecord,
  ChannelCursorUpdateResult,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelSessionBindingRecord,
  CloudChannelDeliveryStatus,
  CloudChannelIdentityRole,
  CloudChannelIdentityStatus,
  CloudChannelProviderEventStatus,
  CloudChannelProviderEventType,
  CloudChannelProviderId,
  CloudChannelProviderKind,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
} from '../contracts.js'

import type { ChannelProviderStatus } from '@open-cowork/shared'
import { isCloudTransportError } from '../errors.js'
import type {
  ChannelActorInput,
  ChannelBindingRecord,
  ChannelCursorUpdateResult,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelSessionBindingRecord,
  CloudChannelDeliveryStatus,
  CloudChannelIdentityRole as ChannelIdentityRole,
  CloudChannelIdentityStatus as ChannelIdentityStatus,
  CloudChannelProviderEventStatus,
  CloudChannelProviderEventType,
  CloudChannelPromptMutationResponse,
  CloudChannelInteractionMutationResponse,
  CloudChannelProviderId as ChannelProviderId,
  CloudSessionView,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
  CloudTransportSubscription,
} from '../contracts.js'
import type { CloudDomainClientContext } from '../domains/shared.js'
import { asRecord, encodePath, queryString } from '../domains/shared.js'
import {
  subscribeCloudEvents,
  type CloudTransportSseContext,
} from './transport.js'

export type CloudChannelsClientContext = CloudDomainClientContext & CloudTransportSseContext

export type CloudChannelsClient = {
  listChannelProviders(): Promise<ChannelProviderStatus[]>
  listHeadlessAgents(): Promise<HeadlessAgentRecord[]>
  createHeadlessAgent(input: {
    name: string
    profileName?: string | null
    status?: 'active' | 'disabled'
    managed?: boolean
    agentId?: string | null
  }): Promise<HeadlessAgentRecord>
  updateHeadlessAgent(agentId: string, input: {
    name?: string
    profileName?: string
    status?: 'active' | 'disabled'
    managed?: boolean
  }): Promise<HeadlessAgentRecord | null>
  listChannelBindings(agentId?: string | null): Promise<ChannelBindingRecord[]>
  createChannelBinding(input: {
    agentId: string
    provider: ChannelProviderId
    displayName: string
    externalWorkspaceId?: string | null
    status?: 'active' | 'disabled' | 'auth_required' | 'error'
    credentialRef?: string | null
    settings?: Record<string, unknown>
    bindingId?: string | null
  }): Promise<ChannelBindingRecord>
  updateChannelBinding(bindingId: string, input: {
    displayName?: string
    status?: 'active' | 'disabled' | 'auth_required' | 'error'
    credentialRef?: string | null
    settings?: Record<string, unknown>
  }): Promise<ChannelBindingRecord | null>
  disconnectChannelBinding(bindingId: string): Promise<ChannelBindingRecord | null>
  listChannelIdentities(input?: {
    provider?: ChannelProviderId | null
    externalWorkspaceId?: string | null
    role?: ChannelIdentityRole
    status?: ChannelIdentityStatus
    limit?: number | null
  }): Promise<ChannelIdentityRecord[]>
  resolveChannelIdentity(input: {
    provider: ChannelProviderId
    externalUserId: string
    channelBindingId?: string | null
    externalWorkspaceId?: string | null
    identityId?: string | null
    accountId?: string | null
    role?: ChannelIdentityRole
    status?: ChannelIdentityStatus
    metadata?: Record<string, unknown>
  }): Promise<ChannelIdentityRecord>
  bindChannelSession(input: ChannelActorInput & {
    channelBindingId: string
    provider: ChannelProviderId
    externalChatId: string
    externalThreadId: string
    sessionId?: string | null
    title?: string | null
  }): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView }>
  getChannelSessionByThread(input: {
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalChatId: string
    externalThreadId: string
  }): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView } | null>
  promptChannelSession(input: ChannelActorInput & {
    bindingId: string
    text: string
    agent?: string | null
    commandId?: string | null
  }): Promise<CloudChannelPromptMutationResponse>
  claimChannelProviderEvent(input: {
    provider: ChannelProviderId
    providerInstanceId: string
    channelBindingId?: string | null
    externalWorkspaceId?: string | null
    providerEventId: string
    eventType: CloudChannelProviderEventType
    claimedBy: string
    ttlMs?: number | null
    metadata?: Record<string, unknown>
  }): Promise<ChannelProviderEventClaimResult>
  completeChannelProviderEvent(eventId: string, input: {
    channelBindingId?: string | null
    claimedBy: string
    status: Extract<CloudChannelProviderEventStatus, 'processed' | 'failed'>
    retryable?: boolean
    lastError?: string | null
  }): Promise<ChannelProviderEventRecord | null>
  updateChannelCursor(input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelCursorUpdateResult>
  createChannelInteraction(input: {
    agentId: string
    sessionId: string
    provider: ChannelProviderId
    kind: ChannelInteractionRecord['kind']
    targetId: string
    externalInteractionId?: string | null
    createdByIdentityId?: string | null
    expiresAt?: string | null
    interactionId?: string | null
  }): Promise<IssuedChannelInteractionRecord>
  resolveChannelInteraction(input: ChannelActorInput & {
    token?: string | null
    externalInteractionId?: string | null
    response?: unknown
    answers?: unknown[]
    reject?: boolean
  }): Promise<CloudChannelInteractionMutationResponse>
  createChannelDelivery(input: {
    agentId: string
    channelBindingId: string
    sessionBindingId?: string | null
    provider: ChannelProviderId
    target: Record<string, unknown>
    eventType: string
    payload: Record<string, unknown>
    deliveryId?: string | null
    nextAttemptAt?: string | null
  }): Promise<ChannelDeliveryRecord>
  ackChannelDelivery(deliveryId: string, input: {
    claimedBy?: string | null
    status: Extract<CloudChannelDeliveryStatus, 'sent' | 'failed' | 'dead'>
    lastError?: string | null
    nextAttemptAt?: string | null
  }): Promise<ChannelDeliveryRecord | null>
  listChannelDeliveries(input?: {
    deliveryId?: string | null
    status?: CloudChannelDeliveryStatus | null
    channelBindingId?: string | null
    limit?: number | null
  }): Promise<ChannelDeliveryRecord[]>
  retryChannelDelivery(deliveryId: string): Promise<ChannelDeliveryRecord | null>
  deadLetterChannelDelivery(deliveryId: string, input?: { lastError?: string | null }): Promise<ChannelDeliveryRecord | null>
  channelDeliveriesUrl(input?: { claimedBy?: string, ttlMs?: number, channelBindingIds?: readonly string[] }): string
  subscribeChannelDeliveries(input: {
    claimedBy?: string
    ttlMs?: number
    channelBindingIds?: readonly string[]
    onDelivery: (delivery: ChannelDeliveryRecord) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
}

function channelDeliveriesUrl(baseUrl: string, input: { claimedBy?: string, ttlMs?: number, channelBindingIds?: readonly string[] } = {}) {
  return `${baseUrl}/api/channels/deliveries/stream${queryString({
    claimedBy: input.claimedBy,
    ttlMs: input.ttlMs,
    channelBindingId: input.channelBindingIds,
  })}`
}

export function createCloudChannelsClient(context: CloudChannelsClientContext): CloudChannelsClient {
  const { request } = context
  return {
    async listChannelProviders() {
      return (await request<{ providers: ChannelProviderStatus[] }>('/api/channels/providers')).providers
    },
    async listHeadlessAgents() {
      return (await request<{ agents: HeadlessAgentRecord[] }>('/api/channels/agents')).agents
    },
    async createHeadlessAgent(input) {
      return (await request<{ agent: HeadlessAgentRecord }>('/api/channels/agents', {
        method: 'POST',
        body: input,
      })).agent
    },
    async updateHeadlessAgent(agentId, input) {
      return (await request<{ agent: HeadlessAgentRecord | null }>(`/api/channels/agents/${encodePath(agentId)}`, {
        method: 'PATCH',
        body: input,
      })).agent
    },
    async listChannelBindings(agentId) {
      return (await request<{ bindings: ChannelBindingRecord[] }>(`/api/channels/bindings${queryString({ agentId })}`)).bindings
    },
    async createChannelBinding(input) {
      return (await request<{ binding: ChannelBindingRecord }>('/api/channels/bindings', {
        method: 'POST',
        body: input,
      })).binding
    },
    async updateChannelBinding(bindingId, input) {
      return (await request<{ binding: ChannelBindingRecord | null }>(`/api/channels/bindings/${encodePath(bindingId)}`, {
        method: 'PATCH',
        body: input,
      })).binding
    },
    async disconnectChannelBinding(bindingId) {
      return (await request<{ binding: ChannelBindingRecord | null }>(`/api/channels/bindings/${encodePath(bindingId)}`, {
        method: 'PATCH',
        body: { status: 'disabled' },
      })).binding
    },
    async listChannelIdentities(input) {
      return (await request<{ identities: ChannelIdentityRecord[] }>(`/api/channels/identities${queryString(input || {})}`)).identities
    },
    async resolveChannelIdentity(input) {
      return (await request<{ identity: ChannelIdentityRecord }>('/api/channels/identities/resolve', {
        method: 'POST',
        body: input,
      })).identity
    },
    bindChannelSession(input) {
      return request('/api/channels/sessions/bind', {
        method: 'POST',
        body: input,
      })
    },
    async getChannelSessionByThread(input) {
      try {
        return await request(`/api/channels/sessions/by-thread${queryString(input)}`)
      } catch (error) {
        if (isCloudTransportError(error) && error.kind === 'not_found') return null
        if (error instanceof Error && /not found/i.test(error.message)) return null
        throw error
      }
    },
    promptChannelSession(input) {
      return request('/api/channels/sessions/prompt', {
        method: 'POST',
        body: input,
      })
    },
    claimChannelProviderEvent(input) {
      return request('/api/channels/provider-events/claim', {
        method: 'POST',
        body: input,
      })
    },
    async completeChannelProviderEvent(eventId, input) {
      return (await request<{ event: ChannelProviderEventRecord | null }>(`/api/channels/provider-events/${encodePath(eventId)}/complete`, {
        method: 'POST',
        body: input,
      })).event
    },
    async updateChannelCursor(input) {
      try {
        const response = await request<{ binding?: ChannelSessionBindingRecord | null, result?: ChannelCursorUpdateResult }>('/api/channels/cursor', {
          method: 'POST',
          body: input,
        })
        if (response.result) return response.result
        return response.binding
          ? { ok: true, binding: response.binding }
          : { ok: false, reason: 'not_found' }
      } catch (error) {
        if (isCloudTransportError(error) && error.kind === 'not_found') return { ok: false, reason: 'not_found' }
        throw error
      }
    },
    createChannelInteraction(input) {
      return request('/api/channels/interactions', {
        method: 'POST',
        body: input,
      })
    },
    resolveChannelInteraction(input) {
      return request('/api/channels/interactions/resolve', {
        method: 'POST',
        body: input,
      })
    },
    async createChannelDelivery(input) {
      return (await request<{ delivery: ChannelDeliveryRecord }>('/api/channels/deliveries', {
        method: 'POST',
        body: input,
      })).delivery
    },
    async ackChannelDelivery(deliveryId, input) {
      return (await request<{ delivery: ChannelDeliveryRecord | null }>(`/api/channels/deliveries/${encodePath(deliveryId)}/ack`, {
        method: 'POST',
        body: input,
      })).delivery
    },
    async listChannelDeliveries(input = {}) {
      return (await request<{ deliveries: ChannelDeliveryRecord[] }>(`/api/channels/deliveries${queryString(input)}`)).deliveries
    },
    async retryChannelDelivery(deliveryId) {
      return (await request<{ delivery: ChannelDeliveryRecord | null }>(`/api/channels/deliveries/${encodePath(deliveryId)}/retry`, {
        method: 'POST',
        body: {},
      })).delivery
    },
    async deadLetterChannelDelivery(deliveryId, input = {}) {
      return (await request<{ delivery: ChannelDeliveryRecord | null }>(`/api/channels/deliveries/${encodePath(deliveryId)}/dead-letter`, {
        method: 'POST',
        body: input,
      })).delivery
    },
    channelDeliveriesUrl(input = {}) {
      return channelDeliveriesUrl(context.baseUrl, input)
    },
    subscribeChannelDeliveries(input) {
      const url = channelDeliveriesUrl(context.baseUrl, {
        claimedBy: input.claimedBy,
        ttlMs: input.ttlMs,
        channelBindingIds: input.channelBindingIds,
      })
      const onEvent = (event: unknown) => {
        const record = asRecord(event)
        if ('error' in record) {
          input.onError?.(new Error(typeof record.error === 'string' ? record.error : 'Channel delivery stream failed.'))
          return
        }
        const delivery = record.delivery
        if (delivery && typeof delivery === 'object') input.onDelivery(delivery as ChannelDeliveryRecord)
      }
      return subscribeCloudEvents(context, url, {
        onEvent,
        onError: input.onError,
      })
    },
  }
}
