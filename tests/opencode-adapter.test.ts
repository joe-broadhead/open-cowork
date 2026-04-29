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
import {
  normalizeMcpStatusEntries,
  normalizeRuntimeCommands,
  normalizeRuntimeEventEnvelope,
  normalizeSessionInfo,
  normalizeSessionMessages,
  normalizeSessionStatuses,
  normalizeShareUrl,
} from '../apps/desktop/src/main/opencode-adapter.ts'

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
