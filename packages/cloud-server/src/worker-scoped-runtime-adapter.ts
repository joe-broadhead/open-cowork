import type { OpenCoworkConfig } from '@open-cowork/shared'
import type { ByokSecretStore } from './byok-secret-store.ts'
import {
  buildCloudByokRuntimeConfig,
  CloudByokRuntimeConfigError,
  type CloudByokRuntimeProviderPolicy,
} from './byok-runtime-config.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import { recordCloudMetric, type CloudObservabilityAdapter } from './observability.ts'
import type { PathProvider } from './path-provider.ts'
import { createCloudSessionPathProvider } from './path-provider.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeDroppedEvent,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
  CloudRuntimeExecutionContext,
} from './runtime-adapter.ts'

type Env = Record<string, string | undefined>

export type WorkerScopedRuntimeFactoryInput = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  execution: CloudRuntimeExecutionContext
  runtimeConfig: import('@opencode-ai/sdk/v2/server').ServerOptions['config']
  // Fired when the managed OpenCode subprocess dies unexpectedly; the cache evicts this
  // entry so the next access rebuilds a fresh runtime instead of using the dead one.
  onUnexpectedExit?: () => void
}

export type WorkerScopedRuntimeFactory = (
  input: WorkerScopedRuntimeFactoryInput,
) => Promise<CloudRuntimeAdapter> | CloudRuntimeAdapter

export type WorkerScopedRuntimeAdapterOptions = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  byokSecrets: ByokSecretStore
  byokPolicy?: CloudByokRuntimeProviderPolicy | null
  observability?: CloudObservabilityAdapter | null
  runtimeFactory: WorkerScopedRuntimeFactory
  maxRuntimeEntries?: number
  runtimeIdleTtlMs?: number
}

type RuntimeEntry = {
  adapter: CloudRuntimeAdapter
  unsubscribe: (() => void | Promise<void>) | null
  activeUses: number
  executionActive: boolean
  nativeRootSessionId: string | null
  lastUsedAt: number
}

type RuntimeEventSubscription = {
  onError?: (error: unknown) => void
  onDroppedEvent?: (event: CloudRuntimeDroppedEvent) => void
}

const DEFAULT_MAX_RUNTIME_ENTRIES = 100
const DEFAULT_RUNTIME_IDLE_TTL_MS = 30 * 60 * 1000

function runtimeKey(context: CloudRuntimeExecutionContext) {
  return `${context.tenantId}\0${context.sessionId}`
}

function requireContext(context: CloudRuntimeExecutionContext | null | undefined) {
  if (!context?.tenantId || !context.sessionId) {
    throw new Error('Cloud worker runtime execution requires tenant and session context.')
  }
  return context
}

function mapRuntimeEventToCoworkSession(context: CloudRuntimeExecutionContext, event: CloudRuntimeEvent): CloudRuntimeEvent {
  const runtimeSessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
  return {
    ...event,
    payload: {
      ...event.payload,
      ...(runtimeSessionId && runtimeSessionId !== context.sessionId ? { opencodeSessionId: runtimeSessionId } : {}),
      sessionId: context.sessionId,
    },
  }
}

export function createWorkerScopedRuntimeAdapter(options: WorkerScopedRuntimeAdapterOptions): CloudRuntimeAdapter {
  const runtimes = new Map<string, RuntimeEntry>()
  const listeners = new Map<CloudRuntimeEventListener, RuntimeEventSubscription>()
  const maxRuntimeEntries = Math.max(1, Math.floor(options.maxRuntimeEntries || DEFAULT_MAX_RUNTIME_ENTRIES))
  const runtimeIdleTtlMs = Math.max(1, Math.floor(options.runtimeIdleTtlMs || DEFAULT_RUNTIME_IDLE_TTL_MS))
  // Reap idle runtimes on a timer, not only on a cache miss — without this, a worker that
  // processed a burst of sessions then went quiet would keep up to maxRuntimeEntries live
  // OpenCode child processes + workspaces resident until new traffic arrived.
  const sweepTimer = setInterval(() => { void evictRuntimes() }, Math.max(1_000, Math.floor(runtimeIdleTtlMs / 2)))
  sweepTimer.unref?.()

  function eventStartsExecution(event: CloudRuntimeEvent) {
    return event.type === 'session.status'
      && (event.payload.statusType === 'busy' || event.payload.statusType === 'running')
  }

  function eventSettlesExecution(event: CloudRuntimeEvent) {
    return event.type === 'session.idle'
      || event.type === 'session.aborted'
      || event.type === 'runtime.error'
      || (event.type === 'session.status' && event.payload.statusType === 'idle')
  }

  function eventNativeSessionId(event: CloudRuntimeEvent) {
    return typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
  }

  function eventBelongsToNativeRoot(entry: RuntimeEntry, event: CloudRuntimeEvent) {
    const eventSessionId = eventNativeSessionId(event)
    return !entry.nativeRootSessionId || !eventSessionId || eventSessionId === entry.nativeRootSessionId
  }

  async function subscribeRuntimeEvents(context: CloudRuntimeExecutionContext, entry: RuntimeEntry) {
    const { adapter } = entry
    if (!adapter.subscribeEvents || listeners.size === 0) return null
    const unsubscribe = await adapter.subscribeEvents(
      async (event) => {
        const belongsToNativeRoot = eventBelongsToNativeRoot(entry, event)
        const mapped = mapRuntimeEventToCoworkSession(context, event)
        // OpenCode child sessions share this directory stream, but Cloud's
        // product session terminal state belongs to the admitted native root.
        // Projecting a child's idle/error onto the root would complete or fail
        // the product run while its orchestrator is still working.
        if (!belongsToNativeRoot && eventSettlesExecution(mapped)) return
        if (belongsToNativeRoot && eventStartsExecution(mapped)) entry.executionActive = true
        entry.activeUses += 1
        entry.lastUsedAt = Date.now()
        try {
          // Propagate durable-boundary backpressure and failures all the way
          // into the SDK stream. Promise.all keeps multiple product listeners
          // concurrent without allowing the next runtime event to overtake.
          await Promise.all([...listeners.keys()].map((listener) => listener(mapped)))
        } finally {
          // Child sessions share the root runtime's directory-scoped stream. A
          // delegated child becoming idle must not make the still-running root
          // eligible for eviction.
          if (belongsToNativeRoot && eventSettlesExecution(mapped)) entry.executionActive = false
          entry.activeUses = Math.max(0, entry.activeUses - 1)
          entry.lastUsedAt = Date.now()
          // Do not await unsubscribe from inside the callback that the inner
          // stream itself is awaiting; an async unsubscribe could otherwise
          // deadlock terminal delivery. Eligibility is already updated.
          void evictRuntimes()
        }
      },
      {
        onError(error) {
          for (const subscription of listeners.values()) subscription.onError?.(error)
        },
        onDroppedEvent(event) {
          for (const subscription of listeners.values()) subscription.onDroppedEvent?.(event)
        },
      },
    )
    return unsubscribe
  }

  async function recordRuntimeCacheMetric(
    name: string,
    value: number,
    attributes: Record<string, string | number | boolean | undefined> = {},
  ) {
    await recordCloudMetric(options.observability, {
      name,
      value,
      unit: '1',
      attributes: {
        cloud_role: options.policy.role,
        cloud_profile: options.policy.profileName,
        ...attributes,
      },
    })
  }

  async function recordRuntimeEntryCount() {
    await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_entries', runtimes.size)
  }

  async function closeRuntime(key: string, entry: RuntimeEntry, reason: 'idle_ttl' | 'max_entries' | 'shutdown' | 'unexpected_exit') {
    // A dead child must be evicted even mid-request (the adapter is already broken), so the
    // next access rebuilds; idle/max eviction keeps the in-use guard.
    if (
      (reason === 'idle_ttl' || reason === 'max_entries')
      && (entry.activeUses > 0 || entry.executionActive)
    ) return false
    if (runtimes.get(key) !== entry) return true
    runtimes.delete(key)
    try {
      await entry.unsubscribe?.()
      await entry.adapter.close?.()
      await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_evictions_total', 1, { reason })
    } catch (error) {
      await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_close_failures_total', 1, {
        reason,
        error: error instanceof Error ? error.name : 'unknown',
      })
    }
    await recordRuntimeEntryCount()
    return true
  }

  async function evictRuntimes(now = Date.now()) {
    const candidates = Array.from(runtimes.entries())
      .filter(([, entry]) => entry.activeUses === 0 && !entry.executionActive)
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)
    for (const [key, entry] of candidates) {
      const expired = now - entry.lastUsedAt >= runtimeIdleTtlMs
      const overLimit = runtimes.size > maxRuntimeEntries
      if (!expired && !overLimit) break
      await closeRuntime(key, entry, expired ? 'idle_ttl' : 'max_entries')
    }
  }

  async function getRuntimeEntry(contextInput: CloudRuntimeExecutionContext | null | undefined) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    const existing = runtimes.get(key)
    if (existing) {
      existing.lastUsedAt = Date.now()
      await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_hits_total', 1)
      return { key, entry: existing }
    }

    await evictRuntimes()
    await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_misses_total', 1)

    const scopedPaths = createCloudSessionPathProvider(options.paths, context.tenantId, context.sessionId)
    let runtimeConfig: WorkerScopedRuntimeFactoryInput['runtimeConfig']
    try {
      runtimeConfig = await buildCloudByokRuntimeConfig({
        appConfig: options.config,
        byokSecrets: options.byokSecrets,
        context,
        allowKmsRef: true,
        byokPolicy: options.byokPolicy,
      })
    } catch (error) {
      if (error instanceof CloudByokRuntimeConfigError) {
        await recordCloudMetric(options.observability, {
          name: 'open_cowork_cloud_byok_reveal_failures_total',
          value: 1,
          unit: '1',
          attributes: {
            provider_id: error.providerId,
            reason: error.code,
            tenant_id: context.tenantId,
            session_id: context.sessionId,
          },
        })
      }
      throw error
    }
    const adapter = await options.runtimeFactory({
      paths: scopedPaths,
      policy: options.policy,
      env: options.env,
      config: options.config,
      execution: context,
      runtimeConfig,
      // Crash recovery: if the managed OpenCode child dies unexpectedly, evict this entry so
      // the next getRuntimeEntry rebuilds a live runtime rather than reusing the dead one.
      onUnexpectedExit: () => {
        const current = runtimes.get(key)
        if (current) void closeRuntime(key, current, 'unexpected_exit')
      },
    })
    const entry: RuntimeEntry = {
      adapter,
      unsubscribe: null,
      activeUses: 0,
      executionActive: false,
      nativeRootSessionId: null,
      lastUsedAt: Date.now(),
    }
    runtimes.set(key, entry)
    try {
      entry.unsubscribe = await subscribeRuntimeEvents(context, entry)
    } catch (error) {
      runtimes.delete(key)
      await adapter.close?.()
      throw error
    }
    await recordRuntimeEntryCount()
    return { key, entry }
  }

  async function withRuntime<T>(
    contextInput: CloudRuntimeExecutionContext | null | undefined,
    callback: (adapter: CloudRuntimeAdapter, entry: RuntimeEntry) => Promise<T>,
  ) {
    const { entry } = await getRuntimeEntry(contextInput)
    entry.activeUses += 1
    entry.lastUsedAt = Date.now()
    try {
      return await callback(entry.adapter, entry)
    } finally {
      entry.activeUses = Math.max(0, entry.activeUses - 1)
      entry.lastUsedAt = Date.now()
      await evictRuntimes()
    }
  }

  return {
    requiresWorkerContext: true,
    async createSession(input) {
      return withRuntime(input?.context, (adapter) => adapter.createSession({ profileName: input?.profileName || undefined }))
    },
    async promptSession(input) {
      return withRuntime(input.context, async (adapter, entry) => {
        const backgroundExecution = Boolean(adapter.subscribeEvents)
        if (backgroundExecution) {
          entry.nativeRootSessionId = input.sessionId
          entry.executionActive = true
        }
        try {
          const result = await adapter.promptSession(input)
          // Synchronous/fake adapters own execution for the lifetime of this
          // call. Native V2 adapters only admit work here and settle through
          // the subscribed idle/error event.
          if (!backgroundExecution || result?.events?.some(eventSettlesExecution)) {
            entry.executionActive = false
          }
          return result
        } catch (error) {
          entry.executionActive = false
          throw error
        }
      })
    },
    async abortSession(input) {
      return withRuntime(input.context, async (adapter, entry) => {
        await adapter.abortSession(input)
        entry.executionActive = false
      })
    },
    async replyToQuestion(input) {
      return withRuntime(input.context, (adapter) => {
        if (!adapter.replyToQuestion) throw new Error('OpenCode question replies are not available.')
        return adapter.replyToQuestion(input)
      })
    },
    async rejectQuestion(input) {
      return withRuntime(input.context, (adapter) => {
        if (!adapter.rejectQuestion) throw new Error('OpenCode question rejection is not available.')
        return adapter.rejectQuestion(input)
      })
    },
    async respondToPermission(input) {
      return withRuntime(input.context, (adapter) => {
        if (!adapter.respondToPermission) throw new Error('OpenCode permission responses are not available.')
        return adapter.respondToPermission(input)
      })
    },
    async subscribeEvents(listener, subscribeOptions) {
      if (subscribeOptions?.signal?.aborted) return () => undefined
      listeners.set(listener, {
        onError: subscribeOptions?.onError,
        onDroppedEvent: subscribeOptions?.onDroppedEvent,
      })
      const unsubscribeListener = () => {
        subscribeOptions?.signal?.removeEventListener('abort', unsubscribeListener)
        listeners.delete(listener)
      }
      subscribeOptions?.signal?.addEventListener('abort', unsubscribeListener, { once: true })
      for (const [key, entry] of runtimes.entries()) {
        if (entry.unsubscribe) continue
        const [tenantId, sessionId] = key.split('\0')
        entry.unsubscribe = await subscribeRuntimeEvents({ tenantId: tenantId!, sessionId: sessionId! }, entry)
      }
      return unsubscribeListener
    },
    async close() {
      clearInterval(sweepTimer)
      for (const [key, entry] of Array.from(runtimes.entries())) {
        await closeRuntime(key, entry, 'shutdown')
      }
      runtimes.clear()
      listeners.clear()
    },
  }
}
