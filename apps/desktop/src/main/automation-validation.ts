import type { AutomationDraft } from '@open-cowork/shared'
import { validateAutomationSchedule } from './automation-schedule.ts'

const VALID_AUTOMATION_KINDS = new Set(['recurring', 'managed-project'])
const VALID_EXECUTION_MODES = new Set(['planning_only', 'scoped_execution'])
const VALID_AUTONOMY_POLICIES = new Set(['review-first', 'mostly-autonomous'])

export function validateAutomationDraft(draft: AutomationDraft) {
  if (!draft.title?.trim()) return 'Automation title is required.'
  if (!draft.goal?.trim()) return 'Automation goal is required.'
  if (!VALID_AUTOMATION_KINDS.has(draft.kind)) return 'Automation kind is invalid.'
  if (!VALID_EXECUTION_MODES.has(draft.executionMode)) return 'Automation execution mode is invalid.'
  if (!VALID_AUTONOMY_POLICIES.has(draft.autonomyPolicy)) return 'Automation autonomy policy is invalid.'
  if (!(draft.heartbeatMinutes > 0)) return 'Heartbeat cadence must be greater than zero.'
  if (draft.retryPolicy.maxRetries < 0) return 'Retry count cannot be negative.'
  if (!(draft.retryPolicy.baseDelayMinutes > 0)) return 'Retry base delay must be greater than zero.'
  if (draft.retryPolicy.maxDelayMinutes < draft.retryPolicy.baseDelayMinutes) {
    return 'Retry max delay must be greater than or equal to the base delay.'
  }
  if (!(draft.runPolicy.dailyRunCap > 0)) return 'Daily work-run attempt cap must be greater than zero.'
  if (!(draft.runPolicy.maxRunDurationMinutes > 0)) return 'Run duration cap must be greater than zero.'
  if (draft.runPolicy.dailyRunCap > 100) return 'Daily work-run attempt cap must stay at or below 100.'
  if (draft.runPolicy.maxRunDurationMinutes > 24 * 60) return 'Run duration cap must stay at or below 1440 minutes.'
  if (draft.executionMode === 'scoped_execution' && !draft.projectDirectory?.trim()) {
    return 'Scoped execution automations require a project directory.'
  }
  const preferredAgentNames = Array.isArray(draft.preferredAgentNames) ? draft.preferredAgentNames : []
  if (preferredAgentNames.some((name) => typeof name !== 'string' || !name.trim())) {
    return 'Preferred agents must be non-empty names.'
  }
  if (preferredAgentNames.some((name) => ['build', 'plan', 'cowork-exec'].includes(name.trim().toLowerCase()))) {
    return 'Preferred agents must be specialist agents, not the primary automation orchestrators.'
  }
  return validateAutomationSchedule(draft.schedule)
}
