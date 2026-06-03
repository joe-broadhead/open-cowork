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

let runtimeReady = false
let runtimeError: string | null = null
let runtimePhase: RuntimeReadinessPhase = 'environment'
let updatedAt = new Date().toISOString()
let timeline: RuntimeReadinessTimelineEntry[] = []
const doctorChecks = new Map<string, RuntimeDoctorCheck>()
let componentVerification: RuntimeComponentVerificationReport | null = null

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

function appendTimeline(entry: Omit<RuntimeReadinessTimelineEntry, 'timestamp'>) {
  timeline = [
    ...timeline,
    {
      ...entry,
      message: sanitizeStatusText(entry.message) || '',
      timestamp: now(),
    },
  ].slice(-MAX_TIMELINE_ENTRIES)
}

function setUpdatedAt() {
  updatedAt = now()
}

export function resetRuntimeStatus() {
  runtimeReady = false
  runtimeError = null
  runtimePhase = 'environment'
  timeline = []
  doctorChecks.clear()
  componentVerification = null
  setUpdatedAt()
  appendTimeline({
    phase: 'environment',
    status: 'started',
    message: 'Runtime status reset.',
    code: checkCodeForPhase('environment'),
  })
}

export function recordRuntimeReadinessPhase(
  phase: RuntimeReadinessPhase,
  message: string,
  options: {
    status?: RuntimeReadinessStatus
    code?: string
  } = {},
) {
  runtimePhase = phase
  setUpdatedAt()
  appendTimeline({
    phase,
    status: options.status || 'started',
    message,
    code: options.code || checkCodeForPhase(phase),
  })
}

export function recordRuntimeDoctorCheck(input: {
  code: string
  severity?: RuntimeDoctorSeverity
  status: RuntimeDoctorStatus
  message: string
  remediation?: string
  evidence?: RuntimeDoctorCheck['evidence']
}) {
  const check: RuntimeDoctorCheck = {
    code: input.code,
    severity: input.severity || (input.status === 'fail' ? 'error' : 'info'),
    status: input.status,
    message: sanitizeStatusText(input.message) || '',
    remediation: sanitizeStatusText(input.remediation) || undefined,
    evidence: input.evidence,
    updatedAt: now(),
  }
  doctorChecks.set(check.code, check)
  setUpdatedAt()
}

export function recordRuntimeComponentVerification(report: RuntimeComponentVerificationReport) {
  componentVerification = report
  recordRuntimeDoctorCheck({
    code: 'runtime.components',
    status: report.ok ? 'pass' : 'fail',
    severity: report.ok ? 'info' : 'error',
    message: report.ok
      ? 'Runtime component manifest verification passed.'
      : 'Runtime component manifest verification failed.',
    remediation: report.ok
      ? undefined
      : 'Review component hashes, signatures, compatibility status, and development override policy before release.',
    evidence: {
      componentCount: report.components.length,
      issueCount: report.issues.length,
      developmentOverride: report.developmentOverride,
    },
  })
  for (const componentIssue of report.issues) {
    recordRuntimeDoctorCheck({
      code: `runtime.component.${componentIssue.componentId || 'manifest'}.${componentIssue.code}`,
      status: componentIssue.severity === 'error' ? 'fail' : 'pending',
      severity: componentIssue.severity,
      message: componentIssue.message,
      evidence: {
        componentId: componentIssue.componentId || null,
        code: componentIssue.code,
      },
    })
  }
}

export function setRuntimeReady(value: boolean, error?: string | null) {
  if (!value && error === null) {
    resetRuntimeStatus()
    return
  }
  runtimeReady = value
  if (error !== undefined) {
    runtimeError = sanitizeStatusText(error)
  } else if (value) {
    runtimeError = null
  }
  if (value) {
    runtimePhase = 'ready'
    recordRuntimeReadinessPhase('ready', 'OpenCode runtime is ready.', { status: 'passed' })
    recordRuntimeDoctorCheck({
      code: 'runtime.ready',
      status: 'pass',
      message: 'Runtime reached ready state.',
    })
  } else if (runtimeError) {
    runtimePhase = 'error'
    recordRuntimeReadinessPhase('error', runtimeError, { status: 'failed' })
  } else {
    runtimePhase = 'environment'
    setUpdatedAt()
  }
}

export function isRuntimeReady() {
  return runtimeReady
}

export function setRuntimeError(error: string | null) {
  runtimeError = sanitizeStatusText(error)
  if (error) {
    runtimeReady = false
    runtimePhase = 'error'
    recordRuntimeReadinessPhase('error', runtimeError || 'Runtime startup failed.', { status: 'failed' })
    recordRuntimeDoctorCheck({
      code: 'runtime.startup',
      status: 'fail',
      severity: 'error',
      message: runtimeError || 'Runtime startup failed.',
      remediation: 'Review runtime input diagnostics, app configuration, and the managed OpenCode startup log.',
    })
  } else {
    setUpdatedAt()
  }
}

export function getRuntimeStatus(): RuntimeStatus {
  return {
    ready: runtimeReady,
    error: runtimeError,
    phase: runtimePhase,
    updatedAt,
    timeline: [...timeline],
    checks: [...doctorChecks.values()].sort((left, right) => left.code.localeCompare(right.code)),
    components: componentVerification,
  }
}

resetRuntimeStatus()
