import type { ChannelProvider, IncomingChannelMessage } from '@open-cowork/gateway-channel'
import type { CloudChannelProviderId } from '@open-cowork/cloud-client'

import type { CloudGateway } from './cloud-gateway.js'
import type { GatewayProviderConfig } from './config.js'
import type { GatewayMetrics } from './metrics.js'

export type RouteGatewayInteractionInput = {
  cloud: CloudGateway
  provider: ChannelProvider
  providerConfig: GatewayProviderConfig
  message: IncomingChannelMessage
  metrics: GatewayMetrics
}

export async function routeGatewayInteraction(input: RouteGatewayInteractionInput): Promise<boolean> {
  const interaction = input.message.interaction
  if (!interaction?.token) return false

  const cloudProvider = input.message.provider as CloudChannelProviderId
  await input.cloud.resolveChannelInteraction({
    provider: cloudProvider,
    externalWorkspaceId: input.providerConfig.externalWorkspaceId ?? null,
    externalUserId: input.message.sender.providerUserId,
    token: interaction.token,
    externalInteractionId: interaction.id,
    response: { allowed: true },
  })
  input.metrics.interactionsResolved += 1

  if (input.provider.answerInteraction) {
    try {
      await input.provider.answerInteraction(interaction.id, 'Approved')
    } catch {
      input.metrics.errors += 1
    }
  }
  return true
}
