import electron from 'electron'
import type { AppSettings } from '@open-cowork/shared'

const ElectronNotification = (electron as { Notification?: typeof import('electron').Notification }).Notification

function parseClock(value: string | null | undefined) {
  if (!value) return null
  const match = value.match(/^(\d{2}):(\d{2})$/)
  if (!match) return null
  const hours = Number.parseInt(match[1], 10)
  const minutes = Number.parseInt(match[2], 10)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null
  }
  return hours * 60 + minutes
}

export function isWithinAutomationQuietHours(settings: Pick<AppSettings, 'automationQuietHoursStart' | 'automationQuietHoursEnd'>, now = new Date()) {
  const start = parseClock(settings.automationQuietHoursStart)
  const end = parseClock(settings.automationQuietHoursEnd)
  if (start == null || end == null || start === end) return false
  const minutes = now.getHours() * 60 + now.getMinutes()
  if (start < end) return minutes >= start && minutes < end
  return minutes >= start || minutes < end
}

export function shouldSendAutomationDesktopNotification(settings: Pick<AppSettings, 'automationDesktopNotifications' | 'automationQuietHoursStart' | 'automationQuietHoursEnd'>, now = new Date()) {
  if (!settings.automationDesktopNotifications) return false
  return !isWithinAutomationQuietHours(settings, now)
}

export function sendAutomationDesktopNotification(input: {
  title: string
  body: string
}) {
  if (!ElectronNotification?.isSupported?.()) return false
  const notification = new ElectronNotification({
    title: input.title,
    body: input.body,
    urgency: 'normal',
    silent: false,
  })
  notification.show()
  return true
}
