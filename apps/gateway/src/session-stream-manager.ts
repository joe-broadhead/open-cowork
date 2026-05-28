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
}

type StreamState = {
  binding: ChannelSessionBindingRecord
  provider: ChannelProvider
  subscription: CloudTransportSubscription | null
  lastEventSequence: number
  lastWorkspaceSequence: number
  lastChatMessageId: string | null
  queue: Promise<void>
  closed: boolean
  retryTimer?: ReturnType<typeof setTimeout>
}

export function createGatewaySessionStreamManager(
  cloud: CloudGateway,
  metrics: GatewayMetrics,
  options: GatewaySessionStreamManagerOptions = {},
): GatewaySessionStreamManager {
  const streams = new Map<string, StreamState>()
  const retryDelayMs = options.retryDelayMs ?? 250

  const manager: GatewaySessionStreamManager = {
    ensure(input) {
      const existing = streams.get(input.binding.bindingId)
      if (existing) {
        existing.binding = input.binding
        existing.provider = input.provider
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
        queue: Promise.resolve(),
        closed: false,
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
    state.subscription = cloud.subscribeSessionEvents({
      sessionId: state.binding.sessionId,
      afterSequence: state.lastEventSequence,
      onEvent: (event) => {
        state.queue = state.queue.then(() => handleEvent(state, event))
      },
      onError: () => {
        metrics.errors += 1
        state.subscription?.close()
        state.subscription = null
        scheduleRetry(state)
      },
    })
  }

  function scheduleRetry(state: StreamState) {
    if (state.closed || state.retryTimer) return
    state.retryTimer = setTimeout(() => {
      state.retryTimer = undefined
      subscribe(state)
    }, retryDelayMs)
    state.retryTimer.unref?.()
  }

  async function handleEvent(state: StreamState, event: CloudTransportSessionEvent) {
    if (state.closed) return
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
      })
      const lastChatMessageId = rendered.lastChatMessageId ?? state.lastChatMessageId
      const updated = await cloud.updateCursor({
        bindingId: state.binding.bindingId,
        lastEventSequence: event.sequence,
        lastWorkspaceSequence: state.lastWorkspaceSequence,
        lastChatMessageId,
      })
      state.lastEventSequence = updated?.lastEventSequence ?? event.sequence
      state.lastWorkspaceSequence = updated?.lastWorkspaceSequence ?? state.lastWorkspaceSequence
      state.lastChatMessageId = updated?.lastChatMessageId ?? lastChatMessageId
      if (updated) state.binding = updated
    } catch {
      metrics.errors += 1
    }
  }

  return manager
}

function closeState(state: StreamState) {
  state.closed = true
  state.subscription?.close()
  if (state.retryTimer) clearTimeout(state.retryTimer)
}
