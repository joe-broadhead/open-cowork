import { performance } from 'node:perf_hooks'

import type {
  CloudRuntimeAdapter,
  CloudRuntimeDroppedEvent,
  CloudRuntimeEvent,
  CloudRuntimeEventListener,
  CloudRuntimeExecutionContext,
  CloudRuntimeProgressEvent,
} from './runtime-adapter.ts'
import { CloudRuntimeCapacityError } from './runtime-capacity.ts'
import {
  beginWorkerRuntimeExecution,
  bindWorkerRuntimeEvent,
  bindWorkerRuntimeProgress,
  runtimeEventBelongsToNativeRoot,
  runtimeEventSettlesExecution,
  runtimeEventStartsExecution,
  settleWorkerRuntimeExecution,
  waitForWorkerRuntimeRecovery,
  type WorkerRuntimeEntry,
} from './worker-runtime-progress.ts'

export type WorkerRuntimeEventSubscription = {
  onError?: (error: unknown) => void
  onDroppedEvent?: (event: CloudRuntimeDroppedEvent) => void
  onProgress?: (event: CloudRuntimeProgressEvent) => void
}

type WorkerRuntimeListeners = ReadonlyMap<CloudRuntimeEventListener, WorkerRuntimeEventSubscription>

function mapRuntimeEventToCoworkSession(
  context: CloudRuntimeExecutionContext,
  event: CloudRuntimeEvent,
): CloudRuntimeEvent {
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

export async function dispatchWorkerRuntimeEvent(input: {
  context: CloudRuntimeExecutionContext
  entry: WorkerRuntimeEntry
  event: CloudRuntimeEvent
  listeners: Iterable<CloudRuntimeEventListener>
  onReleased(): void
}) {
  const { context, entry, event } = input
  const belongsToNativeRoot = runtimeEventBelongsToNativeRoot(entry, event)
  const mappedEvent = mapRuntimeEventToCoworkSession(context, event)
  // Child sessions share the directory stream, but only the native root can
  // settle the product run. Capture its generation before awaiting listeners
  // so a delayed old terminal cannot settle a replacement admitted meanwhile.
  if (!belongsToNativeRoot && runtimeEventSettlesExecution(mappedEvent)) return
  if (belongsToNativeRoot && runtimeEventStartsExecution(mappedEvent)) entry.executionActive = true
  const settlingExecutionGeneration = belongsToNativeRoot
    && runtimeEventSettlesExecution(mappedEvent)
    && entry.executionActive
    ? entry.executionGeneration
    : null
  const mapped = bindWorkerRuntimeEvent(context.tenantId, context.sessionId, entry, mappedEvent) || mappedEvent
  entry.activeUses += 1
  entry.lastUsedAt = Date.now()
  try {
    await Promise.all(Array.from(input.listeners, (listener) => listener(mapped)))
  } finally {
    if (
      settlingExecutionGeneration !== null
      && entry.executionActive
      && entry.executionGeneration === settlingExecutionGeneration
    ) settleWorkerRuntimeExecution(entry)
    entry.activeUses = Math.max(0, entry.activeUses - 1)
    entry.lastUsedAt = Date.now()
    input.onReleased()
  }
}

export type WorkerRuntimePromptExecution = {
  generation: number
  key: string
}

function observesProgress(listeners: WorkerRuntimeListeners) {
  for (const subscription of listeners.values()) if (subscription.onProgress) return true
  return false
}

function dispatchWorkerRuntimeProgress(
  context: CloudRuntimeExecutionContext,
  entry: WorkerRuntimeEntry,
  listeners: WorkerRuntimeListeners,
  event: CloudRuntimeProgressEvent,
) {
  if (!observesProgress(listeners)) return
  const bound = bindWorkerRuntimeProgress(context.tenantId, context.sessionId, entry, event)
  if (bound) for (const subscription of listeners.values()) subscription.onProgress?.(bound)
}

export function dispatchWorkerTerminalProgress(
  context: CloudRuntimeExecutionContext,
  entry: WorkerRuntimeEntry,
  listeners: WorkerRuntimeListeners,
  semanticKey: string,
  runtimeSessionId: string,
) {
  dispatchWorkerRuntimeProgress(context, entry, listeners, {
    source: 'terminal', disposition: 'terminal', semanticKey,
    observedAtMs: performance.now(), runtimeSessionId,
  })
}

function beginWorkerRuntimePrompt(
  entry: WorkerRuntimeEntry,
  input: {
    sessionId: string
    messageId?: string
    lease?: CloudRuntimeExecutionContext['lease']
  },
  retryAfterMs: number,
): WorkerRuntimePromptExecution {
  if (entry.executionActive) {
    throw new CloudRuntimeCapacityError('execution_active', retryAfterMs)
  }
  beginWorkerRuntimeExecution(entry, input)
  return { generation: entry.executionGeneration, key: entry.activeExecutionKey! }
}

function matchesPromptExecution(
  entry: WorkerRuntimeEntry,
  expected: WorkerRuntimePromptExecution,
) {
  return entry.executionActive
    && entry.executionGeneration === expected.generation
    && entry.activeExecutionKey === expected.key
}

async function abortWorkerRuntimeAfterPromptError(input: {
  adapter: CloudRuntimeAdapter
  context: CloudRuntimeExecutionContext
  entry: WorkerRuntimeEntry
  listeners: WorkerRuntimeListeners
  execution: WorkerRuntimePromptExecution
  sessionId: string
}) {
  const { entry, execution } = input
  if (!matchesPromptExecution(entry, execution)) return
  if (entry.recoveryPromise) {
    await entry.recoveryPromise.catch(() => undefined)
    return
  }
  // Lock retries before invoking the adapter. A terminal event may settle the
  // run while abort is in flight, but no replacement generation can then be
  // admitted and accidentally targeted by this exact-session abort.
  const recovery = Promise.resolve()
    .then(() => input.adapter.abortSession({
      sessionId: input.sessionId,
      context: input.context,
    }))
    .then((): 'recovered' => {
      if (matchesPromptExecution(entry, execution)) {
        dispatchWorkerTerminalProgress(
          input.context, entry, input.listeners, `prompt.abort_after_error:${execution.generation}`,
          entry.nativeRootSessionId || input.sessionId,
        )
        settleWorkerRuntimeExecution(entry)
      }
      return 'recovered'
    }, (): 'fenced-stale' => 'fenced-stale')
    .finally(() => {
      if (entry.recoveryPromise === recovery) {
        entry.recoveryPromise = null
        entry.recoveryKey = null
      }
    })
  entry.recoveryKey = `prompt-error\0${execution.generation}\0${execution.key}`
  entry.recoveryPromise = recovery
  await recovery
}

function promptAbortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}

async function waitForPromptAdmissionTurn(
  entry: WorkerRuntimeEntry,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw promptAbortError(signal)
  const previous = entry.promptAdmissionLock
  let resolveCurrent!: () => void
  const current = new Promise<void>((resolve) => { resolveCurrent = resolve })
  entry.promptAdmissionLock = current
  let released = false
  const release = () => {
    if (released) return
    released = true
    resolveCurrent()
    if (entry.promptAdmissionLock === current) entry.promptAdmissionLock = null
  }
  if (!previous) return release
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      const onAbort = () => finish(() => reject(promptAbortError(signal!)))
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      else previous.then(
        () => finish(resolve),
        () => finish(resolve),
      )
    })
    return release
  } catch (error) {
    void previous.then(release, release)
    throw error
  }
}

export async function runWorkerRuntimePrompt(input: {
  adapter: CloudRuntimeAdapter
  context: CloudRuntimeExecutionContext
  entry: WorkerRuntimeEntry
  listeners: WorkerRuntimeListeners
  prompt: Parameters<CloudRuntimeAdapter['promptSession']>[0]
  lease?: CloudRuntimeExecutionContext['lease']
  retryAfterMs: number
}) {
  const backgroundExecution = Boolean(input.adapter.subscribeEvents)
  // Only subscribed runtimes outlive the prompt response and therefore need
  // admission serialization to protect their session-scoped terminal events.
  // Synchronous adapters settle with the prompt call itself and must remain
  // independently concurrent so one long execution cannot starve capacity.
  const releaseAdmissionTurn = backgroundExecution
    ? await waitForPromptAdmissionTurn(input.entry, input.prompt.signal)
    : null
  try {
    await waitForWorkerRuntimeRecovery(input.entry)
    if (input.prompt.signal?.aborted) throw promptAbortError(input.prompt.signal)
    const execution = backgroundExecution
      ? beginWorkerRuntimePrompt(input.entry, {
        sessionId: input.prompt.sessionId,
        messageId: input.prompt.messageId,
        lease: input.lease,
      }, input.retryAfterMs)
      : null
    try {
      const result = await input.adapter.promptSession(input.prompt)
      if (!backgroundExecution || result?.events?.some(runtimeEventSettlesExecution)) {
        dispatchWorkerTerminalProgress(
          input.context, input.entry, input.listeners,
          `prompt.settled:${input.entry.executionGeneration}`,
          input.entry.nativeRootSessionId || input.prompt.sessionId,
        )
        settleWorkerRuntimeExecution(input.entry)
      }
      return result
    } catch (error) {
      if (execution) await abortWorkerRuntimeAfterPromptError({
        adapter: input.adapter,
        context: input.context,
        entry: input.entry,
        listeners: input.listeners,
        execution,
        sessionId: input.prompt.sessionId,
      })
      else settleWorkerRuntimeExecution(input.entry)
      throw error
    }
  } finally {
    releaseAdmissionTurn?.()
  }
}

export async function subscribeWorkerRuntimeEvents(input: {
  context: CloudRuntimeExecutionContext
  entry: WorkerRuntimeEntry
  listeners: WorkerRuntimeListeners
  dispatchEvent: CloudRuntimeEventListener
}) {
  const { adapter } = input.entry
  if (!adapter.subscribeEvents || input.listeners.size === 0) return null
  const withProgress = observesProgress(input.listeners)
  return adapter.subscribeEvents(input.dispatchEvent, {
    onError(error) {
      for (const subscription of input.listeners.values()) subscription.onError?.(error)
    },
    onDroppedEvent(event) {
      for (const subscription of input.listeners.values()) subscription.onDroppedEvent?.(event)
    },
    ...(withProgress
      ? {
          onProgress: (event: CloudRuntimeProgressEvent) => dispatchWorkerRuntimeProgress(
            input.context, input.entry, input.listeners, event,
          ),
        }
      : {}),
  })
}
