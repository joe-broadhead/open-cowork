import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
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
  CloudExecutionCleanupDebtError,
  CloudExecutionIsolationError,
  createDevelopmentProcessIsolationProvider,
  type CloudExecutionBoundary,
  type CloudExecutionIsolationPolicy,
  type CloudExecutionIsolationProvider,
  type CloudExecutionProvisionInput,
} from './execution-isolation.ts'
import {
  recordCloudMetric,
  type CloudMetricRecord,
  type CloudObservabilityAdapter,
} from './observability.ts'
import type { PathProvider } from './path-provider.ts'
import { createCloudSessionPathProvider } from './path-provider.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeDroppedEvent,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
  CloudRuntimeExecutionContext,
} from './runtime-adapter.ts'
import {
  CloudRuntimeCapacityError,
  type CloudRuntimeCapacityReason,
} from './runtime-capacity.ts'

export {
  CloudRuntimeCapacityError,
  type CloudRuntimeCapacityReason,
} from './runtime-capacity.ts'

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
  maxAdmissionQueueEntries?: number
  admissionQueueTimeoutMs?: number
  runtimeProvisionTimeoutMs?: number
  runtimeTeardownTimeoutMs?: number
}

type RuntimeEntry = {
  key: string
  adapter: CloudRuntimeAdapter
  boundary: CloudExecutionBoundary
  unsubscribe: (() => void | Promise<void>) | null
  activeUses: number
  executionActive: boolean
  nativeRootSessionId: string | null
  executionGeneration: number
  activeExecutionKey: string | null
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

type RuntimeCapacityPermit = {
  release(): void
}

type RuntimeProvisionClaim = {
  entry: RuntimeEntry | null
}

type RuntimeAdmissionWaiter = {
  resolve: (permit: RuntimeCapacityPermit) => void
  reject: (error: unknown) => void
  timeout: ReturnType<typeof setTimeout> | null
  signal: AbortSignal | undefined
  onAbort: (() => void) | null
}

type PendingRuntimeProvision = {
  key: string
  controller: AbortController
  promise: Promise<RuntimeEntry>
  timeout: ReturnType<typeof setTimeout> | null
  waiterCount: number
  settled: boolean
  provisionClaim: RuntimeProvisionClaim
}

const DEFAULT_MAX_RUNTIME_ENTRIES = 100
const DEFAULT_RUNTIME_IDLE_TTL_MS = 30 * 60 * 1000
const DEFAULT_MAX_ADMISSION_QUEUE_ENTRIES = 100
const DEFAULT_ADMISSION_QUEUE_TIMEOUT_MS = 30_000
const DEFAULT_RUNTIME_PROVISION_TIMEOUT_MS = 120_000
const DEFAULT_RUNTIME_TEARDOWN_TIMEOUT_MS = 30_000
const WORKER_PRESSURE_SAMPLE_INTERVAL_MS = 10_000

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
  const pendingRuntimeEntries = new Map<string, PendingRuntimeProvision>()
  const inFlightRuntimeProvisions = new Set<PendingRuntimeProvision>()
  const creatingRuntimeKeys = new Set<string>()
  const admissionQueue: RuntimeAdmissionWaiter[] = []
  const capacityPermitsByBoundary = new Map<CloudExecutionBoundary, RuntimeCapacityPermit>()
  const capacityCleanupDebts = new Set<RuntimeCapacityPermit>()
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
  const maxAdmissionQueueEntries = Math.max(
    1,
    Math.floor(options.maxAdmissionQueueEntries || DEFAULT_MAX_ADMISSION_QUEUE_ENTRIES),
  )
  const admissionQueueTimeoutMs = Math.max(
    1,
    Math.floor(options.admissionQueueTimeoutMs || DEFAULT_ADMISSION_QUEUE_TIMEOUT_MS),
  )
  const runtimeProvisionTimeoutMs = Math.max(
    1,
    Math.floor(options.runtimeProvisionTimeoutMs || DEFAULT_RUNTIME_PROVISION_TIMEOUT_MS),
  )
  const runtimeTeardownTimeoutMs = Math.max(
    1,
    Math.floor(options.runtimeTeardownTimeoutMs || DEFAULT_RUNTIME_TEARDOWN_TIMEOUT_MS),
  )
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
  const pressureTimer = setInterval(() => {
    void recordRuntimePressure()
  }, WORKER_PRESSURE_SAMPLE_INTERVAL_MS)
  pressureTimer.unref?.()
  let adapterClosePromise: Promise<void> | null = null
  let adapterClosing = false
  let capacityInUse = 0
  let cleanupDebtGeneration = 0
  let previousEventLoopUtilization = performance.eventLoopUtilization()
  let runtimeStateObservationScheduled = false
  let activeRuntimeCalls = 0
  let admissionPressurePass: Promise<void> | null = null
  const runtimeActivityDrainWaiters = new Set<() => void>()
  void recordRuntimePressure()
  observeRuntimeState()

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

  async function settlesWithin(
    promises: Iterable<Promise<unknown>>,
    timeoutMs: number,
  ) {
    const pending = Array.from(promises)
    if (pending.length === 0) return true
    let timeout: ReturnType<typeof setTimeout> | null = null
    const timedOut = new Promise<false>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(false), timeoutMs)
    })
    const settled = Promise.allSettled(pending).then(() => true as const)
    const result = await Promise.race([settled, timedOut])
    if (timeout) clearTimeout(timeout)
    return result
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

  async function dispatchRuntimeEvent(
    context: CloudRuntimeExecutionContext,
    entry: RuntimeEntry,
    event: CloudRuntimeEvent,
  ) {
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
      // Propagate durable-boundary backpressure and failures all the way into
      // the SDK stream. Promise.all keeps product listeners concurrent
      // without allowing the next runtime event to overtake.
      await Promise.all([...listeners.keys()].map((listener) => listener(mapped)))
    } finally {
      // Child sessions share the root runtime's directory-scoped stream. A
      // delegated child becoming idle must not make the still-running root
      // eligible for eviction.
      if (belongsToNativeRoot && eventSettlesExecution(mapped)) {
        entry.executionActive = false
        entry.activeExecutionKey = null
      }
      entry.activeUses = Math.max(0, entry.activeUses - 1)
      entry.lastUsedAt = Date.now()
      // Do not await unsubscribe from inside the callback that the inner
      // stream itself is awaiting; an async unsubscribe could otherwise
      // deadlock terminal delivery. Eligibility is already updated.
      const deferredClose = finishDeferredRuntimeClose(entry)
      const maintenance = trackMaintenancePass(
        deferredClose
          .then(() => evictRuntimes())
          .then(() => relieveAdmissionPressure()),
      )
      observeRuntimeState()
      notifyRuntimeActivityDrained()
      void maintenance.finally(() => notifyRuntimeActivityDrained())
    }
  }

  async function subscribeRuntimeEvents(context: CloudRuntimeExecutionContext, entry: RuntimeEntry) {
    const { adapter } = entry
    if (!adapter.subscribeEvents || listeners.size === 0) return null
    const unsubscribe = await adapter.subscribeEvents(
      (event) => dispatchRuntimeEvent(context, entry, event),
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

  function unexpectedExitEventId(
    context: CloudRuntimeExecutionContext,
    entry: RuntimeEntry,
    executionKey: string,
  ) {
    const digest = createHash('sha256')
      .update(context.tenantId)
      .update('\0')
      .update(context.sessionId)
      .update('\0')
      .update(executionKey)
      .update('\0')
      .update(String(entry.executionGeneration))
      .digest('hex')
      .slice(0, 32)
    return `cloud-runtime-exit:${digest}`
  }

  async function reportUnexpectedRuntimeExit(
    context: CloudRuntimeExecutionContext,
    entry: RuntimeEntry,
    executionKey: string,
  ) {
    const event: CloudRuntimeEvent = {
      eventId: unexpectedExitEventId(context, entry, executionKey),
      type: 'runtime.error',
      payload: {
        sessionId: entry.nativeRootSessionId || context.sessionId,
        message: 'The Cloud runtime exited unexpectedly.',
        errorCode: 'cloud_runtime_boundary_unexpected_exit',
      },
    }
    let lastError: unknown = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await dispatchRuntimeEvent(context, entry, event)
        return
      } catch (error) {
        lastError = error
        if (attempt < 2) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 50 * (attempt + 1)))
        }
      }
    }
    for (const subscription of listeners.values()) {
      subscription.onError?.(lastError)
    }
    throw lastError
  }

  async function recordRuntimeCacheMetric(
    name: string,
    value: number,
    attributes: Record<string, string | number | boolean | undefined> = {},
    metricOptions: Pick<CloudMetricRecord, 'kind' | 'unit' | 'aggregationTemporality'> = {},
  ) {
    await recordCloudMetric(options.observability, {
      name,
      value,
      kind: metricOptions.kind,
      unit: metricOptions.unit || '1',
      aggregationTemporality: metricOptions.aggregationTemporality,
      attributes: {
        cloud_role: options.policy.role,
        cloud_profile: options.policy.profileName,
        ...attributes,
      },
    })
  }

  async function recordRuntimeEntryCount() {
    await recordRuntimeCacheMetric(
      'open_cowork_cloud_runtime_cache_entries',
      runtimes.size,
      {},
      { kind: 'gauge' },
    )
  }

  async function recordRuntimePressure() {
    const cpu = process.cpuUsage()
    const currentEventLoopUtilization = performance.eventLoopUtilization()
    const eventLoop = performance.eventLoopUtilization(previousEventLoopUtilization)
    previousEventLoopUtilization = currentEventLoopUtilization
    await Promise.all([
      recordRuntimeCacheMetric(
        'open_cowork_cloud_worker_rss_bytes',
        process.memoryUsage.rss(),
        {},
        { kind: 'gauge' },
      ),
      recordRuntimeCacheMetric(
        'open_cowork_cloud_worker_cpu_user_seconds_total',
        cpu.user / 1_000_000,
        {},
        { kind: 'counter', unit: 's', aggregationTemporality: 'cumulative' },
      ),
      recordRuntimeCacheMetric(
        'open_cowork_cloud_worker_cpu_system_seconds_total',
        cpu.system / 1_000_000,
        {},
        { kind: 'counter', unit: 's', aggregationTemporality: 'cumulative' },
      ),
      recordRuntimeCacheMetric(
        'open_cowork_cloud_worker_event_loop_utilization_ratio',
        Math.max(0, Math.min(1, eventLoop.utilization)),
        {},
        { kind: 'gauge' },
      ),
    ])
  }

  async function recordRuntimeState() {
    const active = Array.from(runtimes.values()).filter(
      (entry) => entry.activeUses > 0 || entry.executionActive,
    ).length
    const cached = Math.max(0, runtimes.size - active)
    await Promise.all([
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_capacity', maxRuntimeEntries, {}, { kind: 'gauge' }),
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_capacity_in_use', capacityInUse, {}, { kind: 'gauge' }),
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_cached', cached, {}, { kind: 'gauge' }),
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_active', active, {}, { kind: 'gauge' }),
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_creating', creatingRuntimeKeys.size, {}, { kind: 'gauge' }),
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_cleanup_debt', capacityCleanupDebts.size, {}, { kind: 'gauge' }),
      recordRuntimeCacheMetric('open_cowork_cloud_runtime_admission_queue_depth', admissionQueue.length, {}, { kind: 'gauge' }),
    ])
  }

  function observeRuntimeState() {
    if (runtimeStateObservationScheduled) return
    runtimeStateObservationScheduled = true
    queueMicrotask(() => {
      runtimeStateObservationScheduled = false
      void recordRuntimeState()
    })
  }

  function capacityAbortError(signal: AbortSignal) {
    return signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The operation was aborted.', 'AbortError')
  }

  function throwIfAdmissionAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw capacityAbortError(signal)
  }

  async function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal) {
    throwIfAdmissionAborted(signal)
    if (!signal) return promise
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = () => finish(() => reject(capacityAbortError(signal)))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) {
        onAbort()
        return
      }
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  }

  function startRuntimeProvision(
    context: CloudRuntimeExecutionContext,
    key: string,
  ): PendingRuntimeProvision {
    const controller = new AbortController()
    const provisionClaim: RuntimeProvisionClaim = { entry: null }
    const promise = provisionRuntimeEntry(
      context,
      key,
      controller.signal,
      provisionClaim,
    )
    const pending: PendingRuntimeProvision = {
      key,
      controller,
      promise,
      timeout: null,
      waiterCount: 0,
      settled: false,
      provisionClaim,
    }
    pending.timeout = setTimeout(() => {
      controller.abort(
        new CloudRuntimeCapacityError('provision_timeout', admissionQueueTimeoutMs),
      )
    }, runtimeProvisionTimeoutMs)
    pendingRuntimeEntries.set(key, pending)
    inFlightRuntimeProvisions.add(pending)
    observeRuntimeState()
    void pending.promise.then(
      () => settleRuntimeProvision(pending),
      () => settleRuntimeProvision(pending),
    )
    return pending
  }

  function settleRuntimeProvision(pending: PendingRuntimeProvision) {
    pending.settled = true
    if (pending.timeout) clearTimeout(pending.timeout)
    pending.timeout = null
    inFlightRuntimeProvisions.delete(pending)
    if (pendingRuntimeEntries.get(pending.key) === pending) {
      pendingRuntimeEntries.delete(pending.key)
      observeRuntimeState()
    }
  }

  function relinquishUnconsumedProvisionClaim(pending: PendingRuntimeProvision) {
    void pending.promise.then(
      (entry) => {
        if (
          pending.waiterCount > 0
          || pending.provisionClaim.entry !== entry
        ) return
        pending.provisionClaim.entry = null
        entry.activeUses = Math.max(0, entry.activeUses - 1)
        entry.lastUsedAt = Date.now()
        const release = (async () => {
          await finishDeferredRuntimeClose(entry)
          if (
            entry.activeUses === 0
            && !entry.executionActive
            && runtimes.get(entry.key) === entry
          ) {
            await closeRuntime(entry.key, entry, 'shutdown')
          }
          if (hasBoundaryCleanupDebt()) {
            rejectAdmissionQueue('cleanup_pending')
          } else {
            await relieveAdmissionPressure()
          }
          observeRuntimeState()
          notifyRuntimeActivityDrained()
        })()
        void trackMaintenancePass(release)
      },
      () => undefined,
    )
  }

  async function waitForRuntimeProvision(
    pending: PendingRuntimeProvision,
    signal?: AbortSignal,
  ) {
    throwIfAdmissionAborted(signal)
    throwIfAdmissionAborted(pending.controller.signal)
    pending.waiterCount += 1
    const abortListeners = new Map<AbortSignal, () => void>()
    try {
      const entry = await new Promise<RuntimeEntry>((resolve, reject) => {
        let waiterSettled = false
        const settleWaiter = (callback: () => void) => {
          if (waiterSettled) return
          waiterSettled = true
          for (const [abortSignal, listener] of abortListeners) {
            abortSignal.removeEventListener('abort', listener)
          }
          abortListeners.clear()
          callback()
        }
        for (const abortSignal of new Set(
          [signal, pending.controller.signal].filter(
            (candidate): candidate is AbortSignal => Boolean(candidate),
          ),
        )) {
          const listener = () => settleWaiter(
            () => reject(capacityAbortError(abortSignal)),
          )
          abortListeners.set(abortSignal, listener)
          abortSignal.addEventListener('abort', listener, { once: true })
          if (abortSignal.aborted) {
            listener()
            break
          }
        }
        pending.promise.then(
          (resolvedEntry) => settleWaiter(() => resolve(resolvedEntry)),
          (error) => settleWaiter(() => reject(error)),
        )
      })
      if (pending.provisionClaim.entry === entry) {
        pending.provisionClaim.entry = null
      } else {
        entry.activeUses += 1
      }
      entry.lastUsedAt = Date.now()
      observeRuntimeState()
      return { entry, entryClaimed: true }
    } finally {
      for (const [abortSignal, listener] of abortListeners) {
        abortSignal.removeEventListener('abort', listener)
      }
      pending.waiterCount = Math.max(0, pending.waiterCount - 1)
      if (pending.waiterCount === 0) {
        relinquishUnconsumedProvisionClaim(pending)
        if (!pending.settled && !pending.controller.signal.aborted) {
          // Keep the aborted generation discoverable until its provision promise
          // settles. A provider may ignore cancellation after allocating its
          // boundary, and a same-key retry must not create a second generation
          // before that allocation has been closed.
          pending.controller.abort(
            signal?.aborted
              ? capacityAbortError(signal)
              : new DOMException('Runtime provisioning has no remaining waiters.', 'AbortError'),
          )
        }
      }
    }
  }

  function removeAdmissionWaiter(waiter: RuntimeAdmissionWaiter) {
    const index = admissionQueue.indexOf(waiter)
    if (index < 0) return false
    admissionQueue.splice(index, 1)
    if (waiter.timeout) clearTimeout(waiter.timeout)
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
    }
    waiter.timeout = null
    waiter.onAbort = null
    observeRuntimeState()
    return true
  }

  async function recordCapacityRejection(reason: CloudRuntimeCapacityReason) {
    await recordRuntimeCacheMetric(
      'open_cowork_cloud_runtime_admission_rejections_total',
      1,
      { reason },
      { kind: 'counter' },
    )
  }

  function rejectAdmissionWaiter(
    waiter: RuntimeAdmissionWaiter,
    error: unknown,
    reason?: CloudRuntimeCapacityReason,
  ) {
    if (!removeAdmissionWaiter(waiter)) return
    if (reason) void recordCapacityRejection(reason)
    waiter.reject(error)
  }

  function rejectAdmissionQueue(reason: CloudRuntimeCapacityReason) {
    for (const waiter of Array.from(admissionQueue)) {
      rejectAdmissionWaiter(
        waiter,
        new CloudRuntimeCapacityError(reason, admissionQueueTimeoutMs),
        reason,
      )
    }
  }

  function createCapacityPermit(): RuntimeCapacityPermit {
    capacityInUse += 1
    let released = false
    observeRuntimeState()
    return {
      release() {
        if (released) return
        released = true
        capacityInUse = Math.max(0, capacityInUse - 1)
        dispatchAdmissionQueue()
        observeRuntimeState()
      },
    }
  }

  function dispatchAdmissionQueue() {
    if (adapterClosing) {
      rejectAdmissionQueue('adapter_closing')
      return
    }
    while (capacityInUse < maxRuntimeEntries && admissionQueue.length > 0) {
      const waiter = admissionQueue[0]!
      if (!removeAdmissionWaiter(waiter)) continue
      waiter.resolve(createCapacityPermit())
    }
  }

  async function evictOneIdleRuntimeForAdmission() {
    const candidate = Array.from(runtimes.entries())
      .filter(([, entry]) => entry.activeUses === 0 && !entry.executionActive)
      .sort(([, left], [, right]) => left.lastUsedAt - right.lastUsedAt)[0]
    if (!candidate) return false
    return closeRuntime(candidate[0], candidate[1], 'max_entries')
  }

  function scheduleAdmissionPressure() {
    if (admissionPressurePass) return admissionPressurePass
    const pass = (async () => {
      dispatchAdmissionQueue()
      while (
        !adapterClosing
        && admissionQueue.length > 0
        && capacityInUse >= maxRuntimeEntries
      ) {
        if (!await evictOneIdleRuntimeForAdmission()) break
        dispatchAdmissionQueue()
      }
    })()
    admissionPressurePass = pass
    const clearPass = () => {
      if (admissionPressurePass === pass) admissionPressurePass = null
    }
    void pass.then(clearPass, clearPass)
    return pass
  }

  async function relieveAdmissionPressure() {
    await scheduleAdmissionPressure()
  }

  async function acquireRuntimeCapacity(signal?: AbortSignal) {
    if (signal?.aborted) throw capacityAbortError(signal)
    if (adapterClosing) {
      await recordCapacityRejection('adapter_closing')
      throw new CloudRuntimeCapacityError('adapter_closing', admissionQueueTimeoutMs)
    }
    if (capacityCleanupDebts.size > 0 || pendingBoundaryCleanup.size > 0) {
      await recordCapacityRejection('cleanup_pending')
      throw new CloudRuntimeCapacityError('cleanup_pending', admissionQueueTimeoutMs)
    }
    if (capacityInUse < maxRuntimeEntries && admissionQueue.length === 0) {
      return createCapacityPermit()
    }
    if (admissionQueue.length >= maxAdmissionQueueEntries) {
      await recordCapacityRejection('queue_full')
      throw new CloudRuntimeCapacityError('queue_full', admissionQueueTimeoutMs)
    }

    return new Promise<RuntimeCapacityPermit>((resolve, reject) => {
      const waiter: RuntimeAdmissionWaiter = {
        resolve,
        reject,
        timeout: null,
        signal,
        onAbort: null,
      }
      waiter.timeout = setTimeout(() => {
        rejectAdmissionWaiter(
          waiter,
          new CloudRuntimeCapacityError('queue_timeout', admissionQueueTimeoutMs),
          'queue_timeout',
        )
      }, admissionQueueTimeoutMs)
      waiter.timeout.unref?.()
      if (signal) {
        waiter.onAbort = () => rejectAdmissionWaiter(waiter, capacityAbortError(signal))
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      admissionQueue.push(waiter)
      observeRuntimeState()
      dispatchAdmissionQueue()
      if (signal?.aborted) {
        rejectAdmissionWaiter(waiter, capacityAbortError(signal))
        return
      }
      void scheduleAdmissionPressure()
    })
  }

  function releaseBoundaryCapacity(boundary: CloudExecutionBoundary) {
    const permit = capacityPermitsByBoundary.get(boundary)
    if (!permit) return
    capacityPermitsByBoundary.delete(boundary)
    permit.release()
  }

  function retainPendingBoundaryCleanup(boundary: CloudExecutionBoundary) {
    if (pendingBoundaryCleanup.has(boundary)) return
    pendingBoundaryCleanup.add(boundary)
    cleanupDebtGeneration += 1
    observeRuntimeState()
  }

  function retainCapacityForCleanupDebt(
    permit: RuntimeCapacityPermit,
    cleanup: Promise<void>,
  ) {
    if (!capacityCleanupDebts.has(permit)) {
      capacityCleanupDebts.add(permit)
      cleanupDebtGeneration += 1
    }
    observeRuntimeState()
    void cleanup.then(
      () => {
        if (!capacityCleanupDebts.delete(permit)) return
        permit.release()
        observeRuntimeState()
        void scheduleAdmissionPressure()
      },
      () => {
        // Cleanup debt is fail-closed. A rejected provider signal is not proof
        // that the boundary is gone, so the hard-cap permit remains retained.
        observeRuntimeState()
      },
    )
  }

  function hasBoundaryCleanupDebt(sinceGeneration?: number) {
    return pendingBoundaryCleanup.size > 0
      || capacityCleanupDebts.size > 0
      || (
        sinceGeneration !== undefined
        && cleanupDebtGeneration !== sinceGeneration
      )
  }

  async function retryPendingBoundaryCleanup() {
    for (const boundary of Array.from(pendingBoundaryCleanup)) {
      try {
        await boundary.close()
        pendingBoundaryCleanup.delete(boundary)
        releaseBoundaryCapacity(boundary)
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
    if (hasBoundaryCleanupDebt()) {
      throw new CloudRuntimeCapacityError(
        'cleanup_pending',
        admissionQueueTimeoutMs,
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
      releaseBoundaryCapacity(boundary)
    } catch {
      retainPendingBoundaryCleanup(boundary)
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
        releaseBoundaryCapacity(entry.boundary)
        settleRuntimeClosure(entry)
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_evictions_total', 1, { reason })
      } catch (error) {
        cleanupFailed = true
        retainPendingBoundaryCleanup(entry.boundary)
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_close_failures_total', 1, {
          reason,
          error: error instanceof Error ? error.name : 'unknown',
        })
      } finally {
        deferredRuntimeClosures.delete(entry)
        observeRuntimeState()
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
    observeRuntimeState()
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
    signal: AbortSignal | undefined,
    provisionClaim: RuntimeProvisionClaim,
  ): Promise<RuntimeEntry> {
    const creationStartedAt = Date.now()
    const capacityPermit = await acquireRuntimeCapacity(signal)
    let capacityPermitTransferred = false
    try {
      throwIfAdmissionAborted(signal)
      creatingRuntimeKeys.add(key)
      observeRuntimeState()
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
      throwIfAdmissionAborted(signal)
      assertNoBoundaryCleanupDebt()
      let generationEntry: RuntimeEntry | null = null
      let generationPublished = false
      let generationExited = false
      let generationExitHandled = false
      const provisionInput: CloudExecutionProvisionInput = {
        paths: scopedPaths,
        policy: options.policy,
        env: options.env,
        config: options.config,
        execution: context,
        runtimeConfig,
        signal,
        // Crash recovery: if the managed OpenCode child dies unexpectedly, evict this entry so
        // the next getRuntimeEntry rebuilds a live runtime rather than reusing the dead one.
        onUnexpectedExit: () => {
          generationExited = true
          if (
            generationExitHandled
            || !generationEntry
            || !generationPublished
            || runtimes.get(key) !== generationEntry
          ) return
          generationExitHandled = true
          const exitedEntry = generationEntry
          const executionKey = exitedEntry.activeExecutionKey
          const reportAndClose = (async () => {
            try {
              if (exitedEntry.executionActive && executionKey) {
                await reportUnexpectedRuntimeExit(context, exitedEntry, executionKey)
              }
            } finally {
              await closeRuntime(key, exitedEntry, 'unexpected_exit')
            }
          })()
          void trackMaintenancePass(reportAndClose)
        },
      }
      const isolationPreparation = await isolationProvider.prepareProvision?.(
        provisionInput,
      )
      let boundary: CloudExecutionBoundary
      try {
        throwIfAdmissionAborted(signal)
        // Claim and scrub the private runtime scope before checkpoint state is
        // restored into it. provision() then consumes that exact preparation.
        await options.prepareProvision?.(provisionInput)
        throwIfAdmissionAborted(signal)
        boundary = await isolationProvider.provision(provisionInput)
      } catch (error) {
        // Cleanup failure is the security-significant outcome and naturally
        // supersedes the triggering error. The provider retains its reservation
        // so close() can retry cleanup.
        await isolationPreparation?.release()
        throw error
      }
      capacityPermitsByBoundary.set(boundary, capacityPermit)
      capacityPermitTransferred = true
      if (signal?.aborted) {
        await closeProvisionedBoundary(boundary)
        throw capacityAbortError(signal)
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
        executionGeneration: 0,
        activeExecutionKey: null,
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
      if (signal?.aborted) {
        await closeProvisionedBoundary(boundary, entry.unsubscribe)
        throw capacityAbortError(signal)
      }
      if (hasBoundaryCleanupDebt()) {
        await closeProvisionedBoundary(boundary, entry.unsubscribe)
        throw new CloudRuntimeCapacityError(
          'cleanup_pending',
          admissionQueueTimeoutMs,
        )
      }
      const publicationCleanupDebtGeneration = cleanupDebtGeneration
      if (generationExited) {
        await closeProvisionedBoundary(boundary, entry.unsubscribe)
        throw new CloudExecutionIsolationError(
          'cloud_runtime_boundary_unexpected_exit',
        )
      }
      // Publish only after lifecycle subscription is fully ready.
      // The provisioning owner holds this claim until one successful waiter
      // consumes it. Admission pressure must not treat the new generation as
      // idle while creation telemetry yields.
      entry.activeUses += 1
      provisionClaim.entry = entry
      creatingRuntimeKeys.delete(key)
      runtimes.set(key, entry)
      generationPublished = true
      await recordRuntimeEntryCount()
      await recordRuntimeCacheMetric(
        'open_cowork_cloud_runtime_creation_duration_ms',
        Date.now() - creationStartedAt,
        { status: 'ok' },
        { kind: 'gauge' },
      )
      if (hasBoundaryCleanupDebt(publicationCleanupDebtGeneration)) {
        await closeRuntime(key, entry, 'shutdown')
        throw new CloudRuntimeCapacityError(
          'cleanup_pending',
          admissionQueueTimeoutMs,
        )
      }
      if (signal?.aborted) {
        if (provisionClaim.entry === entry) {
          provisionClaim.entry = null
          entry.activeUses = Math.max(0, entry.activeUses - 1)
        }
        await closeRuntime(key, entry, 'shutdown')
        throw capacityAbortError(signal)
      }
      observeRuntimeState()
      if (generationExited || runtimes.get(key) !== entry) {
        throw new CloudExecutionIsolationError(
          generationExited
            ? 'cloud_runtime_boundary_unexpected_exit'
            : 'cloud_runtime_boundary_evicted_before_use',
        )
      }
      return entry
    } catch (error) {
      const claimedEntry = provisionClaim.entry
      if (claimedEntry) {
        provisionClaim.entry = null
        claimedEntry.activeUses = Math.max(0, claimedEntry.activeUses - 1)
        claimedEntry.lastUsedAt = Date.now()
        await finishDeferredRuntimeClose(claimedEntry)
        observeRuntimeState()
        notifyRuntimeActivityDrained()
      }
      const cleanupDebt = error instanceof CloudExecutionCleanupDebtError
      if (cleanupDebt) {
        retainCapacityForCleanupDebt(capacityPermit, error.cleanup)
        capacityPermitTransferred = true
      }
      await recordRuntimeCacheMetric(
        'open_cowork_cloud_runtime_creation_duration_ms',
        Date.now() - creationStartedAt,
        { status: 'error' },
        { kind: 'gauge' },
      )
      if (cleanupDebt) {
        throw new CloudRuntimeCapacityError(
          'cleanup_pending',
          admissionQueueTimeoutMs,
        )
      }
      throw error
    } finally {
      creatingRuntimeKeys.delete(key)
      if (!capacityPermitTransferred) capacityPermit.release()
      observeRuntimeState()
    }
  }

  async function getRuntimeEntry(
    contextInput: CloudRuntimeExecutionContext | null | undefined,
    signal?: AbortSignal,
  ) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    while (true) {
      const closing = closingRuntimeEntries.get(key)
      if (closing) {
        await waitForAbortable(closing.promise, signal)
        assertNoBoundaryCleanupDebt()
        continue
      }
      const pending = pendingRuntimeEntries.get(key)
      if (pending) {
        if (pending.controller.signal.aborted) {
          throwIfAdmissionAborted(signal)
          // Keep the aborted generation and its hard-cap permit discoverable
          // until the provider settles, but do not make retries inherit an
          // unbounded wait from a provider that ignores cancellation.
          await recordCapacityRejection('cleanup_pending')
          throw new CloudRuntimeCapacityError(
            'cleanup_pending',
            admissionQueueTimeoutMs,
          )
        }
        // Register this waiter synchronously before telemetry yields. Otherwise
        // cancellation of the original waiter can briefly drop the shared
        // provision to zero owners and abort it underneath this survivor.
        const [acquisition] = await Promise.all([
          waitForRuntimeProvision(pending, signal),
          recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_hits_total', 1, {
            state: 'provisioning',
          }),
        ])
        return {
          key,
          ...acquisition,
        }
      }
      const existing = runtimes.get(key)
      if (existing) {
        // Claim the cached entry before telemetry yields. Admission pressure
        // must not evict and close the boundary between lookup and callback.
        existing.activeUses += 1
        existing.lastUsedAt = Date.now()
        observeRuntimeState()
        await recordRuntimeCacheMetric('open_cowork_cloud_runtime_cache_hits_total', 1)
        if (runtimes.get(key) !== existing) {
          existing.activeUses = Math.max(0, existing.activeUses - 1)
          existing.lastUsedAt = Date.now()
          await finishDeferredRuntimeClose(existing)
          observeRuntimeState()
          notifyRuntimeActivityDrained()
          continue
        }
        return { key, entry: existing, entryClaimed: true }
      }

      const provisioning = startRuntimeProvision(context, key)
      const acquisition = await waitForRuntimeProvision(provisioning, signal)
      return {
        key,
        ...acquisition,
      }
    }
  }

  async function withRuntime<T>(
    contextInput: CloudRuntimeExecutionContext | null | undefined,
    callback: (adapter: CloudRuntimeAdapter, entry: RuntimeEntry) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const context = requireContext(contextInput)
    const key = runtimeKey(context)
    if (adapterClosing && !executionScopes.has(key)) {
      throw new CloudRuntimeCapacityError(
        'adapter_closing',
        admissionQueueTimeoutMs,
      )
    }
    activeRuntimeCalls += 1
    try {
      const { entry, entryClaimed } = await getRuntimeEntry(context, signal)
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
      if (!entryClaimed) entry.activeUses += 1
      entry.lastUsedAt = Date.now()
      observeRuntimeState()
      try {
        return await callback(entry.adapter, entry)
      } finally {
        entry.activeUses = Math.max(0, entry.activeUses - 1)
        entry.lastUsedAt = Date.now()
        await finishDeferredRuntimeClose(entry)
        await evictRuntimes()
        await relieveAdmissionPressure()
        observeRuntimeState()
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
        throw new CloudRuntimeCapacityError(
          'adapter_closing',
          admissionQueueTimeoutMs,
        )
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
        await relieveAdmissionPressure()
        observeRuntimeState()
        notifyRuntimeActivityDrained()
      }
    }
  }

  async function closeAdapter() {
    clearInterval(sweepTimer)
    clearInterval(boundaryCleanupTimer)
    clearInterval(pressureTimer)
    rejectAdmissionQueue('adapter_closing')
    let cleanupFailed = false
    const teardownDeadline = Date.now() + runtimeTeardownTimeoutMs
    const runCleanupPhase = async (operation: () => Promise<unknown>) => {
      const remainingMs = teardownDeadline - Date.now()
      if (remainingMs <= 0) {
        cleanupFailed = true
        return false
      }
      let phaseFailed = false
      const phase = Promise.resolve()
        .then(operation)
        .catch(() => {
          phaseFailed = true
        })
      const settled = await settlesWithin([phase], remainingMs)
      if (!settled || phaseFailed) cleanupFailed = true
      return settled && !phaseFailed
    }
    for (const pending of inFlightRuntimeProvisions) {
      if (!pending.controller.signal.aborted) {
        pending.controller.abort(
          new CloudRuntimeCapacityError('adapter_closing', admissionQueueTimeoutMs),
        )
      }
    }
    await runCleanupPhase(() => waitForRuntimeActivityToDrain())
    await runCleanupPhase(async () => {
      await drainMaintenancePasses()
    })
    await runCleanupPhase(async () => {
      await Promise.allSettled(
        Array.from(inFlightRuntimeProvisions, ({ promise }) => promise),
      )
    })
    await runCleanupPhase(async () => {
      const results = await Promise.allSettled(
        Array.from(closingRuntimeEntries.values()).map(async ({ entry }) => {
          await finishDeferredRuntimeClose(entry)
          return entry.teardownPromise ? await entry.teardownPromise : true
        }),
      )
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Runtime teardown failed.')
      }
    })
    await runCleanupPhase(async () => {
      const results = await Promise.allSettled(
        Array.from(runtimes.entries(), ([key, entry]) => (
          closeRuntime(key, entry, 'shutdown')
        )),
      )
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Runtime teardown failed.')
      }
    })
    await runCleanupPhase(async () => {
      const results = await Promise.allSettled(
        Array.from(deferredRuntimeClosures, (entry) => (
          finishDeferredRuntimeClose(entry)
        )),
      )
      if (results.some((result) => result.status === 'rejected')) {
        throw new Error('Deferred runtime teardown failed.')
      }
    })
    if (deferredRuntimeClosures.size > 0) cleanupFailed = true
    for (let attempt = 0; attempt < 3 && pendingBoundaryCleanup.size > 0; attempt += 1) {
      await runCleanupPhase(() => retryPendingBoundaryCleanup())
    }
    if (isolationProvider.close) {
      await runCleanupPhase(async () => {
        await isolationProvider.close!()
      })
    }
    // A provider-level final drain may have resolved debt that the adapter
    // still tracks. Re-run idempotent boundary close once before surfacing it.
    if (pendingBoundaryCleanup.size > 0) {
      await runCleanupPhase(() => retryPendingBoundaryCleanup())
    }
    await Promise.resolve()
    const cleanupResidue = pendingBoundaryCleanup.size > 0
      || capacityCleanupDebts.size > 0
      || capacityPermitsByBoundary.size > 0
      || inFlightRuntimeProvisions.size > 0
      || runtimes.size > 0
      || deferredRuntimeClosures.size > 0
      || activeRuntimeCalls > 0
      || executionScopes.size > 0
    if (cleanupFailed || cleanupResidue) {
      throw new CloudExecutionIsolationError(
        'sandbox_runtime_teardown_failed',
        'Cloud execution boundary teardown failed.',
      )
    }
    runtimes.clear()
    capacityPermitsByBoundary.clear()
    capacityCleanupDebts.clear()
    capacityInUse = 0
    admissionQueue.length = 0
    creatingRuntimeKeys.clear()
    pendingRuntimeEntries.clear()
    executionScopes.clear()
    deferredRuntimeClosures.clear()
    closingRuntimeEntries.clear()
    listeners.clear()
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
          entry.executionGeneration += 1
          entry.nativeRootSessionId = input.sessionId
          entry.activeExecutionKey = input.messageId?.trim()
            || `${input.sessionId}:${entry.executionGeneration}`
          entry.executionActive = true
        }
        try {
          const result = await adapter.promptSession(input)
          // Synchronous/fake adapters own execution for the lifetime of this
          // call. Native V2 adapters only admit work here and settle through
          // the subscribed idle/error event.
          if (!backgroundExecution || result?.events?.some(eventSettlesExecution)) {
            entry.executionActive = false
            entry.activeExecutionKey = null
          }
          return result
        } catch (error) {
          entry.executionActive = false
          entry.activeExecutionKey = null
          throw error
        }
      }, input.signal)
    },
    async abortSession(input) {
      return withRuntime(input.context, async (adapter, entry) => {
        await adapter.abortSession(input)
        entry.executionActive = false
      }, input.signal)
    },
    async replyToQuestion(input) {
      return withRuntime(input.context, (adapter) => {
        if (!adapter.replyToQuestion) throw new Error('OpenCode question replies are not available.')
        return adapter.replyToQuestion(input)
      }, input.signal)
    },
    async rejectQuestion(input) {
      return withRuntime(input.context, (adapter) => {
        if (!adapter.rejectQuestion) throw new Error('OpenCode question rejection is not available.')
        return adapter.rejectQuestion(input)
      }, input.signal)
    },
    async respondToPermission(input) {
      return withRuntime(input.context, (adapter) => {
        if (!adapter.respondToPermission) throw new Error('OpenCode permission responses are not available.')
        return adapter.respondToPermission(input)
      }, input.signal)
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
        const closeAttempt = closeAdapter()
        adapterClosePromise = closeAttempt
        void closeAttempt.catch(() => {
          if (adapterClosePromise === closeAttempt) adapterClosePromise = null
        })
      }
      return adapterClosePromise
    },
  }
}
