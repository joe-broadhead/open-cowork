import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudWebAppApi } from './app-api.ts'
import { CLOUD_WEB_CLIENT_ENDPOINTS, type CloudWebClientBootstrap } from './client-contract.ts'
import { CLOUD_WEB_ROUTES, DEFAULT_CLOUD_WEB_ROUTE } from './app-shell.ts'
import { CLOUD_WEB_ROUTE_API_MATRIX } from './route-api-matrix.ts'
import { CLOUD_WEB_ADMIN_SURFACE_MATRIX } from './admin-surface-matrix.ts'
import { CLOUD_WEB_WORKBENCH_PARITY_MATRIX } from './workbench-parity.ts'

function bootstrap(): CloudWebClientBootstrap {
  return {
    role: 'admin',
    profileName: 'default',
    features: { chat: true, workflows: true },
    publicBranding: { productName: 'Open Cowork Cloud' },
    routes: CLOUD_WEB_ROUTES,
    defaultRoute: DEFAULT_CLOUD_WEB_ROUTE,
    api: CLOUD_WEB_CLIENT_ENDPOINTS,
    routeMatrix: CLOUD_WEB_ROUTE_API_MATRIX,
    adminSurfaces: CLOUD_WEB_ADMIN_SURFACE_MATRIX,
    workbenchParity: CLOUD_WEB_WORKBENCH_PARITY_MATRIX,
    sessionEventTypes: ['assistant.message', 'session.updated'],
  }
}

test('cloud AppAPI maps endpoint metadata, CSRF headers, and API-only requests', async () => {
  const calls: Array<{ path: string; method: string; headers: Record<string, string>; body: unknown }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    calls.push({
      path: new URL(String(input), 'https://cloud.example.test').pathname + new URL(String(input), 'https://cloud.example.test').search,
      method: String(init.method || 'GET'),
      headers: Object.fromEntries(headers.entries()),
      body: init.body ? JSON.parse(String(init.body)) : null,
    })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const api = createCloudWebAppApi(bootstrap(), { csrfToken: 'csrf-1' })
    assert.equal(api.endpointPath('sessionPrompt', '/fallback/:sessionId', { sessionId: 's/1' }), '/api/sessions/s%2F1/prompt')
    await api.sessions.list({ limit: 200, cursor: 'offset:200', empty: '' })
    await api.sessions.prompt('s/1', { text: 'Hello', agent: 'build' })
    api.setCsrfToken?.('csrf-2')
    await api.workflows.run('workflow-1')

    assert.deepEqual(calls.map((call) => call.path), [
      '/api/sessions?limit=200&cursor=offset%3A200',
      '/api/sessions/s%2F1/prompt',
      '/api/workflows/workflow-1/run',
    ])
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[1].method, 'POST')
    assert.equal(calls[1].headers['x-csrf-token'], 'csrf-1')
    assert.deepEqual(calls[1].body, { text: 'Hello', agent: 'build' })
    assert.equal(calls[2].headers['x-csrf-token'], 'csrf-2')
    await assert.rejects(() => api.request('https://example.test/leak'), /blocked non-API request/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cloud AppAPI reports 401 responses through the unauthorized callback', async () => {
  const originalFetch = globalThis.fetch
  let unauthorizedCount = 0
  const calls: Array<{ headers: Record<string, string> }> = []
  globalThis.fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ headers: Object.fromEntries(new Headers(init.headers).entries()) })
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  try {
    const api = createCloudWebAppApi(bootstrap(), {
      csrfToken: 'csrf-1',
      onUnauthorized: () => {
        unauthorizedCount += 1
      },
    })
    await assert.rejects(() => api.sessions.prompt('session-1', { text: 'hello' }), /Authentication required/)
    await assert.rejects(() => api.sessions.prompt('session-1', { text: 'again' }), /Authentication required/)
    assert.equal(unauthorizedCount, 2)
    assert.equal(calls[0].headers['x-csrf-token'], 'csrf-1')
    assert.equal(calls[1].headers['x-csrf-token'], undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cloud AppAPI streams only API EventSource URLs and parses typed events', () => {
  const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource
  const created: Array<{ url: string; init: EventSourceInit | undefined; listeners: Map<string, (event: MessageEvent) => void> }> = []
  class FakeEventSource {
    url: string
    init?: EventSourceInit
    onopen: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    listeners = new Map<string, (event: MessageEvent) => void>()

    constructor(url: string, init?: EventSourceInit) {
      this.url = url
      this.init = init
      created.push({ url, init, listeners: this.listeners })
    }

    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      this.listeners.set(type, listener)
    }

    close() {}
  }
  ;(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource
  try {
    const events: unknown[] = []
    const api = createCloudWebAppApi(bootstrap())
    const stream = api.sessions.events('session-1', { message: (event) => events.push(event) }, { afterSequence: 2 })
    assert.equal(created[0].url, '/api/sessions/session-1/events?after=2')
    assert.equal(created[0].init?.withCredentials, true)
    created[0].listeners.get('assistant.message')?.(new MessageEvent('assistant.message', { data: '{"sequence":2}' }))
    created[0].listeners.get('session.updated')?.(new MessageEvent('session.updated', { data: 'plain text' }))
    assert.equal((events[0] as { type: string }).type, 'assistant.message')
    assert.deepEqual((events[0] as { data: unknown }).data, { sequence: 2 })
    assert.equal((events[1] as { type: string }).type, 'session.updated')
    assert.equal((events[1] as { data: unknown }).data, 'plain text')
    stream.close()
    assert.throws(() => api.stream('/not-api/events'), /blocked non-API event stream/)
  } finally {
    ;(globalThis as { EventSource?: unknown }).EventSource = originalEventSource
  }
})
