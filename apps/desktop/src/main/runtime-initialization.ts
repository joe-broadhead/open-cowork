import type { BrowserWindow } from 'electron'
import type { RuntimeLoadingPhase, RuntimeLoadingStatus } from '@open-cowork/shared'

type Deferred = {
  promise: Promise<RuntimeLoadingStatus>
  resolve: (status: RuntimeLoadingStatus) => void
}

let getLoadingWindow: (() => BrowserWindow | null) | null = null
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
  const win = getLoadingWindow?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send('runtime:loading-status', status)
  }
}

export function configureRuntimeInitialization(options: {
  getLoadingWindow: () => BrowserWindow | null
}) {
  getLoadingWindow = options.getLoadingWindow
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
  publish(currentStatus)
}

export function resolveRuntimeInitializationReady(message = 'Runtime is ready.') {
  currentStatus = createStatus('ready', message, true, null)
  publish(currentStatus)
  deferred.resolve(currentStatus)
}

export function resolveRuntimeInitializationError(message: string) {
  currentStatus = createStatus('error', message, false, message)
  publish(currentStatus)
  deferred.resolve(currentStatus)
}
