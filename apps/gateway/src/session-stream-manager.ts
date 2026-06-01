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
  maxRenderAttempts?: number
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
  closed: boolean
  generation: number
  retryTimer?: ReturnType<typeof setTimeout>
}

export function createGatewaySessionStreamManager(
  cloud: CloudGateway,
  metrics: GatewayMetrics,
  options: GatewaySessionStreamManagerOptions = {},
): GatewaySessionStreamManager {
  const streams = new Map<string, StreamState>()
  const retryDelayMs = options.retryDelayMs ?? 250
  const maxRenderAttempts = options.maxRenderAttempts ?? 5

  const manager: GatewaySessionStreamManager = {
    ensure(input) {
      const existing = streams.get(input.binding.bindingId)
      if (existing) {
        existing.binding = input.binding
        existing.provider = input.provider
        existing.lastEventSequence = Math.max(existing.lastEventSequence, input.binding.lastEventSequence)
        existing.lastWorkspaceSequence = Math.max(existing.lastWorkspaceSequence, input.binding.lastWorkspaceSequence)
        existing.lastChatMessageId = input.binding.lastChatMessageId ?? existing.lastChatMessageId
        return
      }

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
        closed: false,
        generation: 0,
      }
      streams.set(input.binding.bindingId, state)
      subscribe(state)
    },
    close(bindingId) {
      const state = streams.get(bindingId)
      if (!state) return
      closeState(state)
      streams.delete(bindingId)
    },
    closeAll() {
      for (const state of streams.values()) closeState(state)
      streams.clear()
    },
    activeCount() {
      return streams.size
    },
  }

  function subscribe(state: StreamState) {
    if (state.closed) return
    state.subscription?.close()
    state.generation += 1
    const generation = state.generation
    state.subscription = cloud.subscribeSessionEvents({
      sessionId: state.binding.sessionId,
      afterSequence: state.lastEventSequence,
      onEvent: (event) => {
        state.queue = state.queue.then(() => handleEvent(state, event, generation))
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
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      subscribe(state)
    }, retryDelayMs)
    state.retryTimer.unref?.()
  }

  async function handleEvent(state: StreamState, event: CloudTransportSessionEvent, generation: number) {
    if (state.closed) return
    if (generation !== state.generation) return
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
      state.lastEventSequence = updated?.lastEventSequence ?? event.sequence
      state.lastWorkspaceSequence = updated?.lastWorkspaceSequence ?? state.lastWorkspaceSequence
      state.lastChatMessageId = updated?.lastChatMessageId ?? lastChatMessageId
      state.renderFailures.delete(event.sequence)
      if (updated) state.binding = updated
    } catch (error) {
      metrics.errors += 1
      const attempts = (state.renderFailures.get(event.sequence) ?? 0) + 1
      state.renderFailures.set(event.sequence, attempts)
      const failure = classifyProviderFailure(error)
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
    state.lastEventSequence = updated?.lastEventSequence ?? event.sequence
    state.lastWorkspaceSequence = updated?.lastWorkspaceSequence ?? state.lastWorkspaceSequence
    state.lastChatMessageId = updated?.lastChatMessageId ?? state.lastChatMessageId
    state.renderFailures.delete(event.sequence)
    if (updated) state.binding = updated
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
    state.lastEventSequence = updated?.lastEventSequence ?? latestSequence
    state.lastWorkspaceSequence = updated?.lastWorkspaceSequence ?? state.lastWorkspaceSequence
    state.lastChatMessageId = updated?.lastChatMessageId ?? state.lastChatMessageId
    if (updated) state.binding = updated
  }

  async function persistCursor(state: StreamState, input: {
    bindingId: string
    lastEventSequence: number
    lastWorkspaceSequence: number
    lastChatMessageId?: string | null
  }) {
    const updated = await cloud.updateCursor(input)
    if (!updated) {
      metrics.cursorPersistenceFailures += 1
      throw new Error(`Gateway cursor persistence failed for channel binding ${state.binding.bindingId}.`)
    }
    return updated
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
