import { getRun, markRunCancelled } from './automation-store.ts'
import { log } from './logger.ts'
import { getClientForDirectory } from './runtime.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getSessionRecord } from './session-registry.ts'

export async function cancelAutomationRunWithContext(
  runId: string,
  publishAutomationUpdated: () => void,
) {
  const run = getRun(runId)
  if (!run || !run.sessionId || run.status !== 'running') return false
  const record = getSessionRecord(run.sessionId)
  if (!record) {
    markRunCancelled(runId, 'Automation run cancelled.')
    publishAutomationUpdated()
    return true
  }
  await ensureRuntimeContextDirectory(record.opencodeDirectory)
  const client = getClientForDirectory(record.opencodeDirectory)
  try {
    await client?.session.abort({ sessionID: run.sessionId })
  } catch (error) {
    log('error', `Failed to abort automation run ${run.id}: ${error instanceof Error ? error.message : String(error)}`)
  }
  markRunCancelled(runId, 'Automation run cancelled.')
  publishAutomationUpdated()
  return true
}
