import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearChannelStoreCache,
  createChannelDefinition,
  listChannelDeliveryRecords,
  recordChannelInboundItem,
} from '../apps/desktop/src/main/channel-store.ts'
import { deliverChannelDesktopNotification } from '../apps/desktop/src/main/channel-delivery.ts'
import { clearOperationalQueueStoreCache } from '../apps/desktop/src/main/operational-queue-store.ts'

const notificationSettings = {
  automationDesktopNotifications: true,
  automationQuietHoursStart: null,
  automationQuietHoursEnd: null,
}

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-channel-delivery-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function resetStores(userDataDir: string) {
  process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
  clearConfigCaches()
  clearChannelStoreCache()
  clearOperationalQueueStoreCache()
}

function withChannelDeliveryStore(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetStores(userDataDir)
    fn()
  } finally {
    clearChannelStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

test('channel desktop notifications are recorded as delivery attempts without completing channel work', () => withChannelDeliveryStore('desktop-notification', () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Support webhook',
    sourceKey: 'support',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    subject: 'Review this request',
    body: 'Please review before routing.',
  })

  const delivery = deliverChannelDesktopNotification({ item, settings: notificationSettings })
  const deliveries = listChannelDeliveryRecords()

  assert.ok(delivery)
  assert.equal(delivery.provider, 'desktop_notification')
  assert.equal(delivery.channelId, channel.id)
  assert.equal(delivery.inboundItemId, item.id)
  assert.equal(delivery.target, 'system-notification')
  assert.equal(delivery.title, 'Review this request')
  assert.equal(delivery.draftFirst, false)
  assert.match(delivery.status, /^(delivered|failed)$/)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]?.id, delivery.id)
  assert.equal(item.status, 'needs_user')
  const denied = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'attacker@example.net',
    body: 'Do not notify denied senders.',
  })
  assert.equal(denied.status, 'denied')
  assert.equal(deliverChannelDesktopNotification({ item: denied, settings: notificationSettings }), null)
  assert.equal(listChannelDeliveryRecords().length, 1)
}))

test('channel desktop notifications respect the shared notification toggle', () => withChannelDeliveryStore('desktop-notification-disabled', () => {
  const channel = createChannelDefinition({
    provider: 'local_webhook',
    name: 'Support webhook',
    sourceKey: 'support',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  const item = recordChannelInboundItem({
    channelId: channel.id,
    sender: 'ops@example.com',
    subject: 'Review this request',
    body: 'Please review before routing.',
  })

  const delivery = deliverChannelDesktopNotification({
    item,
    settings: {
      ...notificationSettings,
      automationDesktopNotifications: false,
    },
  })

  assert.equal(delivery, null)
  assert.equal(listChannelDeliveryRecords().length, 0)
}))
