import type {
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderEventType,
  ChannelProviderId,
} from '../control-plane-store.ts'
import type { CloudPrincipal } from '../session-service.ts'
import {
  assertGatewayAccess,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export async function claimChannelProviderEvent(
  options: CloudChannelDomainServiceOptions,
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
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  return options.store.claimChannelProviderEvent({
    orgId: options.principalOrgId(principal),
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    externalWorkspaceId: input.externalWorkspaceId,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    claimedBy: input.claimedBy,
    ttlMs: input.ttlMs || undefined,
    metadata: input.metadata || {},
  })
}

export async function completeChannelProviderEvent(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    eventId: string
    claimedBy: string
    status: Extract<ChannelProviderEventRecord['status'], 'processed' | 'failed'>
    retryable?: boolean
    lastError?: string | null
  },
): Promise<ChannelProviderEventRecord | null> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  return options.store.completeChannelProviderEvent({
    orgId: options.principalOrgId(principal),
    eventId: input.eventId,
    claimedBy: input.claimedBy,
    status: input.status,
    retryable: input.retryable,
    lastError: input.lastError,
  })
}
