import {
  getAutomationDetail,
  listOpenInboxForAutomation,
  resumeRunFromNeedsUser,
} from './automation-store.ts'

export function hasBlockingInboxItems(automationId: string) {
  return listOpenInboxForAutomation(automationId).some((item) =>
    item.type === 'clarification' || item.type === 'approval' || item.type === 'failure')
}

export function maybeResumeRunAfterInboxResolution(automationId: string, runId: string | null) {
  if (!runId) return
  const automation = getAutomationDetail(automationId)
  if (!automation || automation.status === 'paused' || automation.status === 'archived') return
  if (hasBlockingInboxItems(automationId)) return
  resumeRunFromNeedsUser(runId)
}
