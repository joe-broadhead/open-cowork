import type { BrowserWindow } from 'electron'
import type { RuntimeLoadingPhase, RuntimeLoadingStatus } from '@open-cowork/shared'
import { recordRuntimeDoctorCheck, recordRuntimeReadinessPhase } from './runtime-status.ts'

type Deferred = {
  promise: Promise<RuntimeLoadingStatus>
  resolve: (status: RuntimeLoadingStatus) => void
}

let getLoadingWindow: (() => BrowserWindow | null) | null = null
let getStatusWindows: (() => Array<BrowserWindow | null>) | null = null
let currentStatus: RuntimeLoadingStatus = createStatus('idle', 'Waiting to start runtime.', false, null)
let deferred: Deferred = createDeferred()

function createStatus(
  phase: RuntimeLoadingPhase,
  message: string,
  ready: boolean,
  error: string | null,
): RuntimeLoadingStatus {
  return {
    phase,
    message,
    ready,
    error,
    updatedAt: new Date().toISOString(),
  }
}

function createDeferred(): Deferred {
  let resolve!: (status: RuntimeLoadingStatus) => void
  const promise = new Promise<RuntimeLoadingStatus>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function publish(status: RuntimeLoadingStatus) {
  const windows = [getLoadingWindow?.(), ...(getStatusWindows?.() || [])]
  const seen = new Set<number>()
  for (const win of windows) {
    if (!win || win.isDestroyed() || seen.has(win.id)) continue
    seen.add(win.id)
    win.webContents.send('runtime:loading-status', status)
  }
}

function readinessPhaseForLoadingPhase(phase: RuntimeLoadingPhase) {
  switch (phase) {
    case 'idle':
    case 'starting':
      return 'environment'
    case 'config':
      return 'config-build'
    case 'managed-server':
      return 'process-launch'
    case 'connecting-events':
      return 'event-stream'
    case 'mcp':
      return 'mcp-skill-bridge'
    case 'ready':
      return 'ready'
    case 'error':
      return 'error'
  }
}

function readinessCode(phase: ReturnType<typeof readinessPhaseForLoadingPhase>) {
  return `runtime.${phase.replace(/-/g, '_')}`
}

function startupFailureRemediation(phase: RuntimeLoadingPhase) {
  switch (phase) {
    case 'config':
      return 'Review generated runtime configuration, capability bundle preflight, MCP policy, and component manifest diagnostics.'
    case 'managed-server':
      return 'Review managed OpenCode process launch logs, bundled CLI resolution, component verification, and startup timeout diagnostics.'
    case 'connecting-events':
      return 'Review OpenCode event stream connectivity, managed server auth, and health/auth diagnostics.'
    case 'mcp':
      return 'Review MCP and skill bridge status, missing credentials, disabled policy, and startup recovery diagnostics.'
    case 'starting':
    case 'idle':
      return 'Review runtime environment, app configuration, and the managed OpenCode startup log.'
    case 'ready':
    case 'error':
      return 'Review the latest runtime readiness timeline and startup diagnostics.'
  }
}

export function configureRuntimeInitialization(options: {
  getLoadingWindow: () => BrowserWindow | null
  getStatusWindows?: () => Array<BrowserWindow | null>
}) {
  getLoadingWindow = options.getLoadingWindow
  getStatusWindows = options.getStatusWindows || null
}

export function getRuntimeInitializationStatus() {
  return currentStatus
}

export function awaitRuntimeInitialization() {
  if (currentStatus.ready || currentStatus.phase === 'error') return Promise.resolve(currentStatus)
  return deferred.promise
}

export function setRuntimeInitializationPhase(phase: RuntimeLoadingPhase, message: string) {
  if (currentStatus.ready || currentStatus.phase === 'error') {
    deferred = createDeferred()
  }
  currentStatus = createStatus(phase, message, false, null)
  const readinessPhase = readinessPhaseForLoadingPhase(phase)
  recordRuntimeReadinessPhase(readinessPhase, message)
  recordRuntimeDoctorCheck({
    code: readinessCode(readinessPhase),
    status: 'pending',
    message,
  })
  publish(currentStatus)
}

export function resolveRuntimeInitializationReady(message = 'Runtime is ready.') {
  currentStatus = createStatus('ready', message, true, null)
  recordRuntimeReadinessPhase('ready', message, { status: 'passed' })
  recordRuntimeDoctorCheck({
    code: 'runtime.ready',
    status: 'pass',
    message,
  })
  publish(currentStatus)
  deferred.resolve(currentStatus)
}

export function resolveRuntimeInitializationError(message: string) {
  const failedLoadingPhase = currentStatus.phase === 'error' ? 'starting' : currentStatus.phase
  const failedReadinessPhase = readinessPhaseForLoadingPhase(failedLoadingPhase)
  const failedCode = `${readinessCode(failedReadinessPhase)}.failed`
  currentStatus = createStatus('error', message, false, message)
  recordRuntimeReadinessPhase(failedReadinessPhase, message, {
    status: 'failed',
    code: failedCode,
  })
  recordRuntimeDoctorCheck({
    code: failedCode,
    status: 'fail',
    severity: 'error',
    message,
    remediation: startupFailureRemediation(failedLoadingPhase),
    evidence: {
      loadingPhase: failedLoadingPhase,
      readinessPhase: failedReadinessPhase,
    },
  })
  recordRuntimeDoctorCheck({
    code: 'runtime.startup',
    status: 'fail',
    severity: 'error',
    message,
    remediation: 'Review the phase-specific runtime readiness check and managed OpenCode startup diagnostics.',
  })
  publish(currentStatus)
  deferred.resolve(currentStatus)
}
