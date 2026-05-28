import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createButtonCapableFakeProvider,
  createButtonlessFakeProvider,
  createConstrainedMessageFakeProvider,
  createFileCapableFakeProvider,
} from '@open-cowork/gateway-testing'

import type { CloudGateway } from '../dist/index.js'
import {
  createGatewaySessionRenderState,
  renderGatewaySessionEvent,
} from '../dist/index.js'

test('event renderer edits streaming assistant output for button-capable providers', async () => {
  const provider = createButtonCapableFakeProvider()
  const state = createGatewaySessionRenderState()
  const binding = bindingRecord()
  const cloud = cloudStub()

  const first = await renderGatewaySessionEvent({
    cloud,
    provider,
    binding,
    state,
    event: {
      eventId: 'event-1',
      sequence: 1,
      type: 'assistant.message',
      payload: { messageId: 'assistant-1', content: 'Hel' },
    },
  })
  const second = await renderGatewaySessionEvent({
    cloud,
    provider,
    binding,
    state,
    event: {
      eventId: 'event-2',
      sequence: 2,
      type: 'assistant.message',
      payload: { messageId: 'assistant-1', content: 'Hello' },
    },
  })
  const duplicate = await renderGatewaySessionEvent({
    cloud,
    provider,
    binding,
    state,
    event: {
      eventId: 'event-3',
      sequence: 3,
      type: 'assistant.message',
      payload: { messageId: 'assistant-1', content: 'Hello' },
    },
  })

  assert.equal(first.lastChatMessageId, '1')
  assert.equal(second.lastChatMessageId, '1')
  assert.equal(duplicate.handled, false)
  assert.deepEqual(provider.sent.map((entry) => ({
    kind: entry.kind,
    text: entry.text,
    messageId: entry.messageId,
  })), [{
    kind: 'text',
    text: 'Hel',
    messageId: undefined,
  }, {
    kind: 'edit',
    text: 'Hello',
    messageId: '1',
  }])
})

test('event renderer chunks buttonless assistant output and renders approval command fallback', async () => {
  const provider = createButtonlessFakeProvider({
    capabilities: { maxTextLength: 128 },
  })
  const state = createGatewaySessionRenderState()
  const interactions: unknown[] = []
  const cloud = cloudStub({
    async createChannelInteraction(input: unknown) {
      interactions.push(input)
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'approval-token',
      }
    },
  })

  await renderGatewaySessionEvent({
    cloud,
    provider,
    binding: bindingRecord(),
    state,
    event: {
      eventId: 'event-1',
      sequence: 1,
      type: 'assistant.message',
      payload: { messageId: 'assistant-1', content: 'hello '.repeat(40) },
    },
  })
  await renderGatewaySessionEvent({
    cloud,
    provider,
    binding: bindingRecord(),
    state,
    event: {
      eventId: 'event-2',
      sequence: 2,
      type: 'permission.requested',
      payload: {
        permissionId: 'permission-1',
        title: 'Run command',
        description: 'Allow shell command?',
      },
    },
  })

  assert.equal(provider.sent.filter((entry) => entry.kind === 'text').length > 1, true)
  const fallback = provider.sent.at(-1)?.text || ''
  assert.match(fallback, /Run command\nAllow shell command\?/)
  assert.match(fallback, /\/approve approval-token/)
  assert.match(fallback, /\/deny approval-token/)
  assert.equal(provider.sent.some((entry) => entry.buttons), false)
  const created = interactions[0] as { interactionId?: string }
  assert.match(created.interactionId || '', /^gw_permission_/)
  assert.deepEqual({ ...created, interactionId: undefined }, {
    interactionId: undefined,
    agentId: 'agent-1',
    sessionId: 'session-1',
    provider: 'cli',
    kind: 'permission',
    targetId: 'permission-1',
  })
})

test('event renderer keeps tool progress compact and redacts failure details', async () => {
  const provider = createButtonCapableFakeProvider()
  const state = createGatewaySessionRenderState()
  const input = {
    cloud: cloudStub(),
    provider,
    binding: bindingRecord(),
    state,
  }

  await renderGatewaySessionEvent({
    ...input,
    event: {
      eventId: 'event-1',
      sequence: 1,
      type: 'tool.call',
      payload: { id: 'tool-1', name: 'bash', status: 'running' },
    },
  })
  await renderGatewaySessionEvent({
    ...input,
    event: {
      eventId: 'event-2',
      sequence: 2,
      type: 'tool.call',
      payload: {
        id: 'tool-1',
        name: 'bash',
        status: 'error',
        error: 'failed with token=super-secret-token',
      },
    },
  })

  assert.deepEqual(provider.sent.map((entry) => ({
    kind: entry.kind,
    text: entry.text,
    messageId: entry.messageId,
  })), [{
    kind: 'text',
    text: 'Tool running: bash',
    messageId: undefined,
  }, {
    kind: 'edit',
    text: 'Tool failed: bash\nfailed with token=[redacted]',
    messageId: '1',
  }])
})

test('event renderer renders question option buttons and buttonless text fallback', async () => {
  const buttonProvider = createButtonCapableFakeProvider()
  const buttonlessProvider = createButtonlessFakeProvider()
  const buttonState = createGatewaySessionRenderState()
  const fallbackState = createGatewaySessionRenderState()
  const cloud = cloudStub({
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'question-token',
      }
    },
  })
  const event = {
    eventId: 'event-1',
    sequence: 1,
    type: 'question.asked',
    payload: {
      requestId: 'question-1',
      questions: [{
        header: 'Choose mode',
        question: 'Deploy now?',
        options: [
          { label: 'Yes', description: 'Ship it' },
          { label: 'No', description: 'Hold back' },
        ],
      }],
    },
  }

  await renderGatewaySessionEvent({
    cloud,
    provider: buttonProvider,
    binding: bindingRecord(),
    state: buttonState,
    event,
  })
  await renderGatewaySessionEvent({
    cloud,
    provider: buttonlessProvider,
    binding: bindingRecord(),
    state: fallbackState,
    event,
  })

  const buttons = buttonProvider.sent[0]?.buttons
  assert.equal(buttonProvider.sent[0]?.text, 'Choose mode\nDeploy now?\n- Yes: Ship it\n- No: Hold back')
  assert.equal(buttons?.[0]?.[0]?.label, 'Yes')
  assert.equal(buttons?.[0]?.[0]?.token.startsWith('ans:'), true)
  assert.equal(buttons?.[1]?.[0]?.label, 'Reject')
  assert.equal(buttons?.[1]?.[0]?.token, 'rej:question-token')

  const fallback = buttonlessProvider.sent[0]?.text || ''
  assert.match(fallback, /Choose mode\nDeploy now\?/)
  assert.match(fallback, /\/answer question-token <response>/)
  assert.match(fallback, /\/reject question-token/)
})

test('event renderer falls back to question text when option tokens exceed provider limits', async () => {
  const provider = createConstrainedMessageFakeProvider({
    capabilities: { maxTextLength: 200 },
  })
  await renderGatewaySessionEvent({
    cloud: cloudStub({
      async createChannelInteraction() {
        return {
          interaction: { interactionId: 'interaction-1' },
          plaintextToken: 'question-token-that-is-too-long-for-buttons',
        }
      },
    }),
    provider,
    binding: bindingRecord(),
    state: createGatewaySessionRenderState(),
    event: {
      eventId: 'event-1',
      sequence: 1,
      type: 'question.asked',
      payload: {
        requestId: 'question-1',
        questions: [{
          question: 'Choose?',
          options: [{ label: 'A very long option label', description: '' }],
        }],
      },
    },
  })

  assert.equal(provider.sent[0]?.kind, 'text')
  assert.equal(provider.sent[0]?.buttons, undefined)
  assert.match(provider.sent[0]?.text || '', /\/answer question-token-that-is-too-long-for-buttons <response>/)
})

test('event renderer sends cloud artifacts as files when provider limits allow it', async () => {
  const provider = createFileCapableFakeProvider()
  const state = createGatewaySessionRenderState()
  const cloud = cloudStub({
    async readArtifactAttachment(sessionId: string, artifactId: string) {
      assert.equal(sessionId, 'session-1')
      assert.equal(artifactId, 'artifact-1')
      return {
        filename: 'report.txt',
        mime: 'text/plain',
        url: `data:text/plain;base64,${Buffer.from('artifact body').toString('base64')}`,
      }
    },
    artifactUrl() {
      throw new Error('artifact link fallback should not be used')
    },
  })

  await renderGatewaySessionEvent({
    cloud,
    provider,
    binding: bindingRecord(),
    state,
    event: {
      eventId: 'event-1',
      sequence: 1,
      type: 'artifact.created',
      payload: {
        artifactId: 'artifact-1',
        filename: 'report.txt',
        contentType: 'text/plain',
        size: 13,
        key: 'tenants/tenant-1/private-object-key',
      },
    },
  })
  const duplicate = await renderGatewaySessionEvent({
    cloud,
    provider,
    binding: bindingRecord(),
    state,
    event: {
      eventId: 'event-1-again',
      sequence: 1,
      type: 'artifact.created',
      payload: { artifactId: 'artifact-1', filename: 'report.txt', size: 13 },
    },
  })

  assert.equal(duplicate.handled, false)
  assert.equal(provider.sent.length, 1)
  assert.equal(provider.sent[0]?.kind, 'file')
  assert.equal(provider.sent[0]?.file?.filename, 'report.txt')
  assert.equal(Buffer.from(provider.sent[0]?.file?.data || []).toString('utf8'), 'artifact body')
})

test('event renderer sends authenticated artifact links for link-only or oversized channels', async () => {
  const provider = createButtonlessFakeProvider({ capabilities: { fileDownloads: false } })
  await renderGatewaySessionEvent({
    cloud: cloudStub({
      async readArtifactAttachment() {
        throw new Error('link-only provider should not fetch artifact bytes')
      },
      artifactUrl(sessionId: string, artifactId: string) {
        return `https://cloud.example.test/api/sessions/${sessionId}/artifacts/${artifactId}`
      },
    }),
    provider,
    binding: bindingRecord(),
    state: createGatewaySessionRenderState(),
    event: {
      eventId: 'event-1',
      sequence: 1,
      type: 'artifact.created',
      payload: {
        artifactId: 'artifact-1',
        filename: 'report-token=secret.txt',
        contentType: 'text/plain',
        size: 13,
        key: 'tenants/tenant-1/private-object-key',
      },
    },
  })

  assert.equal(provider.sent[0]?.kind, 'text')
  assert.match(provider.sent[0]?.text || '', /https:\/\/cloud\.example\.test\/api\/sessions\/session-1\/artifacts\/artifact-1/)
  assert.doesNotMatch(provider.sent[0]?.text || '', /private-object-key/)
  assert.doesNotMatch(provider.sent[0]?.text || '', /secret/)
})

function bindingRecord() {
  return {
    bindingId: 'binding-1',
    orgId: 'tenant-1',
    agentId: 'agent-1',
    channelBindingId: 'channel-binding-1',
    provider: 'cli' as const,
    externalWorkspaceId: null,
    externalThreadId: 'thread-1',
    externalChatId: 'chat-1',
    sessionId: 'session-1',
    lastEventSequence: 0,
    lastWorkspaceSequence: 0,
    lastChatMessageId: null,
    status: 'active' as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function cloudStub(overrides: Partial<CloudGateway> = {}): CloudGateway {
  return {
    async createChannelInteraction() {
      return {
        interaction: { interactionId: 'interaction-1' },
        plaintextToken: 'interaction-token',
      }
    },
    ...overrides,
  } as CloudGateway
}
