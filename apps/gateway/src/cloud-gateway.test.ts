import test from 'node:test'
import assert from 'node:assert/strict'

import type { CloudTransportAdapter } from '@open-cowork/cloud-client'

import { createCloudGateway, resolveGatewayConfig } from '../dist/index.js'

test('cloud gateway wraps all required channel and session operations', async () => {
  const calls: string[] = []
  let sessionClosed = false
  let deliveriesClosed = false
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
    async promptChannelSession(input: unknown) {
      calls.push(`prompt:${JSON.stringify(input)}`)
      return { binding: { bindingId: 'binding-1' }, command: { commandId: 'cmd-1' }, processed: 1 }
    },
    async abortSession(sessionId: string) {
      calls.push(`abort:${sessionId}`)
      return { command: { commandId: 'cmd-abort' }, processed: 1, view: { session: { sessionId }, projection: null } }
    },
    async respondToPermission(sessionId: string, input: unknown) {
      calls.push(`permission:${sessionId}:${JSON.stringify(input)}`)
      return { command: { commandId: 'cmd-permission' }, processed: 1 }
    },
    async replyToQuestion(sessionId: string, input: unknown) {
      calls.push(`question-reply:${sessionId}:${JSON.stringify(input)}`)
      return { command: { commandId: 'cmd-reply' }, processed: 1 }
    },
    async rejectQuestion(sessionId: string, input: unknown) {
      calls.push(`question-reject:${sessionId}:${JSON.stringify(input)}`)
      return { command: { commandId: 'cmd-reject' }, processed: 1 }
    },
    async resolveChannelInteraction(input: unknown) {
      calls.push(`interaction:${JSON.stringify(input)}`)
      return { interaction: { interactionId: 'interaction-1' }, command: { commandId: 'cmd-interaction' }, processed: 1 }
    },
    subscribeSessionEvents(sessionId: string, input: { onEvent: (event: unknown) => void }) {
      calls.push(`session-events:${sessionId}`)
      input.onEvent({ eventId: 'event-1', sequence: 1, type: 'assistant.message', payload: {} })
      return { close() { sessionClosed = true } }
    },
    subscribeChannelDeliveries(input: { onDelivery: (delivery: unknown) => void }) {
      calls.push('deliveries')
      input.onDelivery({ deliveryId: 'delivery-1' })
      return { close() { deliveriesClosed = true } }
    },
    async updateChannelCursor(input: unknown) {
      calls.push(`cursor:${JSON.stringify(input)}`)
      return { bindingId: 'binding-1' }
    },
    async ackChannelDelivery(deliveryId: string, input: unknown) {
      calls.push(`ack:${deliveryId}:${JSON.stringify(input)}`)
      return { deliveryId }
    },
  } as Partial<CloudTransportAdapter> as CloudTransportAdapter
  const gateway = createCloudGateway(resolveGatewayConfig({}, {
    OPEN_COWORK_CLOUD_BASE_URL: 'https://cloud.example.test',
    OPEN_COWORK_GATEWAY_SERVICE_TOKEN: 'service-token',
  }), adapter)

  await gateway.resolveIdentity({ provider: 'telegram', externalUserId: 'user-1' })
  await gateway.bindSession({ channelBindingId: 'channel-1', provider: 'telegram', externalChatId: 'chat-1', externalThreadId: 'thread-1' })
  await gateway.findSessionByThread({ provider: 'telegram', externalChatId: 'chat-1', externalThreadId: 'thread-1' })
  await gateway.prompt({ bindingId: 'binding-1', text: 'hello' })
  await gateway.abortSession('session-1')
  await gateway.respondToPermission('session-1', { permissionId: 'permission-1', response: { allowed: true } })
  await gateway.replyToQuestion('session-1', { requestId: 'question-1', answers: ['yes'] })
  await gateway.rejectQuestion('session-1', { requestId: 'question-2' })
  await gateway.resolveChannelInteraction({ token: 'token-1', response: { allowed: true } })
  const sessionEvents = gateway.subscribeSessionEvents({ sessionId: 'session-1', onEvent() {} })
  const deliveries = gateway.subscribeDeliveries({ onDelivery() {} })
  await gateway.updateCursor({ bindingId: 'binding-1', lastEventSequence: 5, lastWorkspaceSequence: 7 })
  await gateway.ackDelivery('delivery-1', { status: 'sent' })
  sessionEvents.close()
  deliveries.close()

  assert.equal(sessionClosed, true)
  assert.equal(deliveriesClosed, true)
  assert.deepEqual(calls.map((call) => call.split(':')[0]), [
    'identity',
    'bind',
    'by-thread',
    'prompt',
    'abort',
    'permission',
    'question-reply',
    'question-reject',
    'interaction',
    'session-events',
    'deliveries',
    'cursor',
    'ack',
  ])
})
