import type { BrowserWindow } from 'electron'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'

export type RuntimeEventSubscriptionFailureStrategy = 'restart-runtime' | 'retry-subscription'

type SubscribeFn = (
  client: OpencodeClient,
  getMainWindow: () => BrowserWindow | null,
  signal?: AbortSignal,
  directory?: string | null,
) => Promise<void>

type RuntimeEventSubscriptionManagerOptions = {
  getMainWindow: () => BrowserWindow | null
  subscribe: SubscribeFn
  onError: (error: unknown, directory: string | null) => RuntimeEventSubscriptionFailureStrategy
  retryDelayMs?: number
}

function subscriptionKey(directory: string | null) {
  return directory || '__runtime_home__'
}

export function createRuntimeEventSubscriptionManager(
  options: RuntimeEventSubscriptionManagerOptions,
) {
  const retryDelayMs = options.retryDelayMs ?? 1500
  const entries = new Map<string, {
    client: OpencodeClient
    directory: string | null
    controller: AbortController | null
    retryTimer: NodeJS.Timeout | null
  }>()

  function clearRetryTimer(entry: { retryTimer: NodeJS.Timeout | null }) {
    if (!entry.retryTimer) return
    clearTimeout(entry.retryTimer)
    entry.retryTimer = null
  }

  function scheduleRetry(key: string) {
    const entry = entries.get(key)
    if (!entry || entry.retryTimer || entry.controller) return
    entry.retryTimer = setTimeout(() => {
      const current = entries.get(key)
      if (!current || current !== entry) return
      entry.retryTimer = null
      startSubscription(key, entry)
    }, retryDelayMs)
  }

  function startSubscription(
    key: string,
    entry: {
      client: OpencodeClient
      directory: string | null
      controller: AbortController | null
      retryTimer: NodeJS.Timeout | null
    },
  ) {
    if (entry.controller) return

    const controller = new AbortController()
    entry.controller = controller

    void options.subscribe(entry.client, options.getMainWindow, controller.signal, entry.directory).catch((error) => {
      if (controller.signal.aborted) return
      const current = entries.get(key)
      if (current === entry && entry.controller === controller) {
        entry.controller = null
      }
      const strategy = options.onError(error, entry.directory)
      if (strategy === 'retry-subscription') {
        scheduleRetry(key)
        return
      }
      clearRetryTimer(entry)
      entries.delete(key)
    }).finally(() => {
      const current = entries.get(key)
      if (current === entry && entry.controller === controller) {
        entry.controller = null
      }
    })
  }

  function ensure(directory: string | null, client: OpencodeClient) {
    const key = subscriptionKey(directory)
    const existing = entries.get(key)
    if (existing) {
      existing.client = client
      if (existing.controller || existing.retryTimer) return
      startSubscription(key, existing)
      return
    }

    const entry = {
      client,
      directory,
      controller: null,
      retryTimer: null,
    }
    entries.set(key, entry)
    startSubscription(key, entry)
  }

  function stop(directory: string | null) {
    const key = subscriptionKey(directory)
    const entry = entries.get(key)
    if (!entry) return
    entry.controller?.abort()
    clearRetryTimer(entry)
    entries.delete(key)
  }

  function reset() {
    for (const entry of entries.values()) {
      entry.controller?.abort()
      clearRetryTimer(entry)
    }
    entries.clear()
  }

  function has(directory: string | null) {
    return entries.has(subscriptionKey(directory))
  }

  function count() {
    return entries.size
  }

  return {
    ensure,
    stop,
    reset,
    has,
    count,
  }
}
