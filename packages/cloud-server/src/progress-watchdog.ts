import { performance } from 'node:perf_hooks'

import {
  acknowledgeProgressWatchdogDecision,
  createProgressWatchdogState,
  evaluateProgressWatchdog,
  isProgressWatchdogDecisionCurrent,
  recordProgressWatchdogObservation,
  type ProgressWatchdogDecision,
  type ProgressWatchdogMode,
  type ProgressWatchdogObservation,
  type ProgressWatchdogSnapshot,
  type ProgressWatchdogState,
} from '@open-cowork/shared/progress-watchdog'

type Env = Record<string, string | undefined>

export type CloudProgressWatchdogConfigStatus = 'valid' | 'invalid' | 'gated'
export type CloudProgressWatchdogConfigReason =
  | 'default_off'
  | 'configured'
  | 'invalid_mode'
  | 'invalid_thresholds'
  | 'missing_enforcement_evidence'

export type CloudProgressWatchdogConfig = {
  mode: ProgressWatchdogMode
  requestedMode: ProgressWatchdogMode | 'invalid'
  configStatus: CloudProgressWatchdogConfigStatus
  configReason: CloudProgressWatchdogConfigReason
  suspectAfterMs: number
  stalledAfterMs: number
  sweepIntervalMs: number
  maxEntries: number
  maxSnapshotEntries: number
}

export type CloudProgressWatchdogOutcome =
  | 'observed'
  | 'enforced'
  | 'fenced-stale'
  | 'recovered'
  | 'failed'

export type CloudProgressWatchdogDecisionEvent = {
  decision: ProgressWatchdogDecision
  outcome: CloudProgressWatchdogOutcome
}

export type CloudProgressWatchdogAuditEvent = CloudProgressWatchdogDecisionEvent & {
  mode: Exclude<ProgressWatchdogMode, 'off'>
}

export type CloudProgressWatchdogRecoveryOutcome = Extract<
  CloudProgressWatchdogOutcome,
  'fenced-stale' | 'recovered' | 'failed'
>

export type CloudProgressWatchdogSnapshot = ProgressWatchdogSnapshot & Pick<
  CloudProgressWatchdogConfig,
  'mode' | 'requestedMode' | 'configStatus' | 'configReason'
>

export type CloudProgressWatchdog = {
  observe(observation: ProgressWatchdogObservation): boolean
  sweep(): Promise<void>
  snapshot(): CloudProgressWatchdogSnapshot
  isDecisionCurrent(decision: ProgressWatchdogDecision): boolean
  close(): Promise<void>
}

export type CloudProgressWatchdogOptions = {
  config: CloudProgressWatchdogConfig
  now?: () => number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
  onDecision?: (event: CloudProgressWatchdogDecisionEvent) => void | Promise<void>
  recover?: (
    decision: ProgressWatchdogDecision,
    isCurrent: () => boolean,
  ) => Promise<CloudProgressWatchdogRecoveryOutcome>
}

const DEFAULT_SUSPECT_AFTER_MS = 120_000
const DEFAULT_STALLED_AFTER_MS = 300_000
const DEFAULT_SWEEP_INTERVAL_MS = 5_000
const DEFAULT_MAX_ENTRIES = 100
const DEFAULT_MAX_SNAPSHOT_ENTRIES = 50
const MAX_WATCHDOG_DURATION_MS = 24 * 60 * 60 * 1000
const MAX_WATCHDOG_ENTRIES = 10_000
const MAX_WATCHDOG_SNAPSHOT_ENTRIES = 100
const MIN_SUSPECT_AFTER_MS = 1_000
const MIN_STALLED_AFTER_MS = 2_000
const MIN_SWEEP_INTERVAL_MS = 250
const MIN_RECOVERY_RETRY_MS = 1_000
const MAX_RECOVERY_RETRY_MS = 60_000

type RecoveryRetry = {
  decision: ProgressWatchdogDecision
  failures: number
  nextAttemptAtMs: number
}

function recoveryRetryKey(input: Pick<ProgressWatchdogObservation, 'scopeId' | 'sessionId'>) {
  return `${input.scopeId}\0${input.sessionId}`
}

function boundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null
}

function baseConfig(): Pick<
  CloudProgressWatchdogConfig,
  'suspectAfterMs' | 'stalledAfterMs' | 'sweepIntervalMs' | 'maxEntries' | 'maxSnapshotEntries'
> {
  return {
    suspectAfterMs: DEFAULT_SUSPECT_AFTER_MS,
    stalledAfterMs: DEFAULT_STALLED_AFTER_MS,
    sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
    maxEntries: DEFAULT_MAX_ENTRIES,
    maxSnapshotEntries: DEFAULT_MAX_SNAPSHOT_ENTRIES,
  }
}

export function resolveCloudProgressWatchdogConfig(env: Env): CloudProgressWatchdogConfig {
  const rawMode = env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MODE?.trim().toLowerCase()
  const requestedMode: CloudProgressWatchdogConfig['requestedMode'] = !rawMode
    ? 'off'
    : rawMode === 'off' || rawMode === 'observe' || rawMode === 'enforce'
      ? rawMode
      : 'invalid'
  const defaults = baseConfig()
  if (requestedMode === 'invalid') {
    return {
      mode: 'off',
      requestedMode,
      configStatus: 'invalid',
      configReason: 'invalid_mode',
      ...defaults,
    }
  }

  const suspectAfterMs = boundedPositiveInteger(
    env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SUSPECT_MS,
    defaults.suspectAfterMs,
    MIN_SUSPECT_AFTER_MS,
    MAX_WATCHDOG_DURATION_MS,
  )
  const stalledAfterMs = boundedPositiveInteger(
    env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_STALLED_MS,
    defaults.stalledAfterMs,
    MIN_STALLED_AFTER_MS,
    MAX_WATCHDOG_DURATION_MS,
  )
  const sweepIntervalMs = boundedPositiveInteger(
    env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_SWEEP_MS,
    defaults.sweepIntervalMs,
    MIN_SWEEP_INTERVAL_MS,
    MAX_WATCHDOG_DURATION_MS,
  )
  const maxEntries = boundedPositiveInteger(
    env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MAX_ENTRIES,
    defaults.maxEntries,
    1,
    MAX_WATCHDOG_ENTRIES,
  )
  const maxSnapshotEntries = boundedPositiveInteger(
    env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_MAX_SNAPSHOT_ENTRIES,
    defaults.maxSnapshotEntries,
    1,
    MAX_WATCHDOG_SNAPSHOT_ENTRIES,
  )
  if (
    suspectAfterMs === null
    || stalledAfterMs === null
    || sweepIntervalMs === null
    || maxEntries === null
    || maxSnapshotEntries === null
    || suspectAfterMs >= stalledAfterMs
  ) {
    return {
      mode: 'off',
      requestedMode,
      configStatus: 'invalid',
      configReason: 'invalid_thresholds',
      ...defaults,
    }
  }

  const resolved = {
    suspectAfterMs,
    stalledAfterMs,
    sweepIntervalMs,
    maxEntries,
    maxSnapshotEntries: Math.min(maxEntries, maxSnapshotEntries),
  }
  if (requestedMode === 'enforce') {
    const evidence = env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OBSERVE_EVIDENCE_REF?.trim()
    const owner = env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_OPERATOR_OWNER?.trim()
    const rollback = env.OPEN_COWORK_CLOUD_PROGRESS_WATCHDOG_ROLLBACK_MODE?.trim().toLowerCase()
    if (!evidence || !owner || (rollback !== 'off' && rollback !== 'observe')) {
      return {
        mode: 'off',
        requestedMode,
        configStatus: 'gated',
        configReason: 'missing_enforcement_evidence',
        ...resolved,
      }
    }
  }

  return {
    mode: requestedMode,
    requestedMode,
    configStatus: 'valid',
    configReason: requestedMode === 'off' && !rawMode ? 'default_off' : 'configured',
    ...resolved,
  }
}

export function emptyCloudProgressWatchdogSnapshot(
  config: CloudProgressWatchdogConfig = resolveCloudProgressWatchdogConfig({}),
): CloudProgressWatchdogSnapshot {
  return {
    mode: config.mode,
    requestedMode: config.requestedMode,
    configStatus: config.configStatus,
    configReason: config.configReason,
    counts: { healthy: 0, waiting: 0, suspect: 0, stalled: 0 },
    samples: [],
    truncated: false,
  }
}

export function createCloudProgressWatchdog(
  options: CloudProgressWatchdogOptions,
): CloudProgressWatchdog {
  const { config } = options
  if (config.mode === 'off') {
    return {
      observe: () => false,
      sweep: async () => undefined,
      snapshot: () => emptyCloudProgressWatchdogSnapshot(config),
      isDecisionCurrent: () => false,
      close: async () => undefined,
    }
  }

  const now = options.now || (() => performance.now())
  const schedule = options.setInterval || setInterval
  const cancel = options.clearInterval || clearInterval
  let state: ProgressWatchdogState = createProgressWatchdogState()
  const recoveryRetries = new Map<string, RecoveryRetry>()
  let closed = false
  let sweepInFlight: Promise<void> | null = null

  const thresholds = {
    suspectAfterMs: config.suspectAfterMs,
    stalledAfterMs: config.stalledAfterMs,
    maxEntries: config.maxEntries,
    maxSnapshotEntries: config.maxSnapshotEntries,
  }

  const report = async (decision: ProgressWatchdogDecision, outcome: CloudProgressWatchdogOutcome) => {
    try {
      await options.onDecision?.({ decision, outcome })
    } catch {
      // Watchdog observability is best-effort and cannot alter recovery correctness.
    }
  }

  const runSweep = async () => {
    if (closed) return
    const sweepNow = now()
    for (const [key, retry] of recoveryRetries) {
      if (!isProgressWatchdogDecisionCurrent(state, retry.decision)) recoveryRetries.delete(key)
    }
    const evaluation = evaluateProgressWatchdog(state, sweepNow, thresholds)
    for (const decision of evaluation.decisions) {
      if (!isProgressWatchdogDecisionCurrent(state, decision)) continue
      if (decision.state !== 'stalled' || config.mode === 'observe') {
        state = acknowledgeProgressWatchdogDecision(state, decision)
        await report(decision, 'observed')
        continue
      }
      const retryKey = recoveryRetryKey(decision)
      const retry = recoveryRetries.get(retryKey)
      if (retry && retry.nextAttemptAtMs > sweepNow) continue
      await report(decision, 'enforced')
      const isCurrent = () => !closed
        && config.mode === 'enforce'
        && isProgressWatchdogDecisionCurrent(state, decision)
      let outcome: CloudProgressWatchdogRecoveryOutcome = 'failed'
      try {
        if (options.recover) outcome = await options.recover(decision, isCurrent)
      } catch {
        // A transient recovery failure is reported and retried below.
      }
      await report(decision, outcome)
      if (!isCurrent()) {
        recoveryRetries.delete(retryKey)
        continue
      }
      if (outcome !== 'failed') {
        state = recordProgressWatchdogObservation(state, {
          ...decision,
          source: 'terminal',
          disposition: 'terminal',
          observedAtMs: now(),
        }, config.maxEntries)
        recoveryRetries.delete(retryKey)
        continue
      }
      const failures = (retry?.failures || 0) + 1
      const retryBaseMs = Math.max(MIN_RECOVERY_RETRY_MS, config.sweepIntervalMs)
      const retryDelayMs = Math.min(MAX_RECOVERY_RETRY_MS, retryBaseMs * 2 ** Math.min(failures - 1, 10))
      recoveryRetries.set(retryKey, {
        decision,
        failures,
        nextAttemptAtMs: now() + retryDelayMs,
      })
    }
  }

  const sweep = () => {
    if (sweepInFlight) return sweepInFlight
    const pending = runSweep().finally(() => {
      if (sweepInFlight === pending) sweepInFlight = null
    })
    sweepInFlight = pending
    return pending
  }

  const timer = schedule(() => {
    void sweep()
  }, config.sweepIntervalMs)
  timer.unref?.()

  return {
    observe(observation) {
      if (closed) return false
      const next = recordProgressWatchdogObservation(state, observation, config.maxEntries)
      if (next === state) return false
      state = next
      const retryKey = recoveryRetryKey(observation)
      const retry = recoveryRetries.get(retryKey)
      if (retry && !isProgressWatchdogDecisionCurrent(state, retry.decision)) {
        recoveryRetries.delete(retryKey)
      }
      return true
    },
    sweep,
    snapshot() {
      const snapshot = evaluateProgressWatchdog(state, now(), thresholds).snapshot
      return {
        mode: config.mode,
        requestedMode: config.requestedMode,
        configStatus: config.configStatus,
        configReason: config.configReason,
        ...snapshot,
      }
    },
    isDecisionCurrent(decision) {
      return !closed && isProgressWatchdogDecisionCurrent(state, decision)
    },
    async close() {
      if (closed) return
      closed = true
      cancel(timer)
      await sweepInFlight
    },
  }
}
