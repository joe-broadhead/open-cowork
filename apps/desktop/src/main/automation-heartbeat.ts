import {
  createAutomationRun,
  createInboxItem,
  getAutomationDetail,
  getRun,
  listDueHeartbeats,
  listOpenInboxForAutomation,
  markHeartbeatCompleted,
} from './automation-store.ts'
import { startAutomationRun } from './automation-run-starter.ts'
import { AutomationRunConflictError, AutomationRunStartError } from './automation-service-errors.ts'
import { maybeReportFailedRun } from './automation-service-reporting.ts'
import { log } from './logger.ts'

export type AutomationUpdatePublisher = () => void

export async function runAutomationHeartbeatReviews(now: Date, publishAutomationUpdated: AutomationUpdatePublisher) {
  const due = listDueHeartbeats(now)
  for (const automation of due) {
    const detail = getAutomationDetail(automation.id)
    if (!detail) continue
    const openInbox = listOpenInboxForAutomation(automation.id)
    if (detail.status === 'needs_user') {
      const heartbeatRun = createAutomationRun(automation.id, 'heartbeat', `Heartbeat ${automation.title}`)
      if (!heartbeatRun) continue
      const summary = openInbox.length > 0
        ? `Waiting on user input or approval (${openInbox.length} open item${openInbox.length === 1 ? '' : 's'}).`
        : 'Waiting on user input.'
      if (openInbox.length === 0) {
        createInboxItem({
          automationId: automation.id,
          runId: heartbeatRun.id,
          type: 'info',
          title: 'Automation waiting for input',
          body: 'This automation is paused until the missing context or approval is provided.',
        })
      }
      markHeartbeatCompleted(heartbeatRun.id, summary)
      continue
    }
    try {
      await startAutomationRun(automation.id, 'heartbeat', publishAutomationUpdated)
    } catch (error) {
      if (error instanceof AutomationRunConflictError) continue
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Failed to start automation heartbeat ${automation.id}: ${message}`)
      const failedRun = error instanceof AutomationRunStartError && error.runId ? getRun(error.runId) : null
      maybeReportFailedRun(automation.id, failedRun, 'Automation heartbeat failed to start', message)
    }
  }
}
