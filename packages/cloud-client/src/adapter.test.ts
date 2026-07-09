import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import {
  createHttpSseCloudTransportAdapter,
  isCloudTransportError,
  type CloudTransportError,
  type CloudTransportEventSource,
  type CloudTransportFetch,
} from './adapter.ts'

type FetchCall = {
  url: string
  init: NonNullable<Parameters<CloudTransportFetch>[1]>
}

function responseHeaders(values: Record<string, string> = {}) {
  const lower = new Map(Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    get(name: string) {
      return lower.get(name.toLowerCase()) ?? null
    },
  }
}

function textResponse(input: {
  status?: number
  text?: string
  headers?: Record<string, string>
  body?: ReadableStream<Uint8Array> | null
} = {}) {
  const status = input.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => input.text ?? '',
    headers: responseHeaders(input.headers),
    body: input.body ?? null,
  }
}

function jsonResponse(body: unknown, input: {
  status?: number
  headers?: Record<string, string>
} = {}) {
  return textResponse({
    status: input.status,
    headers: input.headers,
    text: JSON.stringify(body),
  })
}

function streamFromText(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

async function expectCloudTransportError(promise: Promise<unknown>, kind: CloudTransportError['kind']) {
  try {
    await promise
  } catch (error) {
    assert.equal(isCloudTransportError(error), true)
    const cloudError = error as CloudTransportError
    assert.equal(cloudError.kind, kind)
    return cloudError
  }
  assert.fail(`Expected CloudTransportError kind ${kind}`)
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await delay(5)
  }
  assert.equal(predicate(), true)
}

test('HTTP requests attach auth, CSRF, credentials, JSON body, and normalized URL', async () => {
  const calls: FetchCall[] = []
  const fetcher: CloudTransportFetch = async (url, init = {}) => {
    calls.push({ url, init })
    return jsonResponse({ session: { sessionId: 's1' }, messages: [] })
  }
  const client = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com/',
    credentials: 'include',
    csrfToken: 'csrf-token',
    headers: { authorization: 'Bearer desktop-token' },
    fetch: fetcher,
  })

  await client.createSession({ profileName: 'default' })

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://cowork.example.com/api/sessions')
  assert.equal(calls[0]?.init.method, 'POST')
  assert.equal(calls[0]?.init.credentials, 'include')
  assert.equal(calls[0]?.init.headers?.authorization, 'Bearer desktop-token')
  assert.equal(calls[0]?.init.headers?.['x-csrf-token'], 'csrf-token')
  assert.equal(calls[0]?.init.headers?.['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0]?.init.body || '{}'), { profileName: 'default' })
})

test('HTTP errors preserve status taxonomy, retry-after, code, and response body', async () => {
  const fetcher: CloudTransportFetch = async () => jsonResponse(
    { error: 'Too many requests', code: 'RATE_LIMITED' },
    { status: 429, headers: { 'retry-after': '10' } },
  )
  const client = createHttpSseCloudTransportAdapter({ baseUrl: 'https://cowork.example.com', fetch: fetcher })

  const error = await expectCloudTransportError(client.listSessions(), 'rate_limited')

  assert.equal(error.status, 429)
  assert.equal(error.retryAfter, '10')
  assert.equal(error.code, 'RATE_LIMITED')
  assert.deepEqual(error.body, { error: 'Too many requests', code: 'RATE_LIMITED' })
  assert.equal(error.message, 'Too many requests')
})

test('HTTP JSON parse failures and network failures are classified', async () => {
  const parseClient = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    fetch: async () => textResponse({ text: 'not json' }),
  })
  const parseError = await expectCloudTransportError(parseClient.listSessions(), 'parse')
  assert.equal(parseError.status, 200)
  assert.equal(parseError.body, 'not json')

  const networkClient = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    fetch: async () => {
      throw new Error('offline')
    },
  })
  const networkError = await expectCloudTransportError(networkClient.listSessions(), 'network')
  assert.match(networkError.message, /network request failed/)
})

test('request timeouts are clamped and abort the underlying fetch signal', async () => {
  let observedSignal: AbortSignal | undefined
  const fetcher: CloudTransportFetch = async (_url, init = {}) => {
    observedSignal = init.signal
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('fetch aborted')), { once: true })
    })
  }
  const client = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    fetch: fetcher,
    requestTimeoutMs: 1,
  })

  const keepAlive = setTimeout(() => undefined, 250)
  try {
    const error = await expectCloudTransportError(client.listSessions(), 'timeout')

    assert.match(error.message, /100ms/)
    assert.equal(observedSignal?.aborted, true)
  } finally {
    clearTimeout(keepAlive)
  }
})

test('caller aborts propagate to fetch and classify as abort', async () => {
  const controller = new AbortController()
  let observedSignal: AbortSignal | undefined
  const fetcher: CloudTransportFetch = async (_url, init = {}) => {
    observedSignal = init.signal
    return new Promise((resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('caller aborted')), { once: true })
    })
  }
  const client = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    fetch: fetcher,
    signal: controller.signal,
  })

  const request = client.listSessions()
  controller.abort(new Error('workspace closed'))
  const error = await expectCloudTransportError(request, 'abort')

  assert.match(error.message, /was aborted/)
  assert.equal(observedSignal?.aborted, true)
})

test('fetch-based SSE sends auth headers and parses events', async () => {
  const calls: FetchCall[] = []
  const events: unknown[] = []
  const fetcher: CloudTransportFetch = async (url, init = {}) => {
    calls.push({ url, init })
    return textResponse({
      body: streamFromText('data: {"eventId":"e1","sequence":1,"type":"session.updated"}\n\n'),
    })
  }
  const client = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    headers: { authorization: 'Bearer stream-token' },
    credentials: 'include',
    fetch: fetcher,
  })

  const subscription = client.subscribeWorkspaceEvents({
    onEvent: (event) => events.push(event),
  })

  await waitFor(() => events.length === 1)
  assert.equal(calls[0]?.url, 'https://cowork.example.com/api/events')
  assert.equal(calls[0]?.init.credentials, 'include')
  assert.equal(calls[0]?.init.headers?.authorization, 'Bearer stream-token')
  assert.equal(calls[0]?.init.headers?.accept, 'text/event-stream')
  assert.deepEqual(events[0], { eventId: 'e1', sequence: 1, type: 'session.updated' })
  subscription.close()
})

test('fetch-based SSE classifies HTTP and parse failures', async () => {
  const httpErrors: unknown[] = []
  const httpClient = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    headers: { authorization: 'Bearer stream-token' },
    fetch: async () => jsonResponse({ error: 'Missing auth', code: 'NO_AUTH' }, { status: 401 }),
  })
  httpClient.subscribeWorkspaceEvents({
    onEvent: () => undefined,
    onError: (error) => httpErrors.push(error),
  })

  await waitFor(() => httpErrors.length === 1)
  assert.equal(isCloudTransportError(httpErrors[0]), true)
  assert.equal((httpErrors[0] as CloudTransportError).kind, 'unauthorized')
  assert.equal((httpErrors[0] as CloudTransportError).code, 'NO_AUTH')

  const parseErrors: unknown[] = []
  const parseClient = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    headers: { authorization: 'Bearer stream-token' },
    fetch: async () => textResponse({ body: streamFromText('data: not-json\n\n') }),
  })
  parseClient.subscribeWorkspaceEvents({
    onEvent: () => undefined,
    onError: (error) => parseErrors.push(error),
  })

  await waitFor(() => parseErrors.length === 1)
  assert.equal(isCloudTransportError(parseErrors[0]), true)
  assert.equal((parseErrors[0] as CloudTransportError).kind, 'parse')
})

test('EventSource SSE uses cookie credentials and reports stream errors', async () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = []

    readonly url: string
    readonly init: { withCredentials?: boolean } | undefined
    readonly listeners = new Map<string, Array<(event: { data: string }) => void>>()
    closed = false
    onmessage: ((event: { data: string }) => void) | null = null
    onerror: ((event: unknown) => void) | null = null

    constructor(url: string, init?: { withCredentials?: boolean }) {
      this.url = url
      this.init = init
      FakeEventSource.instances.push(this)
    }

    addEventListener(type: string, listener: (event: { data: string }) => void) {
      const listeners = this.listeners.get(type) || []
      listeners.push(listener)
      this.listeners.set(type, listeners)
    }

    close() {
      this.closed = true
    }
  }

  const events: unknown[] = []
  const errors: unknown[] = []
  const client = createHttpSseCloudTransportAdapter({
    baseUrl: 'https://cowork.example.com',
    credentials: 'include',
    eventSource: FakeEventSource as CloudTransportEventSource,
    fetch: async () => jsonResponse({}),
  })

  const subscription = client.subscribeSessionEvents('session/one', {
    afterSequence: 42,
    onEvent: (event) => events.push(event),
    onError: (error) => errors.push(error),
  })
  const source = FakeEventSource.instances[0]
  assert.ok(source)
  assert.equal(source.url, 'https://cowork.example.com/api/sessions/session%2Fone/events?after=42')
  assert.equal(source.init?.withCredentials, true)

  source.onmessage?.({ data: '{"eventId":"e2","sequence":43,"type":"session.updated"}' })
  source.onerror?.(new Error('stream dropped'))

  assert.deepEqual(events, [{ eventId: 'e2', sequence: 43, type: 'session.updated' }])
  assert.equal(errors.length, 1)
  assert.equal(isCloudTransportError(errors[0]), true)
  assert.equal((errors[0] as CloudTransportError).kind, 'sse')

  subscription.close()
  assert.equal(source.closed, true)
})
