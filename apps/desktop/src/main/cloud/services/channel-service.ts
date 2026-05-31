import type {
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
  bindChannelSession(principal: CloudPrincipal, input: Record<string, unknown>): Promise<{
    binding: ChannelSessionBindingRecord
    session: CloudSessionView
  }>
  getChannelSessionByThread(principal: CloudPrincipal, input: Record<string, unknown>): Promise<{
    binding: ChannelSessionBindingRecord
    session: CloudSessionView
  } | null>
  updateChannelCursor(principal: CloudPrincipal, input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }): Promise<ChannelSessionBindingRecord | null>
  enqueueChannelPrompt(principal: CloudPrincipal, input: Record<string, unknown>): Promise<{
    binding: ChannelSessionBindingRecord
    command: SessionCommandRecord
  }>
  createChannelInteraction(principal: CloudPrincipal, input: Record<string, unknown>): Promise<IssuedChannelInteractionRecord>
  resolveChannelInteraction(principal: CloudPrincipal, input: Record<string, unknown>): Promise<{
    interaction: ChannelInteractionRecord
    command: SessionCommandRecord
    processed: number
  }>
  createChannelDelivery(principal: CloudPrincipal, input: Record<string, unknown>): Promise<PublicChannelDeliveryRecord>
  listChannelDeliveries(principal: CloudPrincipal, input?: Record<string, unknown>): Promise<PublicChannelDeliveryRecord[]>
  retryChannelDelivery(principal: CloudPrincipal, deliveryId: string): Promise<PublicChannelDeliveryRecord | null>
  deadLetterChannelDelivery(principal: CloudPrincipal, deliveryId: string, input?: { lastError?: string | null }): Promise<PublicChannelDeliveryRecord | null>
  claimNextChannelDelivery(input: { orgId: string, claimedBy: string, now?: Date, ttlMs?: number }): Promise<ChannelDeliveryRecord | null>
  ackChannelDelivery(deliveryId: string, input: Record<string, unknown>): Promise<PublicChannelDeliveryRecord | null>
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
  bindSession(principal: CloudPrincipal, input: Record<string, unknown>) {
    return this.delegate.bindChannelSession(principal, input)
  }
  getSessionByThread(principal: CloudPrincipal, input: Record<string, unknown>) {
    return this.delegate.getChannelSessionByThread(principal, input)
  }
  updateCursor(principal: CloudPrincipal, input: Parameters<CloudChannelServiceDelegate['updateChannelCursor']>[1]) {
    return this.delegate.updateChannelCursor(principal, input)
  }
  enqueuePrompt(principal: CloudPrincipal, input: Record<string, unknown>) {
    return this.delegate.enqueueChannelPrompt(principal, input)
  }
  createInteraction(principal: CloudPrincipal, input: Record<string, unknown>) {
    return this.delegate.createChannelInteraction(principal, input)
  }
  resolveInteraction(principal: CloudPrincipal, input: Record<string, unknown>) {
    return this.delegate.resolveChannelInteraction(principal, input)
  }
  createDelivery(principal: CloudPrincipal, input: Record<string, unknown>) {
    return this.delegate.createChannelDelivery(principal, input)
  }
  listDeliveries(principal: CloudPrincipal, input?: Record<string, unknown>) {
    return this.delegate.listChannelDeliveries(principal, input)
  }
  retryDelivery(principal: CloudPrincipal, deliveryId: string) {
    return this.delegate.retryChannelDelivery(principal, deliveryId)
  }
  deadLetterDelivery(principal: CloudPrincipal, deliveryId: string, input?: { lastError?: string | null }) {
    return this.delegate.deadLetterChannelDelivery(principal, deliveryId, input)
  }
  claimNextDelivery(input: { orgId: string, claimedBy: string, now?: Date, ttlMs?: number }) {
    return this.delegate.claimNextChannelDelivery(input)
  }
  ackDelivery(deliveryId: string, input: Record<string, unknown>) {
    return this.delegate.ackChannelDelivery(deliveryId, input)
  }
}
