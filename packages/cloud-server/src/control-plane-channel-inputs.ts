import type { ChannelProviderId } from './channel-provider-types.ts'
import type {
  ChannelBindingStatus,
  ChannelDeliveryStatus,
  ChannelIdentityRole,
  ChannelIdentityStatus,
  ChannelInteractionKind,
  ChannelSessionBindingStatus,
} from './control-plane-enums.ts'
import type { ChannelSessionBindingRecord } from './control-plane-channel-records.ts'
import type { AuditActorInput } from './control-plane-account-inputs.ts'
import type { ConsumeUsageQuotaInput } from './control-plane-usage-inputs.ts'
import type { EnqueueCommandInput } from './control-plane-event-inputs.ts'

// The control-plane's channel operation input shapes (bindings, identities,
// session bindings, cursors, interactions, deliveries), extracted from the
// 4k-line in-memory store. Pure types depending only on the channel enum
// vocabulary, the channel-provider id, the channel session-binding record, and
// the audit-actor / usage-quota / command-enqueue input contracts.

export type CreateChannelBindingInput = {
  bindingId: string
  orgId: string
  agentId: string
  provider: ChannelProviderId
  externalWorkspaceId?: string | null
  displayName: string
  status?: ChannelBindingStatus
  credentialRef?: string | null
  settings?: Record<string, unknown>
  createdAt?: Date
  quota?: {
    maxGatewayChannelBindingsPerOrg?: number | null
    policyCode?: string
  } | null
}

export type UpdateChannelBindingInput = {
  orgId: string
  bindingId: string
  displayName?: string
  status?: ChannelBindingStatus
  credentialRef?: string | null
  settings?: Record<string, unknown>
  updatedAt?: Date
  actor?: AuditActorInput
}

export type UpsertChannelIdentityInput = {
  identityId?: string
  orgId: string
  provider: ChannelProviderId
  externalWorkspaceId?: string | null
  externalUserId: string
  accountId?: string | null
  role?: ChannelIdentityRole
  status?: ChannelIdentityStatus
  metadata?: Record<string, unknown>
  updatedAt?: Date
}

export type ListChannelIdentitiesInput = {
  provider?: ChannelProviderId | null
  externalWorkspaceId?: string | null
  role?: ChannelIdentityRole | null
  status?: ChannelIdentityStatus | null
  limit?: number | null
}

export type BindChannelSessionInput = {
  bindingId: string
  orgId: string
  agentId: string
  channelBindingId: string
  provider: ChannelProviderId
  externalWorkspaceId?: string | null
  externalThreadId: string
  externalChatId: string
  sessionId: string
  lastEventSequence?: number
  lastWorkspaceSequence?: number
  lastChatMessageId?: string | null
  status?: ChannelSessionBindingStatus
  createdAt?: Date
}

export type UpdateChannelCursorInput = {
  orgId: string
  bindingId: string
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId?: string | null
  updatedAt?: Date
}

export type ChannelCursorUpdateResult = { ok: true, binding: ChannelSessionBindingRecord } | { ok: false, reason: 'stale', binding: ChannelSessionBindingRecord } | { ok: false, reason: 'not_found' }

export type CreateChannelInteractionInput = {
  interactionId: string
  orgId: string
  agentId: string
  sessionId: string
  provider: ChannelProviderId
  externalInteractionId?: string | null
  kind: ChannelInteractionKind
  targetId: string
  createdByIdentityId?: string | null
  expiresAt: Date
  tokenSecret?: string
  createdAt?: Date
}

export type ResolveChannelInteractionInput = {
  orgId: string
  token?: string | null
  externalInteractionId?: string | null
  provider?: ChannelProviderId | null
  identityId: string
  usedAt?: Date
}

export type FindChannelInteractionInput = Omit<ResolveChannelInteractionInput, 'identityId' | 'usedAt'> & {
  now?: Date
}

export type ResolveChannelInteractionWithCommandInput = ResolveChannelInteractionInput & {
  command: EnqueueCommandInput
}

export type CreateChannelDeliveryInput = {
  deliveryId: string
  orgId: string
  agentId: string
  channelBindingId: string
  sessionBindingId?: string | null
  provider: ChannelProviderId
  target: Record<string, unknown>
  eventType: string
  payload: Record<string, unknown>
  status?: ChannelDeliveryStatus
  nextAttemptAt?: Date
  createdAt?: Date
}

export type ClaimChannelDeliveryInput = {
  orgId: string
  claimedBy: string
  lastClaimedBy?: string | null
  channelBindingIds?: readonly string[] | null
  now?: Date
  ttlMs?: number
  quota?: Omit<ConsumeUsageQuotaInput, 'orgId'> | null
}

export type AckChannelDeliveryInput = {
  orgId: string
  deliveryId: string
  channelBindingIds?: readonly string[] | null
  claimedBy?: string | null
  lastClaimedBy?: string | null
  status: Extract<ChannelDeliveryStatus, 'sent' | 'failed' | 'dead'>
  lastError?: string | null
  nextAttemptAt?: Date | null
  updatedAt?: Date
}

export type ListChannelDeliveriesInput = {
  orgId: string
  deliveryId?: string | null
  status?: ChannelDeliveryStatus | null
  channelBindingId?: string | null
  channelBindingIds?: readonly string[] | null
  lastClaimedBy?: string | null
  limit?: number | null
}
