import test from 'node:test'
import assert from 'node:assert/strict'

import type { CloudGateway } from '../dist/index.js'
import { createGatewayRuntime, resolveGatewayConfig as resolveGatewayConfigBase } from '../dist/index.js'

// Runtime-level idempotency on cloud delivery ids (audit #857): the cloud-side claim TTL is not
// renewed in-flight, so a delivery can be re-served after the gateway already sent it (slow lane,
// or the 'sent' ack itself failed). The runtime must re-ack instead of re-sending — while a
// re-serve of a genuinely FAILED attempt must still be sent (at-least-once).

const cloudEnv = {
  OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
  OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
}

function resolveGatewayConfig(
  raw: Parameters<typeof resolveGatewayConfigBase>[0] = {},
  env: Parameters<typeof resolveGatewayConfigBase>[1] = {},
) {
  return resolveGatewayConfigBase(raw, {
    ...cloudEnv,
    ...env,
  })
}

function deliveryRecord(overrides: Partial<{
  deliveryId: string
  attemptCount: number
  channelBindingId: string
  payload: Record<string, unknown>
}> = {}) {
  return {
    deliveryId: overrides.deliveryId || 'delivery-1',
    orgId: 'tenant-1',
    agentId: 'agent-1',
    channelBindingId: overrides.channelBindingId || 'fake-binding',
    sessionBindingId: null,
    provider: 'cli',
    target: {
      externalChatId: 'chat-1',
      externalThreadId: 'thread-1',
    },
    eventType: 'workflow.completed',
    payload: overrides.payload ?? { text: 'delivery text' },
    status: 'claimed',
    attemptCount: overrides.attemptCount ?? 1,
    claimedBy: 'gateway:test',
    lastClaimedBy: 'gateway:test',
    claimExpiresAt: new Date(Date.now() + 30_000).toISOString(),
    nextAttemptAt: new Date(0).toISOString(),
    lastError: null,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function fakeCloud() {
  const acks: Array<{ deliveryId: string, input: Record<string, unknown> }> = []
  const handlers: { onDelivery: ((delivery: unknown) => void) | null } = { onDelivery: null }
  const cloud = {
    subscribeDeliveries(input: { onDelivery: (delivery: unknown) => void }) {
      handlers.onDelivery = input.onDelivery
      return { close() {} }
    },
    async ackDelivery(deliveryId: string, input: Record<string, unknown>) {
      acks.push({ deliveryId, input })
      return { deliveryId, ...input } as never
    },
  } as CloudGateway
  return { cloud, acks, handlers }
}

const fakeConfig = () => resolveGatewayConfig({
  server: { adminToken: 'admin-token' },
  providers: [{
    id: 'fake',
    kind: 'fake',
    channelBindingId: 'fake-binding',
  }],
})

test('gateway runtime re-acks instead of re-sending a re-served delivery that was already sent (#857)', async () => {
  const { cloud, acks, handlers } = fakeCloud()
  const runtime = createGatewayRuntime(fakeConfig(), cloud)
  const provider = runtime.providers.get('fake')?.provider as unknown as {
    sent: Array<{ options?: { deliveryId?: string } }>
  } | undefined
  assert.ok(provider)

  await runtime.start()
  try {
    handlers.onDelivery?.(deliveryRecord({ deliveryId: 'delivery-1' }))
    await waitFor(() => acks.length === 1)
    assert.equal(acks[0]?.input.status, 'sent')
    assert.equal(acks[0]?.input.channelBindingId, 'fake-binding')
    assert.equal(provider.sent.length, 1)
    assert.equal(runtime.metrics.deliveryDuplicatesSuppressed, 0)

    // The claim lapsed before the cloud recorded the 'sent' ack, so it re-serves the same id.
    // The user must not see the message twice: no new provider send, just a fresh 'sent' ack.
    handlers.onDelivery?.(deliveryRecord({ deliveryId: 'delivery-1', attemptCount: 2 }))
    await waitFor(() => acks.length === 2)
    assert.equal(acks[1]?.deliveryId, 'delivery-1')
    assert.equal(acks[1]?.input.status, 'sent')
    assert.equal(acks[1]?.input.channelBindingId, 'fake-binding')
    assert.equal(provider.sent.length, 1)
    // The suppressed re-serve must be visible to operators as a counter increment.
    assert.equal(runtime.metrics.deliveryDuplicatesSuppressed, 1)
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime isolates identical public delivery ids across channel bindings', async () => {
  const { cloud, acks, handlers } = fakeCloud()
  const runtime = createGatewayRuntime(resolveGatewayConfig({
    server: { adminToken: 'admin-token' },
    providers: [{
      id: 'fake-primary',
      kind: 'fake',
      channelBindingId: 'binding-primary',
    }, {
      id: 'fake-secondary',
      kind: 'fake',
      channelBindingId: 'binding-secondary',
    }],
  }), cloud)
  const primary = runtime.providers.get('fake-primary')?.provider as unknown as {
    sent: Array<{ options?: { deliveryId?: string } }>
  } | undefined
  const secondary = runtime.providers.get('fake-secondary')?.provider as unknown as {
    sent: Array<{ options?: { deliveryId?: string } }>
  } | undefined
  assert.ok(primary)
  assert.ok(secondary)

  await runtime.start()
  try {
    // Both copies enter the dispatcher before either settles. Pending-work
    // dedupe must use binding + public id, so neither binding suppresses the
    // other while it is queued or in flight.
    handlers.onDelivery?.(deliveryRecord({
      deliveryId: 'delivery-shared-pending',
      channelBindingId: 'binding-primary',
    }))
    handlers.onDelivery?.(deliveryRecord({
      deliveryId: 'delivery-shared-pending',
      channelBindingId: 'binding-secondary',
    }))
    await waitFor(() => acks.filter((ack) => ack.deliveryId === 'delivery-shared-pending').length === 2)
    assert.equal(primary.sent.length, 1)
    assert.equal(secondary.sent.length, 1)

    // Deliver the next shared id sequentially. The first successful send is
    // already in the sent cache before the second arrives, so this also proves
    // the re-serve cache cannot make one binding impersonate another.
    handlers.onDelivery?.(deliveryRecord({
      deliveryId: 'delivery-shared-sent',
      channelBindingId: 'binding-primary',
    }))
    await waitFor(() => acks.filter((ack) => ack.deliveryId === 'delivery-shared-sent').length === 1)
    handlers.onDelivery?.(deliveryRecord({
      deliveryId: 'delivery-shared-sent',
      channelBindingId: 'binding-secondary',
    }))
    await waitFor(() => acks.filter((ack) => ack.deliveryId === 'delivery-shared-sent').length === 2)

    assert.equal(primary.sent.length, 2)
    assert.equal(secondary.sent.length, 2)
    assert.deepEqual(
      acks.map((ack) => `${String(ack.input.channelBindingId)}:${ack.deliveryId}`).sort(),
      [
        'binding-primary:delivery-shared-pending',
        'binding-primary:delivery-shared-sent',
        'binding-secondary:delivery-shared-pending',
        'binding-secondary:delivery-shared-sent',
      ],
    )
  } finally {
    await runtime.stop()
  }
})

test('gateway runtime still re-sends a re-served delivery whose earlier attempt failed (#857 at-least-once)', async () => {
  const { cloud, acks, handlers } = fakeCloud()
  const runtime = createGatewayRuntime(fakeConfig(), cloud)
  const provider = runtime.providers.get('fake')?.provider
  assert.ok(provider)
  const originalSendText = provider.sendText.bind(provider)
  let failNext = true
  provider.sendText = async (...args) => {
    if (failNext) {
      failNext = false
      throw new Error('provider temporarily down')
    }
    return originalSendText(...args)
  }

  await runtime.start()
  try {
    handlers.onDelivery?.(deliveryRecord({ deliveryId: 'delivery-1' }))
    await waitFor(() => acks.length === 1)
    assert.equal(acks[0]?.input.status, 'failed')
    assert.equal(acks[0]?.input.channelBindingId, 'fake-binding')

    // A failed attempt never reached the channel, so the cloud's retry of the SAME id must be
    // sent for real — the dedupe cache only ever suppresses ids that actually went out.
    handlers.onDelivery?.(deliveryRecord({ deliveryId: 'delivery-1', attemptCount: 2 }))
    await waitFor(() => acks.length === 2)
    assert.equal(acks[1]?.input.status, 'sent')
    assert.equal(acks[1]?.input.channelBindingId, 'fake-binding')
  } finally {
    await runtime.stop()
  }
})
