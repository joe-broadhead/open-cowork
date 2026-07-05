import type {
  ChannelBindingRecord,
  ChannelDeliveryRecord,
  ChannelIdentityRecord,
  ChannelInteractionRecord,
  ChannelProviderEventRecord,
  ChannelProviderId,
  ChannelSessionBindingRecord,
  HeadlessAgentRecord,
} from '../control-plane-store.ts'
import { iso, isoOrNull, jsonRecord, numberValue, stringOrNull, type QueryRow } from './shared.ts'

export function headlessAgentFromRow(row: QueryRow): HeadlessAgentRecord {
  return {
    agentId: String(row.agent_id),
    orgId: String(row.org_id),
    tenantId: String(row.tenant_id),
    profileName: String(row.profile_name),
    name: String(row.name),
    status: String(row.status) as HeadlessAgentRecord['status'],
    managed: row.managed === true,
    createdByAccountId: stringOrNull(row.created_by_account_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function channelBindingFromRow(row: QueryRow): ChannelBindingRecord {
  return {
    bindingId: String(row.binding_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    provider: String(row.provider) as ChannelProviderId,
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    displayName: String(row.display_name),
    status: String(row.status) as ChannelBindingRecord['status'],
    credentialRef: stringOrNull(row.credential_ref),
    settings: jsonRecord(row.settings),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function channelIdentityFromRow(row: QueryRow): ChannelIdentityRecord {
  return {
    identityId: String(row.identity_id),
    orgId: String(row.org_id),
    provider: String(row.provider) as ChannelProviderId,
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    externalUserId: String(row.external_user_id),
    accountId: stringOrNull(row.account_id),
    role: String(row.role) as ChannelIdentityRecord['role'],
    status: String(row.status) as ChannelIdentityRecord['status'],
    metadata: jsonRecord(row.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function channelSessionBindingFromRow(row: QueryRow): ChannelSessionBindingRecord {
  return {
    bindingId: String(row.binding_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    channelBindingId: String(row.channel_binding_id),
    provider: String(row.provider) as ChannelProviderId,
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    externalThreadId: String(row.external_thread_id),
    externalChatId: String(row.external_chat_id),
    sessionId: String(row.session_id),
    lastEventSequence: numberValue(row.last_event_sequence),
    lastWorkspaceSequence: numberValue(row.last_workspace_sequence),
    lastChatMessageId: stringOrNull(row.last_chat_message_id),
    status: String(row.status) as ChannelSessionBindingRecord['status'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function channelInteractionFromRow(row: QueryRow): ChannelInteractionRecord {
  return {
    interactionId: String(row.interaction_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    sessionId: String(row.session_id),
    provider: String(row.provider) as ChannelProviderId,
    externalInteractionId: stringOrNull(row.external_interaction_id),
    tokenHash: String(row.token_hash),
    kind: String(row.kind) as ChannelInteractionRecord['kind'],
    targetId: String(row.target_id),
    status: String(row.status) as ChannelInteractionRecord['status'],
    createdByIdentityId: stringOrNull(row.created_by_identity_id),
    expiresAt: iso(row.expires_at),
    usedAt: isoOrNull(row.used_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function channelDeliveryFromRow(row: QueryRow): ChannelDeliveryRecord {
  return {
    deliveryId: String(row.delivery_id),
    orgId: String(row.org_id),
    agentId: String(row.agent_id),
    channelBindingId: String(row.channel_binding_id),
    sessionBindingId: stringOrNull(row.session_binding_id),
    provider: String(row.provider) as ChannelProviderId,
    target: jsonRecord(row.target),
    eventType: String(row.event_type),
    payload: jsonRecord(row.payload),
    status: String(row.status) as ChannelDeliveryRecord['status'],
    attemptCount: numberValue(row.attempt_count),
    claimedBy: stringOrNull(row.claimed_by),
    lastClaimedBy: stringOrNull(row.last_claimed_by),
    claimExpiresAt: isoOrNull(row.claim_expires_at),
    nextAttemptAt: iso(row.next_attempt_at),
    lastError: stringOrNull(row.last_error),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

export function channelProviderEventFromRow(row: QueryRow): ChannelProviderEventRecord {
  return {
    eventId: String(row.event_id),
    orgId: String(row.org_id),
    provider: String(row.provider) as ChannelProviderId,
    providerInstanceId: String(row.provider_instance_id),
    externalWorkspaceId: stringOrNull(row.external_workspace_id),
    providerEventId: String(row.provider_event_id),
    eventType: String(row.event_type) as ChannelProviderEventRecord['eventType'],
    status: String(row.status) as ChannelProviderEventRecord['status'],
    claimedBy: stringOrNull(row.claimed_by),
    claimExpiresAt: isoOrNull(row.claim_expires_at),
    attemptCount: numberValue(row.attempt_count),
    retryable: row.retryable === true,
    lastError: stringOrNull(row.last_error),
    metadata: jsonRecord(row.metadata),
    processedAt: isoOrNull(row.processed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}
