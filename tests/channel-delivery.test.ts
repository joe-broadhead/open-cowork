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
  getChannelInboundItem,
  recordChannelInboundItem,
} from '../apps/desktop/src/main/channel-store.ts'
import {
  cancelChannelDelivery,
  deliverChannelDesktopNotification,
  sendChannelDelivery,
} from '../apps/desktop/src/main/channel-delivery.ts'
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

async function withChannelDeliveryStore(name: string, fn: () => void | Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    resetStores(userDataDir)
    await fn()
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

test('channel webhook delivery sends draft-first callbacks only after explicit review', async () => {
  await withChannelDeliveryStore('webhook-send', async () => {
    const channel = createChannelDefinition({
      provider: 'local_webhook',
      name: 'Support webhook',
      sourceKey: 'support',
      senderAllowlist: ['ops@example.com'],
      route: { activationMode: 'draft_reply' },
    })
    const item = recordChannelInboundItem({
      channelId: channel.id,
      sender: 'ops@example.com',
      subject: 'Review this request',
      body: 'Please review before routing.',
      replyTarget: 'https://callback.example/hooks/open-cowork',
    })
    const delivery = listChannelDeliveryRecords()[0]
    assert.ok(delivery)
    assert.equal(item.status, 'drafted')
    assert.equal(delivery.status, 'draft')
    assert.equal(delivery.provider, 'webhook')
    assert.equal(delivery.target, 'https://callback.example/hooks/open-cowork')

    let sentPayload: { deliveryId?: string; approvalIds?: string[] } | null = null
    const delivered = await sendChannelDelivery(delivery.id, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      sendWebhook: async (_record, payload) => {
        sentPayload = payload
        return { ok: true, status: 202 }
      },
    })

    assert.equal(delivered?.status, 'delivered')
    assert.equal(delivered?.approvalIds.length, 1)
    assert.equal(sentPayload?.deliveryId, delivery.id)
    assert.deepEqual(sentPayload?.approvalIds, delivered?.approvalIds)
    assert.equal(getChannelInboundItem(item.id)?.status, 'drafted')
  })
})

test('concurrent channel webhook delivery approvals send one callback', async () => {
  await withChannelDeliveryStore('webhook-concurrent-send', async () => {
    const channel = createChannelDefinition({
      provider: 'local_webhook',
      name: 'Support webhook',
      sourceKey: 'support',
      senderAllowlist: ['ops@example.com'],
      route: { activationMode: 'draft_reply' },
    })
    recordChannelInboundItem({
      channelId: channel.id,
      sender: 'ops@example.com',
      body: 'Send once.',
      replyTarget: 'https://callback.example/hooks/open-cowork',
    })
    const delivery = listChannelDeliveryRecords()[0]
    assert.ok(delivery)

    let sendCalls = 0
    let resolveSend: ((result: { ok: boolean; status: number }) => void) | null = null
    const first = sendChannelDelivery(delivery.id, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      sendWebhook: async () => {
        sendCalls += 1
        return await new Promise((resolve) => {
          resolveSend = resolve
        })
      },
    })
    const second = await sendChannelDelivery(delivery.id, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      sendWebhook: async () => {
        sendCalls += 1
        return { ok: true, status: 202 }
      },
    })
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(second?.status, 'sending')
    assert.equal(sendCalls, 1)
    assert.ok(resolveSend)
    resolveSend({ ok: true, status: 202 })
    const delivered = await first

    assert.equal(delivered?.status, 'delivered')
    assert.equal(sendCalls, 1)
  })
})

test('channel webhook delivery failures are recorded without losing inbound work', async () => {
  await withChannelDeliveryStore('webhook-failure', async () => {
    const channel = createChannelDefinition({
      provider: 'local_webhook',
      name: 'Support webhook',
      sourceKey: 'support',
      senderAllowlist: ['ops@example.com'],
      route: { activationMode: 'draft_reply' },
    })
    const item = recordChannelInboundItem({
      channelId: channel.id,
      sender: 'ops@example.com',
      body: 'Send a callback.',
      replyTarget: 'http://callback.example/hooks/open-cowork',
    })
    const delivery = listChannelDeliveryRecords()[0]
    assert.ok(delivery)

    const failed = await sendChannelDelivery(delivery.id, {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      sendWebhook: async () => {
        throw new Error('should not send blocked targets')
      },
    })

    assert.equal(failed?.status, 'failed')
    assert.match(failed?.error || '', /https URLs/)
    assert.equal(getChannelInboundItem(item.id)?.status, 'drafted')
  })
})

test('channel delivery drafts can be cancelled but unsupported providers stay draft-only', async () => {
  await withChannelDeliveryStore('delivery-cancel', async () => {
    const channel = createChannelDefinition({
      provider: 'slack',
      name: 'Customer Slack',
      sourceKey: 'customer-slack',
      senderAllowlist: ['customer@example.com'],
      route: { activationMode: 'draft_reply' },
    })
    recordChannelInboundItem({
      channelId: channel.id,
      sender: 'customer@example.com',
      body: 'Please draft a reply.',
    })
    const delivery = listChannelDeliveryRecords()[0]
    assert.ok(delivery)

    await assert.rejects(
      () => sendChannelDelivery(delivery.id),
      /draft-only/,
    )
    assert.equal(listChannelDeliveryRecords()[0]?.status, 'draft')

    const cancelled = cancelChannelDelivery(delivery.id, 'No longer needed.')
    assert.equal(cancelled?.status, 'cancelled')
    assert.equal(cancelled?.error, 'No longer needed.')
    assert.throws(
      () => cancelChannelDelivery(delivery.id, 'again'),
      /Only draft delivery records/,
    )
  })
})
