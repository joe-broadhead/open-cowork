import type { AutomationDraft } from '@open-cowork/shared'

import {
  createAutomation,
  resumeAutomationStatus,
  updateAutomation,
  updateAutomationStatus,
} from './automation-store.ts'

export function createAutomationRecordWithContext(
  draft: AutomationDraft,
  publishAutomationUpdated: () => void,
) {
  const created = createAutomation(draft)
  publishAutomationUpdated()
  return created
}

export function updateAutomationRecordWithContext(
  automationId: string,
  draft: Partial<AutomationDraft>,
  publishAutomationUpdated: () => void,
) {
  const updated = updateAutomation(automationId, draft)
  publishAutomationUpdated()
  return updated
}

export function pauseAutomationRecordWithContext(
  automationId: string,
  publishAutomationUpdated: () => void,
) {
  const updated = updateAutomationStatus(automationId, 'paused')
  publishAutomationUpdated()
  return updated
}

export function resumeAutomationRecordWithContext(
  automationId: string,
  publishAutomationUpdated: () => void,
) {
  const updated = resumeAutomationStatus(automationId)
  publishAutomationUpdated()
  return updated
}

export function archiveAutomationRecordWithContext(
  automationId: string,
  publishAutomationUpdated: () => void,
) {
  const updated = updateAutomationStatus(automationId, 'archived')
  publishAutomationUpdated()
  return updated
}
