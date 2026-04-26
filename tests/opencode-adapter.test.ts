import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeMcpStatusEntries,
  normalizeRuntimeCommands,
  normalizeRuntimeEventEnvelope,
  normalizeSessionMessages,
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
