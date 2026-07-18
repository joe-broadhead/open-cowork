import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createButtonCapableFakeProvider,
  createButtonlessFakeProvider,
  createConstrainedMessageFakeProvider,
  createFileCapableFakeProvider,
} from '@open-cowork/gateway-testing'
import {
  CLOUD_SESSION_EVENT_TYPES,
  CLOUD_SESSION_EVENT_CONTRACT,
  cloudSessionEventIsChannelRenderable,
  isCloudSessionEventType,
} from '@open-cowork/shared'

import type { CloudGateway } from '../dist/index.js'
import {
  createGatewaySessionRenderState,
  GATEWAY_RENDERED_SESSION_EVENT_TYPES,
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

test('event renderer handles only canonical shared cloud session events', () => {
  const channelRenderableTypes = CLOUD_SESSION_EVENT_CONTRACT
    .filter((entry) => entry.channelRenderable)
    .map((entry) => entry.type)
    .sort()
  assert.deepEqual([...GATEWAY_RENDERED_SESSION_EVENT_TYPES].sort(), [
    'artifact.created',
    'artifact.updated',
    'assistant.message',
    'permission.requested',
    'question.asked',
    'tool.call',
  ])
  assert.deepEqual([...GATEWAY_RENDERED_SESSION_EVENT_TYPES].sort(), channelRenderableTypes)

  for (const type of GATEWAY_RENDERED_SESSION_EVENT_TYPES) {
    assert.equal(CLOUD_SESSION_EVENT_TYPES.includes(type), true)
    assert.equal(isCloudSessionEventType(type), true, `${type} must stay in the shared cloud event contract`)
    assert.equal(cloudSessionEventIsChannelRenderable(type), true, `${type} must stay declared as channel-renderable`)
  }
  assert.equal(cloudSessionEventIsChannelRenderable('permission.resolved'), false)
  assert.equal(isCloudSessionEventType('permission.asked'), false, 'raw SDK events must not become gateway-rendered cloud events')
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

test('event renderer consumes normalized cloud events and ignores raw OpenCode SDK event envelopes', async () => {
  const provider = createButtonlessFakeProvider()
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
  const input = {
    cloud,
    provider,
    binding: bindingRecord(),
    state,
  }

  const rawSdkEvent = await renderGatewaySessionEvent({
    ...input,
    event: {
      eventId: 'sdk-raw-1',
      sequence: 1,
      type: 'permission.asked',
      payload: {
        sessionID: 'session-1',
        permission: {
          id: 'permission-1',
          tool: 'bash',
          input: { command: 'pnpm test' },
        },
      },
    } as never,
  })

  assert.equal(rawSdkEvent.handled, false)
  assert.equal(provider.sent.length, 0)
  assert.equal(interactions.length, 0)

  const normalizedCloudEvent = await renderGatewaySessionEvent({
    ...input,
    event: {
      eventId: 'cloud-1',
      sequence: 2,
      type: 'permission.requested',
      payload: {
        permissionId: 'permission-1',
        title: 'Run command',
        description: 'Allow pnpm test?',
      },
    },
  })

  assert.equal(normalizedCloudEvent.handled, true)
  assert.equal(provider.sent.length, 1)
  assert.match(provider.sent[0]?.text || '', /Run command\nAllow pnpm test\?/)
  assert.match(provider.sent[0]?.text || '', /\/approve approval-token/)
  assert.equal(interactions.length, 1)
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
        error: 'failed in /Users/alice/acme-private with token=super-secret-token',
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
    text: 'Tool failed: bash\nfailed in /Users/[redacted] with token=[redacted]',
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

test('event renderer notifies channels when artifact lifecycle metadata changes', async () => {
  const provider = createButtonlessFakeProvider({ capabilities: { fileDownloads: false } })
  const result = await renderGatewaySessionEvent({
    cloud: cloudStub({
      artifactUrl(sessionId: string, artifactId: string) {
        return `https://cloud.example.test/api/sessions/${sessionId}/artifacts/${artifactId}`
      },
    }),
    provider,
    binding: bindingRecord(),
    state: createGatewaySessionRenderState(),
    event: {
      eventId: 'event-1',
      sequence: 2,
      type: 'artifact.updated',
      payload: {
        artifactId: 'artifact-1',
        filename: 'report.txt',
        status: 'in-review',
        statusUpdatedBy: 'lead',
        size: 13,
      },
    },
  })

  assert.equal(result.handled, true)
  assert.equal(provider.sent[0]?.kind, 'text')
  assert.match(provider.sent[0]?.text || '', /report\.txt/)
  assert.match(provider.sent[0]?.text || '', /https:\/\/cloud\.example\.test\/api\/sessions\/session-1\/artifacts\/artifact-1/)
})

test('event renderer does not resend artifact files for lifecycle metadata updates', async () => {
  const provider = createFileCapableFakeProvider()
  const state = createGatewaySessionRenderState()
  const result = await renderGatewaySessionEvent({
    cloud: cloudStub({
      async readArtifactAttachment() {
        throw new Error('artifact.updated must not fetch artifact bytes')
      },
      artifactUrl(sessionId: string, artifactId: string) {
        return `https://cloud.example.test/api/sessions/${sessionId}/artifacts/${artifactId}`
      },
    }),
    provider,
    binding: bindingRecord(),
    state,
    event: {
      eventId: 'event-1',
      sequence: 2,
      type: 'artifact.updated',
      payload: {
        artifactId: 'artifact-1',
        filename: 'report.txt',
        status: 'final',
        size: 13,
      },
    },
  })
  const duplicate = await renderGatewaySessionEvent({
    cloud: cloudStub({
      artifactUrl(sessionId: string, artifactId: string) {
        return `https://cloud.example.test/api/sessions/${sessionId}/artifacts/${artifactId}`
      },
    }),
    provider,
    binding: bindingRecord(),
    state,
    event: {
      eventId: 'event-1-again',
      sequence: 2,
      type: 'artifact.updated',
      payload: { artifactId: 'artifact-1', filename: 'report.txt', status: 'final', size: 13 },
    },
  })

  assert.equal(result.handled, true)
  assert.equal(duplicate.handled, false)
  assert.equal(provider.sent.length, 1)
  assert.equal(provider.sent[0]?.kind, 'text')
  assert.match(provider.sent[0]?.text || '', /Artifact updated: report\.txt \(final\)/)
  assert.match(provider.sent[0]?.text || '', /https:\/\/cloud\.example\.test\/api\/sessions\/session-1\/artifacts\/artifact-1/)
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
