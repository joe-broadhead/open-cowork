import type { AppSettings, ChannelInboundItem } from '@open-cowork/shared'
import { sendAutomationDesktopNotification, shouldSendAutomationDesktopNotification } from './automation-notifications.ts'
import { createChannelDeliveryRecord } from './channel-store.ts'

function notificationTitle(item: ChannelInboundItem) {
  return item.subject || `Channel item from ${item.sender}`
}

function notificationBody(item: ChannelInboundItem) {
  switch (item.status) {
    case 'needs_user':
      return 'Channel input needs review before work continues.'
    case 'queued':
      return 'Channel input is queued for supervised work.'
    case 'drafted':
      return 'Channel input created a draft reply.'
    case 'failed':
      return item.error || 'Channel input failed.'
    case 'received':
      return 'Channel input was received.'
    case 'denied':
      return item.error || 'Channel input was denied.'
  }
}

function shouldNotifyForChannelItem(item: ChannelInboundItem) {
  return item.status === 'needs_user'
    || item.status === 'queued'
    || item.status === 'drafted'
    || item.status === 'failed'
}

export function deliverChannelDesktopNotification(input: {
  item: ChannelInboundItem
  settings: Pick<AppSettings, 'automationDesktopNotifications' | 'automationQuietHoursStart' | 'automationQuietHoursEnd'>
}) {
  if (!shouldNotifyForChannelItem(input.item)) return null
  if (!shouldSendAutomationDesktopNotification(input.settings)) return null
  const title = notificationTitle(input.item)
  const body = notificationBody(input.item)
  const delivered = sendAutomationDesktopNotification({ title, body })
  return createChannelDeliveryRecord({
    channelId: input.item.channelId,
    inboundItemId: input.item.id,
    provider: 'desktop_notification',
    target: 'system-notification',
    status: delivered ? 'delivered' : 'failed',
    title,
    body,
    draftFirst: false,
    error: delivered ? null : 'Desktop notifications are not supported.',
  })
}
