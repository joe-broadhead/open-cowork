export const COWORK_CHANNEL_SCHEMA_VERSION = 1
export const COWORK_CHANNEL_DELIVERY_SCHEMA_VERSION = 1

export type ChannelProvider = 'local_webhook' | 'email' | 'slack' | 'teams'
export type ChannelActivationMode = 'ignore' | 'draft_reply' | 'ask_user' | 'run_sop' | 'run_crew'
export type ChannelInboundStatus = 'denied' | 'received' | 'drafted' | 'needs_user' | 'queued' | 'dispatching' | 'dispatched' | 'failed'
export type ChannelAuditState =
  | 'denied_unknown_sender'
  | 'denied_channel_disabled'
  | 'ignored'
  | 'draft_created'
  | 'user_review_required'
  | 'queued_for_review'
  | 'execution_dispatching'
  | 'execution_dispatched'
  | 'dismissed'
  | 'failed'
export type ChannelDeliveryProvider = 'desktop_notification' | 'email' | 'slack' | 'teams' | 'webhook'
export type ChannelDeliveryStatus = 'draft' | 'approval_required' | 'sending' | 'delivered' | 'failed' | 'cancelled'

export interface ChannelSchemaVersionedRecord {
  schemaVersion: number
}

export interface ChannelRoutePolicy extends ChannelSchemaVersionedRecord {
  activationMode: ChannelActivationMode
  targetSopId: string | null
  targetCrewId: string | null
}

export interface ChannelDefinition extends ChannelSchemaVersionedRecord {
  id: string
  provider: ChannelProvider
  name: string
  description: string | null
  sourceKey: string
  enabled: boolean
  senderAllowlist: string[]
  allowedCapabilityIds: string[]
  route: ChannelRoutePolicy
  workspaceProfileId: string
  createdAt: string
  updatedAt: string
}

export interface ChannelDefinitionDraft {
  provider: ChannelProvider
  name: string
  description?: string | null
  sourceKey: string
  enabled?: boolean
  senderAllowlist: string[]
  allowedCapabilityIds?: string[]
  route: {
    activationMode: ChannelActivationMode
    targetSopId?: string | null
    targetCrewId?: string | null
  }
  workspaceProfileId?: string | null
}

export interface LocalWebhookChannelPairing extends ChannelSchemaVersionedRecord {
  channelId: string
  sourceKey: string
  tokenPrefix: string
  createdAt: string
  rotatedAt: string
}

export interface LocalWebhookChannelPairingResult {
  channel: ChannelDefinition
  pairing: LocalWebhookChannelPairing
  token: string
}

export interface LocalWebhookReceiverStatus extends ChannelSchemaVersionedRecord {
  enabled: boolean
  listening: boolean
  host: string
  port: number | null
  url: string | null
  pairedChannels: number
  lastError: string | null
}

export interface ChannelInboundSource extends ChannelSchemaVersionedRecord {
  provider: ChannelProvider
  sourceKey: string
  externalMessageId: string | null
}

export interface ChannelInboundItem extends ChannelSchemaVersionedRecord {
  id: string
  channelId: string
  provider: ChannelProvider
  source: ChannelInboundSource
  sender: string
  subject: string | null
  body: string
  route: ChannelRoutePolicy
  status: ChannelInboundStatus
  auditState: ChannelAuditState
  allowedCapabilityIds: string[]
  workspaceProfileId: string
  queueItemId: string | null
  deliveryRecordId: string | null
  workItemId: string | null
  runKind: 'sop' | 'crew' | null
  runId: string | null
  approvedAt: string | null
  approvedBy: string | null
  reviewNote: string | null
  receivedAt: string
  updatedAt: string
  error: string | null
}

export interface ChannelInboundDraft {
  channelId: string
  sender: string
  subject?: string | null
  body: string
  externalMessageId?: string | null
  replyTarget?: string | null
  receivedAt?: string | null
}

export interface ChannelDeliveryRecord extends ChannelSchemaVersionedRecord {
  id: string
  channelId: string
  inboundItemId: string | null
  provider: ChannelDeliveryProvider
  target: string
  status: ChannelDeliveryStatus
  title: string
  body: string
  draftFirst: boolean
  workItemId: string | null
  runKind: 'crew' | 'sop' | 'automation' | 'channel' | null
  runId: string | null
  artifactIds: string[]
  policyDecisionIds: string[]
  approvalIds: string[]
  createdAt: string
  updatedAt: string
  error: string | null
}

export interface ChannelDeliveryDraft {
  channelId: string
  inboundItemId?: string | null
  provider: ChannelDeliveryProvider
  target: string
  status?: ChannelDeliveryStatus
  title: string
  body: string
  draftFirst?: boolean
  workItemId?: string | null
  runKind?: ChannelDeliveryRecord['runKind']
  runId?: string | null
  artifactIds?: string[]
  policyDecisionIds?: string[]
  approvalIds?: string[]
  error?: string | null
}

export interface ChannelListPayload {
  channels: ChannelDefinition[]
  inboundItems: ChannelInboundItem[]
  deliveries: ChannelDeliveryRecord[]
}
