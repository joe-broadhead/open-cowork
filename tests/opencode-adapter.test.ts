import { connectNativeProviderApiKey, createNativeSession, normalizeMcpStatusEntries, normalizeRuntimeCommands, normalizeRuntimeEventEnvelope, normalizeSessionInfo, normalizeSessionMessages, normalizeSessionStatuses, normalizeShareUrl } from '@open-cowork/runtime-host'
import { RUNTIME_EVENT_MAX_COLLECTION_ENTRIES } from '@open-cowork/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import type {
  Event as SdkEvent,
  McpStatus as SdkMcpStatus,
  Message as SdkMessage,
  Part as SdkPart,
  Session as SdkSession,
  SessionMessagesResponse as SdkSessionMessagesResponse,
  SessionStatus as SdkSessionStatus,
} from '@opencode-ai/sdk/v2'
test('normalizeSessionMessages projects info and parts into typed records', () => {
  const messages = normalizeSessionMessages([
    {
      structured: { kind: 'summary', answer: 42 },
      info: {
        id: 'msg_1',
        role: 'assistant',
        time: { created: 1234 },
        model: {
          providerID: 'openrouter',
          modelID: 'anthropic/claude-sonnet-4',
        },
      },
      parts: [
        { type: 'text', id: 'part_1', text: 'hello' },
        {
          type: 'tool',
          id: 'part_2',
          tool: 'websearch',
          callID: 'call_1',
          state: {
            input: { q: 'opencode' },
            output: { ok: true },
            metadata: { agent: 'research' },
          },
        },
      ],
    },
  ])

  assert.equal(messages.length, 1)
  assert.equal(messages[0].info.model.providerId, 'openrouter')
  assert.equal(messages[0].info.model.modelId, 'anthropic/claude-sonnet-4')
  assert.equal(messages[0].parts[0].text, 'hello')
  assert.equal(messages[0].parts[1].callId, 'call_1')
  assert.deepEqual(messages[0].parts[1].state.input, { q: 'opencode' })
  assert.deepEqual(messages[0].structured, { kind: 'summary', answer: 42 })
})

test('runtime adapter preserves the complete message aggregate while bounding content per message', () => {
  let contentReads = 0
  const content = new Array(RUNTIME_EVENT_MAX_COLLECTION_ENTRIES * 4)
  for (let index = 0; index < content.length; index += 1) {
    Object.defineProperty(content, index, {
      configurable: true,
      enumerable: true,
      get() {
        contentReads += 1
        return { type: 'text', id: `part-${index}`, text: `chunk-${index}` }
      },
    })
  }
  const message = {
    id: 'msg_bounded',
    type: 'assistant',
    time: { created: 1 },
    model: { providerID: 'openrouter', modelID: 'test/model' },
    content,
  }
  const messages = normalizeSessionMessages([
    message,
    ...Array.from({ length: RUNTIME_EVENT_MAX_COLLECTION_ENTRIES * 4 }, (_, index) => ({
      id: `msg-${index}`,
      type: 'assistant',
      time: { created: 1 },
      model: { providerID: 'openrouter', modelID: 'test/model' },
      content: [],
    })),
  ])

  assert.equal(messages.length, (RUNTIME_EVENT_MAX_COLLECTION_ENTRIES * 4) + 1)
  assert.equal(messages[0]?.parts.length, RUNTIME_EVENT_MAX_COLLECTION_ENTRIES)
  assert.equal(messages.at(-1)?.id, `msg-${(RUNTIME_EVENT_MAX_COLLECTION_ENTRIES * 4) - 1}`)
  assert.ok(contentReads <= RUNTIME_EVENT_MAX_COLLECTION_ENTRIES)
})

test('normalizeRuntimeEventEnvelope unwraps payload envelopes', () => {
  const event = normalizeRuntimeEventEnvelope({
    payload: {
      type: 'session.status',
      properties: {
        sessionID: 'sess_1',
        status: { type: 'busy' },
      },
    },
  })

  assert.ok(event)
  assert.equal(event?.type, 'session.status')
  assert.equal(event?.properties.sessionID, 'sess_1')
})

test('normalizeRuntimeEventEnvelope supports sync-style data envelopes and strips version suffixes', () => {
  const event = normalizeRuntimeEventEnvelope({
    payload: {
      type: 'message.part.delta.1',
      data: {
        sessionID: 'sess_1',
        messageID: 'msg_1',
        delta: 'hello',
      },
    },
  })

  assert.ok(event)
  assert.equal(event?.type, 'message.part.delta')
  assert.equal(event?.properties.sessionID, 'sess_1')
  assert.equal(event?.properties.messageID, 'msg_1')
  assert.equal(event?.properties.delta, 'hello')
})

test('normalizeRuntimeEventEnvelope unwraps nested properties inside sync-style data envelopes', () => {
  const event = normalizeRuntimeEventEnvelope({
    payload: {
      type: 'message.part.delta.1',
      data: {
        type: 'message.part.delta',
        properties: {
          sessionID: 'sess_nested',
          messageID: 'msg_nested',
          delta: 'world',
        },
      },
    },
  })

  assert.ok(event)
  assert.equal(event?.type, 'message.part.delta')
  assert.equal(event?.properties.sessionID, 'sess_nested')
  assert.equal(event?.properties.messageID, 'msg_nested')
  assert.equal(event?.properties.delta, 'world')
})

test('normalizeRuntimeEventEnvelope accepts SDK sync events that identify the runtime event in name', () => {
  const event = normalizeRuntimeEventEnvelope({
    payload: {
      type: 'sync',
      name: 'message.part.updated.1',
      data: {
        sessionID: 'sess_sync',
        part: {
          id: 'part_sync',
          sessionID: 'sess_sync',
          messageID: 'msg_sync',
          type: 'text',
          text: 'hello from sync',
        },
        time: 42,
      },
    },
  })

  assert.ok(event)
  assert.equal(event?.type, 'message.part.updated')
  assert.equal(event?.properties.sessionID, 'sess_sync')
  assert.equal((event?.properties.part as { id?: string } | undefined)?.id, 'part_sync')
})

test('native model switch history records do not create empty assistant messages', () => {
  assert.deepEqual(normalizeSessionMessages([{
    id: 'model-switch-1',
    type: 'model-switched',
    time: { created: 1 },
    model: { providerID: 'openai', id: 'gpt-5' },
  }]), [])
})

test('native assistant replay preserves V2 ModelRef provider and model ids', () => {
  const messages = normalizeSessionMessages([{
    id: 'assistant-1',
    type: 'assistant',
    time: { created: 1, completed: 2 },
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-5' },
    content: [{ id: 'text-1', type: 'text', text: 'done' }],
  }])

  assert.equal(messages[0]?.info.model.providerId, 'openai')
  assert.equal(messages[0]?.info.model.modelId, 'gpt-5')
})

test('native assistant replay preserves and bounds the V2 session-level error', () => {
  const messages = normalizeSessionMessages([{
    id: 'assistant-error-1',
    type: 'assistant',
    time: { created: 1, completed: 2 },
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-5' },
    error: {
      type: 'unknown',
      message: `provider failed token=${'x'.repeat(80_000)}`,
    },
    content: [],
  }])

  assert.ok(messages[0]?.error)
  assert.equal(messages[0]?.error?.includes('x'.repeat(1_000)), false)
  assert.match(messages[0]?.error || '', /\[REDACTED_TOKEN\]|\[TRUNCATED_RUNTIME_VALUE\]/)
  assert.equal(messages[0]?.time.updated, 2)
})

test('native assistant replay preserves V2 tool file content, attachments, and output paths', () => {
  const messages = normalizeSessionMessages([{
    id: 'assistant-tool-1',
    type: 'assistant',
    time: { created: 1, completed: 2 },
    agent: 'build',
    model: { providerID: 'openai', id: 'gpt-5' },
    content: [{
      id: 'tool-1',
      type: 'tool',
      name: 'write',
      state: {
        status: 'completed',
        input: { path: '/workspace/report.md' },
        content: [
          { type: 'text', text: 'created' },
          { type: 'file', uri: 'file:///workspace/report.md', mime: 'text/markdown', name: 'report.md' },
        ],
        outputPaths: ['/workspace/report.md'],
      },
    }],
  }])

  const tool = messages[0]?.parts[0]
  assert.deepEqual(tool?.state.output, [
    'created',
    { type: 'file', uri: 'file:///workspace/report.md', mime: 'text/markdown', name: 'report.md' },
  ])
  assert.deepEqual(tool?.state.attachments, [
    { mime: 'text/markdown', url: 'file:///workspace/report.md', filename: 'report.md' },
  ])
  assert.deepEqual(tool?.state.outputPaths, ['/workspace/report.md'])
})

test('normalizeMcpStatusEntries maps named status objects', () => {
  const entries = normalizeMcpStatusEntries({
    charts: { status: 'connected' },
    nova: { status: 'needs_auth' },
  })

  assert.deepEqual(entries, [
    { name: 'charts', connected: true, rawStatus: 'connected' },
    { name: 'nova', connected: false, rawStatus: 'needs_auth' },
  ])
})

test('normalizeMcpStatusEntries maps auth-like HTTP failures to auth_required', () => {
  const entries = normalizeMcpStatusEntries({
    nova: {
      status: 'failed',
      error: 'SSE error: Non-200 status code (403)',
    },
    charts: {
      status: 'failed',
      error: 'Failed to get tools',
    },
  })

  assert.deepEqual(entries, [
    {
      name: 'nova',
      connected: false,
      rawStatus: 'auth_required',
      error: 'SSE error: Non-200 status code (403)',
    },
    {
      name: 'charts',
      connected: false,
      rawStatus: 'failed',
      error: 'Failed to get tools',
    },
  ])
})

test('normalizeRuntimeCommands drops malformed command entries', () => {
  const commands = normalizeRuntimeCommands([
    { name: 'review', description: 'Review changes' },
    { description: 'Missing name' },
  ])

  assert.deepEqual(commands, [
    { name: 'review', description: 'Review changes', source: undefined },
  ])
})

test('normalizeShareUrl supports string and nested share payloads', () => {
  assert.equal(normalizeShareUrl('https://example.com/share'), 'https://example.com/share')
  assert.equal(
    normalizeShareUrl({ share: { url: 'https://example.com/share/2' } }),
    'https://example.com/share/2',
  )
})

test('opencode adapter accepts current SDK session, message, part, status, and event types', () => {
  const session = {
    id: 'ses_sdk',
    slug: 'sdk',
    projectID: 'proj',
    directory: '/tmp/project',
    title: 'SDK session',
    version: '1.14.29',
    time: { created: 1, updated: 2 },
    summary: { additions: 3, deletions: 1, files: 2 },
  } satisfies SdkSession

  const assistantMessage = {
    id: 'msg_sdk',
    sessionID: 'ses_sdk',
    role: 'assistant',
    time: { created: 3, completed: 4 },
    parentID: 'msg_parent',
    modelID: 'gpt-5.5',
    providerID: 'openai',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/tmp/project', root: '/tmp/project' },
    cost: 0.01,
    tokens: {
      input: 10,
      output: 20,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    structured: { ok: true },
  } satisfies Extract<SdkMessage, { role: 'assistant' }>

  const textPart = {
    id: 'part_sdk',
    sessionID: 'ses_sdk',
    messageID: 'msg_sdk',
    type: 'text',
    text: 'hello from sdk',
  } satisfies SdkPart

  const messages = [{
    info: assistantMessage,
    parts: [textPart],
  }] satisfies SdkSessionMessagesResponse

  const event = {
    type: 'message.part.updated',
    properties: {
      sessionID: 'ses_sdk',
      part: textPart,
      time: 5,
    },
  } satisfies SdkEvent

  const mcpStatuses = {
    charts: { status: 'connected' },
    blocked: { status: 'failed', error: 'Non-200 status code (403)' },
  } satisfies Record<string, SdkMcpStatus>

  const sessionStatuses = {
    ses_sdk: { type: 'busy' },
  } satisfies Record<string, SdkSessionStatus>

  assert.equal(normalizeSessionInfo(session)?.id, 'ses_sdk')
  assert.deepEqual(normalizeSessionInfo(assistantMessage)?.model, {
    providerId: 'openai',
    modelId: 'gpt-5.5',
  })
  assert.equal(normalizeSessionMessages(messages)[0]?.parts[0]?.text, 'hello from sdk')
  assert.equal(normalizeRuntimeEventEnvelope(event)?.type, 'message.part.updated')
  assert.deepEqual(normalizeSessionStatuses(sessionStatuses), { ses_sdk: { type: 'busy' } })
  assert.equal(normalizeMcpStatusEntries(mcpStatuses)[1]?.rawStatus, 'auth_required')
})

test('native provider API-key sync resolves the provider integration before connecting', async () => {
  const calls: unknown[] = []
  const client = {
    v2: {
      provider: {
        async get(input: unknown) {
          calls.push(['provider.get', input])
          return { data: { data: { id: 'openrouter', integrationID: 'openrouter' } } }
        },
      },
      integration: {
        async get(input: unknown) {
          calls.push(['integration.get', input])
          return { data: { data: { id: 'openrouter', methods: [{ type: 'key' }] } } }
        },
        connect: {
          async key(input: unknown) {
            calls.push(['integration.connect.key', input])
          },
        },
      },
    },
  }

  await connectNativeProviderApiKey(client as never, 'openrouter', 'secret')

  assert.deepEqual(calls, [
    ['provider.get', { providerID: 'openrouter' }],
    ['integration.get', { integrationID: 'openrouter' }],
    ['integration.connect.key', {
      integrationID: 'openrouter',
      key: 'secret',
      label: 'Open Cowork',
    }],
  ])
})

test('native session creation sends an explicit V2 location body', async () => {
  const calls: unknown[] = []
  const client = {
    v2: {
      session: {
        async create(input: unknown, options: unknown) {
          calls.push([input, options])
          return {
            data: {
              data: {
                id: 'ses_native',
                projectID: 'project-native',
                cost: 0,
                tokens: {
                  input: 0,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 0, write: 0 },
                },
                time: { created: 1, updated: 1 },
                title: 'New session',
                location: { directory: '/workspace' },
              },
            },
          }
        },
      },
    },
  }

  const session = await createNativeSession(client as never, {
    location: { directory: ' /workspace ' },
  })

  assert.equal(session.id, 'ses_native')
  assert.deepEqual(calls, [[
    { location: { directory: '/workspace' } },
    { throwOnError: true },
  ]])
})

test('native session creation rejects an empty V2 location before transport', async () => {
  let called = false
  const client = {
    v2: {
      session: {
        async create() {
          called = true
        },
      },
    },
  }

  await assert.rejects(
    createNativeSession(client as never, { location: { directory: '   ' } }),
    /requires an explicit location directory/,
  )
  assert.equal(called, false)
})

test('native provider API-key sync fails closed when V2 exposes no key integration', async () => {
  const client = {
    v2: {
      provider: {
        async get() {
          return { data: { data: { id: 'local-provider' } } }
        },
      },
    },
  }

  await assert.rejects(
    connectNativeProviderApiKey(client as never, 'local-provider', 'secret'),
    /does not expose a credential integration/,
  )
})
