import test from 'node:test'
import assert from 'node:assert/strict'

import { FakeChannelProvider } from '@open-cowork/gateway-testing'

import type { CloudGateway } from '../dist/index.js'
import { createGatewayMetrics, createGatewaySessionStreamManager } from '../dist/index.js'

test('session stream manager renders session events once and persists cursor after provider send', async () => {
  const provider = new FakeChannelProvider()
  const subscriptions: Array<{
    sessionId: string
    afterSequence: number | undefined
    onEvent: (event: unknown) => void
    onError?: (error: unknown) => void
    closed: boolean
  }> = []
  const cursorUpdates: unknown[] = []
  const cloud = {
    subscribeSessionEvents(input: { sessionId: string, afterSequence?: number, onEvent: (event: unknown) => void, onError?: (error: unknown) => void }) {
      subscriptions.push({ ...input, closed: false })
      return {
        close() {
          subscriptions[subscriptions.length - 1].closed = true
        },
      }
    },
    async updateCursor(input: unknown) {
      cursorUpdates.push(input)
      return {
        bindingId: 'binding-1',
        orgId: 'tenant-1',
        agentId: 'agent-1',
        channelBindingId: 'channel-binding-1',
        provider: 'cli',
        externalWorkspaceId: null,
        externalThreadId: 'thread-1',
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        lastEventSequence: (input as { lastEventSequence: number }).lastEventSequence,
        lastWorkspaceSequence: (input as { lastWorkspaceSequence: number }).lastWorkspaceSequence,
        lastChatMessageId: (input as { lastChatMessageId?: string | null }).lastChatMessageId ?? null,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, createGatewayMetrics())

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 4,
      lastWorkspaceSequence: 8,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })
  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 4,
      lastWorkspaceSequence: 8,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })

  assert.equal(manager.activeCount(), 1)
  assert.equal(subscriptions.length, 1)
  assert.equal(subscriptions[0].afterSequence, 4)

  subscriptions[0].onEvent({
    eventId: 'event-4',
    sequence: 4,
    type: 'assistant.message',
    payload: { content: 'stale response' },
  })
  subscriptions[0].onEvent({
    eventId: 'event-5',
    sequence: 5,
    type: 'assistant.message',
    payload: { content: 'fresh response' },
  })
  await waitFor(() => cursorUpdates.length === 1)

  assert.deepEqual(provider.sent.map((entry) => entry.text), ['fresh response'])
  assert.deepEqual(cursorUpdates, [{
    bindingId: 'binding-1',
    lastEventSequence: 5,
    lastWorkspaceSequence: 8,
    lastChatMessageId: '1',
  }])

  subscriptions[0].onEvent({
    eventId: 'event-5-again',
    sequence: 5,
    type: 'assistant.message',
    payload: { content: 'duplicate response' },
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(provider.sent.map((entry) => entry.text), ['fresh response'])
  manager.closeAll()
})

test('session stream manager renders permission requests as channel buttons', async () => {
  const provider = new FakeChannelProvider()
  const interactions: unknown[] = []
  let onEvent: ((event: unknown) => void) | null = null
  const cloud = {
    subscribeSessionEvents(input: { onEvent: (event: unknown) => void }) {
      onEvent = input.onEvent
      return { close() {} }
    },
    async createChannelInteraction(input: unknown) {
      interactions.push(input)
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'approve-token',
      }
    },
    async updateCursor(input: unknown) {
      return {
        bindingId: 'binding-1',
        orgId: 'tenant-1',
        agentId: 'agent-1',
        channelBindingId: 'channel-binding-1',
        provider: 'cli',
        externalWorkspaceId: null,
        externalThreadId: 'thread-1',
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        lastEventSequence: (input as { lastEventSequence: number }).lastEventSequence,
        lastWorkspaceSequence: 0,
        lastChatMessageId: (input as { lastChatMessageId?: string | null }).lastChatMessageId ?? null,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, createGatewayMetrics())

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 0,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })
  onEvent?.({
    eventId: 'event-1',
    sequence: 1,
    type: 'permission.requested',
    payload: {
      permissionId: 'permission-1',
      title: 'Run command',
      description: 'Allow shell command?',
    },
  })
  await waitFor(() => provider.sent.some((entry) => entry.buttons))

  const created = interactions[0] as { interactionId?: string }
  assert.equal(created.interactionId?.startsWith('gw_'), true)
  assert.deepEqual({ ...created, interactionId: undefined }, {
    interactionId: undefined,
    agentId: 'agent-1',
    sessionId: 'session-1',
    provider: 'cli',
    kind: 'permission',
    targetId: 'permission-1',
  })
  assert.equal(provider.sent[0].text, 'Run command\nAllow shell command?')
  assert.deepEqual(provider.sent[0].buttons, [[{
    label: 'Approve',
    token: 'apv:approve-token',
    style: 'success',
  }, {
    label: 'Deny',
    token: 'den:approve-token',
    style: 'danger',
  }]])
  manager.closeAll()
})

test('session stream manager reconnects from the last persisted cursor', async () => {
  const provider = new FakeChannelProvider()
  const metrics = createGatewayMetrics()
  const subscriptions: Array<{
    afterSequence?: number
    onError?: (error: unknown) => void
  }> = []
  const cloud = {
    subscribeSessionEvents(input: { afterSequence?: number, onError?: (error: unknown) => void }) {
      subscriptions.push(input)
      return { close() {} }
    },
    async updateCursor() { return null },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, metrics, { retryDelayMs: 1 })

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 9,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })
  subscriptions[0].onError?.(new Error('stream broke'))
  await waitFor(() => subscriptions.length === 2)

  assert.equal(metrics.errors, 1)
  assert.equal(metrics.streamReconnects, 1)
  assert.equal(subscriptions[1].afterSequence, 9)
  manager.closeAll()
})

test('session stream manager hydrates snapshot-required retention gaps', async () => {
  const provider = new FakeChannelProvider()
  let onEvent: ((event: unknown) => void) | null = null
  const cursorUpdates: unknown[] = []
  let hydrated = 0
  const cloud = {
    subscribeSessionEvents(input: { onEvent: (event: unknown) => void }) {
      onEvent = input.onEvent
      return { close() {} }
    },
    async getSession(sessionId: string) {
      hydrated += 1
      return {
        session: { sessionId },
        projection: {
          tenantId: 'tenant-1',
          sessionId,
          sequence: 42,
          view: {},
          updatedAt: new Date(0).toISOString(),
        },
      }
    },
    async updateCursor(input: unknown) {
      cursorUpdates.push(input)
      return {
        bindingId: 'binding-1',
        orgId: 'tenant-1',
        agentId: 'agent-1',
        channelBindingId: 'channel-binding-1',
        provider: 'cli',
        externalWorkspaceId: null,
        externalThreadId: 'thread-1',
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        lastEventSequence: (input as { lastEventSequence: number }).lastEventSequence,
        lastWorkspaceSequence: 0,
        lastChatMessageId: null,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, createGatewayMetrics())

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 10,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })
  onEvent?.({
    eventId: 'snapshot-required:10',
    sequence: 10,
    type: 'snapshot.required',
    payload: {
      reason: 'event_retention_gap',
      latestSequence: 42,
    },
  })
  await waitFor(() => cursorUpdates.length === 1)

  assert.equal(hydrated, 1)
  assert.deepEqual(cursorUpdates, [{
    bindingId: 'binding-1',
    lastEventSequence: 42,
    lastWorkspaceSequence: 0,
    lastChatMessageId: null,
  }])
  assert.equal(provider.sent.length, 0)
  manager.closeAll()
})

test('session stream manager leaves failed provider sends retryable', async () => {
  const provider = new FakeChannelProvider()
  const originalSendText = provider.sendText.bind(provider)
  let failNextSend = true
  provider.sendText = async (...args) => {
    if (failNextSend) {
      failNextSend = false
      throw new Error('provider down')
    }
    return originalSendText(...args)
  }
  const metrics = createGatewayMetrics()
  const subscriptions: Array<{ onEvent: (event: unknown) => void }> = []
  const cursorUpdates: unknown[] = []
  const cloud = {
    subscribeSessionEvents(input: { onEvent: (event: unknown) => void }) {
      subscriptions.push(input)
      return { close() {} }
    },
    async updateCursor(input: unknown) {
      cursorUpdates.push(input)
      return {
        bindingId: 'binding-1',
        orgId: 'tenant-1',
        agentId: 'agent-1',
        channelBindingId: 'channel-binding-1',
        provider: 'cli',
        externalWorkspaceId: null,
        externalThreadId: 'thread-1',
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        lastEventSequence: (input as { lastEventSequence: number }).lastEventSequence,
        lastWorkspaceSequence: 0,
        lastChatMessageId: (input as { lastChatMessageId?: string | null }).lastChatMessageId ?? null,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, metrics, { retryDelayMs: 1 })

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 0,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })

  const event = {
    eventId: 'event-1',
    sequence: 1,
    type: 'assistant.message',
    payload: { content: 'retry me' },
  }
  subscriptions[0].onEvent(event)
  await waitFor(() => metrics.errors === 1)
  assert.equal(metrics.streamReconnects, 1)
  assert.equal(cursorUpdates.length, 0)
  await waitFor(() => subscriptions.length === 2)

  subscriptions[1].onEvent(event)
  await waitFor(() => cursorUpdates.length === 1)
  assert.deepEqual(provider.sent.map((entry) => entry.text), ['retry me'])
  manager.closeAll()
})

test('session stream manager retries transient poison events before skipping them', async () => {
  const provider = new FakeChannelProvider()
  provider.sendText = async () => {
    throw new Error('provider down')
  }
  const metrics = createGatewayMetrics()
  const subscriptions: Array<{ onEvent: (event: unknown) => void }> = []
  const cursorUpdates: unknown[] = []
  const cloud = {
    subscribeSessionEvents(input: { onEvent: (event: unknown) => void }) {
      subscriptions.push(input)
      return { close() {} }
    },
    async updateCursor(input: unknown) {
      cursorUpdates.push(input)
      return {
        bindingId: 'binding-1',
        orgId: 'tenant-1',
        agentId: 'agent-1',
        channelBindingId: 'channel-binding-1',
        provider: 'cli',
        externalWorkspaceId: null,
        externalThreadId: 'thread-1',
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        lastEventSequence: (input as { lastEventSequence: number }).lastEventSequence,
        lastWorkspaceSequence: 0,
        lastChatMessageId: null,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, metrics, { retryDelayMs: 1, maxRenderAttempts: 2 })

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 0,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })

  subscriptions[0].onEvent({
    eventId: 'event-1',
    sequence: 1,
    type: 'assistant.message',
    payload: { content: 'drop me' },
  })
  await waitFor(() => subscriptions.length === 2)
  assert.equal(cursorUpdates.length, 0)

  subscriptions[1].onEvent({
    eventId: 'event-1',
    sequence: 1,
    type: 'assistant.message',
    payload: { content: 'drop me' },
  })
  await waitFor(() => cursorUpdates.length === 1)

  assert.equal(metrics.errors, 2)
  assert.equal(metrics.streamReconnects, 1)
  assert.equal(metrics.sessionRenderRetries, 1)
  assert.equal(metrics.sessionRenderDeadLetters, 1)
  assert.equal(metrics.droppedSessionEvents, 1)
  assert.deepEqual(cursorUpdates, [{
    bindingId: 'binding-1',
    lastEventSequence: 1,
    lastWorkspaceSequence: 0,
    lastChatMessageId: null,
  }])
  manager.closeAll()
})

test('session stream manager does not let queued later events jump a failed transient event', async () => {
  const provider = new FakeChannelProvider()
  const originalSendText = provider.sendText.bind(provider)
  let failNextSend = true
  provider.sendText = async (...args) => {
    if (failNextSend) {
      failNextSend = false
      throw new Error('provider temporarily down')
    }
    return originalSendText(...args)
  }
  const metrics = createGatewayMetrics()
  const subscriptions: Array<{ afterSequence?: number, onEvent: (event: unknown) => void }> = []
  const cursorUpdates: unknown[] = []
  const cloud = {
    subscribeSessionEvents(input: { afterSequence?: number, onEvent: (event: unknown) => void }) {
      subscriptions.push(input)
      return { close() {} }
    },
    async updateCursor(input: unknown) {
      cursorUpdates.push(input)
      return {
        bindingId: 'binding-1',
        orgId: 'tenant-1',
        agentId: 'agent-1',
        channelBindingId: 'channel-binding-1',
        provider: 'cli',
        externalWorkspaceId: null,
        externalThreadId: 'thread-1',
        externalChatId: 'chat-1',
        sessionId: 'session-1',
        lastEventSequence: (input as { lastEventSequence: number }).lastEventSequence,
        lastWorkspaceSequence: 0,
        lastChatMessageId: (input as { lastChatMessageId?: string | null }).lastChatMessageId ?? null,
        status: 'active',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      }
    },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, metrics, { retryDelayMs: 1, maxRenderAttempts: 3 })

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 0,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })

  subscriptions[0].onEvent({
    eventId: 'event-1',
    sequence: 1,
    type: 'assistant.message',
    payload: { content: 'first' },
  })
  subscriptions[0].onEvent({
    eventId: 'event-2',
    sequence: 2,
    type: 'assistant.message',
    payload: { content: 'second' },
  })
  await waitFor(() => subscriptions.length === 2)

  assert.equal(metrics.sessionRenderRetries, 1)
  assert.deepEqual(provider.sent.map((entry) => entry.text), [])
  assert.deepEqual(cursorUpdates, [])
  assert.equal(subscriptions[1].afterSequence, 0)

  subscriptions[1].onEvent({
    eventId: 'event-1',
    sequence: 1,
    type: 'assistant.message',
    payload: { content: 'first' },
  })
  await waitFor(() => cursorUpdates.length === 1)
  subscriptions[1].onEvent({
    eventId: 'event-2',
    sequence: 2,
    type: 'assistant.message',
    payload: { content: 'second' },
  })
  await waitFor(() => cursorUpdates.length === 2)

  assert.deepEqual(provider.sent.map((entry) => entry.text), ['first', 'second'])
  assert.deepEqual(cursorUpdates.map((entry) => (entry as { lastEventSequence: number }).lastEventSequence), [1, 2])
  manager.closeAll()
})

test('session stream manager reconnects without advancing when cursor persistence fails', async () => {
  const provider = new FakeChannelProvider()
  const metrics = createGatewayMetrics()
  const subscriptions: Array<{ afterSequence?: number, onEvent: (event: unknown) => void }> = []
  const cloud = {
    subscribeSessionEvents(input: { afterSequence?: number, onEvent: (event: unknown) => void }) {
      subscriptions.push(input)
      return { close() {} }
    },
    async updateCursor() {
      return null
    },
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'token-1',
      }
    },
  } as CloudGateway
  const manager = createGatewaySessionStreamManager(cloud, metrics, { retryDelayMs: 1, maxRenderAttempts: 3 })

  manager.ensure({
    provider,
    binding: {
      bindingId: 'binding-1',
      orgId: 'tenant-1',
      agentId: 'agent-1',
      channelBindingId: 'channel-binding-1',
      provider: 'cli',
      externalWorkspaceId: null,
      externalThreadId: 'thread-1',
      externalChatId: 'chat-1',
      sessionId: 'session-1',
      lastEventSequence: 0,
      lastWorkspaceSequence: 0,
      lastChatMessageId: null,
      status: 'active',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    },
  })

  subscriptions[0].onEvent({
    eventId: 'event-1',
    sequence: 1,
    type: 'assistant.message',
    payload: { content: 'sent but not persisted' },
  })
  await waitFor(() => subscriptions.length === 2)

  assert.equal(metrics.cursorPersistenceFailures, 1)
  assert.equal(metrics.sessionRenderRetries, 1)
  assert.equal(subscriptions[1].afterSequence, 0)
  assert.deepEqual(provider.sent.map((entry) => entry.text), ['sent but not persisted'])
  manager.closeAll()
})

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate.')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
