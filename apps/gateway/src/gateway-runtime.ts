import type {
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  SentMessage,
} from '@open-cowork/gateway-channel'
import type { ChannelDeliveryRecord, CloudChannelProviderId } from '@open-cowork/cloud-client'

import type { CloudGateway } from './cloud-gateway.js'
import type { GatewayConfig, GatewayProviderConfig } from './config.js'
import { routeGatewayInteraction } from './interaction-router.js'
import { createGatewayMetrics, type GatewayMetrics } from './metrics.js'
import { createGatewayProviderRegistry, type GatewayProviderRegistry, type ProviderRegistration } from './provider-registry.js'
import { createGatewaySessionStreamManager, type GatewaySessionStreamManager } from './session-stream-manager.js'

export type GatewayRuntime = {
  readonly metrics: GatewayMetrics
  readonly providers: GatewayProviderRegistry
  readonly streams: GatewaySessionStreamManager
  start(): Promise<void>
  stop(): Promise<void>
  ready(): boolean
}

export type GatewayRuntimeOptions = {
  subscribeDeliveries?: boolean
}

export function createGatewayRuntime(
  config: GatewayConfig,
  cloud: CloudGateway,
  providers = createGatewayProviderRegistry(config),
  options: GatewayRuntimeOptions = {},
): GatewayRuntime {
  const metrics = createGatewayMetrics()
  const streams = createGatewaySessionStreamManager(cloud, metrics)
  const deliverySubscriptions: Array<{ close(): void }> = []
  let started = false

  const runtime: GatewayRuntime = {
    metrics,
    providers,
    streams,
    async start() {
      if (started) return
      await providers.start((providerConfig, message) => handleMessage(providerConfig, message, cloud, providers, streams, metrics))
      started = true
      if (options.subscribeDeliveries !== false) {
        deliverySubscriptions.push(cloud.subscribeDeliveries({
          claimedBy: `gateway:${config.mode}`,
          onDelivery: (delivery) => {
            void handleDelivery(delivery, providers, cloud, metrics)
          },
          onError: () => {
            metrics.errors += 1
          },
        }))
      }
    },
    async stop() {
      streams.closeAll()
      for (const subscription of deliverySubscriptions.splice(0)) subscription.close()
      await providers.stop()
      started = false
    },
    ready() {
      return started && providers.registrations.every((provider) => provider.started)
    },
  }

  return runtime
}

async function handleMessage(
  providerConfig: GatewayProviderConfig,
  message: IncomingChannelMessage,
  cloud: CloudGateway,
  providers: GatewayProviderRegistry,
  streams: GatewaySessionStreamManager,
  metrics: GatewayMetrics,
) {
  metrics.incomingMessages += 1
  const provider = message.provider as CloudChannelProviderId
  const externalWorkspaceId = providerConfig.externalWorkspaceId ?? null
  const externalUserId = message.sender.providerUserId

  try {
    const registration = providers.get(providerConfig.id)
    if (!registration) throw new Error(`Unknown gateway provider ${providerConfig.id}.`)
    if (await routeGatewayInteraction({ cloud, provider: registration.provider, providerConfig, message, metrics })) {
      return
    }

    const text = message.text.trim()
    if (!text) return

    const identity = await cloud.resolveIdentity({
      provider,
      externalWorkspaceId,
      externalUserId,
      metadata: {
        username: message.sender.username,
        displayName: message.sender.displayName,
      },
    })
    const bound = await cloud.bindSession({
      identityId: identity.identityId,
      provider,
      externalWorkspaceId,
      externalUserId,
      channelBindingId: providerConfig.channelBindingId,
      externalChatId: message.target.chatId,
      externalThreadId: message.target.threadId || message.target.chatId,
      title: text.slice(0, 80),
    })
    streams.ensure({ binding: bound.binding, provider: registration.provider })
    await cloud.prompt({
      bindingId: bound.binding.bindingId,
      text,
      agent: providerConfig.defaultAgent,
      identityId: identity.identityId,
      provider,
      externalWorkspaceId,
      externalUserId,
    })
    metrics.promptedMessages += 1
  } catch (error) {
    metrics.errors += 1
    throw error
  }
}

async function handleDelivery(
  delivery: ChannelDeliveryRecord,
  providers: GatewayProviderRegistry,
  cloud: CloudGateway,
  metrics: GatewayMetrics,
) {
  metrics.deliveriesReceived += 1
  const registration = findDeliveryProvider(providers, delivery)
  if (!registration) {
    metrics.errors += 1
    await cloud.ackDelivery(delivery.deliveryId, {
      status: 'failed',
      claimedBy: delivery.claimedBy,
      lastError: `No provider registered for ${delivery.provider}.`,
    })
    return
  }

  try {
    await sendDelivery(registration.provider, delivery)
    await cloud.ackDelivery(delivery.deliveryId, {
      status: 'sent',
      claimedBy: delivery.claimedBy,
      lastError: null,
    })
  } catch (error) {
    metrics.errors += 1
    await cloud.ackDelivery(delivery.deliveryId, {
      status: 'failed',
      claimedBy: delivery.claimedBy,
      lastError: error instanceof Error ? error.message : String(error),
    })
  }
}

async function sendDelivery(provider: ChannelProvider, delivery: ChannelDeliveryRecord): Promise<SentMessage> {
  const target = readDeliveryTarget(delivery)
  const text = typeof delivery.payload.text === 'string'
    ? delivery.payload.text
    : typeof delivery.payload.message === 'string'
      ? delivery.payload.message
      : JSON.stringify(delivery.payload)
  return provider.sendText(target, text)
}

function findDeliveryProvider(providers: GatewayProviderRegistry, delivery: ChannelDeliveryRecord): ProviderRegistration | null {
  return providers.registrations.find((entry) => entry.config.channelBindingId === delivery.channelBindingId) || null
}

function readDeliveryTarget(delivery: ChannelDeliveryRecord): ChannelTarget {
  const target = delivery.target
  return {
    provider: delivery.provider as ChannelTarget['provider'],
    chatId: stringField(target.externalChatId) || stringField(target.chatId) || 'unknown',
    threadId: stringField(target.externalThreadId) || stringField(target.threadId),
    messageId: stringField(target.lastChatMessageId) || stringField(target.messageId),
    userId: stringField(target.externalUserId) || stringField(target.userId),
  }
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
