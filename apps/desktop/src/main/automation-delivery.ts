import type { AutomationDetail, AutomationRun, AppSettings } from '@open-cowork/shared'
import { createDeliveryRecord } from './automation-store.ts'
import { sendAutomationDesktopNotification, shouldSendAutomationDesktopNotification } from './automation-notifications.ts'

type DeliveryInput = {
  automation: AutomationDetail
  run: AutomationRun
  summary: string
}

type DeliveryProvider = {
  provider: 'in_app'
  deliver(input: DeliveryInput): ReturnType<typeof createDeliveryRecord>
}

const inAppProvider: DeliveryProvider = {
  provider: 'in_app',
  deliver(input) {
    return createDeliveryRecord({
      automationId: input.automation.id,
      runId: input.run.id,
      provider: 'in_app',
      target: 'automation-inbox',
      status: 'delivered',
      title: `${input.automation.title} output ready`,
      body: input.summary,
    })
  },
}

export function deliverAutomationRunResult(input: DeliveryInput) {
  return [inAppProvider.deliver(input)].filter(Boolean)
}

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
