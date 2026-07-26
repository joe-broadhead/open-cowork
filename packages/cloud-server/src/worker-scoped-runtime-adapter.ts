import type { OpenCoworkConfig } from '@open-cowork/shared'
import type { ByokSecretStore } from './byok-secret-store.ts'
import {
  buildCloudByokRuntimeConfig,
  CloudByokRuntimeConfigError,
  type CloudByokRuntimeProviderPolicy,
} from './byok-runtime-config.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import {
  assertCloudExecutionIsolationAttestation,
  CloudExecutionIsolationError,
  createDevelopmentProcessIsolationProvider,
  type CloudExecutionBoundary,
  type CloudExecutionIsolationPolicy,
  type CloudExecutionIsolationProvider,
  type CloudExecutionProvisionInput,
} from './execution-isolation.ts'
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

export type WorkerScopedRuntimeFactoryInput = CloudExecutionProvisionInput

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
  isolationPolicy?: CloudExecutionIsolationPolicy
  isolationProvider?: CloudExecutionIsolationProvider
  prepareProvision?: (input: CloudExecutionProvisionInput) => Promise<void>
  maxRuntimeEntries?: number
  runtimeIdleTtlMs?: number
}

type RuntimeEntry = {
  key: string
  adapter: CloudRuntimeAdapter
  boundary: CloudExecutionBoundary
  unsubscribe: (() => void | Promise<void>) | null
  activeUses: number
  executionActive: boolean
  nativeRootSessionId: string | null
  lastUsedAt: number
  deferredCloseReason: 'unexpected_exit' | null
  teardownPromise: Promise<boolean> | null
}

type RuntimeEventSubscription = {
  onError?: (error: unknown) => void
  onDroppedEvent?: (event: CloudRuntimeDroppedEvent) => void
}

type RuntimeExecutionScope = {
  entry: RuntimeEntry | null
  owners: number
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
  const pendingRuntimeEntries = new Map<string, Promise<RuntimeEntry>>()
  const executionScopes = new Map<string, RuntimeExecutionScope>()
  const pendingBoundaryCleanup = new Set<CloudExecutionBoundary>()
  const deferredRuntimeClosures = new Set<RuntimeEntry>()
  const closingRuntimeEntries = new Map<string, {
    entry: RuntimeEntry
    promise: Promise<void>
    resolve: () => void
  }>()
  const maintenancePasses = new Set<Promise<void>>()
  const listeners = new Map<CloudRuntimeEventListener, RuntimeEventSubscription>()
  const isolationProvider = options.isolationProvider
    || createDevelopmentProcessIsolationProvider(options.runtimeFactory)
  const maxRuntimeEntries = Math.max(1, Math.floor(options.maxRuntimeEntries || DEFAULT_MAX_RUNTIME_ENTRIES))
  const runtimeIdleTtlMs = Math.max(1, Math.floor(options.runtimeIdleTtlMs || DEFAULT_RUNTIME_IDLE_TTL_MS))
  // Reap idle runtimes on a timer, not only on a cache miss — without this, a worker that
  // processed a burst of sessions then went quiet would keep up to maxRuntimeEntries live
  // OpenCode child processes + workspaces resident until new traffic arrived.
  const sweepTimer = setInterval(() => {
    void trackMaintenancePass(evictRuntimes())
  }, Math.max(1_000, Math.floor(runtimeIdleTtlMs / 2)))
  sweepTimer.unref?.()
  const boundaryCleanupTimer = setInterval(() => {
    void trackMaintenancePass(retryPendingBoundaryCleanup())
  }, 10_000)
  boundaryCleanupTimer.unref?.()
  let adapterClosePromise: Promise<void> | null = null
  let adapterClosing = false
  let activeRuntimeCalls = 0
  const runtimeActivityDrainWaiters = new Set<() => void>()

  function trackMaintenancePass(operation: Promise<void>) {
    let tracked: Promise<void>
    tracked = operation
      .catch(() => undefined)
      .finally(() => maintenancePasses.delete(tracked))
    maintenancePasses.add(tracked)
    return tracked
  }

  async function drainMaintenancePasses() {
    while (maintenancePasses.size > 0) {
      await Promise.allSettled(Array.from(maintenancePasses))
    }
  }

  function runtimeActivityDrained() {
    if (activeRuntimeCalls > 0 || executionScopes.size > 0) return false
    for (const entry of [...runtimes.values(), ...deferredRuntimeClosures]) {
      if (entry.activeUses > 0) return false
    }
    return true
  }

  function notifyRuntimeActivityDrained() {
    if (!runtimeActivityDrained()) return
    for (const resolveDrain of runtimeActivityDrainWaiters) resolveDrain()
    runtimeActivityDrainWaiters.clear()
  }

  function waitForRuntimeActivityToDrain() {
    return runtimeActivityDrained()
      ? Promise.resolve()
      : new Promise<void>((resolveDrain) => runtimeActivityDrainWaiters.add(resolveDrain))
  }

  function ensureRuntimeClosure(entry: RuntimeEntry) {
    const existing = closingRuntimeEntries.get(entry.key)
    if (existing?.entry === entry) return existing
    let resolveClosure: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      resolveClosure = resolve
    })
    const closure = {
      entry,
      promise,
      resolve: resolveClosure,
    }
    closingRuntimeEntries.set(entry.key, closure)
    return closure
  }

  function settleRuntimeClosure(entry: RuntimeEntry) {
    const closure = closingRuntimeEntries.get(entry.key)
    if (closure?.entry !== entry) return
    closingRuntimeEntries.delete(entry.key)
    closure.resolve()
  }

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
          const deferredClose = finishDeferredRuntimeClose(entry)
          const maintenance = trackMaintenancePass(
            deferredClose.then(() => evictRuntimes()),
          )
          notifyRuntimeActivityDrained()
          void maintenance
            .finally(() => notifyRuntimeActivityDrained())
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

  async function retryPendingBoundaryCleanup() {
    for (const boundary of Array.from(pendingBoundaryCleanup)) {
      try {
        await boundary.close()
        pendingBoundaryCleanup.delete(boundary)
        for (const closure of closingRuntimeEntries.values()) {
          if (closure.entry.boundary === boundary) {
            settleRuntimeClosure(closure.entry)
            break
          }
        }
        await recordRuntimeCacheMetric('open_cowork_cloud_isolation_cleanup_retries_total', 1, {
          status: 'ok',
        })
      } catch (error) {
        await recordRuntimeCacheMetric('open_cowork_cloud_isolation_cleanup_retries_total', 1, {
          status: 'failed',
          error: error instanceof Error ? error.name : 'unknown',
        })
      }
    }
  }

  function assertNoBoundaryCleanupDebt() {
    if (pendingBoundaryCleanup.size > 0) {
      throw new CloudExecutionIsolationError(
        'cloud_runtime_boundary_cleanup_pending',
        'Cloud execution boundary cleanup is pending.',
      )
    }
  }

  async function closeProvisionedBoundary(
    boundary: CloudExecutionBoundary,
    unsubscribe: (() => void | Promise<void>) | null = null,
  ) {
    try {
      await unsubscribe?.()
      await boundary.close()
    } catch {
      pendingBoundaryCleanup.add(boundary)
      throw new CloudExecutionIsolationError(
        'cloud_runtime_boundary_cleanup_pending',
        'Cloud execution boundary cleanup is pending.',
      )
    }
  }

  async function teardownRuntimeEntry(
    entry: RuntimeEntry,
    reason: 'idle_ttl' | 'max_entries' | 'shutdown' | 'unexpected_exit',
  ) {
    if (entry.teardownPromise) return entry.teardownPromise
    entry.teardownPromise = (async () => {
      let cleanupFailed = false
      try {
        await entry.unsubscribe?.()
      } catch {
        cleanupFailed = true
      }
      try {
        await entry.boundary.close()
        settleRuntimeClosure(entry)
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_evictions_total', 1, { reason })
      } catch (error) {
        cleanupFailed = true
        pendingBoundaryCleanup.add(entry.boundary)
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_close_failures_total', 1, {
          reason,
          error: error instanceof Error ? error.name : 'unknown',
        })
      } finally {
        deferredRuntimeClosures.delete(entry)
        notifyRuntimeActivityDrained()
      }
      await recordRuntimeEntryCount()
      return !cleanupFailed
    })()
    return entry.teardownPromise
  }

  async function finishDeferredRuntimeClose(entry: RuntimeEntry) {
    const reason = entry.deferredCloseReason
    if (!reason || entry.activeUses > 0) return
    entry.deferredCloseReason = null
    await teardownRuntimeEntry(entry, reason)
  }

  async function closeRuntime(key: string, entry: RuntimeEntry, reason: 'idle_ttl' | 'max_entries' | 'shutdown' | 'unexpected_exit') {
    if (
      (reason === 'idle_ttl' || reason === 'max_entries')
      && (entry.activeUses > 0 || entry.executionActive)
    ) return false
    if (runtimes.get(key) !== entry) return true
    ensureRuntimeClosure(entry)
    runtimes.delete(key)
    if (reason === 'unexpected_exit' && entry.activeUses > 0) {
      entry.executionActive = false
      entry.deferredCloseReason = reason
      deferredRuntimeClosures.add(entry)
      return true
    }
    await teardownRuntimeEntry(entry, reason)
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

  async function provisionRuntimeEntry(
    context: CloudRuntimeExecutionContext,
    key: string,
  ): Promise<RuntimeEntry> {
    await evictRuntimes()
    assertNoBoundaryCleanupDebt()
    await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_misses_total', 1)

    const scopedPaths = createCloudSessionPathProvider(options.paths, context.tenantId, context.sessionId)
    let runtimeConfig: WorkerScopedRuntimeFactoryInput['runtimeConfig']
    try {
      runtimeConfig = await buildCloudByokRuntimeConfig({
        appConfig: options.config,
        byokSecrets: options.byokSecrets,
        context,
        runtimePolicy: options.policy,
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
          },
        })
      }
      throw error
    }
    assertNoBoundaryCleanupDebt()
    let generationEntry: RuntimeEntry | null = null
    let generationPublished = false
    let generationExited = false
    const provisionInput: CloudExecutionProvisionInput = {
      paths: scopedPaths,
      policy: options.policy,
      env: options.env,
      config: options.config,
      execution: context,
      runtimeConfig,
      // Crash recovery: if the managed OpenCode child dies unexpectedly, evict this entry so
      // the next getRuntimeEntry rebuilds a live runtime rather than reusing the dead one.
      onUnexpectedExit: () => {
        generationExited = true
        if (!generationEntry || !generationPublished) {
          return
        }
        if (runtimes.get(key) === generationEntry) {
          void closeRuntime(key, generationEntry, 'unexpected_exit')
        }
      },
    }
    const isolationPreparation = await isolationProvider.prepareProvision?.(
      provisionInput,
    )
    let boundary: CloudExecutionBoundary
    try {
      // Claim and scrub the private runtime scope before checkpoint state is
      // restored into it. provision() then consumes that exact preparation.
      await options.prepareProvision?.(provisionInput)
      boundary = await isolationProvider.provision(provisionInput)
    } catch (error) {
      // Cleanup failure is the security-significant outcome and naturally
      // supersedes the triggering error. The provider retains its reservation
      // so close() can retry cleanup.
      await isolationPreparation?.release()
      throw error
    }
    if (options.isolationPolicy) {
      try {
        assertCloudExecutionIsolationAttestation(options.isolationPolicy, boundary.attestation)
      } catch (error) {
        await closeProvisionedBoundary(boundary)
        throw error
      }
    }
    const adapter = boundary.adapter
    const entry: RuntimeEntry = {
      key,
      adapter,
      boundary,
      unsubscribe: null,
      activeUses: 0,
      executionActive: false,
      nativeRootSessionId: null,
      lastUsedAt: Date.now(),
      deferredCloseReason: null,
      teardownPromise: null,
    }
    generationEntry = entry
    try {
      entry.unsubscribe = await subscribeRuntimeEvents(context, entry)
    } catch (error) {
      await closeProvisionedBoundary(boundary)
      throw error
    }
    if (pendingBoundaryCleanup.size > 0) {
      await closeProvisionedBoundary(boundary, entry.unsubscribe)
      throw new CloudExecutionIsolationError(
        'cloud_runtime_boundary_cleanup_pending',
        'Cloud execution boundary cleanup is pending.',
      )
    }
    if (generationExited) {
      await closeProvisionedBoundary(boundary, entry.unsubscribe)
      throw new CloudExecutionIsolationError(
        'cloud_runtime_boundary_unexpected_exit',
      )
    }
    // Publish only after lifecycle subscription is fully ready.
    runtimes.set(key, entry)
    generationPublished = true
    await recordRuntimeEntryCount()
    if (generationExited || runtimes.get(key) !== entry) {
      throw new CloudExecutionIsolationError(
        generationExited
          ? 'cloud_runtime_boundary_unexpected_exit'
          : 'cloud_runtime_boundary_evicted_before_use',
      )
    }
    return entry
  }

  async function getRuntimeEntry(contextInput: CloudRuntimeExecutionContext | null | undefined) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    while (true) {
      const closing = closingRuntimeEntries.get(key)
      if (closing) {
        await closing.promise
        assertNoBoundaryCleanupDebt()
        continue
      }
      const pending = pendingRuntimeEntries.get(key)
      if (pending) {
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_hits_total', 1, {
          state: 'provisioning',
        })
        return { key, entry: await pending }
      }
      const existing = runtimes.get(key)
      if (existing) {
        existing.lastUsedAt = Date.now()
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_hits_total', 1)
        return { key, entry: existing }
      }

      const provisioning = provisionRuntimeEntry(context, key)
      pendingRuntimeEntries.set(key, provisioning)
      try {
        return { key, entry: await provisioning }
      } finally {
        if (pendingRuntimeEntries.get(key) === provisioning) {
          pendingRuntimeEntries.delete(key)
        }
      }
    }
  }

  async function withRuntime<T>(
    contextInput: CloudRuntimeExecutionContext | null | undefined,
    callback: (adapter: CloudRuntimeAdapter, entry: RuntimeEntry) => Promise<T>,
  ) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    if (adapterClosing && !executionScopes.has(key)) {
      throw new CloudExecutionIsolationError('cloud_runtime_adapter_closing')
    }
    activeRuntimeCalls += 1
    try {
      const { entry } = await getRuntimeEntry(context)
      const executionScope = executionScopes.get(key)
      if (executionScope && executionScope.entry !== entry) {
        if (executionScope.entry) {
          executionScope.entry.activeUses = Math.max(
            0,
            executionScope.entry.activeUses - 1,
          )
        }
        executionScope.entry = entry
        entry.activeUses += 1
      }
      entry.activeUses += 1
      entry.lastUsedAt = Date.now()
      try {
        return await callback(entry.adapter, entry)
      } finally {
        entry.activeUses = Math.max(0, entry.activeUses - 1)
        entry.lastUsedAt = Date.now()
        await finishDeferredRuntimeClose(entry)
        await evictRuntimes()
      }
    } finally {
      activeRuntimeCalls = Math.max(0, activeRuntimeCalls - 1)
      notifyRuntimeActivityDrained()
    }
  }

  async function runInExecutionScope<T>(
    contextInput: CloudRuntimeExecutionContext | null | undefined,
    callback: () => Promise<T>,
  ) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    let scope = executionScopes.get(key)
    if (!scope) {
      if (adapterClosing) {
        throw new CloudExecutionIsolationError('cloud_runtime_adapter_closing')
      }
      scope = { entry: null, owners: 0 }
      executionScopes.set(key, scope)
    }
    scope.owners += 1
    try {
      return await callback()
    } finally {
      scope.owners = Math.max(0, scope.owners - 1)
      if (scope.owners === 0 && executionScopes.get(key) === scope) {
        executionScopes.delete(key)
        if (scope.entry) {
          scope.entry.activeUses = Math.max(0, scope.entry.activeUses - 1)
          scope.entry.lastUsedAt = Date.now()
          await finishDeferredRuntimeClose(scope.entry)
        }
        await evictRuntimes()
        notifyRuntimeActivityDrained()
      }
    }
  }

  async function closeAdapter() {
    clearInterval(sweepTimer)
    clearInterval(boundaryCleanupTimer)
    let cleanupFailed = false
    await waitForRuntimeActivityToDrain()
    await drainMaintenancePasses()
    await Promise.allSettled(Array.from(pendingRuntimeEntries.values()))
    const closingResults = await Promise.allSettled(
      Array.from(closingRuntimeEntries.values()).map(async ({ entry }) => {
        await finishDeferredRuntimeClose(entry)
        return entry.teardownPromise ? await entry.teardownPromise : true
      }),
    )
    if (closingResults.some((result) => result.status === 'rejected')) {
      cleanupFailed = true
    }
    for (const [key, entry] of Array.from(runtimes.entries())) {
      try {
        await closeRuntime(key, entry, 'shutdown')
      } catch {
        cleanupFailed = true
      }
    }
    for (const entry of Array.from(deferredRuntimeClosures)) {
      try {
        await finishDeferredRuntimeClose(entry)
      } catch {
        cleanupFailed = true
      }
    }
    if (deferredRuntimeClosures.size > 0) cleanupFailed = true
    for (let attempt = 0; attempt < 3 && pendingBoundaryCleanup.size > 0; attempt += 1) {
      try {
        await retryPendingBoundaryCleanup()
      } catch {
        cleanupFailed = true
      }
    }
    try {
      await isolationProvider.close?.()
    } catch {
      cleanupFailed = true
    }
    // A provider-level final drain may have resolved debt that the adapter
    // still tracks. Re-run idempotent boundary close once before surfacing it.
    if (pendingBoundaryCleanup.size > 0) {
      try {
        await retryPendingBoundaryCleanup()
      } catch {
        cleanupFailed = true
      }
    }
    const cleanupResidue = pendingBoundaryCleanup.size > 0
    runtimes.clear()
    pendingRuntimeEntries.clear()
    executionScopes.clear()
    deferredRuntimeClosures.clear()
    closingRuntimeEntries.clear()
    listeners.clear()
    if (cleanupFailed || cleanupResidue) {
      throw new CloudExecutionIsolationError(
        'sandbox_runtime_teardown_failed',
        'Cloud execution boundary teardown failed.',
      )
    }
  }

  return {
    requiresWorkerContext: true,
    async withExecutionScope(context, callback) {
      return runInExecutionScope(context, callback)
    },
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
    close() {
      if (!adapterClosePromise) {
        adapterClosing = true
        adapterClosePromise = closeAdapter()
      }
      return adapterClosePromise
    },
  }
}
