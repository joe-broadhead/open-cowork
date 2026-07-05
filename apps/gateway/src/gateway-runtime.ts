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
import {
  createGatewayMetrics,
  ensureGatewayProviderMetrics,
  observeGatewayDeliveryLatency,
  setGatewayProviderState,
  type GatewayMetrics,
} from './metrics.js'
import { classifyProviderFailure } from './provider-errors.js'
import { createGatewayProviderRegistry, type GatewayProviderRegistry, type ProviderRegistration } from './provider-registry.js'
import { createGatewaySessionStreamManager, type GatewaySessionStreamManager } from './session-stream-manager.js'

const MAX_DELIVERY_ATTEMPTS = 5
const PROVIDER_EVENT_CLAIM_TTL_MS = 5 * 60_000
// Cloud-side claim TTL (ms) requested for each served delivery (audit G3). The claim is never
// renewed in-flight, so a slow/multi-chunk send that outlasts the cloud's 30s default would be
// re-served and delivered twice. Sized to comfortably exceed a worst-case single send (local queue
// wait + chunked send), it preserves at-least-once while stopping the duplicate; the cloud still
// re-serves after this window if the gateway actually dies mid-delivery.
const DELIVERY_CLAIM_TTL_MS = 2 * 60_000

export type DeliverySubscriber = { start(): void; close(): void }

// Self-healing wrapper around the cloud→channel delivery subscription (audit P1-G1). The raw
// subscription opens once and never recovers: a clean server close (idle timeout / deploy / scale
// event) ends it silently and an error left it permanently down until an orchestrator restart, so a
// broken delivery pipe could persist undetected. This resubscribes with capped, jittered backoff on
// error OR clean close, flips a health flag so /ready reflects the real state, and rotates a quiet
// connection on a watchdog so a half-open/zombie socket can't blackhole deliveries forever.
export function createDeliverySubscriber(input: {
  subscribe: (handlers: {
    onDelivery: (delivery: ChannelDeliveryRecord) => void
    onError: () => void
    onClose: () => void
  }) => { close(): void }
  onDelivery: (delivery: ChannelDeliveryRecord) => void
  onHealthy: (healthy: boolean) => void
  onError?: () => void
  retryDelayMs?: number
  maxRetryDelayMs?: number
  watchdogMs?: number
  now?: () => number
  random?: () => number
}): DeliverySubscriber {
  const retryDelayMs = input.retryDelayMs ?? 250
  const maxRetryDelayMs = input.maxRetryDelayMs ?? 30_000
  const watchdogMs = input.watchdogMs ?? 5 * 60_000
  const now = input.now ?? (() => Date.now())
  const random = input.random ?? Math.random
  let subscription: { close(): void } | null = null
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  let retryAttempts = 0
  let lastDeliveryMs = now()
  let closed = false

  const open = () => {
    if (closed) return
    subscription = input.subscribe({
      onDelivery: (delivery) => {
        retryAttempts = 0 // a live delivery proves the (re)subscription is healthy — reset backoff
        lastDeliveryMs = now()
        input.onHealthy(true)
        input.onDelivery(delivery)
      },
      onError: () => { input.onError?.(); reconnect() },
      // A clean server close is expected churn, not an error — recover without inflating error metrics.
      onClose: () => reconnect(),
    })
    input.onHealthy(true) // optimistic: an open subscription is healthy until it errors
  }

  const reconnect = () => {
    if (closed) return
    input.onHealthy(false)
    subscription?.close()
    subscription = null
    scheduleRetry()
  }

  const scheduleRetry = () => {
    if (closed || retryTimer) return
    // Exponential backoff with full jitter, capped — reset to the base delay once a delivery arrives.
    const ceiling = Math.min(retryDelayMs * 2 ** retryAttempts, maxRetryDelayMs)
    const delay = retryDelayMs + random() * (ceiling - retryDelayMs)
    retryAttempts += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      open()
    }, delay)
    retryTimer.unref?.()
  }

  return {
    start() {
      if (closed) return
      lastDeliveryMs = now()
      open()
      watchdogTimer = setInterval(() => {
        // Rotate a connection that has been quiet past the watchdog window so a half-open/zombie
        // socket (no FIN, no read error) can't blackhole deliveries. Skip while a retry is pending.
        if (closed || retryTimer || subscription === null) return
        if (now() - lastDeliveryMs >= watchdogMs) {
          lastDeliveryMs = now()
          subscription.close()
          subscription = null
          open()
        }
      }, watchdogMs)
      watchdogTimer.unref?.()
    },
    close() {
      closed = true
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null }
      subscription?.close()
      subscription = null
    },
  }
}

export type DeliveryDispatcher = {
  enqueue(delivery: ChannelDeliveryRecord): void
  drain(timeoutMs: number): Promise<void>
}

// Stable per-destination lane key: deliveries to the same channel binding AND target run
// one-at-a-time in arrival order (so a conversation's messages stay ordered) while different
// destinations run concurrently up to the global cap.
function deliveryLaneKey(delivery: ChannelDeliveryRecord): string {
  const target = delivery.target && typeof delivery.target === 'object'
    ? Object.keys(delivery.target).sort().map((key) => `${key}=${String((delivery.target as Record<string, unknown>)[key])}`).join('&')
    : ''
  return `${delivery.channelBindingId}\u0000${target}`
}

// Bounded delivery worker pool (audit P1-G2). The raw path fired handleDelivery immediately for
// every delivery, so a backlog drain (e.g. after downtime) spawned unbounded concurrent outbound
// sends → provider 429s → transient-retry storm → out-of-order channel messages. This caps global
// concurrency AND serializes per binding+target so a conversation stays ordered.
export function createDeliveryDispatcher(input: {
  handle: (delivery: ChannelDeliveryRecord) => Promise<void>
  maxConcurrency?: number
  maxQueueDepth?: number
  laneKey?: (delivery: ChannelDeliveryRecord) => string
  onQueueDepth?: (depth: number) => void
  onShed?: (delivery: ChannelDeliveryRecord) => void
}): DeliveryDispatcher {
  const maxConcurrency = Math.max(1, Math.floor(input.maxConcurrency ?? 8))
  // Hard cap on locally-queued deliveries (P1-C). A backlog drain streams the whole
  // cloud-side queue at once; without this, every claimed delivery is retained in memory
  // (heap cliff) and waits past its server-side claim TTL (→ reclaim + duplicate send). When
  // the cap is hit we simply stop accepting: the delivery is never acked, so its claim expires
  // and the cloud re-serves it later — bounded memory, no message loss.
  const maxQueueDepth = Math.max(maxConcurrency, Math.floor(input.maxQueueDepth ?? 512))
  const laneKey = input.laneKey ?? deliveryLaneKey
  const lanes = new Map<string, { queue: ChannelDeliveryRecord[]; running: boolean }>()
  const inFlight = new Set<Promise<void>>()
  let active = 0
  let queued = 0

  const pump = () => {
    for (const [key, lane] of lanes) {
      if (active >= maxConcurrency) break
      if (lane.running || lane.queue.length === 0) continue
      const delivery = lane.queue.shift()!
      queued -= 1
      lane.running = true
      active += 1
      const task = Promise.resolve()
        .then(() => input.handle(delivery))
        .catch(() => undefined) // handle() already records errors + acks; never wedge the lane
        .finally(() => {
          active -= 1
          lane.running = false
          if (lane.queue.length === 0) lanes.delete(key)
          inFlight.delete(task)
          pump()
        })
      inFlight.add(task)
    }
  }

  return {
    enqueue(delivery) {
      // Shed when at capacity: leave the delivery unacked so the cloud re-serves it after its
      // claim expires, rather than growing the local queue without bound past the claim TTL.
      if (queued >= maxQueueDepth) {
        input.onShed?.(delivery)
        return
      }
      const key = laneKey(delivery)
      let lane = lanes.get(key)
      if (!lane) { lane = { queue: [], running: false }; lanes.set(key, lane) }
      lane.queue.push(delivery)
      queued += 1
      input.onQueueDepth?.(queued)
      pump()
    },
    async drain(timeoutMs) {
      const deadline = Date.now() + Math.max(0, timeoutMs)
      while ((queued > 0 || active > 0) && Date.now() < deadline) {
        await settleWithin(Promise.allSettled([...inFlight]), Math.max(1, deadline - Date.now()))
      }
    },
  }
}

export type GatewayRuntime = {
  readonly metrics: GatewayMetrics
  readonly providers: GatewayProviderRegistry
  readonly streams: GatewaySessionStreamManager
  start(): Promise<void>
  stop(): Promise<void>
  ready(): boolean
  refreshProviderHealth(): void
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
  for (const provider of config.providers.filter((entry) => entry.enabled)) {
    ensureGatewayProviderMetrics(metrics, provider)
  }
  const streams = createGatewaySessionStreamManager(cloud, metrics)
  const claimedBy = `gateway:${config.instanceId}`
  const channelBindingIds = [...new Set(config.providers.filter((provider) => provider.enabled).map((provider) => provider.channelBindingId))]
  const deliverySubscriptions: Array<{ close(): void }> = []
  const deliveryDispatcher = createDeliveryDispatcher({
    handle: (delivery) => handleDelivery(delivery, providers, cloud, metrics),
    maxConcurrency: config.maxDeliveryConcurrency,
    maxQueueDepth: config.maxDeliveryQueueDepth,
    onQueueDepth: (depth) => {
      if (depth > metrics.deliveryQueueDepthMax) metrics.deliveryQueueDepthMax = depth
    },
    onShed: () => { metrics.deliverySheds += 1 },
  })
  let started = false
  // Tracks whether the cloud delivery subscription is live. The gateway's job is to relay between
  // channels and the cloud, so a broken delivery pipe means it is not ready even when its channel
  // providers are healthy. createDeliverySubscriber now auto-recovers (resubscribe with backoff on
  // error/clean-close + a quiet-connection watchdog) and drives this flag, so /ready reflects the
  // real delivery state and self-heals instead of requiring an orchestrator restart.
  let cloudDeliveriesHealthy = true

  const runtime: GatewayRuntime = {
    metrics,
    providers,
    streams,
    async start() {
      if (started) return
      for (const provider of config.providers.filter((entry) => entry.enabled)) {
        setGatewayProviderState(metrics, provider, 'starting')
      }
      await providers.start((providerConfig, message) => handleMessage(providerConfig, message, cloud, providers, streams, metrics, claimedBy))
      for (const registration of providers.registrations) {
        setGatewayProviderState(metrics, registration.config, registration.healthy ? 'healthy' : 'unhealthy')
      }
      started = true
      if (options.subscribeDeliveries !== false) {
        cloudDeliveriesHealthy = true
        const subscriber = createDeliverySubscriber({
          subscribe: (handlers) => cloud.subscribeDeliveries({
            claimedBy,
            // Request a claim TTL that exceeds a worst-case single send (audit G3). The claim is
            // not renewed in-flight, so the default 30s could lapse during a slow/multi-chunk send
            // and the cloud would re-serve → duplicate delivery. A longer TTL stops the duplicate
            // while keeping at-least-once: a gateway that actually dies still releases after this.
            ttlMs: DELIVERY_CLAIM_TTL_MS,
            channelBindingIds,
            onDelivery: handlers.onDelivery,
            onError: handlers.onError,
            onClose: handlers.onClose,
          }),
          onDelivery: (delivery) => deliveryDispatcher.enqueue(delivery),
          onHealthy: (healthy) => { cloudDeliveriesHealthy = healthy },
          onError: () => {
            metrics.cloudSubscriptionErrors += 1
            metrics.errors += 1
          },
        })
        subscriber.start()
        deliverySubscriptions.push(subscriber)
      }
    },
    async stop() {
      for (const subscription of deliverySubscriptions.splice(0)) subscription.close()
      streams.closeAll()
      // Drain queued + in-flight deliveries within the shutdown budget so a graceful stop doesn't
      // abandon already-claimed deliveries mid-send.
      await deliveryDispatcher.drain(config.timeouts.shutdownDrainMs)
      await providers.stop()
      for (const provider of config.providers.filter((entry) => entry.enabled)) {
        setGatewayProviderState(metrics, provider, 'stopped')
      }
      started = false
    },
    ready() {
      refreshProviderHealth(providers, metrics)
      const cloudReachable = options.subscribeDeliveries === false || cloudDeliveriesHealthy
      return started && cloudReachable && providers.registrations.every((registration) => registration.started && registration.healthy)
    },
    refreshProviderHealth() {
      refreshProviderHealth(providers, metrics)
    },
  }

  return runtime
}

function refreshProviderHealth(providers: GatewayProviderRegistry, metrics: GatewayMetrics) {
  for (const registration of providers.registrations) {
    const health = registration.provider.health?.()
    registration.healthy = health?.ok ?? registration.healthy
    registration.lastError = health?.error || null
    setGatewayProviderState(metrics, registration.config, registration.healthy ? 'healthy' : 'unhealthy')
  }
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs)
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
  const providerMetrics = ensureGatewayProviderMetrics(metrics, providerConfig)
  providerMetrics.incomingMessages += 1
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
      channelBindingId: providerConfig.channelBindingId,
      externalWorkspaceId,
      providerEventId: providerEventIdForMessage(message),
      eventType: providerEventTypeForMessage(message),
      claimedBy,
      ttlMs: PROVIDER_EVENT_CLAIM_TTL_MS,
      metadata: providerEventMetadata(message, providerConfig),
    })
    if (!eventClaim.claimed) {
      providerMetrics.inboundDuplicates += 1
      return
    }
    claimedEvent = { eventId: eventClaim.event.eventId }

    if (await routeGatewayInteraction({ cloud, provider: registration.provider, providerConfig, message, metrics })) {
      sideEffectCommitted = true
      await cloud.completeProviderEvent(claimedEvent.eventId, {
        channelBindingId: providerConfig.channelBindingId,
        claimedBy,
        status: 'processed',
      })
      return
    }

    const text = message.text.trim()
    if (!text) {
      await cloud.completeProviderEvent(claimedEvent.eventId, {
        channelBindingId: providerConfig.channelBindingId,
        claimedBy,
        status: 'processed',
      })
      return
    }

    const identity = await cloud.resolveIdentity({
      provider,
      channelBindingId: providerConfig.channelBindingId,
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
    providerMetrics.promptedMessages += 1
    await cloud.completeProviderEvent(claimedEvent.eventId, {
      channelBindingId: providerConfig.channelBindingId,
      claimedBy,
      status: 'processed',
    })
  } catch (error) {
    const retryable = providerEventFailureIsRetryable(error)
    if (claimedEvent && !sideEffectCommitted) {
      await cloud.completeProviderEvent(claimedEvent.eventId, {
        channelBindingId: providerConfig.channelBindingId,
        claimedBy,
        status: 'failed',
        retryable,
        lastError: error instanceof Error ? error.message : String(error),
      }).catch(() => {})
      // Don't SILENTLY drop a permanently-failed inbound message (audit P2-15). A retryable failure
      // will be re-attempted (and the cloud dedups the re-prompt on commandId == eventId), so stay
      // quiet for those; but a non-retryable failure means the message is dropped for good, so tell
      // the user in-channel rather than leaving the bot looking like it ignored them.
      if (!retryable) {
        await notifyChannelOfDroppedMessage(providers, providerConfig, message, claimedEvent.eventId).catch(() => {})
      }
    }
    metrics.errors += 1
    providerMetrics.inboundFailures += 1
    throw error
  }
}

// Best-effort in-channel notice that a message was dropped after a non-retryable failure (P2-15).
// Idempotent on the event id so a re-run can't double-post, and never throws (the original error is
// what matters; failing to notify must not mask it).
async function notifyChannelOfDroppedMessage(
  providers: GatewayProviderRegistry,
  providerConfig: GatewayProviderConfig,
  message: IncomingChannelMessage,
  eventId: string,
) {
  const registration = providers.get(providerConfig.id)
  if (!registration) return
  await registration.provider.sendText(
    message.target,
    'Sorry — I could not process that message. Please try again.',
    { deliveryId: `${eventId}:dropped` },
  )
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
  const providerMetrics = ensureGatewayProviderMetrics(metrics, registration.config)
  providerMetrics.deliveriesReceived += 1

  try {
    await sendDelivery(registration.provider, delivery)
    await cloud.ackDelivery(delivery.deliveryId, {
      status: 'sent',
      claimedBy: delivery.claimedBy,
      lastError: null,
    })
    metrics.deliveriesSent += 1
    providerMetrics.deliveriesSent += 1
    observeGatewayDeliveryLatency(metrics, providerMetrics, Date.now() - startedAt)
  } catch (error) {
    metrics.errors += 1
    const failure = classifyProviderFailure(error)
    const shouldRetry = failure.transient && delivery.attemptCount < MAX_DELIVERY_ATTEMPTS
    if (shouldRetry) {
      metrics.deliveryRetries += 1
      providerMetrics.deliveryRetries += 1
    } else {
      metrics.deliveryDeadLetters += 1
      providerMetrics.deliveryDeadLetters += 1
    }
    await cloud.ackDelivery(delivery.deliveryId, {
      status: shouldRetry ? 'failed' : 'dead',
      claimedBy: delivery.claimedBy,
      lastError: failure.message,
      nextAttemptAt: shouldRetry ? new Date(Date.now() + deliveryRetryDelayMs(delivery.attemptCount, failure.retryAfterMs)).toISOString() : null,
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

function deliveryRetryDelayMs(attemptCount: number, retryAfterMs?: number) {
  if (retryAfterMs !== undefined) return Math.max(0, Math.floor(retryAfterMs))
  const retryIndex = Math.max(0, attemptCount - 1)
  const base = Math.min(60_000, 1000 * 2 ** retryIndex)
  const spread = base * 0.2
  return Math.max(0, Math.floor(base - spread + Math.random() * spread * 2))
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
