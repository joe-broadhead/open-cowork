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
  markChannelInboundItemDispatched,
  recordChannelInboundItem,
} from '../apps/desktop/src/main/channel-store.ts'
import {
  cancelChannelDelivery,
  createChannelRunDeliveryDraft,
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

test('completed channel SOP runs create draft delivery records with output links', async () => {
  await withChannelDeliveryStore('sop-run-draft', async () => {
    const channel = createChannelDefinition({
      provider: 'local_webhook',
      name: 'Support webhook',
      sourceKey: 'support',
      senderAllowlist: ['ops@example.com'],
      route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
    })
    const item = recordChannelInboundItem({
      channelId: channel.id,
      sender: 'ops@example.com',
      subject: 'Weekly digest',
      body: 'Run the digest.',
      externalMessageId: 'msg-1',
      replyTarget: 'https://callback.example/hooks/open-cowork',
    })
    const dispatched = markChannelInboundItemDispatched(item.id, {
      runKind: 'sop',
      runId: 'automation-run-1',
      approvedBy: 'local-user',
    })
    assert.ok(dispatched)

    const delivery = createChannelRunDeliveryDraft(item.id, {
      getSopRunDetail: () => ({
        run: {
          schemaVersion: 1,
          id: 'automation-run-1',
          automationId: 'automation-1',
          sessionId: 'session-1',
          kind: 'execution',
          status: 'completed',
          title: 'Run SOP',
          summary: 'Completed summary.',
          error: null,
          failureCode: null,
          attempt: 1,
          retryOfRunId: null,
          nextRetryAt: null,
          createdAt: '2026-05-11T00:00:00.000Z',
          startedAt: '2026-05-11T00:01:00.000Z',
          finishedAt: '2026-05-11T00:02:00.000Z',
        },
        outputs: {
          schemaVersion: 1,
          summary: 'Send this weekly digest.',
          deliveries: [],
        },
        artifacts: [{
          schemaVersion: 1,
          id: 'chart:session-1/report.png',
          title: 'Weekly chart',
          mime: 'image/png',
          uri: 'chart-artifact:session-1/report.png',
          hash: null,
          createdAt: '2026-05-11T00:02:00.000Z',
        }],
        approvals: [{
          id: 'approval-1',
          automationId: 'automation-1',
          runId: 'automation-run-1',
          sessionId: null,
          questionId: null,
          type: 'approval',
          status: 'resolved',
          title: 'Approve digest',
          body: 'Approved.',
          createdAt: '2026-05-11T00:01:00.000Z',
          updatedAt: '2026-05-11T00:01:30.000Z',
        }],
      }),
    })

    assert.equal(delivery?.provider, 'webhook')
    assert.equal(delivery?.target, 'https://callback.example/hooks/open-cowork')
    assert.equal(delivery?.status, 'draft')
    assert.equal(delivery?.runKind, 'sop')
    assert.equal(delivery?.runId, 'automation-run-1')
    assert.deepEqual(delivery?.artifactIds, ['chart:session-1/report.png'])
    assert.deepEqual(delivery?.approvalIds, ['approval-1'])
    assert.match(delivery?.body || '', /Send this weekly digest/)
    assert.equal(getChannelInboundItem(item.id)?.deliveryRecordId, delivery?.id)

    const duplicate = createChannelRunDeliveryDraft(item.id, {
      getSopRunDetail: () => {
        throw new Error('existing delivery should be reused')
      },
    })
    assert.equal(duplicate?.id, delivery?.id)
  })
})

test('channel run delivery draft bodies are capped before review', async () => {
  await withChannelDeliveryStore('run-draft-body-cap', async () => {
    const channel = createChannelDefinition({
      provider: 'local_webhook',
      name: 'Support webhook',
      sourceKey: 'support',
      senderAllowlist: ['ops@example.com'],
      route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
    })
    const item = recordChannelInboundItem({
      channelId: channel.id,
      sender: 'ops@example.com',
      subject: 'Large weekly digest',
      body: 'Run the digest.',
      replyTarget: 'https://callback.example/hooks/open-cowork',
    })
    markChannelInboundItemDispatched(item.id, {
      runKind: 'sop',
      runId: 'automation-run-large',
      approvedBy: 'local-user',
    })

    const delivery = createChannelRunDeliveryDraft(item.id, {
      getSopRunDetail: () => ({
        run: {
          schemaVersion: 1,
          id: 'automation-run-large',
          automationId: 'automation-1',
          sessionId: 'session-1',
          kind: 'execution',
          status: 'completed',
          title: 'Run SOP',
          summary: null,
          error: null,
          failureCode: null,
          attempt: 1,
          retryOfRunId: null,
          nextRetryAt: null,
          createdAt: '2026-05-11T00:00:00.000Z',
          startedAt: '2026-05-11T00:01:00.000Z',
          finishedAt: '2026-05-11T00:02:00.000Z',
        },
        outputs: {
          schemaVersion: 1,
          summary: 'Summary\n' + 'x'.repeat(80_000),
          deliveries: [],
        },
        artifacts: [],
        approvals: [],
      }),
    })

    assert.ok(delivery)
    assert.ok(Buffer.byteLength(delivery.body, 'utf8') <= 64 * 1024)
    assert.match(delivery.body, /Draft truncated before delivery review/)
  })
})

test('completed channel Crew runs create draft delivery records with artifacts, policy, and approvals', async () => {
  await withChannelDeliveryStore('crew-run-draft', async () => {
    const channel = createChannelDefinition({
      provider: 'email',
      name: 'Research inbox',
      sourceKey: 'research',
      senderAllowlist: ['lead@example.com'],
      route: { activationMode: 'run_crew', targetCrewId: 'crew-research' },
    })
    const item = recordChannelInboundItem({
      channelId: channel.id,
      sender: 'lead@example.com',
      subject: 'Market scan',
      body: 'Run a market scan.',
    })
    markChannelInboundItemDispatched(item.id, {
      runKind: 'crew',
      runId: 'crew-run-1',
      workItemId: 'work-1',
      approvedBy: 'local-user',
    })

    const delivery = createChannelRunDeliveryDraft(item.id, {
      getCrewRunDetail: () => ({
        run: {
          schemaVersion: 1,
          id: 'crew-run-1',
          crewId: 'crew-1',
          crewVersionId: 'crew-version-1',
          workItemId: 'work-1',
          status: 'completed',
          title: 'Market scan',
          summary: 'Market scan is ready.',
          rootSessionId: 'session-1',
          createdAt: '2026-05-11T00:00:00.000Z',
          startedAt: '2026-05-11T00:01:00.000Z',
          finishedAt: '2026-05-11T00:03:00.000Z',
        },
        workItem: {
          schemaVersion: 1,
          id: 'work-1',
          title: 'Market scan',
          description: 'Scan the market.',
          source: 'channel',
          status: 'completed',
          createdAt: '2026-05-11T00:00:00.000Z',
          updatedAt: '2026-05-11T00:03:00.000Z',
        },
        artifacts: [{
          schemaVersion: 1,
          id: 'artifact-1',
          crewRunId: 'crew-run-1',
          nodeId: null,
          title: 'Market report',
          mime: 'text/markdown',
          uri: 'artifact://market-report',
          hash: null,
          createdAt: '2026-05-11T00:02:00.000Z',
        }],
        approvals: [{
          schemaVersion: 1,
          id: 'crew-approval-1',
          crewRunId: 'crew-run-1',
          nodeId: null,
          status: 'approved',
          title: 'Approve delivery',
          body: 'Approved.',
          requestedAt: '2026-05-11T00:02:00.000Z',
          resolvedAt: '2026-05-11T00:02:30.000Z',
          resolvedBy: 'local-user',
        }],
        policyDecisions: [{
          schemaVersion: 1,
          id: 'policy-1',
          runId: 'crew-run-1',
          runKind: 'crew',
          nodeId: null,
          status: 'approval_required',
          reason: 'External delivery needs review.',
          capabilityId: 'delivery:external',
          createdAt: '2026-05-11T00:02:00.000Z',
        }],
        evaluations: [{
          schemaVersion: 1,
          id: 'eval-1',
          crewRunId: 'crew-run-1',
          evaluatorAgentName: 'general',
          rubricId: 'rubric-1',
          status: 'passed',
          score: 0.92,
          evidenceTraceEventIds: [],
          recommendation: 'deliver',
          createdAt: '2026-05-11T00:03:00.000Z',
        }],
      }),
    })

    assert.equal(delivery?.provider, 'email')
    assert.equal(delivery?.target, 'lead@example.com')
    assert.equal(delivery?.workItemId, 'work-1')
    assert.equal(delivery?.runKind, 'crew')
    assert.equal(delivery?.runId, 'crew-run-1')
    assert.deepEqual(delivery?.artifactIds, ['artifact-1'])
    assert.deepEqual(delivery?.policyDecisionIds, ['policy-1'])
    assert.deepEqual(delivery?.approvalIds, ['crew-approval-1'])
    assert.match(delivery?.body || '', /Market scan is ready/)
    assert.match(delivery?.body || '', /score 0.92/)
  })
})
