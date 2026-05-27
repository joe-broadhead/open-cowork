import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createHttpSseCloudTransportAdapter,
  type CloudTransportEventSource,
  type CloudTransportFetch,
} from '../apps/desktop/src/main/cloud/transport-adapter.ts'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body)
    },
  }
}

test('cloud transport adapter maps session commands to HTTP routes with CSRF', async () => {
  const requests: Array<{ url: string, init?: Parameters<CloudTransportFetch>[1] }> = []
  const fetcher: CloudTransportFetch = async (url, init) => {
    requests.push({ url, init })
    if (url.endsWith('/api/config')) {
      return jsonResponse({
        role: 'web',
        profileName: 'full',
        features: { chat: true },
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
      })
    }
    if (url.endsWith('/api/sessions')) {
      if (init?.method === 'POST') {
        return jsonResponse({ session: { sessionId: 'session-1' }, projection: null }, 201)
      }
      return jsonResponse({ sessions: [{ sessionId: 'session-1' }] })
    }
    if (url.endsWith('/api/sessions/session-1/prompt')) {
      return jsonResponse({ command: { commandId: 'cmd-1' }, processed: 0, view: { session: {}, projection: null } }, 202)
    }
    if (url.endsWith('/api/sessions/session-1/question-reply')) {
      return jsonResponse({ command: { commandId: 'cmd-2' }, processed: 0 }, 202)
    }
    if (url.endsWith('/api/sessions/session-1/permission-respond')) {
      return jsonResponse({ command: { commandId: 'cmd-3' }, processed: 0 }, 202)
    }
    if (url.endsWith('/api/runtime/status')) {
      return jsonResponse({
        role: 'web',
        profileName: 'full',
        canExecute: false,
        commandProcessing: 'delegated',
        checkpoints: false,
        heartbeats: [],
      })
    }
    return jsonResponse({ error: 'not found' }, 404)
  }
  const transport = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cloud.example.test/',
    fetch: fetcher,
    csrfToken: 'csrf-token',
    credentials: 'include',
  })

  assert.equal((await transport.getConfig()).profileName, 'full')
  assert.equal((await transport.getRuntimeStatus()).commandProcessing, 'delegated')
  assert.deepEqual((await transport.listSessions()).map((session) => session.sessionId), ['session-1'])
  assert.equal((await transport.createSession()).session.sessionId, 'session-1')
  assert.equal((await transport.promptSession('session-1', { text: 'hello' })).processed, 0)
  assert.equal((await transport.replyToQuestion('session-1', { requestId: 'q1', answers: ['A'] })).processed, 0)
  assert.equal((await transport.respondToPermission('session-1', { permissionId: 'p1', response: { allowed: true } })).processed, 0)

  const mutating = requests.filter((request) => request.init?.method === 'POST')
  assert.equal(mutating.every((request) => request.init?.headers?.['x-csrf-token'] === 'csrf-token'), true)
  assert.equal(mutating.every((request) => request.init?.credentials === 'include'), true)
  assert.deepEqual(
    mutating.map((request) => new URL(request.url).pathname),
    [
      '/api/sessions',
      '/api/sessions/session-1/prompt',
      '/api/sessions/session-1/question-reply',
      '/api/sessions/session-1/permission-respond',
    ],
  )
})

test('cloud transport adapter builds Last-Event-ID compatible SSE URLs and subscriptions', () => {
  const instances: Array<{
    url: string
    init?: { withCredentials?: boolean }
    listeners: Map<string, (event: { data: string }) => void>
    onmessage: ((event: { data: string }) => void) | null
    onerror: ((event: unknown) => void) | null
    closed: boolean
  }> = []
  const EventSourceImpl: CloudTransportEventSource = class {
    readonly url: string
    readonly init?: { withCredentials?: boolean }
    readonly listeners = new Map<string, (event: { data: string }) => void>()
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null
    closed = false

    constructor(
      url: string,
      init?: { withCredentials?: boolean },
    ) {
      this.url = url
      this.init = init
      instances.push(this)
    }

    addEventListener(type: string, listener: (event: { data: string }) => void) {
      this.listeners.set(type, listener)
    }

    close() {
      this.closed = true
    }
  }
  const transport = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cloud.example.test',
    eventSource: EventSourceImpl,
    credentials: 'include',
  })
  const events: unknown[] = []
  const subscription = transport.subscribeSessionEvents('session 1', {
    afterSequence: 42,
    onEvent: (event) => events.push(event),
  })

  assert.equal(
    transport.sessionEventsUrl('session 1', 42),
    'https://cloud.example.test/api/sessions/session%201/events?after=42',
  )
  assert.equal(instances[0]?.url, 'https://cloud.example.test/api/sessions/session%201/events?after=42')
  assert.equal(instances[0]?.init?.withCredentials, true)
  instances[0]?.listeners.get('assistant.message')?.({
    data: JSON.stringify({
      sequence: 43,
      eventId: 'event-43',
      type: 'assistant.message',
      payload: { content: 'hello' },
    }),
  })
  assert.deepEqual(events, [{
    sequence: 43,
    eventId: 'event-43',
    type: 'assistant.message',
    payload: { content: 'hello' },
  }])
  subscription.close()
  assert.equal(instances[0]?.closed, true)
})
