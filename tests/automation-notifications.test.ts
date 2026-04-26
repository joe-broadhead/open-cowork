import test from 'node:test'
import assert from 'node:assert/strict'
import { isWithinAutomationQuietHours, shouldSendAutomationDesktopNotification } from '../apps/desktop/src/main/automation-notifications.ts'

const baseSettings = {
  automationDesktopNotifications: true,
  automationQuietHoursStart: '22:00',
  automationQuietHoursEnd: '07:00',
}

test('quiet hours suppress overnight notifications across midnight', () => {
  assert.equal(isWithinAutomationQuietHours(baseSettings, new Date('2026-04-20T22:30:00')), true)
  assert.equal(isWithinAutomationQuietHours(baseSettings, new Date('2026-04-21T06:59:00')), true)
  assert.equal(isWithinAutomationQuietHours(baseSettings, new Date('2026-04-21T09:00:00')), false)
})

test('desktop notifications respect the global toggle and quiet hours', () => {
  assert.equal(shouldSendAutomationDesktopNotification(baseSettings, new Date('2026-04-21T09:00:00')), true)
  assert.equal(shouldSendAutomationDesktopNotification(baseSettings, new Date('2026-04-20T23:00:00')), false)
  assert.equal(shouldSendAutomationDesktopNotification({
    ...baseSettings,
    automationDesktopNotifications: false,
  }, new Date('2026-04-21T09:00:00')), false)
})
