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

  async function subscribeRuntimeEvents(context: CloudRuntimeExecutionContext, adapter: CloudRuntimeAdapter) {
    if (!adapter.subscribeEvents || listeners.size === 0) return null
    const unsubscribe = await adapter.subscribeEvents(
      (event) => {
        const mapped = mapRuntimeEventToCoworkSession(context, event)
        for (const listener of listeners.keys()) {
          void listener(mapped)
        }
      },
      {
        onError(error) {
          for (const entry of listeners.values()) entry.onError?.(error)
        },
        onDroppedEvent(event) {
          for (const entry of listeners.values()) entry.onDroppedEvent?.(event)
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

  async function closeRuntime(key: string, entry: RuntimeEntry, reason: 'idle_ttl' | 'max_entries' | 'shutdown') {
    if (entry.activeUses > 0) return false
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
      .filter(([, entry]) => entry.activeUses === 0)
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
    })
    const unsubscribe = await subscribeRuntimeEvents(context, adapter)
    const entry = {
      adapter,
      unsubscribe,
      activeUses: 0,
      lastUsedAt: Date.now(),
    }
    runtimes.set(key, entry)
    await recordRuntimeEntryCount()
    return { key, entry }
  }

  async function withRuntime<T>(
    contextInput: CloudRuntimeExecutionContext | null | undefined,
    callback: (adapter: CloudRuntimeAdapter) => Promise<T>,
  ) {
    const { entry } = await getRuntimeEntry(contextInput)
    entry.activeUses += 1
    entry.lastUsedAt = Date.now()
    try {
      return await callback(entry.adapter)
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
      return withRuntime(input.context, (adapter) => adapter.promptSession(input))
    },
    async abortSession(input) {
      return withRuntime(input.context, (adapter) => adapter.abortSession(input))
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
        entry.unsubscribe = await subscribeRuntimeEvents({ tenantId: tenantId!, sessionId: sessionId! }, entry.adapter)
      }
      return unsubscribeListener
    },
    async close() {
      for (const [key, entry] of Array.from(runtimes.entries())) {
        await closeRuntime(key, entry, 'shutdown')
      }
      runtimes.clear()
      listeners.clear()
    },
  }
}
