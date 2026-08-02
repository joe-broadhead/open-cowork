import type { ProgressWatchdogIdentity } from '@open-cowork/shared/progress-watchdog'
import type { CloudExecutionBoundary } from './execution-isolation.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeEvent,
  CloudRuntimeGenerationFence,
  CloudRuntimeProgressEvent,
  CloudRuntimeRecoveryOutcome,
} from './runtime-adapter.ts'

export type WorkerRuntimeEntry = {
  key: string
  adapter: CloudRuntimeAdapter
  boundary: CloudExecutionBoundary
  unsubscribe: (() => void | Promise<void>) | null
  activeUses: number
  executionActive: boolean
  nativeRootSessionId: string | null
  runtimeGeneration: number
  executionGeneration: number
  activeExecutionKey: string | null
  activeLeaseOwner: string | null
  activeLeaseEpoch: string | null
  lastUsedAt: number
  deferredCloseReason: 'unexpected_exit' | null
  teardownPromise: Promise<boolean> | null
  recoveryKey: string | null
  recoveryPromise: Promise<CloudRuntimeRecoveryOutcome> | null
  promptAdmissionLock: Promise<void> | null
}

export function runtimeEventStartsExecution(event: { type: string; payload: Record<string, unknown> }) {
  return event.type === 'session.status'
    && (event.payload.statusType === 'busy' || event.payload.statusType === 'running')
}

export function runtimeEventSettlesExecution(event: { type: string; payload: Record<string, unknown> }) {
  return event.type === 'session.idle'
    || event.type === 'session.aborted'
    || event.type === 'runtime.error'
    || (event.type === 'session.status' && event.payload.statusType === 'idle')
}

export function runtimeEventBelongsToNativeRoot(entry: WorkerRuntimeEntry, event: { payload: Record<string, unknown> }) {
  const eventSessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
  return !entry.nativeRootSessionId || !eventSessionId || eventSessionId === entry.nativeRootSessionId
}

export function beginWorkerRuntimeExecution(
  entry: WorkerRuntimeEntry,
  input: { sessionId: string; messageId?: string; lease?: { owner: string; epoch: string } | null },
) {
  entry.executionGeneration += 1
  entry.nativeRootSessionId = input.sessionId
  entry.activeExecutionKey = input.messageId?.trim() || `${input.sessionId}:${entry.executionGeneration}`
  entry.activeLeaseOwner = input.lease?.owner || null
  entry.activeLeaseEpoch = input.lease?.epoch || null
  entry.executionActive = true
}

export function settleWorkerRuntimeExecution(entry: WorkerRuntimeEntry) {
  entry.executionActive = false
  entry.activeExecutionKey = null
  entry.activeLeaseOwner = null
  entry.activeLeaseEpoch = null
}

export function bindWorkerRuntimeProgress(
  scopeId: string,
  sessionId: string,
  entry: WorkerRuntimeEntry,
  event: CloudRuntimeProgressEvent,
): CloudRuntimeProgressEvent | null {
  if (
    event.disposition === 'terminal'
    && entry.nativeRootSessionId
    && event.runtimeSessionId
    && event.runtimeSessionId !== entry.nativeRootSessionId
  ) return null
  const provenance = workerRuntimeIdentity(scopeId, sessionId, entry)
  if (!provenance) return null
  const belongsToRoot = !entry.nativeRootSessionId
    || !event.runtimeSessionId
    || event.runtimeSessionId === entry.nativeRootSessionId
  return {
    ...event,
    ...(!belongsToRoot ? { sequence: null, progressCursor: null } : {}),
    provenance,
  }
}

export function bindWorkerRuntimeEvent(
  scopeId: string,
  sessionId: string,
  entry: WorkerRuntimeEntry,
  event: CloudRuntimeEvent,
): CloudRuntimeEvent | null {
  const provenance = workerRuntimeIdentity(scopeId, sessionId, entry)
  return provenance ? { ...event, provenance } : null
}

function workerRuntimeIdentity(
  scopeId: string,
  sessionId: string,
  entry: WorkerRuntimeEntry,
): ProgressWatchdogIdentity | null {
  if (
    !entry.executionActive
    || !entry.activeExecutionKey
    || !entry.activeLeaseOwner
    || !entry.activeLeaseEpoch
  ) return null
  return {
    scopeId,
    sessionId,
    runId: entry.activeExecutionKey,
    runtimeGeneration: entry.runtimeGeneration,
    executionGeneration: entry.executionGeneration,
    leaseOwner: entry.activeLeaseOwner,
    leaseEpoch: entry.activeLeaseEpoch,
  }
}

function recoveryKey(
  sessionId: string,
  expected: CloudRuntimeGenerationFence,
  lease?: { owner: string; epoch: string } | null,
) {
  return [
    sessionId,
    expected.runtimeGeneration,
    expected.executionGeneration,
    expected.runId,
    lease?.owner || '',
    lease?.epoch || '',
  ].join('\0')
}

function matchesRecoveryFence(entry: WorkerRuntimeEntry, expected: CloudRuntimeGenerationFence) {
  return entry.executionActive
    && entry.runtimeGeneration === expected.runtimeGeneration
    && entry.executionGeneration === expected.executionGeneration
    && entry.activeExecutionKey === expected.runId
}

export function isWorkerRuntimeGenerationCurrent(
  entry: WorkerRuntimeEntry,
  input: {
    expected: CloudRuntimeGenerationFence
    lease?: { owner: string; epoch: string } | null
  },
) {
  return matchesRecoveryFence(entry, input.expected)
    && entry.activeLeaseOwner === input.lease?.owner
    && entry.activeLeaseEpoch === input.lease?.epoch
}

export async function waitForWorkerRuntimeRecovery(entry: WorkerRuntimeEntry) {
  await entry.recoveryPromise
}

export function recoverWorkerRuntimeEntry(
  entry: WorkerRuntimeEntry,
  input: {
    sessionId: string
    context: Parameters<CloudRuntimeAdapter['abortSession']>[0]['context']
    expected: CloudRuntimeGenerationFence
    isDecisionCurrent: () => boolean
    signal?: AbortSignal
  },
): Promise<CloudRuntimeRecoveryOutcome> {
  const expectedKey = recoveryKey(input.sessionId, input.expected, input.context?.lease)
  if (entry.recoveryPromise) {
    return entry.recoveryKey === expectedKey
      ? entry.recoveryPromise
      : Promise.resolve('fenced-stale')
  }
  if (
    !isWorkerRuntimeGenerationCurrent(entry, { expected: input.expected, lease: input.context?.lease })
    || entry.nativeRootSessionId !== input.sessionId
    || !input.isDecisionCurrent()
  ) {
    return Promise.resolve('fenced-stale')
  }

  entry.activeUses += 1
  entry.recoveryKey = expectedKey
  const recovery = entry.adapter.abortSession({
    sessionId: input.sessionId,
    context: input.context,
    signal: input.signal,
  }).then((): CloudRuntimeRecoveryOutcome => {
    if (isWorkerRuntimeGenerationCurrent(entry, { expected: input.expected, lease: input.context?.lease })) {
      settleWorkerRuntimeExecution(entry)
    }
    return 'recovered'
  }).finally(() => {
    entry.activeUses = Math.max(0, entry.activeUses - 1)
    entry.lastUsedAt = Date.now()
    if (entry.recoveryPromise === recovery) {
      entry.recoveryPromise = null
      entry.recoveryKey = null
    }
  })
  entry.recoveryPromise = recovery
  return recovery
}
