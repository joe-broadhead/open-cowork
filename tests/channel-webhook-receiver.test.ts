import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  clearChannelStoreCache,
  createLocalWebhookChannelPairing,
  listChannelInboundItems,
} from '../apps/desktop/src/main/channel-store.ts'
import {
  clearOperationalQueueStoreCache,
  listOperationalQueueItems,
} from '../apps/desktop/src/main/operational-queue-store.ts'
import {
  getLocalWebhookReceiverStatus,
  startLocalWebhookReceiver,
  stopLocalWebhookReceiver,
} from '../apps/desktop/src/main/channel-webhook-receiver.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-webhook-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

async function withWebhookStore(name: string, fn: () => Promise<void>) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearChannelStoreCache()
    clearOperationalQueueStoreCache()
    await stopLocalWebhookReceiver()
    await fn()
  } finally {
    await stopLocalWebhookReceiver()
    clearChannelStoreCache()
    clearOperationalQueueStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

function webhookUrl(sourceKey: string) {
  const status = getLocalWebhookReceiverStatus()
  assert.equal(status.listening, true)
  assert.ok(status.port)
  return `http://127.0.0.1:${status.port}/channels/local-webhook/${encodeURIComponent(sourceKey)}`
}

async function postWebhook(sourceKey: string, token: string | null, payload: Record<string, unknown>) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (token) headers.authorization = `Bearer ${token}`
  return fetch(webhookUrl(sourceKey), {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
}

test('local webhook receiver stays disabled unless explicitly configured', async () => withWebhookStore('disabled', async () => {
  const status = await startLocalWebhookReceiver({ enabled: false })
  assert.equal(status.enabled, false)
  assert.equal(status.listening, false)
  assert.equal(status.port, null)
  assert.equal(status.pairedChannels, 0)
}))

test('local webhook receiver rejects missing tokens without recording inbound items', async () => withWebhookStore('missing-token', async () => {
  createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })

  const response = await postWebhook('ops', null, {
    sender: 'ops@example.com',
    body: 'Please review this.',
  })

  assert.equal(response.status, 401)
  assert.equal(listChannelInboundItems().length, 0)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver handles malformed routes without recording inbound items', async () => withWebhookStore('malformed-route', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })
  const status = getLocalWebhookReceiverStatus()
  assert.ok(status.port)

  const response = await fetch(`http://127.0.0.1:${status.port}/channels/local-webhook/%E0%A4%A`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sender: 'ops@example.com', body: 'Please review this.' }),
  })

  assert.equal(response.status, 404)
  assert.equal(listChannelInboundItems().length, 0)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver rejects decoded path separators and blank source keys as routes', async () => withWebhookStore('invalid-source-key', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })
  const status = getLocalWebhookReceiverStatus()
  assert.ok(status.port)

  for (const sourceKey of ['bad%2Fkey', '%20']) {
    const response = await fetch(`http://127.0.0.1:${status.port}/channels/local-webhook/${sourceKey}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${paired.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sender: 'ops@example.com', body: 'Please review this.' }),
    })

    assert.equal(response.status, 404)
  }
  assert.equal(listChannelInboundItems().length, 0)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver rejects oversized bodies without recording inbound items', async () => withWebhookStore('oversized-body', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })

  const response = await postWebhook('ops', paired.token, {
    sender: 'ops@example.com',
    body: 'x'.repeat(260 * 1024),
  })

  assert.equal(response.status, 413)
  assert.deepEqual(await response.json(), { ok: false, error: 'payload_too_large' })
  assert.equal(listChannelInboundItems().length, 0)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver rejects malformed payload fields before recording inbound items', async () => withWebhookStore('malformed-payload', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })

  const response = await postWebhook('ops', paired.token, {
    sender: 'ops@example.com',
    body: { text: 'not a string' },
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'invalid_payload' })
  assert.equal(listChannelInboundItems().length, 0)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver returns stable client errors for invalid JSON', async () => withWebhookStore('invalid-json', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })
  const status = getLocalWebhookReceiverStatus()
  assert.ok(status.port)

  const response = await fetch(`http://127.0.0.1:${status.port}/channels/local-webhook/ops`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${paired.token}`,
      'content-type': 'application/json',
    },
    body: '{not-json',
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { ok: false, error: 'invalid_json' })
  assert.equal(listChannelInboundItems().length, 0)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver audits unknown senders without queueing execution', async () => withWebhookStore('unknown-sender', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Support webhook',
    sourceKey: 'support',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-triage' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })

  const response = await postWebhook('support', paired.token, {
    sender: 'attacker@example.net',
    subject: 'Run this',
    body: 'Run this SOP.',
    externalMessageId: 'msg-1',
  })
  const body = await response.json() as { status?: string; auditState?: string }

  assert.equal(response.status, 202)
  assert.equal(body.status, 'denied')
  assert.equal(body.auditState, 'denied_unknown_sender')
  assert.equal(listChannelInboundItems().length, 1)
  assert.equal(listOperationalQueueItems().length, 0)
}))

test('local webhook receiver routes accepted SOP items through the channel sandbox queue', async () => withWebhookStore('accepted-sop', async () => {
  const paired = createLocalWebhookChannelPairing({
    name: 'Ops webhook',
    sourceKey: 'ops',
    senderAllowlist: ['*@example.com'],
    allowedCapabilityIds: ['tool:read_crm'],
    route: { activationMode: 'run_sop', targetSopId: 'sop-weekly' },
  })
  await startLocalWebhookReceiver({ enabled: true, host: '127.0.0.1', port: 0 })

  const response = await postWebhook('ops', paired.token, {
    sender: 'lead@example.com',
    subject: 'Weekly report',
    body: 'Prepare the weekly report.',
  })
  const body = await response.json() as { status?: string; auditState?: string; queueItemId?: string }
  const queue = listOperationalQueueItems()

  assert.equal(response.status, 202)
  assert.equal(body.status, 'queued')
  assert.equal(body.auditState, 'queued_for_review')
  assert.ok(body.queueItemId)
  assert.equal(queue.length, 1)
  assert.equal(queue[0]?.runKind, 'channel')
  assert.equal(queue[0]?.authority.isolation.channelBound, true)
}))
