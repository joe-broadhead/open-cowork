import { getSessionRecord } from '@open-cowork/runtime-host/session-registry'
import { getClientForDirectory, getRuntimeHomeDir } from '@open-cowork/runtime-host/runtime'
import { isRuntimeReady } from '@open-cowork/runtime-host/runtime-status'
import { measureAsyncPerf } from '@open-cowork/runtime-host/perf-metrics'
import { shortSessionId } from '@open-cowork/shared'
import type { BrowserWindow } from 'electron'
import { log } from '@open-cowork/shared/node'
import { createSessionStatusReconciler } from './session-status-coordinator.ts'
import { listNativeActiveSessionIds } from '@open-cowork/runtime-host'

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
    return listNativeActiveSessionIds(client)
  }, {
    slowThresholdMs: 200,
    slowData: { sessionId: shortSessionId(sessionId) },
  })

  return result.has(sessionId) ? 'busy' : 'idle'
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
