import test from 'node:test'
import assert from 'node:assert/strict'

import { CloudSseReplayHub } from '@open-cowork/cloud-server/sse-replay'
import { resolveCloudBootstrapOptionsFromEnv } from '@open-cowork/cloud-server/app'
import {
  CLOUD_SSE_NOTIFY_CHANNEL,
  CloudSsePgNotifyListener,
  encodeSsePgNotifyPayload,
  sessionSseWakeKey,
  ssePgNotifyWakeKeys,
  workspaceSseWakeKey,
  type CloudSsePgNotifyClient,
} from '@open-cowork/cloud-server/sse-pg-notify'

// This suite covers EVERYTHING that is locally validatable for the Postgres
// LISTEN/NOTIFY SSE accelerator (audit F1b): the flag default, the pure
// payload-encode/decode + wake-key matching, the hub's wake() -> *ForStream read path,
// and the listener lifecycle (decode -> wake, malformed payloads, reconnect, close)
// driven with an injected fake client. The ONE thing it cannot cover is real
// cross-connection NOTIFY delivery (in-memory/PGlite do not model it); that is exercised
// only by the real-Postgres CI path (OPEN_COWORK_TEST_POSTGRES_URL).

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function waitFor(predicate: () => boolean, label: string) {
  const started = Date.now()
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer)
        resolve()
        return
      }
      if (Date.now() - started > 1000) {
        clearInterval(timer)
        reject(new Error(`Timed out waiting for ${label}.`))
      }
    }, 5)
  })
}

test('SSE pg-notify accelerator flag defaults OFF and parses booleans', () => {
  assert.equal(resolveCloudBootstrapOptionsFromEnv({}).ssePgNotifyEnabled, false)
  assert.equal(
    resolveCloudBootstrapOptionsFromEnv({ OPEN_COWORK_CLOUD_SSE_PG_NOTIFY: '1' }).ssePgNotifyEnabled,
    true,
  )
  assert.equal(
    resolveCloudBootstrapOptionsFromEnv({ OPEN_COWORK_CLOUD_SSE_PG_NOTIFY: 'false' }).ssePgNotifyEnabled,
    false,
  )
})

test('payload encode/decode round-trips to the hub wake keys', () => {
  const session = encodeSsePgNotifyPayload({ kind: 'session', tenantId: 'tenant-a', sessionId: 'sess-1' })
  assert.deepEqual(ssePgNotifyWakeKeys(session), [sessionSseWakeKey('tenant-a', 'sess-1')])

  const workspace = encodeSsePgNotifyPayload({ kind: 'workspace', tenantId: 'tenant-a', userId: 'user-9' })
  assert.deepEqual(ssePgNotifyWakeKeys(workspace), [workspaceSseWakeKey('tenant-a', 'user-9')])

  // Identifiers only — never the event body. Encoded payload stays tiny.
  assert.ok(session.length < 200)
  assert.doesNotMatch(session, /payload|body/i)
})

test('session wake key drops the subscriber userId so one NOTIFY wakes all watchers', () => {
  // The HTTP topic key is `session:tenant:userId:sessionId`, but the NOTIFY only carries
  // tenant + session — so the wake key must be userId-independent.
  assert.equal(sessionSseWakeKey('t', 's'), 'session:t:s')
  const decoded = ssePgNotifyWakeKeys(encodeSsePgNotifyPayload({ kind: 'session', tenantId: 't', sessionId: 's' }))
  assert.deepEqual(decoded, ['session:t:s'])
})

test('malformed / partial / unknown NOTIFY payloads decode to no wake keys', () => {
  assert.deepEqual(ssePgNotifyWakeKeys('not-json'), [])
  assert.deepEqual(ssePgNotifyWakeKeys('null'), [])
  assert.deepEqual(ssePgNotifyWakeKeys('[]'), [])
  assert.deepEqual(ssePgNotifyWakeKeys('"string"'), [])
  assert.deepEqual(ssePgNotifyWakeKeys(JSON.stringify({ k: 's', t: 't' })), []) // missing sessionId
  assert.deepEqual(ssePgNotifyWakeKeys(JSON.stringify({ k: 'w', u: 'u' })), []) // missing tenantId
  assert.deepEqual(ssePgNotifyWakeKeys(JSON.stringify({ k: 'x', t: 't', s: 's' })), []) // unknown kind
})

test('hub wake() triggers an immediate *ForStream read for the matching topic', async () => {
  const hub = new CloudSseReplayHub()
  const received: number[] = []
  const loadCalls: number[] = []
  let available: { sequence: number }[] = []
  const unsubscribe = hub.subscribe({
    key: 'session:tenant:user:sess',
    wakeKey: sessionSseWakeKey('tenant', 'sess'),
    afterSequence: 0,
    // Long poll interval: the timer must not fire during the test, so delivery here is
    // driven solely by wake() — proving wake() alone triggers the read path.
    pollMs: 60_000,
    loadEvents: async (after) => {
      loadCalls.push(after)
      return available.filter((event) => event.sequence > after)
    },
    listener: (event) => received.push(event.sequence),
  })
  try {
    await waitFor(() => loadCalls.length >= 1, 'initial subscribe poll')
    const before = loadCalls.length
    available = [{ sequence: 1 }]
    hub.wake(sessionSseWakeKey('tenant', 'sess'))
    await waitFor(() => received.includes(1), 'wake-triggered delivery')
    assert.ok(loadCalls.length > before, 'wake() should trigger another loadEvents read')
    assert.deepEqual(received, [1])

    // A non-matching wake key is a harmless no-op.
    const after = loadCalls.length
    hub.wake(sessionSseWakeKey('tenant', 'other'))
    await delay(20)
    assert.equal(loadCalls.length, after)
  } finally {
    unsubscribe()
    hub.close()
  }
})

test('hub wake() wakes every topic sharing a session wake key', async () => {
  const hub = new CloudSseReplayHub()
  const a: number[] = []
  const b: number[] = []
  let available: { sequence: number }[] = []
  const loadEvents = async (after: number) => available.filter((event) => event.sequence > after)
  const wakeKey = sessionSseWakeKey('t', 's')
  const ua = hub.subscribe({ key: 'session:t:userA:s', wakeKey, afterSequence: 0, pollMs: 60_000, loadEvents, listener: (e) => a.push(e.sequence) })
  const ub = hub.subscribe({ key: 'session:t:userB:s', wakeKey, afterSequence: 0, pollMs: 60_000, loadEvents, listener: (e) => b.push(e.sequence) })
  try {
    available = [{ sequence: 1 }]
    hub.wake(wakeKey)
    await waitFor(() => a.includes(1) && b.includes(1), 'both per-user topics woken')
  } finally {
    ua()
    ub()
    hub.close()
  }
})

test('hub wake() no longer fires once the last subscriber for a wake key unsubscribes', async () => {
  const hub = new CloudSseReplayHub()
  const loadCalls: number[] = []
  const wakeKey = workspaceSseWakeKey('t', 'u')
  const unsubscribe = hub.subscribe({
    key: 'workspace:t:u',
    wakeKey,
    afterSequence: 0,
    pollMs: 60_000,
    loadEvents: async (after) => { loadCalls.push(after); return [] },
    listener: () => {},
  })
  await waitFor(() => loadCalls.length >= 1, 'initial poll')
  unsubscribe()
  const before = loadCalls.length
  hub.wake(wakeKey) // index entry must be gone — no read
  await delay(20)
  assert.equal(loadCalls.length, before)
  hub.close()
})

// ---- Listener lifecycle, driven with an injected fake pg client (no real Postgres) ----

type FakeClient = CloudSsePgNotifyClient & {
  connectCalls: number
  endedFlag: boolean
  queries: string[]
  emit(event: string, ...args: unknown[]): void
}

function fakeClient(): FakeClient {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const client: FakeClient = {
    connectCalls: 0,
    endedFlag: false,
    queries: [],
    async connect() { this.connectCalls += 1 },
    async query(text: string) { this.queries.push(text); return { rows: [] } },
    on(event: string, handler: (...args: unknown[]) => void) {
      const list = handlers.get(event) || []
      list.push(handler)
      handlers.set(event, list)
    },
    removeAllListeners() { handlers.clear() },
    async end() { this.endedFlag = true },
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) || []) handler(...args)
    },
  }
  return client
}

test('listener connects, LISTENs, and wakes the hub for decoded notifications', async () => {
  const woke: string[] = []
  const client = fakeClient()
  const listener = new CloudSsePgNotifyListener({
    connectionString: 'postgres://example/db',
    hub: { wake: (key) => woke.push(key) },
    createClient: () => client,
  })
  listener.start()
  await waitFor(
    () => client.connectCalls === 1 && client.queries.some((q) => q.includes(`LISTEN "${CLOUD_SSE_NOTIFY_CHANNEL}"`)),
    'connect + LISTEN',
  )

  client.emit('notification', {
    channel: CLOUD_SSE_NOTIFY_CHANNEL,
    payload: encodeSsePgNotifyPayload({ kind: 'session', tenantId: 't', sessionId: 's' }),
  })
  client.emit('notification', {
    channel: CLOUD_SSE_NOTIFY_CHANNEL,
    payload: encodeSsePgNotifyPayload({ kind: 'workspace', tenantId: 't', userId: 'u' }),
  })
  assert.deepEqual(woke, [sessionSseWakeKey('t', 's'), workspaceSseWakeKey('t', 'u')])

  // Malformed payload + foreign channel must be ignored without throwing or waking.
  client.emit('notification', { channel: CLOUD_SSE_NOTIFY_CHANNEL, payload: 'not-json' })
  client.emit('notification', { channel: 'other_channel', payload: encodeSsePgNotifyPayload({ kind: 'session', tenantId: 't', sessionId: 'z' }) })
  assert.deepEqual(woke, [sessionSseWakeKey('t', 's'), workspaceSseWakeKey('t', 'u')])

  await listener.close()
  assert.equal(client.endedFlag, true)
})

test('listener reconnects with backoff after a connection drop', async () => {
  const clients: FakeClient[] = []
  const listener = new CloudSsePgNotifyListener({
    connectionString: 'postgres://example/db',
    hub: { wake: () => {} },
    createClient: () => { const client = fakeClient(); clients.push(client); return client },
    initialBackoffMs: 1,
    maxBackoffMs: 4,
  })
  listener.start()
  await waitFor(() => clients.length === 1 && clients[0]!.connectCalls === 1, 'first connect')

  // Simulate a dropped connection: the listener must spin up a fresh client.
  clients[0]!.emit('error', new Error('connection reset'))
  await waitFor(() => clients.length === 2 && clients[1]!.connectCalls === 1, 'reconnect with a new client')

  await listener.close()
})

test('listener stops reconnecting after close()', async () => {
  const clients: FakeClient[] = []
  const listener = new CloudSsePgNotifyListener({
    connectionString: 'postgres://example/db',
    hub: { wake: () => {} },
    createClient: () => { const client = fakeClient(); clients.push(client); return client },
    initialBackoffMs: 1,
  })
  listener.start()
  await waitFor(() => clients.length === 1, 'connect')
  await listener.close()
  // A late drop after close must not schedule another reconnect.
  clients[0]!.emit('error', new Error('late drop'))
  await delay(30)
  assert.equal(clients.length, 1)
})
