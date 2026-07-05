import type {
  ChannelProviderEventClaimResult,
  ChannelProviderEventRecord,
  ChannelProviderEventType,
  ChannelProviderId,
} from '../control-plane-store.ts'
import type { CloudPrincipal } from '../session-service.ts'
import {
  resolveGatewayChannelBindingForProviderScope,
  resolveGatewayChannelBindingScope,
} from './channel-binding-scope.ts'
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
    channelBindingId?: string | null
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
  const channelBinding = await resolveGatewayChannelBindingForProviderScope(options, principal, input, 'Provider event claim')
  await resolveGatewayChannelBindingScope(options, principal, [channelBinding.bindingId])
  return options.store.claimChannelProviderEvent({
    orgId: options.principalOrgId(principal),
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    channelBindingId: channelBinding.bindingId,
    externalWorkspaceId: input.externalWorkspaceId === undefined ? channelBinding.externalWorkspaceId : input.externalWorkspaceId,
    providerEventId: input.providerEventId,
    eventType: input.eventType,
    claimedBy: input.claimedBy,
    ttlMs: input.ttlMs || undefined,
    metadata: { ...(input.metadata || {}), channelBindingId: channelBinding.bindingId },
  })
}

export async function completeChannelProviderEvent(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    eventId: string
    channelBindingId?: string | null
    claimedBy: string
    status: Extract<ChannelProviderEventRecord['status'], 'processed' | 'failed'>
    retryable?: boolean
    lastError?: string | null
  },
): Promise<ChannelProviderEventRecord | null> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const scope = await resolveGatewayChannelBindingScope(
    options,
    principal,
    input.channelBindingId ? [input.channelBindingId] : null,
  )
  return options.store.completeChannelProviderEvent({
    orgId: options.principalOrgId(principal),
    eventId: input.eventId,
    channelBindingIds: scope.channelBindingIds,
    claimedBy: input.claimedBy,
    status: input.status,
    retryable: input.retryable,
    lastError: input.lastError,
  })
}
