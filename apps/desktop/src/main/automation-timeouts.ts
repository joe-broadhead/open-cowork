import {
  getAutomationDetail,
  listActiveAutomationRuns,
} from './automation-store.ts'
import { processAutomationRunFailure } from './automation-service-reporting.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { getClientForDirectory } from './runtime.ts'
import { getSessionRecord } from './session-registry.ts'
import { log } from './logger.ts'

export type AutomationSessionErrorHandler = (sessionId: string, message: string) => void
export type AutomationUpdatePublisher = () => void

export async function enforceAutomationRunTimeLimits(
  now: Date,
  onSessionError: AutomationSessionErrorHandler,
  publishAutomationUpdated: AutomationUpdatePublisher,
) {
  const activeRuns = listActiveAutomationRuns()
  for (const run of activeRuns) {
    if (run.kind === 'heartbeat') continue
    const automation = getAutomationDetail(run.automationId)
    if (!automation) continue
    const startedAt = run.startedAt || run.createdAt
    if (!startedAt) continue
    const elapsedMs = now.getTime() - new Date(startedAt).getTime()
    if (elapsedMs < automation.runPolicy.maxRunDurationMinutes * 60_000) continue
    const message = `Automation run timed out after exceeding the ${automation.runPolicy.maxRunDurationMinutes}-minute run cap.`
    if (run.sessionId) {
      const record = getSessionRecord(run.sessionId)
      if (record) {
        await ensureRuntimeContextDirectory(record.opencodeDirectory)
        const client = getClientForDirectory(record.opencodeDirectory)
        try {
          await client?.session.abort({ sessionID: run.sessionId })
        } catch (error) {
          log('error', `Failed to abort timed-out automation run ${run.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
        onSessionError(run.sessionId, message)
        continue
      }
    }
    processAutomationRunFailure({
      automationId: run.automationId,
      run,
      title: 'Automation run timed out',
      message,
      sessionId: null,
      failureCode: 'run_timeout',
    })
    publishAutomationUpdated()
  }
}
