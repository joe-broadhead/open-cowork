import type {
  ChannelBindingRecord,
  ChannelCursorUpdateResult,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderEventType,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
  SessionCommandRecord,
} from '../control-plane-store.ts'
import type {
  PublicChannelBindingRecord,
  PublicChannelDeliveryRecord,
} from '../public-channel-records.ts'
import type {
  CloudPrincipal,
  CloudSessionView,
} from '../session-service.ts'
import * as adminActions from './channel-admin-actions.ts'
import {
  type ChannelActorInput,
  type ChannelInteractionResolutionInput,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'
import * as deliveryActions from './channel-delivery-actions.ts'
import * as interactionActions from './channel-interaction-actions.ts'
import * as providerEventActions from './channel-provider-event-actions.ts'
import * as sessionActions from './channel-session-actions.ts'

export type {
  ChannelActorInput,
  ChannelInteractionResolutionInput,
  CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export class CloudChannelDomainService {
  private readonly options: CloudChannelDomainServiceOptions

  constructor(options: CloudChannelDomainServiceOptions) {
    this.options = options
  }

  listHeadlessAgents(principal: CloudPrincipal, input: { limit?: number | null } = {}): Promise<HeadlessAgentRecord[]> {
    return adminActions.listHeadlessAgents(this.options, principal, input)
  }

  createHeadlessAgent(
    principal: CloudPrincipal,
    input: {
      name: string
      profileName?: string | null
      status?: HeadlessAgentRecord['status']
      managed?: boolean
      agentId?: string | null
    },
  ): Promise<HeadlessAgentRecord> {
    return adminActions.createHeadlessAgent(this.options, principal, input)
  }

  updateHeadlessAgent(
    principal: CloudPrincipal,
    agentId: string,
    input: {
      name?: string
      profileName?: string
      status?: HeadlessAgentRecord['status']
      managed?: boolean
    },
  ): Promise<HeadlessAgentRecord | null> {
    return adminActions.updateHeadlessAgent(this.options, principal, agentId, input)
  }

  listChannelBindings(
    principal: CloudPrincipal,
    agentId?: string | null,
    input: { limit?: number | null } = {},
  ): Promise<PublicChannelBindingRecord[]> {
    return adminActions.listChannelBindings(this.options, principal, agentId, input)
  }

  createChannelBinding(
    principal: CloudPrincipal,
    input: {
      agentId: string
      provider: ChannelProviderId
      displayName: string
      externalWorkspaceId?: string | null
      status?: ChannelBindingRecord['status']
      credentialRef?: string | null
      settings?: Record<string, unknown>
      bindingId?: string | null
    },
  ): Promise<PublicChannelBindingRecord> {
    return adminActions.createChannelBinding(this.options, principal, input)
  }

  updateChannelBinding(
    principal: CloudPrincipal,
    bindingId: string,
    input: {
      displayName?: string
      status?: ChannelBindingRecord['status']
      credentialRef?: string | null
      settings?: Record<string, unknown>
    },
  ): Promise<PublicChannelBindingRecord | null> {
    return adminActions.updateChannelBinding(this.options, principal, bindingId, input)
  }

  resolveChannelIdentity(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      externalWorkspaceId?: string | null
      externalUserId: string
      identityId?: string | null
      accountId?: string | null
      role?: ChannelIdentityRecord['role']
      status?: ChannelIdentityRecord['status']
      metadata?: Record<string, unknown>
    },
  ): Promise<ChannelIdentityRecord> {
    return adminActions.resolveChannelIdentity(this.options, principal, input)
  }

  bindChannelSession(
    principal: CloudPrincipal,
    input: ChannelActorInput & {
      channelBindingId: string
      provider: ChannelProviderId
      externalChatId: string
      externalThreadId: string
      sessionId?: string | null
      title?: string | null
      lastEventSequence?: number
      lastWorkspaceSequence?: number
      lastChatMessageId?: string | null
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView }> {
    return sessionActions.bindChannelSession(this.options, principal, input)
  }

  getChannelSessionByThread(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      externalWorkspaceId?: string | null
      externalChatId: string
      externalThreadId: string
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, session: CloudSessionView } | null> {
    return sessionActions.getChannelSessionByThread(this.options, principal, input)
  }

  updateChannelCursor(
    principal: CloudPrincipal,
    input: {
      bindingId: string
      lastEventSequence: number
      lastWorkspaceSequence: number
      lastChatMessageId?: string | null
    },
  ): Promise<ChannelCursorUpdateResult> {
    return sessionActions.updateChannelCursor(this.options, principal, input)
  }

  enqueueChannelPrompt(
    principal: CloudPrincipal,
    input: ChannelActorInput & {
      bindingId: string
      text: string
      agent?: string | null
      commandId?: string | null
    },
  ): Promise<{ binding: ChannelSessionBindingRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
    return sessionActions.enqueueChannelPrompt(this.options, principal, input)
  }

  createChannelInteraction(
    principal: CloudPrincipal,
    input: {
      agentId: string
      sessionId: string
      provider: ChannelProviderId
      kind: ChannelInteractionRecord['kind']
      targetId: string
      externalInteractionId?: string | null
      createdByIdentityId?: string | null
      expiresAt?: Date | null
      interactionId?: string | null
      tokenSecret?: string | null
    },
  ): Promise<IssuedChannelInteractionRecord> {
    return interactionActions.createChannelInteraction(this.options, principal, input)
  }

  resolveChannelInteraction(
    principal: CloudPrincipal,
    input: ChannelInteractionResolutionInput,
  ): Promise<{ interaction: ChannelInteractionRecord, command: SessionCommandRecord, beforeProjectionSequence: number }> {
    return interactionActions.resolveChannelInteraction(this.options, principal, input)
  }

  createChannelDelivery(
    principal: CloudPrincipal,
    input: {
      agentId: string
      channelBindingId: string
      sessionBindingId?: string | null
      provider: ChannelProviderId
      target: Record<string, unknown>
      eventType: string
      payload: Record<string, unknown>
      status?: ChannelDeliveryRecord['status']
      nextAttemptAt?: Date | null
      deliveryId?: string | null
    },
  ): Promise<PublicChannelDeliveryRecord> {
    return deliveryActions.createChannelDelivery(this.options, principal, input)
  }

  listChannelDeliveries(
    principal: CloudPrincipal,
    input: {
      status?: ChannelDeliveryRecord['status'] | null
      channelBindingId?: string | null
      limit?: number | null
    } = {},
  ): Promise<PublicChannelDeliveryRecord[]> {
    return deliveryActions.listChannelDeliveries(this.options, principal, input)
  }

  retryChannelDelivery(principal: CloudPrincipal, deliveryId: string): Promise<PublicChannelDeliveryRecord | null> {
    return deliveryActions.retryChannelDelivery(this.options, principal, deliveryId)
  }

  deadLetterChannelDelivery(
    principal: CloudPrincipal,
    input: { deliveryId: string, lastError?: string | null },
  ): Promise<PublicChannelDeliveryRecord | null> {
    return deliveryActions.deadLetterChannelDelivery(this.options, principal, input)
  }

  claimNextChannelDelivery(
    principal: CloudPrincipal,
    input: { claimedBy: string, ttlMs?: number, now?: Date },
  ): Promise<ChannelDeliveryRecord | null> {
    return deliveryActions.claimNextChannelDelivery(this.options, principal, input)
  }

  ackChannelDelivery(
    principal: CloudPrincipal,
    input: {
      deliveryId: string
      claimedBy?: string | null
      status: Extract<ChannelDeliveryRecord['status'], 'sent' | 'failed' | 'dead'>
      lastError?: string | null
      nextAttemptAt?: Date | null
    },
  ): Promise<PublicChannelDeliveryRecord | null> {
    return deliveryActions.ackChannelDelivery(this.options, principal, input)
  }

  claimChannelProviderEvent(
    principal: CloudPrincipal,
    input: {
      provider: ChannelProviderId
      providerInstanceId: string
      externalWorkspaceId?: string | null
      providerEventId: string
      eventType: ChannelProviderEventType
      claimedBy: string
      ttlMs?: number | null
      metadata?: Record<string, unknown>
    },
  ): Promise<ChannelProviderEventClaimResult> {
    return providerEventActions.claimChannelProviderEvent(this.options, principal, input)
  }

  completeChannelProviderEvent(
    principal: CloudPrincipal,
    input: {
      eventId: string
      claimedBy: string
      status: Extract<ChannelProviderEventRecord['status'], 'processed' | 'failed'>
      retryable?: boolean
      lastError?: string | null
    },
  ): Promise<ChannelProviderEventRecord | null> {
    return providerEventActions.completeChannelProviderEvent(this.options, principal, input)
  }
}
