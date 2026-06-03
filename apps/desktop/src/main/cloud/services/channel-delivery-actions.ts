import { CloudServiceError } from '../cloud-service-error.ts'
import type {
  ChannelDeliveryRecord,
  ChannelProviderId,
} from '../control-plane-store.ts'
import {
  publicChannelDelivery,
  type PublicChannelDeliveryRecord,
} from '../public-channel-records.ts'
import type { CloudPrincipal } from '../session-service.ts'
import {
  assertChannelSetupAllowed,
  assertGatewayAccess,
  CHANNEL_HOUR_MS,
  type CloudChannelDomainServiceOptions,
} from './channel-domain-context.ts'

export async function createChannelDelivery(
  options: CloudChannelDomainServiceOptions,
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
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const orgId = options.principalOrgId(principal)
  const agent = await options.store.getHeadlessAgent(orgId, input.agentId)
  if (!agent) throw new CloudServiceError(404, 'Headless agent was not found.')
  const channelBinding = await options.store.getChannelBinding(orgId, input.channelBindingId)
  if (!channelBinding) throw new CloudServiceError(404, 'Channel binding was not found.')
  if (channelBinding.agentId !== agent.agentId) {
    throw new CloudServiceError(403, 'Channel delivery binding does not belong to the selected headless agent.')
  }
  if (channelBinding.provider !== input.provider) {
    throw new CloudServiceError(400, 'Channel delivery provider does not match the channel binding.')
  }
  if (input.sessionBindingId) {
    const sessionBinding = await options.store.getChannelSessionBinding(orgId, input.sessionBindingId)
    if (!sessionBinding) throw new CloudServiceError(404, 'Channel session binding was not found.')
    if (
      sessionBinding.agentId !== agent.agentId
      || sessionBinding.channelBindingId !== channelBinding.bindingId
      || sessionBinding.provider !== input.provider
    ) {
      throw new CloudServiceError(403, 'Channel delivery session binding does not belong to the selected channel binding.')
    }
  }
  const delivery = await options.store.createChannelDelivery({
    deliveryId: input.deliveryId || options.ids.randomUUID(),
    orgId,
    agentId: agent.agentId,
    channelBindingId: channelBinding.bindingId,
    sessionBindingId: input.sessionBindingId,
    provider: input.provider,
    target: input.target,
    eventType: input.eventType,
    payload: input.payload,
    status: input.status,
    nextAttemptAt: input.nextAttemptAt || undefined,
  })
  return publicChannelDelivery(delivery)
}

export async function listChannelDeliveries(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    status?: ChannelDeliveryRecord['status'] | null
    channelBindingId?: string | null
    limit?: number | null
  } = {},
): Promise<PublicChannelDeliveryRecord[]> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  return (await options.store.listChannelDeliveries({
    orgId: options.principalOrgId(principal),
    status: input.status || null,
    channelBindingId: input.channelBindingId || null,
    limit: input.limit || null,
  })).map(publicChannelDelivery)
}

export async function retryChannelDelivery(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  deliveryId: string,
): Promise<PublicChannelDeliveryRecord | null> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  const delivery = await options.store.ackChannelDelivery({
    orgId: options.principalOrgId(principal),
    deliveryId,
    status: 'failed',
    lastError: null,
    nextAttemptAt: new Date(),
  })
  return delivery ? publicChannelDelivery(delivery) : null
}

export async function deadLetterChannelDelivery(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: { deliveryId: string, lastError?: string | null },
): Promise<PublicChannelDeliveryRecord | null> {
  await options.ensurePrincipal(principal)
  assertChannelSetupAllowed(principal)
  const delivery = await options.store.ackChannelDelivery({
    orgId: options.principalOrgId(principal),
    deliveryId: input.deliveryId,
    status: 'dead',
    lastError: input.lastError || 'Manually dead-lettered by gateway operator.',
    nextAttemptAt: null,
  })
  return delivery ? publicChannelDelivery(delivery) : null
}

export async function claimNextChannelDelivery(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: { claimedBy: string, ttlMs?: number, now?: Date },
): Promise<ChannelDeliveryRecord | null> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  try {
    const gatewayDeliveryLimit = await options.usageGovernance.effectiveQuotaLimit(
      options.principalOrgId(principal),
      options.abuse.maxGatewayDeliveriesPerHour,
      'maxGatewayDeliveriesPerHour',
    )
    const delivery = await options.store.claimNextChannelDelivery({
      orgId: options.principalOrgId(principal),
      claimedBy: input.claimedBy,
      ttlMs: input.ttlMs,
      now: input.now,
      quota: options.usageGovernance.quotaLimit(gatewayDeliveryLimit)
        ? {
            quotaKey: 'gateway_deliveries:hour',
            limit: gatewayDeliveryLimit!,
            windowMs: CHANNEL_HOUR_MS,
            policyCode: 'quota.gateway_deliveries_per_hour_exceeded',
          }
        : null,
    })
    if (delivery) {
      await options.usageGovernance.recordUsage({
        orgId: options.principalOrgId(principal),
        accountId: principal.accountId || null,
        eventType: 'gateway.delivery.claimed',
        unit: 'count',
        metadata: {
          deliveryId: delivery.deliveryId,
          provider: delivery.provider,
          claimedBy: input.claimedBy,
        },
      })
    }
    return delivery
  } catch (error) {
    options.usageGovernance.translateQuotaError(error, 'Gateway delivery quota exceeded.', 'quota.gateway_deliveries_per_hour_exceeded')
  }
}

export async function ackChannelDelivery(
  options: CloudChannelDomainServiceOptions,
  principal: CloudPrincipal,
  input: {
    deliveryId: string
    claimedBy?: string | null
    status: Extract<ChannelDeliveryRecord['status'], 'sent' | 'failed' | 'dead'>
    lastError?: string | null
    nextAttemptAt?: Date | null
  },
): Promise<PublicChannelDeliveryRecord | null> {
  await options.ensurePrincipal(principal)
  assertGatewayAccess(principal)
  const delivery = await options.store.ackChannelDelivery({
    orgId: options.principalOrgId(principal),
    deliveryId: input.deliveryId,
    claimedBy: input.claimedBy,
    status: input.status,
    lastError: input.lastError,
    nextAttemptAt: input.nextAttemptAt,
  })
  return delivery ? publicChannelDelivery(delivery) : null
}
