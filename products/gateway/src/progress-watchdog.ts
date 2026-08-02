import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  acknowledgeProgressWatchdogDecision,
  classifyOpenCodeProgressEvent,
  createProgressWatchdogState,
  evaluateProgressWatchdog,
  isProgressWatchdogDecisionCurrent,
  recordProgressWatchdogObservation,
  type ProgressWatchdogDecision,
  type ProgressWatchdogMode,
  type ProgressWatchdogSnapshot,
  type ProgressWatchdogState,
} from '@open-cowork/shared/progress-watchdog'
import { canCurrentDaemonWrite } from './daemon-leadership.js'
import { createOpenCodeSessionRuntime } from './opencode-session-runtime.js'
import { recordProgressWatchdogOutcome, type ProgressWatchdogMetricOutcome } from './runtime-metrics.js'
import { appendWorkEvent, type RunRecord } from './work-store.js'
import { getActiveRunsBySessionIdsReadOnly, getRunBySessionId, getRunReadOnly, listActiveRunsReadOnly } from './work-store/queries.js'
import { createSqliteWorkStoreRunLeasePort } from './work-store/run-lease-port.js'

const MODE_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MODE'
const SUSPECT_MS_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_SUSPECT_MS'
const STALLED_MS_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_STALLED_MS'
const SWEEP_MS_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_SWEEP_MS'
const MAX_ENTRIES_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MAX_ENTRIES'
const MAX_SNAPSHOT_ENTRIES_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_MAX_SNAPSHOT_ENTRIES'
const EVIDENCE_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF'
const OWNER_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_OPERATOR_OWNER'
const ROLLBACK_ENV = 'OPENCODE_GATEWAY_PROGRESS_WATCHDOG_ROLLBACK_MODE'

const DEFAULT_SUSPECT_MS = 2 * 60_000
const DEFAULT_STALLED_MS = 5 * 60_000
const DEFAULT_SWEEP_MS = 10_000
const DEFAULT_MAX_ENTRIES = 1_000
const DEFAULT_MAX_SNAPSHOT_ENTRIES = 20
const RECENT_EVENT_SIGNATURES = 128
const SEMANTIC_MAX_NODES = 128
const SEMANTIC_MAX_COLLECTION_SAMPLES = 16
const SEMANTIC_STRING_SAMPLE_CHARS = 256
const MIN_RECOVERY_RETRY_MS = 1_000
const MAX_RECOVERY_RETRY_MS = 5 * 60_000
const MAX_RECOVERY_RETRY_EXPONENT = 9
const PROCESS_RUNTIME_GENERATION = Math.min(Number.MAX_SAFE_INTEGER, Date.now())

export interface GatewayProgressWatchdogConfig {
  requestedMode: ProgressWatchdogMode
  mode: ProgressWatchdogMode
  status: 'disabled' | 'valid' | 'invalid' | 'gated'
  reason: 'mode_off' | 'mode_invalid' | 'bounds_invalid' | 'enforce_gate_incomplete' | 'configured'
  suspectAfterMs: number
  stalledAfterMs: number
  sweepMs: number
  maxEntries: number
  maxSnapshotEntries: number
}

export interface GatewayProgressWatchdogSnapshot extends ProgressWatchdogSnapshot {
  mode: ProgressWatchdogMode
  status: GatewayProgressWatchdogConfig['status']
  generation: number
}

export type GatewayProgressWatchdogRecoveryOutcome = 'recovered' | 'fenced_stale' | 'failed'

export interface GatewayProgressWatchdogController {
  admit(run: GatewayProgressRun): void
  observe(event: unknown): void
  snapshot(): GatewayProgressWatchdogSnapshot
  sweep(): Promise<void>
  stop(): void
}

export interface GatewayStalledRunRecoveryDependencies {
  canWrite(): boolean
  isDecisionCurrent?(): boolean
  findRunById(runId: string): GatewayProgressRun | undefined
  recoverStalledRun(input: { runId: string; leaseOwner: string; schedulerGeneration: string }): {
    applied: boolean
    abortedSessionId?: string
  }
  abortSession(sessionId: string): Promise<void>
  now?: () => number
}

interface GatewayProgressRun extends Pick<
  RunRecord,
  'id' | 'sessionId' | 'status' | 'attempt' | 'leaseOwner' | 'leaseExpiresAt' | 'schedulerGeneration'
> {}

interface RunObservationBinding {
  identityFingerprint: string
  executionGeneration: number
  cursor: number
  recentSignatures: string[]
  touchedAtMs: number
}

interface CachedRunBinding {
  run: GatewayProgressRun
  checkedAtMs: number
}

interface RecoveryRetry {
  attempts: number
  nextAttemptAtMs: number
}

interface GatewayProgressWatchdogOptions {
  config: GatewayProgressWatchdogConfig
  findRunBySessionId(sessionId: string): GatewayProgressRun | undefined
  findRunsBySessionIds(sessionIds: readonly string[]): readonly GatewayProgressRun[]
  recover(
    decision: ProgressWatchdogDecision,
    isDecisionCurrent: () => boolean,
  ): Promise<GatewayProgressWatchdogRecoveryOutcome>
  now?: () => number
  wallNow?: () => number
  runtimeGeneration?: number
  onMetric?: (outcome: ProgressWatchdogMetricOutcome) => void
  onDecision?: (input: {
    decision: ProgressWatchdogDecision
    mode: Exclude<ProgressWatchdogMode, 'off'>
    outcome: ProgressWatchdogMetricOutcome
  }) => void
  setIntervalFn?: typeof setInterval
  clearIntervalFn?: typeof clearInterval
}

export function resolveGatewayProgressWatchdogConfig(
  env: NodeJS.ProcessEnv = process.env,
): GatewayProgressWatchdogConfig {
  const rawMode = String(env[MODE_ENV] || '').trim().toLowerCase()
  if (!rawMode) return disabledConfig('mode_off')
  if (rawMode !== 'off' && rawMode !== 'observe' && rawMode !== 'enforce') {
    return disabledConfig('mode_invalid', 'invalid')
  }
  const requestedMode = rawMode
  if (requestedMode === 'off') return disabledConfig('mode_off')

  const suspect = boundedInteger(env[SUSPECT_MS_ENV], DEFAULT_SUSPECT_MS, 1_000, 24 * 60 * 60_000)
  const stalled = boundedInteger(env[STALLED_MS_ENV], DEFAULT_STALLED_MS, 2_000, 7 * 24 * 60 * 60_000)
  const sweep = boundedInteger(env[SWEEP_MS_ENV], DEFAULT_SWEEP_MS, 250, 60 * 60_000)
  const maxEntries = boundedInteger(env[MAX_ENTRIES_ENV], DEFAULT_MAX_ENTRIES, 1, 10_000)
  const maxSnapshotEntries = boundedInteger(env[MAX_SNAPSHOT_ENTRIES_ENV], DEFAULT_MAX_SNAPSHOT_ENTRIES, 0, 100)
  if (!suspect.valid || !stalled.valid || !sweep.valid || !maxEntries.valid || !maxSnapshotEntries.valid || stalled.value <= suspect.value) {
    return disabledConfig('bounds_invalid', 'invalid', requestedMode)
  }
  if (requestedMode === 'enforce') {
    const evidence = String(env[EVIDENCE_ENV] || '').trim()
    const owner = String(env[OWNER_ENV] || '').trim()
    const rollbackMode = String(env[ROLLBACK_ENV] || '').trim().toLowerCase()
    if (!evidence || !owner || (rollbackMode !== 'off' && rollbackMode !== 'observe')) {
      return disabledConfig('enforce_gate_incomplete', 'gated', requestedMode)
    }
  }
  return {
    requestedMode,
    mode: requestedMode,
    status: 'valid',
    reason: 'configured',
    suspectAfterMs: suspect.value,
    stalledAfterMs: stalled.value,
    sweepMs: sweep.value,
    maxEntries: maxEntries.value,
    maxSnapshotEntries: maxSnapshotEntries.value,
  }
}

export function disabledGatewayProgressWatchdogSnapshot(
  config: GatewayProgressWatchdogConfig = disabledConfig('mode_off'),
): GatewayProgressWatchdogSnapshot {
  return {
    mode: 'off',
    status: config.status,
    generation: 0,
    counts: { healthy: 0, waiting: 0, suspect: 0, stalled: 0 },
    samples: [],
    truncated: false,
  }
}

export function createGatewayProgressWatchdog(
  options: GatewayProgressWatchdogOptions,
): GatewayProgressWatchdogController | null {
  if (options.config.mode === 'off') return null
  const mode = options.config.mode
  const now = options.now || (() => performance.now())
  const wallNow = options.wallNow || Date.now
  const runtimeGeneration = options.runtimeGeneration ?? PROCESS_RUNTIME_GENERATION
  const setIntervalFn = options.setIntervalFn || setInterval
  const clearIntervalFn = options.clearIntervalFn || clearInterval
  const thresholds = {
    suspectAfterMs: options.config.suspectAfterMs,
    stalledAfterMs: options.config.stalledAfterMs,
    maxEntries: options.config.maxEntries,
    maxSnapshotEntries: options.config.maxSnapshotEntries,
  }
  const bindings = new Map<string, RunObservationBinding>()
  const runCache = new Map<string, CachedRunBinding>()
  const recoveryRetries = new Map<string, RecoveryRetry>()
  const runLookupTtlMs = Math.min(options.config.sweepMs, 5_000)
  let state: ProgressWatchdogState = createProgressWatchdogState()
  let stopped = false
  let sweepChain = Promise.resolve()

  const admit = (run: GatewayProgressRun) => {
    if (stopped || !isObservableRun(run, run.sessionId)) return
    const observedAtMs = now()
    const binding = observationBinding(bindings, run, observedAtMs, options.config.maxEntries)
    cacheObservableRun(runCache, run, observedAtMs, options.config.maxEntries)
    const previousState = state
    state = recordProgressWatchdogObservation(state, {
      scopeId: run.id,
      sessionId: run.sessionId,
      runId: run.id,
      runtimeGeneration,
      executionGeneration: binding.executionGeneration,
      leaseOwner: run.leaseOwner!,
      leaseEpoch: leaseEpoch(run.schedulerGeneration!),
      source: 'admission',
      disposition: 'running',
      semanticKey: 'gateway.run.admitted',
      observedAtMs,
    }, options.config.maxEntries)
    if (state !== previousState) recoveryRetries.delete(recoveryKey(run.id, run.sessionId))
  }

  const observe = (event: unknown) => {
    if (stopped) return
    const raw = eventRecord(event)
    const sessionId = eventSessionId(raw)
    if (!sessionId) return
    const observedAtMs = now()
    const input = progressInput(raw, observedAtMs, wallNow())
    const classified = classifyOpenCodeProgressEvent(input)
    if (!classified) return
    const run = classified.disposition === 'terminal'
      ? runCache.get(sessionId)?.run || safeFindRun(options.findRunBySessionId, sessionId)
      : cachedObservableRun(runCache, options.findRunBySessionId, sessionId, observedAtMs, runLookupTtlMs, options.config.maxEntries)
    if (!hasProgressIdentity(run, sessionId)) return
    if (classified.disposition !== 'terminal' && !isObservableRun(run, sessionId)) return
    const binding = observationBinding(bindings, run, observedAtMs, options.config.maxEntries)
    const signature = progressEventSignature(raw, input.type)
    const progressCursor = input.sequence === undefined || input.sequence === null
      ? cursorForSignature(binding, signature)
      : undefined
    const previousState = state
    state = recordProgressWatchdogObservation(state, {
      scopeId: run.id,
      sessionId: run.sessionId,
      runId: run.id,
      runtimeGeneration,
      executionGeneration: binding.executionGeneration,
      leaseOwner: run.leaseOwner!,
      leaseEpoch: leaseEpoch(run.schedulerGeneration!),
      ...classified,
      ...(progressCursor !== undefined ? { progressCursor } : {}),
      observedAtMs,
    }, options.config.maxEntries)
    if (state !== previousState) recoveryRetries.delete(recoveryKey(run.id, run.sessionId))
    if (classified.disposition === 'terminal' && state !== previousState) {
      bindings.delete(run.id)
      runCache.delete(sessionId)
      recoveryRetries.delete(recoveryKey(run.id, run.sessionId))
    }
  }

  const runSweep = async () => {
    if (stopped) return
    reconcileTrackedRuns()
    const evaluation = evaluateProgressWatchdog(state, now(), thresholds)
    for (const decision of evaluation.decisions) {
      if (!isProgressWatchdogDecisionCurrent(state, decision)) continue
      if (decision.state === 'suspect') {
        reportDecision(options, mode, decision, 'suspect')
        state = acknowledgeProgressWatchdogDecision(state, decision)
        continue
      }
      const decisionRecoveryKey = recoveryKey(decision.scopeId, decision.sessionId)
      const retry = recoveryRetries.get(decisionRecoveryKey)
      if (retry && now() < retry.nextAttemptAtMs) continue
      reportDecision(options, mode, decision, 'stalled')
      if (mode === 'observe') {
        state = acknowledgeProgressWatchdogDecision(state, decision)
        continue
      }
      if (!isProgressWatchdogDecisionCurrent(state, decision)) {
        reportDecision(options, mode, decision, 'fenced_stale')
        continue
      }
      reportDecision(options, mode, decision, 'enforced')
      let outcome: GatewayProgressWatchdogRecoveryOutcome = 'failed'
      try {
        outcome = await options.recover(
          decision,
          () => !stopped && isProgressWatchdogDecisionCurrent(state, decision),
        )
      } catch {}
      reportDecision(options, mode, decision, outcome)
      if (outcome === 'recovered') {
        if (!isProgressWatchdogDecisionCurrent(state, decision)) {
          recoveryRetries.delete(decisionRecoveryKey)
          continue
        }
        const previousState = state
        state = recordProgressWatchdogObservation(state, {
          scopeId: decision.scopeId,
          sessionId: decision.sessionId,
          runId: decision.runId,
          runtimeGeneration: decision.runtimeGeneration,
          executionGeneration: decision.executionGeneration,
          leaseOwner: decision.leaseOwner,
          leaseEpoch: decision.leaseEpoch,
          source: 'terminal',
          disposition: 'terminal',
          observedAtMs: now(),
        }, options.config.maxEntries)
        if (state !== previousState) {
          bindings.delete(decision.scopeId)
          runCache.delete(decision.sessionId)
          recoveryRetries.delete(decisionRecoveryKey)
        }
        continue
      }
      if (!isProgressWatchdogDecisionCurrent(state, decision)) {
        recoveryRetries.delete(decisionRecoveryKey)
        continue
      }
      recoveryRetries.set(decisionRecoveryKey, nextRecoveryRetry(retry, now(), options.config.sweepMs))
      boundRecoveryRetries(recoveryRetries, options.config.maxEntries)
    }
  }

  const reconcileTrackedRuns = () => {
    const observedAtMs = now()
    const entries = [...state.entries.values()]
    if (entries.length === 0) return
    let durableRuns: readonly GatewayProgressRun[]
    try {
      durableRuns = options.findRunsBySessionIds(entries.map(entry => entry.sessionId))
    } catch {
      return
    }
    const durableRunsBySession = new Map<string, GatewayProgressRun>()
    const trackedSessions = new Set(entries.map(entry => entry.sessionId))
    for (const run of durableRuns.slice(0, options.config.maxEntries)) {
      if (trackedSessions.has(run.sessionId)) durableRunsBySession.set(run.sessionId, run)
    }
    for (const entry of entries) {
      const durableRun = durableRunsBySession.get(entry.sessionId)
      const binding = bindings.get(entry.scopeId)
      if (matchesTrackedRun(durableRun, entry, binding)) {
        cacheObservableRun(runCache, durableRun, observedAtMs, options.config.maxEntries)
        continue
      }
      state = recordProgressWatchdogObservation(state, {
        scopeId: entry.scopeId,
        sessionId: entry.sessionId,
        runId: entry.runId,
        runtimeGeneration: entry.runtimeGeneration,
        executionGeneration: entry.executionGeneration,
        leaseOwner: entry.leaseOwner,
        leaseEpoch: entry.leaseEpoch,
        source: 'terminal',
        disposition: 'terminal',
        observedAtMs,
      }, options.config.maxEntries)
      bindings.delete(entry.scopeId)
      runCache.delete(entry.sessionId)
      recoveryRetries.delete(recoveryKey(entry.scopeId, entry.sessionId))
      if (isObservableRun(durableRun, entry.sessionId)) admit(durableRun)
    }
  }

  const queueSweep = () => {
    sweepChain = sweepChain.then(runSweep, runSweep)
    return sweepChain
  }
  const timer = setIntervalFn(() => { void queueSweep() }, options.config.sweepMs)
  timer.unref?.()
  return {
    admit,
    observe,
    snapshot: () => ({
      mode,
      status: options.config.status,
      generation: runtimeGeneration,
      ...evaluateProgressWatchdog(state, now(), thresholds).snapshot,
    }),
    sweep: queueSweep,
    stop() {
      if (stopped) return
      stopped = true
      clearIntervalFn(timer)
      bindings.clear()
      runCache.clear()
      recoveryRetries.clear()
      state = createProgressWatchdogState()
    },
  }
}

export function createGatewayProgressWatchdogRuntime(input: {
  client: any
  env?: NodeJS.ProcessEnv
}): { config: GatewayProgressWatchdogConfig; controller: GatewayProgressWatchdogController | null; reseed(): void } {
  const config = resolveGatewayProgressWatchdogConfig(input.env)
  if (config.mode === 'off') return { config, controller: null, reseed() {} }
  const runtime = createOpenCodeSessionRuntime(input.client)
  const runLeasePort = createSqliteWorkStoreRunLeasePort()
  const controller = createGatewayProgressWatchdog({
    config,
    findRunBySessionId(sessionId) {
      try { return getRunBySessionId(sessionId) } catch { return undefined }
    },
    findRunsBySessionIds: getActiveRunsBySessionIdsReadOnly,
    recover: (decision, isDecisionCurrent) => recoverGatewayStalledRun(decision, {
      canWrite: canCurrentDaemonWrite,
      isDecisionCurrent,
      findRunById(runId) {
        try { return getRunReadOnly(runId) } catch { return undefined }
      },
      recoverStalledRun: value => runLeasePort.recoverStalledRun(value),
      abortSession: sessionId => runtime.abort(sessionId, undefined, { requireConfirmation: true }),
    }),
    onMetric: recordProgressWatchdogOutcome,
    onDecision({ decision, mode, outcome }) {
      if (!canCurrentDaemonWrite()) return
      try {
        appendWorkEvent('runtime.progress_watchdog.decision', decision.runId, {
          mode,
          state: decision.state,
          source: decision.source,
          outcome,
        })
      } catch {}
    },
  })
  const reseed = () => {
    if (!controller) return
    try {
      for (const run of listActiveRunsReadOnly(config.maxEntries)) controller.admit(run)
    } catch {}
  }
  reseed()
  return { config, controller, reseed }
}

export async function recoverGatewayStalledRun(
  decision: ProgressWatchdogDecision,
  dependencies: GatewayStalledRunRecoveryDependencies,
): Promise<GatewayProgressWatchdogRecoveryOutcome> {
  const isDecisionCurrent = dependencies.isDecisionCurrent || (() => true)
  if (!dependencies.canWrite() || !isDecisionCurrent()) return 'fenced_stale'
  let current: GatewayProgressRun | undefined
  try { current = dependencies.findRunById(decision.runId) } catch { return 'fenced_stale' }
  if (!current || current.status !== 'running' || current.sessionId !== decision.sessionId) return 'fenced_stale'
  if (current.leaseOwner !== decision.leaseOwner) return 'fenced_stale'
  if (!current.schedulerGeneration || leaseEpoch(current.schedulerGeneration) !== decision.leaseEpoch) return 'fenced_stale'
  if (!leaseIsFresh(current.leaseExpiresAt, (dependencies.now || Date.now)())) return 'fenced_stale'
  if (!dependencies.canWrite() || !isDecisionCurrent()) return 'fenced_stale'
  try {
    await dependencies.abortSession(decision.sessionId)
  } catch {
    return 'failed'
  }
  if (!dependencies.canWrite() || !isDecisionCurrent()) return 'fenced_stale'
  let control: ReturnType<GatewayStalledRunRecoveryDependencies['recoverStalledRun']>
  try {
    control = dependencies.recoverStalledRun({
      runId: current.id,
      leaseOwner: current.leaseOwner,
      schedulerGeneration: current.schedulerGeneration,
    })
  } catch {
    return 'failed'
  }
  return control.applied && control.abortedSessionId === decision.sessionId
    ? 'recovered'
    : 'fenced_stale'
}

function reportDecision(
  options: GatewayProgressWatchdogOptions,
  mode: Exclude<ProgressWatchdogMode, 'off'>,
  decision: ProgressWatchdogDecision,
  outcome: ProgressWatchdogMetricOutcome,
) {
  options.onMetric?.(outcome)
  options.onDecision?.({ decision, mode, outcome })
}

function disabledConfig(
  reason: GatewayProgressWatchdogConfig['reason'],
  status: GatewayProgressWatchdogConfig['status'] = 'disabled',
  requestedMode: ProgressWatchdogMode = 'off',
): GatewayProgressWatchdogConfig {
  return {
    requestedMode,
    mode: 'off',
    status,
    reason,
    suspectAfterMs: DEFAULT_SUSPECT_MS,
    stalledAfterMs: DEFAULT_STALLED_MS,
    sweepMs: DEFAULT_SWEEP_MS,
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxSnapshotEntries: DEFAULT_MAX_SNAPSHOT_ENTRIES,
  }
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number) {
  if (raw === undefined || raw === '') return { valid: true, value: fallback }
  if (!/^\d+$/.test(raw.trim())) return { valid: false, value: fallback }
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? { valid: true, value }
    : { valid: false, value: fallback }
}

function eventRecord(event: unknown): Record<string, any> {
  return event && typeof event === 'object' ? event as Record<string, any> : {}
}

function objectValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function eventPayload(event: Record<string, any>) {
  const outerPayload = objectValue(event['payload']) || event
  const globalPayload = objectValue(outerPayload['payload'])
  return typeof outerPayload['directory'] === 'string'
    && globalPayload
    && typeof globalPayload['type'] === 'string'
    && objectValue(globalPayload['properties'])
      ? globalPayload
      : outerPayload
}

function eventProperties(event: Record<string, any>) {
  const payload = eventPayload(event)
  return objectValue(payload['properties']) || objectValue(payload['data']) || payload
}

function eventSessionId(event: Record<string, any>): string | undefined {
  const payload = eventPayload(event)
  const properties = eventProperties(event)
  const info = objectValue(properties['info']) || objectValue(payload['info'])
  const message = objectValue(properties['message']) || objectValue(payload['message'])
  const part = objectValue(properties['part']) || objectValue(payload['part'])
  const candidates = [
    properties['sessionID'], properties['sessionId'], properties['session_id'],
    info?.['sessionID'], info?.['sessionId'], message?.['sessionID'], message?.['sessionId'],
    part?.['sessionID'], part?.['sessionId'], payload['sessionID'], payload['sessionId'],
  ]
  const value = candidates.find(candidate => typeof candidate === 'string' && candidate.trim())
  return typeof value === 'string' && value.length <= 500 ? value : undefined
}

function progressInput(event: Record<string, any>, observedAtMs: number, wallNowMs: number) {
  const payload = eventPayload(event)
  const properties = eventProperties(event)
  const status = objectValue(properties['status']) || objectValue(payload['status'])
  const part = objectValue(properties['part']) || objectValue(payload['part'])
  const type = String(payload['type'] || event['type'] || '').trim()
  const sequence = firstSafeInteger(event['sequence'], payload['sequence'], properties['sequence'], properties['eventSequence'])
  const progressCursor = firstSafeInteger(properties['offset'], properties['cursor'], part?.['offset'])
  const text = typeof part?.['text'] === 'string'
    ? part['text']
    : typeof properties['text'] === 'string'
      ? properties['text']
      : undefined
  const statusType = typeof status?.['type'] === 'string'
    ? status['type']
    : typeof properties['status'] === 'string'
      ? properties['status']
      : undefined
  const retryAtWallMs = firstTime(status?.['next'], status?.['retryAt'], properties['retryAt'])
  return {
    type,
    sequence,
    statusType,
    retryAtMs: retryAtWallMs === undefined
      ? undefined
      : observedAtMs + Math.max(0, retryAtWallMs - wallNowMs),
    progressCursor,
    outputLength: text?.length,
  }
}

function firstSafeInteger(...values: unknown[]): number | undefined {
  return values.find(value => Number.isSafeInteger(value) && Number(value) >= 0) as number | undefined
}

function firstTime(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string') {
      const parsed = Date.parse(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function safeFindRun(
  findRun: GatewayProgressWatchdogOptions['findRunBySessionId'],
  sessionId: string,
): GatewayProgressRun | undefined {
  try { return findRun(sessionId) } catch { return undefined }
}

function cachedObservableRun(
  cache: Map<string, CachedRunBinding>,
  findRun: GatewayProgressWatchdogOptions['findRunBySessionId'],
  sessionId: string,
  nowMs: number,
  ttlMs: number,
  maxEntries: number,
): GatewayProgressRun | undefined {
  const cached = cache.get(sessionId)
  if (cached && nowMs - cached.checkedAtMs < ttlMs) return cached.run
  const run = safeFindRun(findRun, sessionId)
  if (!isObservableRun(run, sessionId)) {
    cache.delete(sessionId)
    return undefined
  }
  cache.set(sessionId, { run, checkedAtMs: nowMs })
  boundRunCache(cache, maxEntries)
  return run
}

function cacheObservableRun(
  cache: Map<string, CachedRunBinding>,
  run: GatewayProgressRun,
  checkedAtMs: number,
  maxEntries: number,
) {
  cache.set(run.sessionId, { run, checkedAtMs })
  boundRunCache(cache, maxEntries)
}

function boundRunCache(cache: Map<string, CachedRunBinding>, maxEntries: number) {
  while (cache.size > maxEntries) cache.delete(cache.keys().next().value!)
}

function isObservableRun(run: GatewayProgressRun | undefined, sessionId: string): run is GatewayProgressRun {
  return Boolean(
    hasProgressIdentity(run, sessionId)
    && run.status === 'running',
  )
}

function hasProgressIdentity(run: GatewayProgressRun | undefined, sessionId: string): run is GatewayProgressRun {
  return Boolean(run && run.sessionId === sessionId && run.id && run.leaseOwner && run.leaseExpiresAt && run.schedulerGeneration)
}

function observationBinding(
  bindings: Map<string, RunObservationBinding>,
  run: GatewayProgressRun,
  nowMs: number,
  maxEntries: number,
) {
  const fingerprint = runIdentityFingerprint(run)
  const previous = bindings.get(run.id)
  const binding: RunObservationBinding = previous?.identityFingerprint === fingerprint
    ? { ...previous, touchedAtMs: nowMs }
    : {
        identityFingerprint: fingerprint,
        executionGeneration: (previous?.executionGeneration || 0) + 1,
        cursor: 0,
        recentSignatures: [],
        touchedAtMs: nowMs,
      }
  bindings.set(run.id, binding)
  while (bindings.size > maxEntries) {
    const oldest = [...bindings.entries()].sort(([, left], [, right]) => left.touchedAtMs - right.touchedAtMs)[0]
    if (!oldest) break
    bindings.delete(oldest[0])
  }
  return binding
}

function runIdentityFingerprint(run: GatewayProgressRun) {
  return createHash('sha256')
    .update(`${run.id}\0${run.sessionId}\0${run.attempt}\0${run.leaseOwner}\0${run.schedulerGeneration}`)
    .digest('hex')
}

function matchesTrackedRun(
  run: GatewayProgressRun | undefined,
  entry: ProgressWatchdogState['entries'] extends ReadonlyMap<string, infer Entry> ? Entry : never,
  binding: RunObservationBinding | undefined,
): run is GatewayProgressRun {
  return Boolean(
    isObservableRun(run, entry.sessionId)
    && run.id === entry.runId
    && run.leaseOwner === entry.leaseOwner
    && leaseEpoch(run.schedulerGeneration!) === entry.leaseEpoch
    && (!binding || binding.identityFingerprint === runIdentityFingerprint(run)),
  )
}

function cursorForSignature(binding: RunObservationBinding, signature: string) {
  const priorIndex = binding.recentSignatures.indexOf(signature)
  if (priorIndex >= 0) return binding.cursor - (binding.recentSignatures.length - 1 - priorIndex)
  binding.cursor += 1
  binding.recentSignatures.push(signature)
  while (binding.recentSignatures.length > RECENT_EVENT_SIGNATURES) binding.recentSignatures.shift()
  return binding.cursor
}

function progressEventSignature(event: Record<string, any>, type: string) {
  const payload = eventPayload(event)
  const nativeEventId = typeof payload['id'] === 'string' && payload['id'].length <= 500
    ? payload['id']
    : null
  return createHash('sha256')
    .update(type)
    .update('\0')
    .update(nativeEventId
      ? `event:${nativeEventId}`
      : boundedSemanticFingerprint(progressEventSemanticState(eventProperties(event), type)))
    .digest('hex')
}

function progressEventSemanticState(properties: Record<string, any>, type: string): unknown[] {
  const info = objectValue(properties['info'])
  const message = objectValue(properties['message'])
  const part = objectValue(properties['part'])
  const status = objectValue(properties['status'])
  const identity = [
    properties['assistantMessageID'], properties['assistantMessageId'],
    properties['messageID'], properties['messageId'], message?.['id'], info?.['id'],
    properties['callID'], properties['callId'], part?.['callID'],
    properties['partID'], properties['partId'], properties['textID'], properties['reasoningID'], part?.['id'],
  ]
  if (type.startsWith('session.next.tool.')) {
    return [identity, properties['tool'], properties['status'], properties['input'], properties['delta'],
      properties['content'], properties['structured'], properties['result'], properties['error'], properties['provider']]
  }
  if (type.startsWith('session.next.shell.')) {
    return [identity, properties['shellID'], properties['shellId'], properties['command'], properties['status'],
      properties['exitCode'], properties['output'], properties['delta']]
  }
  if (
    type.startsWith('session.next.text.')
    || type.startsWith('session.next.reasoning.')
    || type === 'message.part.delta'
    || type === 'message.part.updated'
  ) {
    return [identity, properties['field'], properties['delta'], properties['text'], part]
  }
  if (type === 'message.updated') return [identity, info, message]
  if (type === 'todo.updated') return [identity, properties['todos'], properties['todo']]
  if (type.startsWith('session.next.compaction.')) {
    return [identity, properties['delta'], properties['text'], properties['status']]
  }
  if (type.startsWith('permission.') || type.startsWith('question.')) {
    return [identity, properties['id'], properties['requestID'], properties['reply'], properties['response'], properties['status']]
  }
  if (type === 'session.status') {
    return [identity, status, properties['status'], properties['retryAt']]
  }
  return [identity, properties['id'], properties['status'], properties['phase'], properties['agent'],
    properties['model'], properties['from'], properties['to'], properties['finish'], properties['reason']]
}

function boundedSemanticFingerprint(value: unknown) {
  const hash = createHash('sha256')
  const budget = { remainingNodes: SEMANTIC_MAX_NODES }
  appendBoundedSemanticValue(hash, value, budget, new WeakSet<object>(), 0)
  return hash.digest('hex')
}

function appendBoundedSemanticValue(
  hash: ReturnType<typeof createHash>,
  value: unknown,
  budget: { remainingNodes: number },
  seen: WeakSet<object>,
  depth: number,
) {
  if (budget.remainingNodes-- <= 0) {
    hash.update('!budget')
    return
  }
  if (value === null || value === undefined) {
    hash.update(value === null ? 'null' : 'undefined')
    return
  }
  if (typeof value === 'string') {
    hash.update(`string:${value.length}:`)
    hash.update(value.slice(0, SEMANTIC_STRING_SAMPLE_CHARS))
    if (value.length > SEMANTIC_STRING_SAMPLE_CHARS) {
      hash.update(':tail:').update(value.slice(-SEMANTIC_STRING_SAMPLE_CHARS))
    }
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    hash.update(`${typeof value}:${String(value)}`)
    return
  }
  if (typeof value !== 'object') {
    hash.update(typeof value)
    return
  }
  if (seen.has(value)) {
    hash.update('!cycle')
    return
  }
  if (depth >= 5) {
    hash.update('!depth')
    return
  }
  seen.add(value)
  if (Array.isArray(value)) {
    hash.update(`array:${value.length}:`)
    for (const index of boundedSampleIndexes(value.length)) {
      hash.update(`index:${index}:`)
      appendBoundedSemanticValue(hash, value[index], budget, seen, depth + 1)
    }
  } else {
    const keys = Object.keys(value).sort()
    hash.update(`object:${keys.length}:`)
    for (const index of boundedSampleIndexes(keys.length)) {
      const key = keys[index]!
      hash.update(`key:${key.slice(0, SEMANTIC_STRING_SAMPLE_CHARS)}:`)
      appendBoundedSemanticValue(hash, (value as Record<string, unknown>)[key], budget, seen, depth + 1)
    }
  }
  seen.delete(value)
}

function boundedSampleIndexes(length: number) {
  if (length <= SEMANTIC_MAX_COLLECTION_SAMPLES) return Array.from({ length }, (_, index) => index)
  const half = SEMANTIC_MAX_COLLECTION_SAMPLES / 2
  return [
    ...Array.from({ length: half }, (_, index) => index),
    ...Array.from({ length: half }, (_, index) => length - half + index),
  ]
}

function recoveryKey(scopeId: string, sessionId: string) {
  return `${scopeId}\0${sessionId}`
}

function recoveryRetryDelayMs(sweepMs: number, attempts: number) {
  const baseMs = Math.max(MIN_RECOVERY_RETRY_MS, sweepMs)
  const exponentialMs = baseMs * (2 ** Math.min(MAX_RECOVERY_RETRY_EXPONENT, Math.max(0, attempts - 1)))
  return Math.max(baseMs, Math.min(MAX_RECOVERY_RETRY_MS, exponentialMs))
}

function nextRecoveryRetry(previous: RecoveryRetry | undefined, nowMs: number, sweepMs: number): RecoveryRetry {
  const attempts = Math.min((previous?.attempts || 0) + 1, MAX_RECOVERY_RETRY_EXPONENT + 1)
  return {
    attempts,
    nextAttemptAtMs: nowMs + recoveryRetryDelayMs(sweepMs, attempts),
  }
}

function boundRecoveryRetries(retries: Map<string, RecoveryRetry>, maxEntries: number) {
  while (retries.size > maxEntries) retries.delete(retries.keys().next().value!)
}

function leaseIsFresh(leaseExpiresAt: string | undefined, nowMs: number) {
  if (!leaseExpiresAt) return false
  const expiresAtMs = Date.parse(leaseExpiresAt)
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs
}

function leaseEpoch(schedulerGeneration: string) {
  return createHash('sha256').update(schedulerGeneration).digest('hex')
}
