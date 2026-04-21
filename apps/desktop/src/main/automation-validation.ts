import type { AutomationDraft } from '@open-cowork/shared'
import { validateAutomationSchedule } from './automation-schedule.ts'

export function validateAutomationDraft(draft: AutomationDraft) {
  if (!draft.title?.trim()) return 'Automation title is required.'
  if (!draft.goal?.trim()) return 'Automation goal is required.'
  if (!(draft.heartbeatMinutes > 0)) return 'Heartbeat cadence must be greater than zero.'
  if (draft.retryPolicy.maxRetries < 0) return 'Retry count cannot be negative.'
  if (!(draft.retryPolicy.baseDelayMinutes > 0)) return 'Retry base delay must be greater than zero.'
  if (draft.retryPolicy.maxDelayMinutes < draft.retryPolicy.baseDelayMinutes) {
    return 'Retry max delay must be greater than or equal to the base delay.'
  }
  if (draft.executionMode === 'scoped_execution' && !draft.projectDirectory?.trim()) {
    return 'Scoped execution automations require a project directory.'
  }
  return validateAutomationSchedule(draft.schedule)
}
