import type {
  ChannelActorInput,
  ChannelInteractionResolutionInput,
} from './channel-domain-context.ts'
import type {
  ChannelCursorUpdateResult,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelIdentityRole,
  ChannelIdentityStatus,
  ChannelInteractionRecord,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  HeadlessAgentRecord,
  IssuedChannelInteractionRecord,
  SessionCommandRecord,
} from '../control-plane-store.ts'
import type {
  CloudPrincipal,
  CloudSessionView,
  PublicChannelBindingRecord,
  PublicChannelDeliveryRecord,
} from '../session-service.ts'

export type CloudChannelServiceDelegate = {
  listHeadlessAgents(principal: CloudPrincipal): Promise<HeadlessAgentRecord[]>
  createHeadlessAgent(principal: CloudPrincipal, input: {
    agentId?: string | null
    name: string
    profileName?: string | null
    status?: 'active' | 'disabled'
    managed?: boolean
  }): Promise<HeadlessAgentRecord>
  updateHeadlessAgent(principal: CloudPrincipal, agentId: string, input: {
    name?: string
    profileName?: string
    status?: 'active' | 'disabled'
    managed?: boolean
  }): Promise<HeadlessAgentRecord | null>
  listChannelBindings(principal: CloudPrincipal, agentId?: string | null): Promise<PublicChannelBindingRecord[]>
  createChannelBinding(principal: CloudPrincipal, input: {
    bindingId?: string | null
    agentId: string
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    displayName: string
    status?: 'active' | 'disabled' | 'auth_required' | 'error'
    credentialRef?: string | null
    settings?: Record<string, unknown>
  }): Promise<PublicChannelBindingRecord>
  updateChannelBinding(principal: CloudPrincipal, bindingId: string, input: {
    displayName?: string
    status?: 'active' | 'disabled' | 'auth_required' | 'error'
    credentialRef?: string | null
    settings?: Record<string, unknown>
  }): Promise<PublicChannelBindingRecord | null>
  resolveChannelIdentity(principal: CloudPrincipal, input: {
    identityId?: string | null
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalUserId: string
    accountId?: string | null
    role?: ChannelIdentityRole
    status?: ChannelIdentityStatus
    metadata?: Record<string, unknown>
  }): Promise<ChannelIdentityRecord>
  bindChannelSession(principal: CloudPrincipal, input: ChannelActorInput & {
    channelBindingId: string
    provider: ChannelProviderId
    externalChatId: string
    externalThreadId: string
    sessionId?: string | null
    title?: string | null
    lastEventSequence?: number
    lastWorkspaceSequence?: number
    lastChatMessageId?: string | null
  }): Promise<{
    binding: ChannelSessionBindingRecord
    session: CloudSessionView
  }>
  getChannelSessionByThread(principal: CloudPrincipal, input: {
    provider: ChannelProviderId
    externalWorkspaceId?: string | null
    externalChatId: string
    externalThreadId: string
  }): Promise<{
    binding: ChannelSessionBindingRecord
    session: CloudSessionView
  } | null>
  updateChannelCursor(principal: CloudPrincipal, input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelCursorUpdateResult>
  enqueueChannelPrompt(principal: CloudPrincipal, input: ChannelActorInput & {
    bindingId: string
    text: string
    agent?: string | null
  }): Promise<{
    binding: ChannelSessionBindingRecord
    command: SessionCommandRecord
    beforeProjectionSequence: number
  }>
  createChannelInteraction(principal: CloudPrincipal, input: {
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
  }): Promise<IssuedChannelInteractionRecord>
  resolveChannelInteraction(principal: CloudPrincipal, input: ChannelInteractionResolutionInput): Promise<{
    interaction: ChannelInteractionRecord
    command: SessionCommandRecord
    beforeProjectionSequence: number
  }>
  createChannelDelivery(principal: CloudPrincipal, input: {
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
  }): Promise<PublicChannelDeliveryRecord>
  listChannelDeliveries(principal: CloudPrincipal, input?: {
    status?: ChannelDeliveryRecord['status'] | null
    channelBindingId?: string | null
    limit?: number | null
  }): Promise<PublicChannelDeliveryRecord[]>
  retryChannelDelivery(principal: CloudPrincipal, deliveryId: string): Promise<PublicChannelDeliveryRecord | null>
  deadLetterChannelDelivery(principal: CloudPrincipal, input: { deliveryId: string, lastError?: string | null }): Promise<PublicChannelDeliveryRecord | null>
  claimNextChannelDelivery(principal: CloudPrincipal, input: { claimedBy: string, now?: Date, ttlMs?: number }): Promise<ChannelDeliveryRecord | null>
  ackChannelDelivery(principal: CloudPrincipal, input: {
    deliveryId: string
    claimedBy?: string | null
    status: Extract<ChannelDeliveryRecord['status'], 'sent' | 'failed' | 'dead'>
    lastError?: string | null
    nextAttemptAt?: Date | null
  }): Promise<PublicChannelDeliveryRecord | null>
}

export class CloudChannelService {
  private readonly delegate: CloudChannelServiceDelegate

  constructor(delegate: CloudChannelServiceDelegate) {
    this.delegate = delegate
  }

  listAgents(principal: CloudPrincipal) { return this.delegate.listHeadlessAgents(principal) }
  createAgent(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['createHeadlessAgent']>[1]) {
    return this.delegate.createHeadlessAgent(principal, input)
  }
  updateAgent(principal: CloudPrincipal, agentId: string, input: Parameters<CloudChannelServiceDelegate['updateHeadlessAgent']>[2]) {
    return this.delegate.updateHeadlessAgent(principal, agentId, input)
  }
  listBindings(principal: CloudPrincipal, agentId?: string | null) {
    return this.delegate.listChannelBindings(principal, agentId)
  }
  createBinding(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['createChannelBinding']>[1]) {
    return this.delegate.createChannelBinding(principal, input)
  }
  updateBinding(principal: CloudPrincipal, bindingId: string, input: Parameters<CloudChannelServiceDelegate['updateChannelBinding']>[2]) {
    return this.delegate.updateChannelBinding(principal, bindingId, input)
  }
  resolveIdentity(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['resolveChannelIdentity']>[1]) {
    return this.delegate.resolveChannelIdentity(principal, input)
  }
  bindSession(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['bindChannelSession']>[1]) {
    return this.delegate.bindChannelSession(principal, input)
  }
  getSessionByThread(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['getChannelSessionByThread']>[1]) {
    return this.delegate.getChannelSessionByThread(principal, input)
  }
  updateCursor(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['updateChannelCursor']>[1]) {
    return this.delegate.updateChannelCursor(principal, input)
  }
  enqueuePrompt(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['enqueueChannelPrompt']>[1]) {
    return this.delegate.enqueueChannelPrompt(principal, input)
  }
  createInteraction(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['createChannelInteraction']>[1]) {
    return this.delegate.createChannelInteraction(principal, input)
  }
  resolveInteraction(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['resolveChannelInteraction']>[1]) {
    return this.delegate.resolveChannelInteraction(principal, input)
  }
  createDelivery(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['createChannelDelivery']>[1]) {
    return this.delegate.createChannelDelivery(principal, input)
  }
  listDeliveries(principal: CloudPrincipal, input?: Parameters<CloudChannelServiceDelegate['listChannelDeliveries']>[1]) {
    return this.delegate.listChannelDeliveries(principal, input)
  }
  retryDelivery(principal: CloudPrincipal, deliveryId: string) {
    return this.delegate.retryChannelDelivery(principal, deliveryId)
  }
  deadLetterDelivery(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['deadLetterChannelDelivery']>[1]) {
    return this.delegate.deadLetterChannelDelivery(principal, input)
  }
  claimNextDelivery(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['claimNextChannelDelivery']>[1]) {
    return this.delegate.claimNextChannelDelivery(principal, input)
  }
  ackDelivery(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['ackChannelDelivery']>[1]) {
    return this.delegate.ackChannelDelivery(principal, input)
  }
}
