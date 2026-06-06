import type {
  ChannelProvider,
  ChannelTarget,
  IncomingChannelMessage,
  SentMessage,
} from '@open-cowork/gateway-channel'
import { chunkText } from '@open-cowork/gateway-channel'
import { isCloudTransportError, type ChannelDeliveryRecord, type CloudChannelProviderId } from '@open-cowork/cloud-client'

import type { CloudGateway } from './cloud-gateway.js'
import type { GatewayConfig, GatewayProviderConfig } from './config.js'
import { routeGatewayInteraction } from './interaction-router.js'
import { createGatewayMetrics, type GatewayMetrics } from './metrics.js'
import { classifyProviderFailure } from './provider-errors.js'
import { createGatewayProviderRegistry, type GatewayProviderRegistry, type ProviderRegistration } from './provider-registry.js'
import { createGatewaySessionStreamManager, type GatewaySessionStreamManager } from './session-stream-manager.js'

const MAX_DELIVERY_ATTEMPTS = 5
const PROVIDER_EVENT_CLAIM_TTL_MS = 5 * 60_000

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
  const claimedBy = `gateway:${config.instanceId}`
  const deliverySubscriptions: Array<{ close(): void }> = []
  const inFlightDeliveries = new Set<Promise<void>>()
  let started = false

  const runtime: GatewayRuntime = {
    metrics,
    providers,
    streams,
    async start() {
      if (started) return
      await providers.start((providerConfig, message) => handleMessage(providerConfig, message, cloud, providers, streams, metrics, claimedBy))
      started = true
      if (options.subscribeDeliveries !== false) {
        deliverySubscriptions.push(cloud.subscribeDeliveries({
          claimedBy,
          onDelivery: (delivery) => {
            const task = handleDelivery(delivery, providers, cloud, metrics)
              .finally(() => {
                inFlightDeliveries.delete(task)
              })
            inFlightDeliveries.add(task)
          },
          onError: () => {
            metrics.cloudSubscriptionErrors += 1
            metrics.errors += 1
          },
        }))
      }
    },
    async stop() {
      for (const subscription of deliverySubscriptions.splice(0)) subscription.close()
      streams.closeAll()
      if (inFlightDeliveries.size > 0) {
        await settleWithin(Promise.allSettled([...inFlightDeliveries]), config.timeouts.shutdownDrainMs)
      }
      await providers.stop()
      started = false
    },
    ready() {
      return started && providers.registrations.every((registration) => {
        const health = registration.provider.health?.()
        registration.healthy = health?.ok ?? registration.healthy
        registration.lastError = health?.error || null
        return registration.started && registration.healthy
      })
    },
  }

  return runtime
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs)
        timeout.unref?.()
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function handleMessage(
  providerConfig: GatewayProviderConfig,
  message: IncomingChannelMessage,
  cloud: CloudGateway,
  providers: GatewayProviderRegistry,
  streams: GatewaySessionStreamManager,
  metrics: GatewayMetrics,
  claimedBy: string,
) {
  metrics.incomingMessages += 1
  const provider = message.provider as CloudChannelProviderId
  const externalWorkspaceId = providerConfig.externalWorkspaceId ?? null
  const externalUserId = message.sender.providerUserId
  let claimedEvent: { eventId: string } | null = null
  let sideEffectCommitted = false

  try {
    const registration = providers.get(providerConfig.id)
    if (!registration) throw new Error(`Unknown gateway provider ${providerConfig.id}.`)
    const eventClaim = await cloud.claimProviderEvent({
      provider,
      providerInstanceId: providerConfig.id,
      externalWorkspaceId,
      providerEventId: providerEventIdForMessage(message),
      eventType: providerEventTypeForMessage(message),
      claimedBy,
      ttlMs: PROVIDER_EVENT_CLAIM_TTL_MS,
      metadata: providerEventMetadata(message, providerConfig),
    })
    if (!eventClaim.claimed) return
    claimedEvent = { eventId: eventClaim.event.eventId }

    if (await routeGatewayInteraction({ cloud, provider: registration.provider, providerConfig, message, metrics })) {
      sideEffectCommitted = true
      await cloud.completeProviderEvent(claimedEvent.eventId, {
        claimedBy,
        status: 'processed',
      })
      return
    }

    const text = message.text.trim()
    if (!text) {
      await cloud.completeProviderEvent(claimedEvent.eventId, {
        claimedBy,
        status: 'processed',
      })
      return
    }

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
      commandId: claimedEvent.eventId,
      identityId: identity.identityId,
      provider,
      externalWorkspaceId,
      externalUserId,
    })
    sideEffectCommitted = true
    metrics.promptedMessages += 1
    await cloud.completeProviderEvent(claimedEvent.eventId, {
      claimedBy,
      status: 'processed',
    })
  } catch (error) {
    if (claimedEvent && !sideEffectCommitted) {
      await cloud.completeProviderEvent(claimedEvent.eventId, {
        claimedBy,
        status: 'failed',
        retryable: providerEventFailureIsRetryable(error),
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
    }
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
  const startedAt = Date.now()
  metrics.deliveriesReceived += 1
  const registration = findDeliveryProvider(providers, delivery)
  if (!registration) {
    metrics.errors += 1
    metrics.deliveryDeadLetters += 1
    await cloud.ackDelivery(delivery.deliveryId, {
      status: 'dead',
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
    metrics.deliveriesSent += 1
    metrics.deliveryLatencyMsTotal += Math.max(0, Date.now() - startedAt)
  } catch (error) {
    metrics.errors += 1
    const failure = classifyProviderFailure(error)
    const shouldRetry = failure.transient && delivery.attemptCount < MAX_DELIVERY_ATTEMPTS
    if (shouldRetry) metrics.deliveryRetries += 1
    else metrics.deliveryDeadLetters += 1
    await cloud.ackDelivery(delivery.deliveryId, {
      status: shouldRetry ? 'failed' : 'dead',
      claimedBy: delivery.claimedBy,
      lastError: failure.message,
      nextAttemptAt: shouldRetry ? new Date(Date.now() + deliveryRetryDelayMs(delivery.attemptCount)).toISOString() : null,
    })
  }
}

async function sendDelivery(provider: ChannelProvider, delivery: ChannelDeliveryRecord): Promise<SentMessage> {
  const target = readDeliveryTarget(delivery, provider)
  const text = typeof delivery.payload.text === 'string'
    ? delivery.payload.text
    : typeof delivery.payload.message === 'string'
      ? delivery.payload.message
      : JSON.stringify(delivery.payload)
  let sent: SentMessage | null = null
  const chunks = chunkText(text, provider.capabilities.maxTextLength)
  for (const [index, chunk] of chunks.entries()) {
    sent = await provider.sendText(target, chunk, {
      deliveryId: chunks.length === 1 ? delivery.deliveryId : `${delivery.deliveryId}:chunk:${index + 1}`,
    })
  }
  if (!sent) throw new Error('Channel delivery payload was empty.')
  return sent
}

function deliveryRetryDelayMs(attemptCount: number) {
  const retryIndex = Math.max(0, attemptCount - 1)
  return Math.min(60_000, 1000 * 2 ** retryIndex)
}

function findDeliveryProvider(providers: GatewayProviderRegistry, delivery: ChannelDeliveryRecord): ProviderRegistration | null {
  return providers.registrations.find((entry) => entry.config.channelBindingId === delivery.channelBindingId) || null
}

function readDeliveryTarget(delivery: ChannelDeliveryRecord, provider: Pick<ChannelProvider, 'id' | 'kind'>): ChannelTarget {
  const target = delivery.target
  return {
    provider: provider.id,
    providerKind: provider.kind,
    chatId: stringField(target.externalChatId) || stringField(target.chatId) || 'unknown',
    threadId: stringField(target.externalThreadId) || stringField(target.threadId),
    messageId: stringField(target.lastChatMessageId) || stringField(target.messageId),
    userId: stringField(target.externalUserId) || stringField(target.userId),
  }
}

function stringField(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function providerEventIdForMessage(message: IncomingChannelMessage) {
  return stringField(message.providerEventId)
    || stringField(message.providerMessageId)
    || stringField(message.interaction?.id)
    || message.id
}

function providerEventTypeForMessage(message: IncomingChannelMessage) {
  if (message.interaction) return 'interaction'
  if (message.isCommand) return 'command'
  return 'message'
}

function providerEventMetadata(message: IncomingChannelMessage, providerConfig: GatewayProviderConfig) {
  return {
    providerKind: message.providerKind || providerConfig.kind,
    providerMessageId: stringField(message.providerMessageId),
    targetChatId: stringField(message.target.chatId),
    targetThreadId: stringField(message.target.threadId),
    senderUserId: stringField(message.sender.providerUserId),
    command: stringField(message.command),
    attachmentCount: message.attachments.length,
    interactionKind: message.interaction?.kind || null,
    receivedAt: message.receivedAt.toISOString(),
  }
}

function providerEventFailureIsRetryable(error: unknown) {
  if (isCloudTransportError(error)) {
    return ['network', 'abort', 'timeout', 'server', 'http', 'rate_limited', 'sse', 'request'].includes(error.kind)
  }
  return false
}
