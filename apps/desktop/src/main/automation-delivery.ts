import type { AutomationDetail, AppSettings } from '@open-cowork/shared'
import { createDeliveryRecord } from './automation-store.ts'
import { sendAutomationDesktopNotification, shouldSendAutomationDesktopNotification } from './automation-notifications.ts'

export function deliverAutomationDesktopUpdate(input: {
  automation: AutomationDetail
  runId?: string | null
  settings: AppSettings
  title: string
  body: string
}) {
  if (!shouldSendAutomationDesktopNotification(input.settings)) return null
  const delivered = sendAutomationDesktopNotification({ title: input.title, body: input.body })
  return createDeliveryRecord({
    automationId: input.automation.id,
    runId: input.runId || null,
    provider: 'desktop_notification',
    target: 'system-notification',
    status: delivered ? 'delivered' : 'failed',
    title: input.title,
    body: input.body,
  })
}
