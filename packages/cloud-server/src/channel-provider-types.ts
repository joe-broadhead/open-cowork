export type ChannelProviderKind = 'telegram' | 'slack' | 'email' | 'discord' | 'whatsapp' | 'signal' | 'webhook' | 'cli'
export type ChannelProviderId = ChannelProviderKind | `${ChannelProviderKind}-${string}` | `${string}-${string}`
export type ChannelProviderEventType = 'message' | 'command' | 'interaction'
export type ChannelProviderEventStatus = 'received' | 'processing' | 'processed' | 'failed'

export type ChannelProviderEventRecord = {
  eventId: string
  orgId: string
  provider: ChannelProviderId
  providerInstanceId: string
  externalWorkspaceId: string | null
  providerEventId: string
  eventType: ChannelProviderEventType
  status: ChannelProviderEventStatus
  claimedBy: string | null
  claimExpiresAt: string | null
  attemptCount: number
  retryable: boolean
  lastError: string | null
  metadata: Record<string, unknown>
  processedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ChannelProviderEventClaimResult = {
  event: ChannelProviderEventRecord
  claimed: boolean
  duplicate: boolean
}

export type ClaimChannelProviderEventInput = {
  eventId?: string
  orgId: string
  provider: ChannelProviderId
  providerInstanceId: string
  channelBindingId?: string | null
  externalWorkspaceId?: string | null
  providerEventId: string
  eventType: ChannelProviderEventType
  claimedBy: string
  ttlMs?: number
  now?: Date
  metadata?: Record<string, unknown>
}

export type CompleteChannelProviderEventInput = {
  orgId: string
  eventId: string
  channelBindingIds?: readonly string[] | null
  claimedBy: string
  status: Extract<ChannelProviderEventStatus, 'processed' | 'failed'>
  retryable?: boolean
  lastError?: string | null
  updatedAt?: Date
}
