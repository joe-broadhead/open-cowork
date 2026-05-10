import type {
  AutomationDetail,
  AutomationRun,
  ExecutionBrief,
} from '@open-cowork/shared'

import {
  getAutomationDetail,
  getRun,
  listOpenInboxForAutomation,
  markRunCompleted,
  resolveInboxItem,
  saveAutomationBrief,
} from './automation-store.ts'
import { startAutomationRun } from './automation-run-starter.ts'

export async function previewAutomationBriefWithContext(
  automationId: string,
  publishAutomationUpdated: () => void,
): Promise<AutomationDetail | null> {
  const automation = getAutomationDetail(automationId)
  if (!automation) return null
  await startAutomationRun(automationId, 'enrichment', publishAutomationUpdated)
  publishAutomationUpdated()
  return getAutomationDetail(automationId)
}

export function approveAutomationBriefWithContext(
  automationId: string,
  publishAutomationUpdated: () => void,
): AutomationDetail | null {
  const automation = getAutomationDetail(automationId)
  if (!automation?.brief) return null
  const approvedBrief: ExecutionBrief = {
    ...automation.brief,
    status: 'ready',
    approvedAt: new Date().toISOString(),
  }
  const updated = saveAutomationBrief(automationId, approvedBrief)
  for (const item of listOpenInboxForAutomation(automationId, 'approval')) {
    if (item.runId) {
      const run = getRun(item.runId)
      if (run?.automationId === automationId && run.kind === 'enrichment' && run.status === 'needs_user') {
        markRunCompleted(item.runId, 'Execution brief approved.', item.sessionId)
      }
    }
    resolveInboxItem(item.id, 'resolved')
  }
  publishAutomationUpdated()
  return getAutomationDetail(automationId) || updated
}

export async function runAutomationNowWithContext(
  automationId: string,
  publishAutomationUpdated: () => void,
): Promise<AutomationRun | null> {
  const automation = getAutomationDetail(automationId)
  if (!automation) return null
  if (!automation.brief || !automation.brief.approvedAt) {
    await previewAutomationBriefWithContext(automationId, publishAutomationUpdated)
    return null
  }
  const run = await startAutomationRun(automationId, 'execution', publishAutomationUpdated, {
    sopTriggerType: 'manual',
    sopInputs: {
      source: 'automation_run_now',
      requestedAt: new Date().toISOString(),
    },
  })
  publishAutomationUpdated()
  return run
}
