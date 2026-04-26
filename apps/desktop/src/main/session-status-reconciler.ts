import type { BrowserWindow } from 'electron'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { isRuntimeReady } from './runtime-status.ts'
import { getSessionRecord } from './session-registry.ts'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { measureAsyncPerf } from './perf-metrics.ts'
import { createSessionStatusReconciler } from './session-status-coordinator.ts'

type RuntimeSessionStatusReconcilerOptions = {
  getMainWindow: () => BrowserWindow | null
  initialDelayMs?: number
  maxDelayMs?: number
  onIdle: (win: BrowserWindow | null, sessionId: string) => void | Promise<void>
}

async function lookupRuntimeSessionStatus(sessionId: string): Promise<string | null> {
  const record = getSessionRecord(sessionId)
  if (!record) return null
  if (!isRuntimeReady()) return null

  const client = getClientForDirectory(record.opencodeDirectory || getRuntimeHomeDir())
  if (!client) return null

  const result = await measureAsyncPerf('session.status.lookup', async () => {
    return client.session.status()
  }, {
    slowThresholdMs: 200,
    slowData: { sessionId: shortSessionId(sessionId) },
  })

  const statuses = ((result.data as Record<string, { type?: string }> | undefined) || {})
  return typeof statuses[sessionId]?.type === 'string'
    ? statuses[sessionId].type
    : null
}

const runtimeSessionStatusReconciler = createSessionStatusReconciler(lookupRuntimeSessionStatus)

export function startSessionStatusReconciliation(
  sessionId: string,
  options: RuntimeSessionStatusReconcilerOptions,
) {
  runtimeSessionStatusReconciler.start(sessionId, {
    initialDelayMs: options.initialDelayMs,
    maxDelayMs: options.maxDelayMs,
    onIdle: async () => {
      log('session', `Reconciled idle via status for ${shortSessionId(sessionId)}`)
      await options.onIdle(options.getMainWindow(), sessionId)
    },
    onError: (err) => {
      const message = err instanceof Error
        ? err.message
        : typeof err === 'string'
          ? err
          : JSON.stringify(err)
      log('error', `session.status reconcile ${shortSessionId(sessionId)} failed: ${message}`)
    },
  })
}

export function stopSessionStatusReconciliation(sessionId: string) {
  runtimeSessionStatusReconciler.stop(sessionId)
}
