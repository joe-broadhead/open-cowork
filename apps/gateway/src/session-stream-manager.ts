import type {
  ChannelProvider,
} from '@open-cowork/gateway-channel'
import type {
  ChannelSessionBindingRecord,
  CloudTransportSessionEvent,
  CloudTransportSubscription,
} from '@open-cowork/cloud-client'

import type { CloudGateway } from './cloud-gateway.js'
import { renderGatewaySessionEvent } from './event-renderer.js'
import type { GatewayMetrics } from './metrics.js'
import { classifyProviderFailure } from './provider-errors.js'
import {
  createGatewaySessionRenderState,
  type GatewaySessionRenderState,
} from './render/state.js'

export type GatewaySessionStreamManager = {
  ensure(input: {
    binding: ChannelSessionBindingRecord
    provider: ChannelProvider
  }): void
  close(bindingId: string): void
  closeAll(): void
  activeCount(): number
}

export type GatewaySessionStreamManagerOptions = {
  retryDelayMs?: number
  maxRetryDelayMs?: number
  maxRenderAttempts?: number
  maxQueueDepth?: number
  // Live stream subscriptions are a bounded cache: each holds an upstream SSE
  // connection (a file descriptor) + render state. `ensure()` is called on every
  // inbound message, so an evicted idle stream re-subscribes from its persisted
  // cursor on the next message with no event loss. Without these bounds the map
  // (and FDs) grow O(all channel sessions ever seen) for the process lifetime.
  maxStreams?: number
  idleTtlMs?: number
  sweepIntervalMs?: number
  now?: () => number
}

type StreamState = {
  binding: ChannelSessionBindingRecord
  provider: ChannelProvider
  subscription: CloudTransportSubscription | null
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId: string | null
  renderState: GatewaySessionRenderState
  renderFailures: Map<number, number>
  queue: Promise<void>
  // Depth of the in-flight serial event queue. handleEvent awaits a render +
  // a cursor DB round-trip, so a fast upstream can chain faster than we drain.
  queueDepth: number
  // When the queue hits maxQueueDepth we stop enqueuing (detach from the
  // producer) until it fully drains, then resubscribe from the advanced cursor.
  overflowing: boolean
  closed: boolean
  generation: number
  lastActivityMs: number
  retryTimer?: ReturnType<typeof setTimeout>
  retryAttempts: number
}

export function createGatewaySessionStreamManager(
  cloud: CloudGateway,
  metrics: GatewayMetrics,
  options: GatewaySessionStreamManagerOptions = {},
): GatewaySessionStreamManager {
  const streams = new Map<string, StreamState>()
  const retryDelayMs = options.retryDelayMs ?? 250
  // Cap for exponential backoff so a sustained cloud-SSE outage doesn't have every stream
  // hammer reconnect at the base delay (thundering herd).
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000
  const maxRenderAttempts = options.maxRenderAttempts ?? 5
  // Bound the in-flight event queue. A burst (or a slow channel render) must not
  // grow the serial promise chain — and its retained event payloads — without limit.
  const maxQueueDepth = Math.max(1, options.maxQueueDepth ?? 512)
  const maxStreams = Math.max(1, options.maxStreams ?? 2_000)
  const idleTtlMs = options.idleTtlMs ?? 30 * 60_000
  const sweepIntervalMs = Math.max(1_000, options.sweepIntervalMs ?? 60_000)
  const now = options.now ?? (() => Date.now())
  let sweepTimer: ReturnType<typeof setInterval> | undefined

  function evict(bindingId: string) {
    const state = streams.get(bindingId)
    if (!state) return
    closeState(state)
    streams.delete(bindingId)
  }

  function sweepIdle() {
    if (idleTtlMs <= 0) return
    const cutoff = now() - idleTtlMs
    for (const [bindingId, state] of [...streams]) {
      if (state.lastActivityMs <= cutoff) evict(bindingId)
    }
  }

  function evictUntilUnderCap() {
    while (streams.size >= maxStreams) {
      let oldestId: string | undefined
      let oldestActivity = Number.POSITIVE_INFINITY
      for (const [bindingId, state] of streams) {
        if (state.lastActivityMs < oldestActivity) {
          oldestActivity = state.lastActivityMs
          oldestId = bindingId
        }
      }
      if (!oldestId) break
      metrics.streamEvictions += 1
      evict(oldestId)
    }
  }

  function ensureSweepTimer() {
    if (sweepTimer || idleTtlMs <= 0) return
    sweepTimer = setInterval(sweepIdle, sweepIntervalMs)
    sweepTimer.unref?.()
  }

  const manager: GatewaySessionStreamManager = {
    ensure(input) {
      const existing = streams.get(input.binding.bindingId)
      if (existing) {
        existing.binding = input.binding
        existing.provider = input.provider
        existing.lastEventSequence = Math.max(existing.lastEventSequence, input.binding.lastEventSequence)
        existing.lastWorkspaceSequence = Math.max(existing.lastWorkspaceSequence, input.binding.lastWorkspaceSequence)
        existing.lastChatMessageId = input.binding.lastChatMessageId ?? existing.lastChatMessageId
        existing.lastActivityMs = now()
        return
      }

      // Free idle/over-cap subscriptions before opening a new one so the live-stream
      // map (and its upstream SSE file descriptors) stay bounded.
      sweepIdle()
      evictUntilUnderCap()

      const state: StreamState = {
        binding: input.binding,
        provider: input.provider,
        subscription: null,
        lastEventSequence: input.binding.lastEventSequence,
        lastWorkspaceSequence: input.binding.lastWorkspaceSequence,
        lastChatMessageId: input.binding.lastChatMessageId,
        renderState: createGatewaySessionRenderState(),
        renderFailures: new Map(),
        queue: Promise.resolve(),
        queueDepth: 0,
        overflowing: false,
        closed: false,
        generation: 0,
        lastActivityMs: now(),
        retryAttempts: 0,
      }
      streams.set(input.binding.bindingId, state)
      ensureSweepTimer()
      subscribe(state)
    },
    close(bindingId) {
      evict(bindingId)
    },
    closeAll() {
      for (const state of streams.values()) closeState(state)
      streams.clear()
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = undefined
      }
    },
    activeCount() {
      return streams.size
    },
  }

  function subscribe(state: StreamState) {
    if (state.closed) return
    state.subscription?.close()
    state.overflowing = false
    state.generation += 1
    const generation = state.generation
    state.subscription = cloud.subscribeSessionEvents({
      sessionId: state.binding.sessionId,
      afterSequence: state.lastEventSequence,
      onEvent: (event) => {
        // Already detached for backpressure: drop further events (no enqueue).
        // They'll be re-delivered when we resubscribe from the advanced cursor.
        if (state.overflowing) return
        if (state.queueDepth >= maxQueueDepth) {
          // Consumer is behind. Stop reading from the producer; the in-flight
          // queue keeps advancing the persisted cursor. When it drains we
          // resubscribe from that cursor, so no event is lost — guaranteeing
          // forward progress under a sustained burst rather than livelocking.
          state.overflowing = true
          metrics.streamBackpressureDisconnects += 1
          return
        }
        state.queueDepth += 1
        state.queue = state.queue
          .then(() => handleEvent(state, event, generation))
          .finally(() => {
            state.queueDepth -= 1
            // Drained after a backpressure detach: resubscribe from the advanced
            // cursor. Skip if a retry is already pending (an SSE error raced the
            // drain) — that timer's subscribe() will recover and reset the flag.
            if (state.overflowing && state.queueDepth === 0 && !state.closed && !state.retryTimer) {
              subscribe(state)
            }
          })
      },
      onError: () => {
        metrics.errors += 1
        metrics.streamReconnects += 1
        reconnect(state)
      },
    })
  }

  function reconnect(state: StreamState) {
    state.generation += 1
    state.subscription?.close()
    state.subscription = null
    scheduleRetry(state)
  }

  function scheduleRetry(state: StreamState) {
    if (state.closed || state.retryTimer) return
    // Exponential backoff with full jitter, capped — reset to the base delay once a
    // (re)subscribe starts delivering events again (see handleEvent).
    const backoff = Math.min(retryDelayMs * 2 ** state.retryAttempts, maxRetryDelayMs)
    const delay = retryDelayMs + Math.random() * (backoff - retryDelayMs)
    state.retryAttempts += 1
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      subscribe(state)
    }, delay)
    state.retryTimer.unref?.()
  }

  async function handleEvent(state: StreamState, event: CloudTransportSessionEvent, generation: number) {
    if (state.closed) return
    if (generation !== state.generation) return
    state.lastActivityMs = now()
    state.retryAttempts = 0 // a live event means the (re)subscription is healthy — reset backoff
    if (event.type === 'snapshot.required') {
      try {
        await hydrateSnapshot(state, event)
      } catch {
        metrics.errors += 1
        metrics.streamReconnects += 1
        reconnect(state)
      }
      return
    }
    if (event.sequence <= state.lastEventSequence) return

    try {
      const rendered = await renderGatewaySessionEvent({
        cloud,
        provider: state.provider,
        binding: {
          ...state.binding,
          lastEventSequence: state.lastEventSequence,
          lastWorkspaceSequence: state.lastWorkspaceSequence,
          lastChatMessageId: state.lastChatMessageId,
        },
        event,
        state: state.renderState,
      })
      const lastChatMessageId = rendered.lastChatMessageId ?? state.lastChatMessageId
      const updated = await persistCursor(state, {
        bindingId: state.binding.bindingId,
        lastEventSequence: event.sequence,
        lastWorkspaceSequence: state.lastWorkspaceSequence,
        lastChatMessageId,
      })
      state.lastEventSequence = updated.lastEventSequence
      state.lastWorkspaceSequence = updated.lastWorkspaceSequence
      state.lastChatMessageId = updated.lastChatMessageId ?? lastChatMessageId
      state.renderFailures.delete(event.sequence)
      state.binding = updated
    } catch (error) {
      metrics.errors += 1
      const attempts = (state.renderFailures.get(event.sequence) ?? 0) + 1
      state.renderFailures.set(event.sequence, attempts)
      // Re-rendering is idempotent (cursor-gated), so retry unknown/transient failures rather than
      // dropping the event — unlike the outbound delivery path's no-idempotency-key conservatism.
      const failure = classifyProviderFailure(error, { defaultTransient: true })
      if (failure.transient && attempts < maxRenderAttempts) {
        metrics.sessionRenderRetries += 1
        metrics.streamReconnects += 1
        reconnect(state)
        return
      }
      try {
        await skipFailedEvent(state, event)
      } catch {
        metrics.errors += 1
        metrics.streamReconnects += 1
        reconnect(state)
      }
    }
  }

  async function skipFailedEvent(state: StreamState, event: CloudTransportSessionEvent) {
    metrics.droppedSessionEvents += 1
    metrics.sessionRenderDeadLetters += 1
    const updated = await persistCursor(state, {
      bindingId: state.binding.bindingId,
      lastEventSequence: event.sequence,
      lastWorkspaceSequence: state.lastWorkspaceSequence,
      lastChatMessageId: state.lastChatMessageId,
    })
    state.lastEventSequence = updated.lastEventSequence
    state.lastWorkspaceSequence = updated.lastWorkspaceSequence
    state.lastChatMessageId = updated.lastChatMessageId ?? state.lastChatMessageId
    state.renderFailures.delete(event.sequence)
    state.binding = updated
  }

  async function hydrateSnapshot(state: StreamState, event: CloudTransportSessionEvent) {
    const snapshot = await cloud.getSession(state.binding.sessionId)
    const latestSequence = Math.max(
      state.lastEventSequence,
      numberField(event.payload, 'latestSequence'),
      snapshot.projection?.sequence ?? 0,
      event.sequence,
    )
    if (latestSequence <= state.lastEventSequence) return
    const updated = await persistCursor(state, {
      bindingId: state.binding.bindingId,
      lastEventSequence: latestSequence,
      lastWorkspaceSequence: state.lastWorkspaceSequence,
      lastChatMessageId: state.lastChatMessageId,
    })
    state.lastEventSequence = updated.lastEventSequence
    state.lastWorkspaceSequence = updated.lastWorkspaceSequence
    state.lastChatMessageId = updated.lastChatMessageId ?? state.lastChatMessageId
    state.binding = updated
  }

  async function persistCursor(state: StreamState, input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }) {
    const result = await cloud.updateCursor(input)
    if (!result.ok && result.reason === 'not_found') {
      metrics.cursorPersistenceFailures += 1
      throw new Error(`Gateway cursor persistence failed for channel binding ${state.binding.bindingId}.`)
    }
    return result.binding
  }

  return manager
}

function numberField(payload: Record<string, unknown>, key: string): number {
  const value = payload[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function closeState(state: StreamState) {
  state.closed = true
  state.subscription?.close()
  if (state.retryTimer) clearTimeout(state.retryTimer)
}
