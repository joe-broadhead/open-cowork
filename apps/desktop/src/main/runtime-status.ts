import type {
  RuntimeDoctorCheck,
  RuntimeDoctorSeverity,
  RuntimeDoctorStatus,
  RuntimeComponentVerificationReport,
  RuntimeReadinessPhase,
  RuntimeReadinessStatus,
  RuntimeReadinessTimelineEntry,
  RuntimeStatus,
} from '@open-cowork/shared'
import { sanitizeLogMessage } from './log-sanitizer.ts'

const MAX_TIMELINE_ENTRIES = 80

export type RuntimeDoctorCheckInput = {
  code: string
  severity?: RuntimeDoctorSeverity
  status: RuntimeDoctorStatus
  message: string
  remediation?: string
  evidence?: RuntimeDoctorCheck['evidence']
}

export type RuntimeStatusState = {
  ready: boolean
  error: string | null
  phase: RuntimeReadinessPhase
  updatedAt: string
  timeline: RuntimeReadinessTimelineEntry[]
  checks: RuntimeDoctorCheck[]
  components: RuntimeComponentVerificationReport | null
}

export type RuntimeStatusAction =
  | { type: 'reset'; timestamp: string }
  | {
    type: 'record-readiness-phase'
    phase: RuntimeReadinessPhase
    message: string
    status?: RuntimeReadinessStatus
    code?: string
    timestamp: string
  }
  | { type: 'record-doctor-check'; input: RuntimeDoctorCheckInput; timestamp: string }
  | { type: 'record-component-verification'; report: RuntimeComponentVerificationReport; timestamp: string }
  | {
    type: 'set-ready'
    ready: boolean
    error?: string | null
    hasErrorArgument: boolean
    timestamp: string
  }
  | { type: 'set-error'; error: string | null; timestamp: string }

function now() {
  return new Date().toISOString()
}

function sanitizeStatusText(value: string | null | undefined) {
  if (!value) return null
  return sanitizeLogMessage(value).slice(0, 2000)
}

function checkCodeForPhase(phase: RuntimeReadinessPhase) {
  return `runtime.${phase.replace(/-/g, '_')}`
}

function cloneRuntimeStatusValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  try {
    return structuredClone(value)
  } catch {
    if (Array.isArray(value)) return [...value] as T
    return { ...(value as Record<string, unknown>) } as T
  }
}

function createEmptyRuntimeStatusState(timestamp: string): RuntimeStatusState {
  return {
    ready: false,
    error: null,
    phase: 'environment',
    updatedAt: timestamp,
    timeline: [],
    checks: [],
    components: null,
  }
}

function appendTimeline(
  state: RuntimeStatusState,
  entry: Omit<RuntimeReadinessTimelineEntry, 'timestamp'>,
  timestamp: string,
): RuntimeStatusState {
  return {
    ...state,
    updatedAt: timestamp,
    timeline: [
      ...state.timeline,
      {
        ...entry,
        message: sanitizeStatusText(entry.message) || '',
        timestamp,
      },
    ].slice(-MAX_TIMELINE_ENTRIES),
  }
}

function upsertDoctorCheck(
  state: RuntimeStatusState,
  input: RuntimeDoctorCheckInput,
  timestamp: string,
): RuntimeStatusState {
  const check: RuntimeDoctorCheck = {
    code: input.code,
    severity: input.severity || (input.status === 'fail' ? 'error' : 'info'),
    status: input.status,
    message: sanitizeStatusText(input.message) || '',
    remediation: sanitizeStatusText(input.remediation) || undefined,
    evidence: input.evidence ? { ...input.evidence } : undefined,
    updatedAt: timestamp,
  }
  return {
    ...state,
    updatedAt: timestamp,
    checks: [
      ...state.checks.filter((entry) => entry.code !== check.code),
      check,
    ],
  }
}

export function reduceRuntimeStatus(
  state: RuntimeStatusState,
  action: RuntimeStatusAction,
): RuntimeStatusState {
  switch (action.type) {
    case 'reset': {
      return appendTimeline(createEmptyRuntimeStatusState(action.timestamp), {
        phase: 'environment',
        status: 'started',
        message: 'Runtime status reset.',
        code: checkCodeForPhase('environment'),
      }, action.timestamp)
    }
    case 'record-readiness-phase': {
      return appendTimeline({
        ...state,
        phase: action.phase,
      }, {
        phase: action.phase,
        status: action.status || 'started',
        message: action.message,
        code: action.code || checkCodeForPhase(action.phase),
      }, action.timestamp)
    }
    case 'record-doctor-check':
      return upsertDoctorCheck(state, action.input, action.timestamp)
    case 'record-component-verification': {
      let next: RuntimeStatusState = {
        ...state,
        updatedAt: action.timestamp,
        components: cloneRuntimeStatusValue(action.report),
      }
      next = upsertDoctorCheck(next, {
        code: 'runtime.components',
        status: action.report.ok ? 'pass' : 'fail',
        severity: action.report.ok ? 'info' : 'error',
        message: action.report.ok
          ? 'Runtime component manifest verification passed.'
          : 'Runtime component manifest verification failed.',
        remediation: action.report.ok
          ? undefined
          : 'Review component hashes, signatures, compatibility status, and development override policy before release.',
        evidence: {
          componentCount: action.report.components.length,
          issueCount: action.report.issues.length,
          developmentOverride: action.report.developmentOverride,
        },
      }, action.timestamp)
      for (const componentIssue of action.report.issues) {
        next = upsertDoctorCheck(next, {
          code: `runtime.component.${componentIssue.componentId || 'manifest'}.${componentIssue.code}`,
          status: componentIssue.severity === 'error' ? 'fail' : 'pending',
          severity: componentIssue.severity,
          message: componentIssue.message,
          evidence: {
            componentId: componentIssue.componentId || null,
            code: componentIssue.code,
          },
        }, action.timestamp)
      }
      return next
    }
    case 'set-ready': {
      if (!action.ready && action.hasErrorArgument && action.error === null) {
        return reduceRuntimeStatus(state, { type: 'reset', timestamp: action.timestamp })
      }

      const sanitizedError = action.hasErrorArgument ? sanitizeStatusText(action.error) : state.error
      let next: RuntimeStatusState = {
        ...state,
        ready: action.ready,
        error: action.ready ? null : sanitizedError,
        updatedAt: action.timestamp,
      }

      if (action.ready) {
        next = {
          ...next,
          phase: 'ready',
        }
        next = appendTimeline(next, {
          phase: 'ready',
          status: 'passed',
          message: 'OpenCode runtime is ready.',
          code: checkCodeForPhase('ready'),
        }, action.timestamp)
        return upsertDoctorCheck(next, {
          code: 'runtime.ready',
          status: 'pass',
          message: 'Runtime reached ready state.',
        }, action.timestamp)
      }

      const errorMessage = next.error
      if (errorMessage) {
        next = {
          ...next,
          phase: 'error',
        }
        return appendTimeline(next, {
          phase: 'error',
          status: 'failed',
          message: errorMessage,
          code: checkCodeForPhase('error'),
        }, action.timestamp)
      }

      return {
        ...next,
        phase: 'environment',
      }
    }
    case 'set-error': {
      const error = sanitizeStatusText(action.error)
      if (!error) {
        return {
          ...state,
          error: null,
          updatedAt: action.timestamp,
        }
      }

      let next: RuntimeStatusState = {
        ...state,
        ready: false,
        error,
        phase: 'error',
        updatedAt: action.timestamp,
      }
      next = appendTimeline(next, {
        phase: 'error',
        status: 'failed',
        message: error,
        code: checkCodeForPhase('error'),
      }, action.timestamp)
      return upsertDoctorCheck(next, {
        code: 'runtime.startup',
        status: 'fail',
        severity: 'error',
        message: error,
        remediation: 'Review runtime input diagnostics, app configuration, and the managed OpenCode startup log.',
      }, action.timestamp)
    }
  }
}

function toRuntimeStatus(state: RuntimeStatusState): RuntimeStatus {
  return {
    ready: state.ready,
    error: state.error,
    phase: state.phase,
    updatedAt: state.updatedAt,
    timeline: state.timeline.map((entry) => cloneRuntimeStatusValue(entry)),
    checks: [...state.checks]
      .sort((left, right) => left.code.localeCompare(right.code))
      .map((check) => cloneRuntimeStatusValue(check)),
    components: cloneRuntimeStatusValue(state.components),
  }
}

export class RuntimeStatusStore {
  private state: RuntimeStatusState
  private readonly clock: () => string

  constructor(clock: () => string = now) {
    this.clock = clock
    const timestamp = this.clock()
    this.state = reduceRuntimeStatus(createEmptyRuntimeStatusState(timestamp), {
      type: 'reset',
      timestamp,
    })
  }

  reset() {
    this.dispatch({ type: 'reset', timestamp: this.clock() })
  }

  recordReadinessPhase(
    phase: RuntimeReadinessPhase,
    message: string,
    options: {
      status?: RuntimeReadinessStatus
      code?: string
    } = {},
  ) {
    this.dispatch({
      type: 'record-readiness-phase',
      phase,
      message,
      status: options.status,
      code: options.code,
      timestamp: this.clock(),
    })
  }

  recordDoctorCheck(input: RuntimeDoctorCheckInput) {
    this.dispatch({
      type: 'record-doctor-check',
      input,
      timestamp: this.clock(),
    })
  }

  recordComponentVerification(report: RuntimeComponentVerificationReport) {
    this.dispatch({
      type: 'record-component-verification',
      report,
      timestamp: this.clock(),
    })
  }

  setReady(value: boolean, error: string | null | undefined, hasErrorArgument: boolean) {
    this.dispatch({
      type: 'set-ready',
      ready: value,
      error,
      hasErrorArgument,
      timestamp: this.clock(),
    })
  }

  isReady() {
    return this.state.ready
  }

  setError(error: string | null) {
    this.dispatch({
      type: 'set-error',
      error,
      timestamp: this.clock(),
    })
  }

  getStatus(): RuntimeStatus {
    return toRuntimeStatus(this.state)
  }

  private dispatch(action: RuntimeStatusAction) {
    this.state = reduceRuntimeStatus(this.state, action)
  }
}

const runtimeStatusStore = new RuntimeStatusStore()

export function resetRuntimeStatus() {
  runtimeStatusStore.reset()
}

export function recordRuntimeReadinessPhase(
  phase: RuntimeReadinessPhase,
  message: string,
  options: {
    status?: RuntimeReadinessStatus
    code?: string
  } = {},
) {
  runtimeStatusStore.recordReadinessPhase(phase, message, options)
}

export function recordRuntimeDoctorCheck(input: RuntimeDoctorCheckInput) {
  runtimeStatusStore.recordDoctorCheck(input)
}

export function recordRuntimeComponentVerification(report: RuntimeComponentVerificationReport) {
  runtimeStatusStore.recordComponentVerification(report)
}

export function setRuntimeReady(value: boolean, error?: string | null) {
  runtimeStatusStore.setReady(value, error, error !== undefined)
}

export function isRuntimeReady() {
  return runtimeStatusStore.isReady()
}

export function setRuntimeError(error: string | null) {
  runtimeStatusStore.setError(error)
}

export function getRuntimeStatus(): RuntimeStatus {
  return runtimeStatusStore.getStatus()
}
