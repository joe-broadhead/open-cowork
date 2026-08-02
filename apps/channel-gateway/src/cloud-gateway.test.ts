import test from 'node:test'
import assert from 'node:assert/strict'

import type { CloudTransportAdapter } from '@open-cowork/cloud-client/domains/transport'

import { createCloudGateway, resolveGatewayCloudConnection, resolveGatewayConfig } from '../dist/index.js'

test('cloud gateway wraps all required channel and session operations', async () => {
  const calls: string[] = []
  let sessionClosed = false
  let deliveriesClosed = false
  const fence = (commandId: string, sessionId = 'session-1') => ({
    version: 1,
    scope: 'session',
    tenantId: 'tenant-1',
    sessionId,
    commandId,
    issuedAt: '2026-05-27T10:00:00.000Z',
  })
  const adapter = {
    async resolveChannelIdentity(input: unknown) {
      calls.push(`identity:${JSON.stringify(input)}`)
      return { identityId: 'identity-1', role: 'member', status: 'active' }
    },
    async bindChannelSession(input: unknown) {
      calls.push(`bind:${JSON.stringify(input)}`)
      return { binding: { bindingId: 'binding-1' }, session: { session: { sessionId: 'session-1' }, projection: null } }
    },
    async getChannelSessionByThread(input: unknown) {
      calls.push(`by-thread:${JSON.stringify(input)}`)
      return null
    },
    async getChannelSessionSnapshot(sessionBindingId: string) {
      calls.push(`session:${sessionBindingId}`)
      return { session: { sessionId: 'session-1' }, projection: null }
    },
    async promptChannelSession(input: unknown) {
      calls.push(`prompt:${JSON.stringify(input)}`)
      return {
        binding: { bindingId: 'binding-1' },
        command: { commandId: 'cmd-1' },
        processed: 1,
        projectionFence: fence('cmd-1'),
      }
    },
    async resolveChannelInteraction(input: unknown) {
      calls.push(`interaction:${JSON.stringify(input)}`)
      return {
        interaction: { interactionId: 'interaction-1' },
        command: { commandId: 'cmd-interaction' },
        processed: 1,
        projectionFence: fence('cmd-interaction'),
      }
    },
    async createChannelInteraction(input: unknown) {
      calls.push(`interaction-create:${JSON.stringify(input)}`)
      return { interaction: { interactionId: 'interaction-created' }, plaintextToken: 'token-created' }
    },
    async readChannelArtifactAttachment(sessionBindingId: string, artifactId: string) {
      calls.push(`artifact:${sessionBindingId}:${artifactId}`)
      return { filename: 'artifact.txt', mime: 'text/plain', url: 'data:text/plain;base64,b2s=' }
    },
    subscribeChannelSessionEvents(sessionBindingId: string, input: { onEvent: (event: unknown) => void }) {
      calls.push(`session-events:${sessionBindingId}`)
      input.onEvent({ eventId: 'event-1', sequence: 1, type: 'assistant.message', payload: {} })
      return { close() { sessionClosed = true } }
    },
    subscribeChannelDeliveries(input: {
      claimedBy?: string
      channelBindingIds?: readonly string[]
      onDelivery: (delivery: unknown) => void
    }) {
      calls.push(`deliveries:${JSON.stringify({
        claimedBy: input.claimedBy,
        channelBindingIds: input.channelBindingIds,
      })}`)
      input.onDelivery({ deliveryId: 'delivery-1' })
      return { close() { deliveriesClosed = true } }
    },
    async updateChannelCursor(input: unknown) {
      calls.push(`cursor:${JSON.stringify(input)}`)
      return { ok: true, binding: { bindingId: 'binding-1' } }
    },
    async ackChannelDelivery(deliveryId: string, input: unknown) {
      calls.push(`ack:${deliveryId}:${JSON.stringify(input)}`)
      return { deliveryId }
    },
  } as Partial<CloudTransportAdapter> as CloudTransportAdapter
  const gatewayEnv = {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
    OPEN_COWORK_GATEWAY_ADMIN_TOKEN: 'admin-token',
    OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER: 'true',
  }
  resolveGatewayConfig({}, gatewayEnv)
  const gateway = createCloudGateway(resolveGatewayCloudConnection(gatewayEnv), adapter)

  await gateway.resolveIdentity({ provider: 'telegram', externalUserId: 'user-1' })
  await gateway.bindSession({ channelBindingId: 'channel-1', provider: 'telegram', externalChatId: 'chat-1', externalThreadId: 'thread-1' })
  await gateway.findSessionByThread({ provider: 'telegram', externalChatId: 'chat-1', externalThreadId: 'thread-1' })
  await gateway.getSession('binding-1')
  const prompt = await gateway.prompt({ bindingId: 'binding-1', text: 'hello' })
  const interaction = await gateway.resolveChannelInteraction({ token: 'token-1', response: { allowed: true } })
  await gateway.createChannelInteraction({
    agentId: 'agent-1',
    sessionBindingId: 'binding-1',
    sessionId: 'session-1',
    provider: 'telegram',
    kind: 'permission',
    targetId: 'permission-1',
  })
  await gateway.readArtifactAttachment?.('binding-1', 'artifact-1')
  assert.equal(gateway.artifactUrl('binding-1', 'artifact-1'), 'https://cloud.example.test/api/channels/sessions/binding-1/artifacts/artifact-1')
  const sessionEvents = gateway.subscribeSessionEvents({ sessionBindingId: 'binding-1', onEvent() {} })
  const deliveries = gateway.subscribeDeliveries({
    claimedBy: 'gateway:test',
    channelBindingIds: ['channel-binding-1'],
    onDelivery() {},
  })
  await gateway.updateCursor({ bindingId: 'binding-1', lastEventSequence: 5, lastWorkspaceSequence: 7 })
  await gateway.ackDelivery('delivery-1', { channelBindingId: 'channel-binding-1', status: 'sent' })
  sessionEvents.close()
  deliveries.close()

  assert.equal(sessionClosed, true)
  assert.equal(deliveriesClosed, true)
  assert.equal(prompt.projectionFence?.commandId, 'cmd-1')
  assert.equal(interaction.projectionFence?.commandId, 'cmd-interaction')
  assert.deepEqual(calls.map((call) => call.split(':')[0]), [
    'identity',
    'bind',
    'by-thread',
    'session',
    'prompt',
    'interaction',
    'interaction-create',
    'artifact',
    'session-events',
    'deliveries',
    'cursor',
    'ack',
  ])
  assert.equal(calls.some((call) => call === 'deliveries:{"claimedBy":"gateway:test","channelBindingIds":["channel-binding-1"]}'), true)
  assert.equal(calls.some((call) => call === 'ack:delivery-1:{"channelBindingId":"channel-binding-1","status":"sent"}'), true)
})
