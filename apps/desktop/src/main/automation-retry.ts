import type { AutomationRun } from '@open-cowork/shared'

import {
  clearPendingRetriesForChain,
  getActiveRunForAutomation,
  getAutomationDetail,
  getNextRetryAttemptForChain,
  getRun,
} from './automation-store.ts'
import { getRetryRootRunId } from './automation-service-reporting.ts'
import { AutomationRunStartError } from './automation-service-errors.ts'
import { startAutomationRun } from './automation-run-starter.ts'

export async function retryAutomationRunWithContext(
  runId: string,
  publishAutomationUpdated: () => void,
): Promise<AutomationRun | null> {
  const run = getRun(runId)
  if (!run || run.status === 'running') return null
  const automation = getAutomationDetail(run.automationId)
  if (!automation) return null
  if (automation.status === 'archived') {
    throw new Error('Archived automations cannot be started.')
  }
  const activeRun = getActiveRunForAutomation(run.automationId)
  if (activeRun) {
    throw new Error(`Automation already has an active ${activeRun.kind} run.`)
  }
  const retryRootRunId = getRetryRootRunId(run)
  const nextAttempt = getNextRetryAttemptForChain(retryRootRunId)
  try {
    const started = await startAutomationRun(run.automationId, run.kind, publishAutomationUpdated, {
      attempt: nextAttempt,
      retryOfRunId: retryRootRunId,
      title: `${run.title} (retry ${nextAttempt})`,
    })
    if (started) clearPendingRetriesForChain(retryRootRunId, started.id)
    return started
  } catch (error) {
    if (error instanceof AutomationRunStartError && error.runId) {
      clearPendingRetriesForChain(retryRootRunId, error.runId)
    }
    throw error
  }
}
