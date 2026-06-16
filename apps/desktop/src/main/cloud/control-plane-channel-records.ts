import type { ChannelProviderId } from './channel-provider-types.ts'
import type {
  ChannelBindingStatus,
  ChannelDeliveryStatus,
  ChannelIdentityRole,
  ChannelIdentityStatus,
  ChannelInteractionKind,
  ChannelInteractionStatus,
  ChannelSessionBindingStatus,
} from './control-plane-enums.ts'

// The control-plane's channel record shapes (bindings, identities, session
// bindings, interactions, deliveries), extracted from the 4k-line in-memory
// store. Pure types depending only on the channel enum vocabulary and the
// channel-provider id contract.

export type ChannelBindingRecord = {
  bindingId: string
  orgId: string
  agentId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  displayName: string
  status: ChannelBindingStatus
  credentialRef: string | null
  settings: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelIdentityRecord = {
  identityId: string
  orgId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  externalUserId: string
  accountId: string | null
  role: ChannelIdentityRole
  status: ChannelIdentityStatus
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export type ChannelSessionBindingRecord = {
  bindingId: string
  orgId: string
  agentId: string
  channelBindingId: string
  provider: ChannelProviderId
  externalWorkspaceId: string | null
  externalThreadId: string
  externalChatId: string
  sessionId: string
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId: string | null
  status: ChannelSessionBindingStatus
  createdAt: string
  updatedAt: string
}

export type ChannelInteractionRecord = {
  interactionId: string
  orgId: string
  agentId: string
  sessionId: string
  provider: ChannelProviderId
  externalInteractionId: string | null
  tokenHash: string
  kind: ChannelInteractionKind
  targetId: string
  status: ChannelInteractionStatus
  createdByIdentityId: string | null
  expiresAt: string
  usedAt: string | null
  createdAt: string
  updatedAt: string
}

export type IssuedChannelInteractionRecord = {
  interaction: ChannelInteractionRecord
  plaintextToken: string
}

export type ChannelDeliveryRecord = {
  deliveryId: string
  orgId: string
  agentId: string
  channelBindingId: string
  sessionBindingId: string | null
  provider: ChannelProviderId
  target: Record<string, unknown>
  eventType: string
  payload: Record<string, unknown>
  status: ChannelDeliveryStatus
  attemptCount: number
  claimedBy: string | null
  lastClaimedBy: string | null
  claimExpiresAt: string | null
  nextAttemptAt: string
  lastError: string | null
  createdAt: string
  updatedAt: string
}
