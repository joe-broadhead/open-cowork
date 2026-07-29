import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES } from '@open-cowork/shared'
import { createHttpSseCloudTransportAdapter } from '@open-cowork/cloud-server/transport-adapter'
import { CloudWorkspaceAdapter } from '../apps/desktop/src/main/cloud-workspace-adapter.ts'
import { CloudSessionService } from '@open-cowork/cloud-server/session-service'
import {
  handleSessionSse,
  handleWorkspaceSse,
} from '../packages/cloud-server/src/http-sse-streams.ts'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import { asRecord } from './helpers/cloud-http-test-support.ts'
import {
  readSseUntil,
  withTimeout,
  readInitialStreamChunk,
  waitForStreamReaderClosed,
} from './helpers/cloud-sse-test-support.ts'

test('cloud HTTP SSE streams durable session events without sticky renderer state', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'stream me', agent: 'build' }),
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(asRecord(event.payload).content, 'echo: stream me')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP workspace event feed streams owned session deltas', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })

    const stream = await fetch(`${baseUrl}/api/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'workspace stream', agent: 'build' }),
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(event.entityType, 'session')
    assert.equal(event.entityId, 'oc-session-1')
    assert.equal(event.operation, 'update')
    assert.equal(event.projectionVersion, event.sequence)
    assert.equal(asRecord(event.payload).content, 'echo: workspace stream')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP server close shuts down active SSE streams without client aborts', async () => {
  const scenarios = [
    {
      name: 'session events',
      setup: async (baseUrl: string) => {
        await fetch(`${baseUrl}/api/sessions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        })
      },
      path: '/api/sessions/oc-session-1/events?after=0',
    },
    {
      name: 'workspace events',
      setup: async () => {},
      path: '/api/events?after=0',
    },
    {
      name: 'channel deliveries',
      setup: async () => {},
      path: '/api/channels/deliveries/stream?claimedBy=test-gateway',
    },
  ]

  for (const scenario of scenarios) {
    const fixture = createFixture({ ssePollMs: 10 })
    const baseUrl = await fixture.server.listen()
    const controller = new AbortController()
    let closed = false
    try {
      await scenario.setup(baseUrl)
      const stream = await fetch(`${baseUrl}${scenario.path}`, {
        signal: controller.signal,
      })
      assert.equal(stream.status, 200, scenario.name)
      const reader = await readInitialStreamChunk(stream)

      await withTimeout(
        fixture.server.close().then(() => {
          closed = true
        }),
        1000,
        `${scenario.name} stream blocked server shutdown.`,
      )
      await waitForStreamReaderClosed(reader)
    } finally {
      controller.abort()
      if (!closed) await fixture.server.close().catch(() => {})
    }
  }
})

test('cloud HTTP SSE capacity rejection uses HTTP 429 before opening a stream', async () => {
  const fixture = createFixture({ maxSseConnectionsPerOrg: 1 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  try {
    const first = await fetch(`${baseUrl}/api/events?after=0`, {
      signal: controller.signal,
    })
    assert.equal(first.status, 200)

    const rejected = await fetch(`${baseUrl}/api/events?after=0`)
    assert.equal(rejected.status, 429)
    assert.match(await rejected.text(), /Too many concurrent streams/)
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP session SSE does not open after disconnect during cursor lookup', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 10 })
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'owner' as const,
  }
  const created = await fixture.service.createSession(principal)
  const sessionId = created.session.sessionId
  const cursor = await fixture.service.getSessionEventCursor(principal, sessionId)
  const originalGetSessionEventCursor = fixture.service.getSessionEventCursor.bind(fixture.service)
  let signalCursorStarted: () => void = () => {}
  const cursorStarted = new Promise<void>((resolve) => {
    signalCursorStarted = resolve
  })
  let releaseCursor: () => void = () => {}
  const cursorGate = new Promise<void>((resolve) => {
    releaseCursor = resolve
  })
  fixture.service.getSessionEventCursor = async () => {
    signalCursorStarted()
    await cursorGate
    return cursor
  }

  class TrackingResponse extends EventEmitter {
    destroyed = false
    writableEnded = false
    writableLength = 0
    headerWrites = 0
    writeHeadCalls = 0
    writeCalls = 0

    setHeader() {
      this.headerWrites += 1
      return this
    }
    writeHead() {
      this.writeHeadCalls += 1
      return this
    }
    write() {
      this.writeCalls += 1
      return true
    }
  }

  const request = Object.assign(new EventEmitter(), {
    headers: {},
    destroyed: false,
    socket: { setKeepAlive() {} },
  })
  const response = new TrackingResponse()
  const context = {
    principal,
    authSource: 'resolver' as const,
    cookieSession: null,
    url: new URL(`http://cloud.test/api/sessions/${sessionId}/events?after=0`),
    segments: ['api', 'sessions', sessionId, 'events'],
  }
  const handling = handleSessionSse(
    request as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      service: fixture.service,
      policy: fixture.policy,
      corsOrigin: 'https://cowork.example.test',
      ssePollMs: 10,
    },
    context,
    sessionId,
  )

  try {
    await cursorStarted
    request.emit('close')
    releaseCursor()
    await handling

    assert.deepEqual({
      headerWrites: response.headerWrites,
      writeHeadCalls: response.writeHeadCalls,
      writeCalls: response.writeCalls,
      subscribers: fixture.service.eventBus.subscriberCount,
    }, {
      headerWrites: 0,
      writeHeadCalls: 0,
      writeCalls: 0,
      subscribers: 0,
    })
  } finally {
    releaseCursor()
    request.emit('close')
    response.emit('close')
    fixture.service.getSessionEventCursor = originalGetSessionEventCursor
  }
})

test('cloud HTTP server close handles workspace SSE shutdown during replay load', async () => {
  const fixture = createFixture({ ssePollMs: 10 })
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  let releaseList: (() => void) | null = null
  const listStarted = new Promise<void>((resolve) => {
    fixture.service.listWorkspaceEvents = async () => {
      resolve()
      await new Promise<void>((release) => {
        releaseList = release
      })
      return [{
        tenantId: 'tenant-1',
        userId: 'user-1',
        sessionId: 'oc-session-1',
        sequence: 10,
        entityType: 'session',
        entityId: 'oc-session-1',
        operation: 'update',
        projectionVersion: 10,
        type: 'assistant.message',
        eventId: 'event-10',
        payload: { content: 'retained event after a replay gap' },
        createdAt: '2026-06-02T00:00:00.000Z',
      }] satisfies Awaited<ReturnType<typeof originalListWorkspaceEvents>>
    }
  })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  let closed = false
  try {
    const stream = await fetch(`${baseUrl}/api/events?after=8`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    await listStarted

    const closePromise = fixture.server.close().then(() => {
      closed = true
    })
    releaseList?.()
    await withTimeout(closePromise, 1000, 'Workspace SSE replay load blocked server shutdown.')
    const reader = stream.body?.getReader()
    if (reader) await waitForStreamReaderClosed(reader)
  } finally {
    controller.abort()
    releaseList?.()
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    if (!closed) await fixture.server.close().catch(() => {})
  }
})

test('cloud HTTP session and workspace SSE streams drop backpressured clients before subscribing', async () => {
  const fixture = createFixture({ ssePollMs: 10 })
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user@example.test',
    role: 'owner' as const,
  }
  const created = await fixture.service.createSession(principal)
  const options = {
    service: fixture.service,
    policy: fixture.policy,
    ssePollMs: 10,
  }

  class BackpressuredResponse extends EventEmitter {
    destroyed = false
    destroyCalls = 0
    writeCalls = 0
    writableLength = CLOUD_SESSION_SSE_MAX_BUFFERED_BYTES + 1

    setHeader() {}
    writeHead() {}
    write() {
      this.writeCalls += 1
      return true
    }
    destroy() {
      this.destroyCalls += 1
      this.destroyed = true
      this.emit('close')
      return this
    }
  }

  const scenarios = [
    {
      name: 'session',
      url: new URL(`http://cloud.test/api/sessions/${created.session.sessionId}/events?after=0`),
      subscriberCount: () => fixture.service.eventBus.subscriberCount,
      invoke: (
        req: IncomingMessage,
        res: ServerResponse,
        context: Parameters<typeof handleSessionSse>[3],
      ) => handleSessionSse(req, res, options, context, created.session.sessionId),
    },
    {
      name: 'workspace',
      url: new URL('http://cloud.test/api/events?after=0'),
      subscriberCount: () => fixture.service.workspaceEventBus.subscriberCount,
      invoke: (
        req: IncomingMessage,
        res: ServerResponse,
        context: Parameters<typeof handleWorkspaceSse>[3],
      ) => handleWorkspaceSse(req, res, options, context),
    },
  ]

  for (const scenario of scenarios) {
    const req = Object.assign(new EventEmitter(), {
      headers: {},
      socket: { setKeepAlive() {} },
    }) as unknown as IncomingMessage
    const response = new BackpressuredResponse()
    const context = {
      principal,
      authSource: 'resolver' as const,
      cookieSession: null,
      url: scenario.url,
      segments: scenario.url.pathname.split('/').filter(Boolean),
    }

    assert.equal(scenario.subscriberCount(), 0, `${scenario.name}: precondition`)
    await scenario.invoke(req, response as unknown as ServerResponse, context)

    assert.equal(response.destroyCalls, 1, `${scenario.name}: destroy count`)
    assert.equal(response.writeCalls, 4, `${scenario.name}: connected comment plus first event`)
    assert.equal(scenario.subscriberCount(), 0, `${scenario.name}: no steady-state subscription`)
  }
})

test('cloud HTTP workspace event feed replays one ordered user stream across sessions', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  }
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  const replayListCalls: number[] = []
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'first session', agent: 'build' }),
    })
    await fetch(`${baseUrl}/api/sessions/oc-session-2/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'second session', agent: 'build' }),
    })

    const events = await fixture.service.listWorkspaceEvents(principal, 0)
    assert.deepEqual(
      events.map((event) => event.sequence),
      Array.from({ length: events.length }, (_, index) => index + 1),
    )
    assert.deepEqual(
      events.filter((event) => event.type === 'assistant.message').map((event) => event.sessionId),
      ['oc-session-1', 'oc-session-2'],
    )

    const firstAssistant = events.find((event) => event.type === 'assistant.message' && event.sessionId === 'oc-session-1')
    assert.ok(firstAssistant)
    fixture.service.listWorkspaceEvents = async (eventPrincipal, afterSequence = 0) => {
      replayListCalls.push(afterSequence)
      return originalListWorkspaceEvents(eventPrincipal, afterSequence)
    }
    const stream = await fetch(`${baseUrl}/api/events?after=${firstAssistant.sequence}`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)
    const replayed = await readSseUntil(stream, (entry) => (
      entry.type === 'assistant.message' && entry.sessionId === 'oc-session-2'
    ))
    assert.equal(asRecord(replayed.payload).content, 'echo: second session')
    assert.equal(replayListCalls.includes(0), false)
    assert.equal(replayListCalls.includes(firstAssistant.sequence), true)
  } finally {
    controller.abort()
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    await fixture.server.close()
  }
})

test('cloud HTTP workspace event feed closes the replay-to-subscribe handoff with durable catch-up', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 10 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const workerSideService = new CloudSessionService(fixture.store, fixture.runtime, fixture.policy)
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  let injected = false
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    fixture.service.listWorkspaceEvents = async (principal, afterSequence = 0, limit) => {
      const batch = await originalListWorkspaceEvents(principal, afterSequence, limit)
      if (!injected) {
        injected = true
        await workerSideService.appendRuntimeEvent({
          tenantId: 'tenant-1',
          sessionId: 'oc-session-1',
          event: {
            type: 'assistant.message',
            payload: {
              messageId: 'external-workspace-message',
              content: 'from another workspace worker',
            },
          },
        })
      }
      return batch
    }

    const stream = await fetch(`${baseUrl}/api/events?after=0`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(asRecord(event.payload).messageId, 'external-workspace-message')
  } finally {
    controller.abort()
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    await fixture.server.close()
  }
})

test('cloud HTTP workspace event feed asks clients to refresh snapshots after retention gaps', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEvents.bind(fixture.service)
  const originalGetWorkspaceEventCursor = fixture.service.getWorkspaceEventCursor.bind(fixture.service)
  const replayListCalls: number[] = []
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    fixture.service.getWorkspaceEventCursor = async () => ({
      earliestSequence: 10,
      latestSequence: 10,
    })
    fixture.service.listWorkspaceEvents = async (principal, afterSequence = 0) => {
      replayListCalls.push(afterSequence)
      return originalListWorkspaceEvents(principal, afterSequence)
    }

    const stream = await fetch(`${baseUrl}/api/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const event = await readSseUntil(stream, (entry) => entry.type === 'snapshot.required')
    assert.equal(asRecord(event.payload).reason, 'event_retention_gap')
    assert.equal(asRecord(event.payload).afterSequence, 1)
    assert.equal(asRecord(event.payload).earliestSequence, 10)
    assert.equal(asRecord(event.payload).latestSequence, 10)
    assert.equal(replayListCalls.includes(0), false)
  } finally {
    controller.abort()
    fixture.service.getWorkspaceEventCursor = originalGetWorkspaceEventCursor
    fixture.service.listWorkspaceEvents = originalListWorkspaceEvents
    await fixture.server.close()
  }
})

test('cloud HTTP session event feed asks clients to refresh snapshots after retention gaps', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const originalGetSessionEventStats = fixture.store.getSessionEventStats.bind(fixture.store)
  const originalListSessionEvents = fixture.service.listSessionEventsForStream.bind(fixture.service)
  const replayListCalls: number[] = []
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    fixture.store.getSessionEventStats = () => ({
      count: 1,
      earliestSequence: 10,
      latestSequence: 10,
    })
    fixture.service.listSessionEventsForStream = async (
      tenantId,
      sessionId,
      afterSequence = 0,
      limit,
    ) => {
      replayListCalls.push(afterSequence)
      return originalListSessionEvents(tenantId, sessionId, afterSequence, limit)
    }

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const event = await readSseUntil(stream, (entry) => entry.type === 'snapshot.required')
    assert.equal(asRecord(event.payload).reason, 'event_retention_gap')
    assert.equal(asRecord(event.payload).afterSequence, 1)
    assert.equal(asRecord(event.payload).earliestSequence, 10)
    assert.equal(asRecord(event.payload).latestSequence, 10)
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(event.entityType, 'session')
    assert.equal(event.entityId, 'oc-session-1')
    assert.equal(replayListCalls.includes(1), false)
  } finally {
    controller.abort()
    fixture.store.getSessionEventStats = originalGetSessionEventStats
    fixture.service.listSessionEventsForStream = originalListSessionEvents
    await fixture.server.close()
  }
})

test('cloud HTTP SSE detects retention gaps that open after the cursor snapshot', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 60_000 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  }
  const originalGetSessionEventCursor = fixture.service.getSessionEventCursor.bind(fixture.service)
  const originalGetWorkspaceEventCursor = fixture.service.getWorkspaceEventCursor.bind(fixture.service)
  const retentionCutoff = new Date('9999-12-31T23:59:59.999Z')

  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fixture.service.appendRuntimeEvent({
      tenantId: principal.tenantId,
      sessionId: 'oc-session-1',
      event: {
        type: 'assistant.message',
        payload: {
          messageId: 'retention-race-first',
          content: 'removed after the cursor snapshot',
        },
      },
    })
    await fixture.service.appendRuntimeEvent({
      tenantId: principal.tenantId,
      sessionId: 'oc-session-1',
      event: {
        type: 'assistant.message',
        payload: {
          messageId: 'retention-race-second',
          content: 'first retained replay event',
        },
      },
    })

    const sessionEvents = await fixture.service.listEvents(principal, 'oc-session-1')
    const workspaceEvents = await fixture.service.listWorkspaceEvents(principal, 0)
    assert.ok(sessionEvents.length >= 3)
    assert.ok(workspaceEvents.length >= 3)
    assert.equal(
      fixture.store.pruneExpiredSessionEvents({
        olderThan: retentionCutoff,
        limit: sessionEvents.length - 2,
      }),
      sessionEvents.length - 2,
    )
    assert.equal(
      fixture.store.pruneExpiredWorkspaceEvents({
        olderThan: retentionCutoff,
        limit: workspaceEvents.length - 2,
      }),
      workspaceEvents.length - 2,
    )

    const retainedSessionEvents = await fixture.service.listEvents(principal, 'oc-session-1')
    const retainedWorkspaceEvents = await fixture.service.listWorkspaceEvents(principal, 0)
    const sessionAfter = retainedSessionEvents[0]!.sequence - 1
    const workspaceAfter = retainedWorkspaceEvents[0]!.sequence - 1
    const expectedSessionEarliest = retainedSessionEvents[1]!.sequence
    const expectedWorkspaceEarliest = retainedWorkspaceEvents[1]!.sequence

    fixture.service.getSessionEventCursor = async (cursorPrincipal, sessionId) => {
      const cursor = await originalGetSessionEventCursor(cursorPrincipal, sessionId)
      assert.equal(cursor.earliestSequence, sessionAfter + 1)
      assert.equal(
        fixture.store.pruneExpiredSessionEvents({
          olderThan: retentionCutoff,
          limit: 1,
        }),
        1,
      )
      return cursor
    }
    fixture.service.getWorkspaceEventCursor = async (cursorPrincipal) => {
      const cursor = await originalGetWorkspaceEventCursor(cursorPrincipal)
      assert.equal(cursor.earliestSequence, workspaceAfter + 1)
      assert.equal(
        fixture.store.pruneExpiredWorkspaceEvents({
          olderThan: retentionCutoff,
          limit: 1,
        }),
        1,
      )
      return cursor
    }

    const [sessionStream, workspaceStream] = await Promise.all([
      fetch(
        `${baseUrl}/api/sessions/oc-session-1/events?after=${sessionAfter}`,
        { signal: controller.signal },
      ),
      fetch(
        `${baseUrl}/api/events?after=${workspaceAfter}`,
        { signal: controller.signal },
      ),
    ])
    assert.equal(sessionStream.status, 200)
    assert.equal(workspaceStream.status, 200)

    const [sessionSnapshot, workspaceSnapshot] = await Promise.all([
      readSseUntil(sessionStream, () => true),
      readSseUntil(workspaceStream, () => true),
    ])
    assert.equal(sessionSnapshot.type, 'snapshot.required')
    assert.equal(asRecord(sessionSnapshot.payload).reason, 'event_retention_gap')
    assert.equal(asRecord(sessionSnapshot.payload).afterSequence, sessionAfter)
    assert.equal(asRecord(sessionSnapshot.payload).earliestSequence, expectedSessionEarliest)
    assert.equal(asRecord(sessionSnapshot.payload).latestSequence, expectedSessionEarliest)
    assert.equal(sessionSnapshot.sessionId, 'oc-session-1')
    assert.equal(sessionSnapshot.entityType, 'session')
    assert.equal(sessionSnapshot.entityId, 'oc-session-1')
    assert.equal(workspaceSnapshot.type, 'snapshot.required')
    assert.equal(asRecord(workspaceSnapshot.payload).reason, 'event_retention_gap')
    assert.equal(asRecord(workspaceSnapshot.payload).afterSequence, workspaceAfter)
    assert.equal(asRecord(workspaceSnapshot.payload).earliestSequence, expectedWorkspaceEarliest)
    assert.equal(asRecord(workspaceSnapshot.payload).latestSequence, expectedWorkspaceEarliest)
  } finally {
    controller.abort()
    fixture.service.getSessionEventCursor = originalGetSessionEventCursor
    fixture.service.getWorkspaceEventCursor = originalGetWorkspaceEventCursor
    await fixture.server.close()
  }
})

test('SSE close helper reports a reader timeout instead of treating it as closure', async () => {
  const reader = {
    read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => undefined),
  } as ReadableStreamDefaultReader<Uint8Array>
  const keepProcessAlive = setTimeout(() => undefined, 1000)

  try {
    await assert.rejects(
      () => waitForStreamReaderClosed(reader, 10),
      /Timed out waiting for SSE reader to close/,
    )
  } finally {
    clearTimeout(keepProcessAlive)
  }
})

test('cloud HTTP clients share session state across desktop adapter and web transport', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    const web = createHttpSseCloudTransportAdapter({ baseUrl })
    const desktop = new CloudWorkspaceAdapter({
      connection: {
        id: 'cloud:test',
        baseUrl,
        label: 'Test Cloud',
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: '2026-05-27T10:00:00.000Z',
        lastSyncedAt: null,
      },
      transport: createHttpSseCloudTransportAdapter({ baseUrl }),
      cache: null,
    })

    const created = await desktop.createSession()
    assert.equal((await web.listSessions()).some((session) => session.sessionId === created.id), true)

    await web.promptSession(created.id, { text: 'from web', agent: 'build' })
    const desktopAfterWebPrompt = await desktop.getSessionView(created.id)
    assert.equal(desktopAfterWebPrompt.messages.some((message) => message.content === 'echo: from web'), true)

    await desktop.promptSession(created.id, { text: 'from desktop', agent: 'build' })
    const webAfterDesktopPrompt = await web.getSession(created.id)
    assert.equal(
      webAfterDesktopPrompt.projection?.view.messages.some((message) => message.content === 'echo: from desktop'),
      true,
    )
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP SSE resumes from Last-Event-ID without replaying older events', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  }

  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'before reconnect', agent: 'build' }),
    })
    const priorEvents = await fixture.service.listEvents(principal, 'oc-session-1')
    const lastSequence = Math.max(...priorEvents.map((event) => event.sequence))

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events`, {
      signal: controller.signal,
      headers: {
        'Last-Event-ID': String(lastSequence),
      },
    })
    assert.equal(stream.status, 200)

    await fetch(`${baseUrl}/api/sessions/oc-session-1/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'after reconnect', agent: 'build' }),
    })

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(asRecord(event.payload).content, 'echo: after reconnect')
  } finally {
    controller.abort()
    await fixture.server.close()
  }
})

test('cloud HTTP session SSE closes the replay-to-subscribe handoff with durable catch-up', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 10 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const workerSideService = new CloudSessionService(fixture.store, fixture.runtime, fixture.policy)
  const originalListSessionEvents = fixture.service.listSessionEventsForStream.bind(fixture.service)
  let injected = false
  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    fixture.service.listSessionEventsForStream = async (
      tenantId,
      sessionId,
      afterSequence = 0,
      limit,
    ) => {
      const batch = await originalListSessionEvents(tenantId, sessionId, afterSequence, limit)
      if (!injected) {
        injected = true
        await workerSideService.appendRuntimeEvent({
          tenantId: 'tenant-1',
          sessionId: 'oc-session-1',
          event: {
            type: 'assistant.message',
            payload: {
              messageId: 'external-worker-message',
              content: 'from another worker',
            },
          },
        })
      }
      return batch
    }

    const stream = await fetch(`${baseUrl}/api/sessions/oc-session-1/events?after=1`, {
      signal: controller.signal,
    })
    assert.equal(stream.status, 200)

    const event = await readSseUntil(stream, (entry) => entry.type === 'assistant.message')
    assert.equal(event.sessionId, 'oc-session-1')
    assert.equal(asRecord(event.payload).messageId, 'external-worker-message')
  } finally {
    controller.abort()
    fixture.service.listSessionEventsForStream = originalListSessionEvents
    await fixture.server.close()
  }
})

test('cloud HTTP session and workspace SSE preserve durable order when live events overtake replay', async () => {
  const fixture = createFixture({ autoProcessCommands: false, ssePollMs: 60_000 })
  const baseUrl = await fixture.server.listen()
  const controller = new AbortController()
  const principal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    userId: 'user-1',
    email: 'user@example.test',
  }
  const workerSideService = new CloudSessionService(fixture.store, fixture.runtime, fixture.policy)
  const originalListSessionEvents = fixture.service.listSessionEventsForStream.bind(fixture.service)
  const originalListWorkspaceEvents = fixture.service.listWorkspaceEventsForStream.bind(fixture.service)
  let sessionReplayLoadCalls = 0
  let signalSessionReplayStarted: () => void = () => {}
  const sessionReplayStarted = new Promise<void>((resolve) => {
    signalSessionReplayStarted = resolve
  })
  let signalWorkspaceReplayStarted: () => void = () => {}
  const workspaceReplayStarted = new Promise<void>((resolve) => {
    signalWorkspaceReplayStarted = resolve
  })
  let releaseReplay: () => void = () => {}
  const replayGate = new Promise<void>((resolve) => {
    releaseReplay = resolve
  })

  try {
    await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const existingSessionEvents = await fixture.service.listEvents(principal, 'oc-session-1')
    const sessionAfter = Math.max(...existingSessionEvents.map((event) => event.sequence))
    const existingWorkspaceEvents = await fixture.service.listWorkspaceEvents(principal, 0)
    const workspaceAfter = Math.max(...existingWorkspaceEvents.map((event) => event.sequence))

    fixture.service.listSessionEventsForStream = async (
      tenantId,
      sessionId,
      after = 0,
      limit,
    ) => {
      sessionReplayLoadCalls += 1
      if (sessionReplayLoadCalls === 2) {
        signalSessionReplayStarted()
        await replayGate
      }
      return originalListSessionEvents(tenantId, sessionId, after, limit)
    }
    fixture.service.listWorkspaceEventsForStream = async (
      tenantId,
      userId,
      after = 0,
      limit,
    ) => {
      signalWorkspaceReplayStarted()
      await replayGate
      return originalListWorkspaceEvents(tenantId, userId, after, limit)
    }

    const [sessionStream, workspaceStream] = await Promise.all([
      fetch(
        `${baseUrl}/api/sessions/oc-session-1/events?after=${sessionAfter}`,
        { signal: controller.signal },
      ),
      fetch(
        `${baseUrl}/api/events?after=${workspaceAfter}`,
        { signal: controller.signal },
      ),
    ])
    assert.equal(sessionStream.status, 200)
    assert.equal(workspaceStream.status, 200)
    await withTimeout(
      Promise.all([sessionReplayStarted, workspaceReplayStarted]),
      1000,
      'SSE replay polls did not start.',
    )

    const missed = await workerSideService.appendRuntimeEvent({
      tenantId: 'tenant-1',
      sessionId: 'oc-session-1',
      event: {
        type: 'assistant.message',
        payload: {
          messageId: 'external-before-live',
          content: 'durable event from another worker',
        },
      },
    })
    const missedWorkspace = (
      await fixture.service.listWorkspaceEvents(principal, workspaceAfter)
    ).find((event) => asRecord(event.payload).messageId === 'external-before-live')
    assert.ok(missedWorkspace)
    const live = await fixture.service.appendRuntimeEvent({
      tenantId: 'tenant-1',
      sessionId: 'oc-session-1',
      event: {
        type: 'assistant.message',
        payload: {
          messageId: 'local-live-event',
          content: 'local event after external event',
        },
      },
    })
    assert.equal(live.sequence, missed.sequence + 1)
    const liveWorkspace = (
      await fixture.service.listWorkspaceEvents(principal, missedWorkspace.sequence)
    ).find((event) => asRecord(event.payload).messageId === 'local-live-event')
    assert.ok(liveWorkspace)

    releaseReplay()
    const sessionEvents: Array<Record<string, unknown>> = []
    const workspaceEvents: Array<Record<string, unknown>> = []
    await Promise.all([
      readSseUntil(
        sessionStream,
        (event) => {
          if (Number(event.sequence) > sessionAfter) sessionEvents.push(event)
          return sessionEvents.length === 2
        },
      ),
      readSseUntil(
        workspaceStream,
        (event) => {
          if (Number(event.sequence) > workspaceAfter) workspaceEvents.push(event)
          return workspaceEvents.length === 2
        },
      ),
    ])
    assert.deepEqual(
      sessionEvents.map((event) => event.sequence),
      [missed.sequence, live.sequence],
    )
    assert.deepEqual(
      sessionEvents.map((event) => asRecord(event.payload).messageId),
      ['external-before-live', 'local-live-event'],
    )
    assert.deepEqual(
      workspaceEvents.map((event) => event.sequence),
      [missedWorkspace.sequence, liveWorkspace.sequence],
    )
    assert.deepEqual(
      workspaceEvents.map((event) => asRecord(event.payload).messageId),
      ['external-before-live', 'local-live-event'],
    )
  } finally {
    releaseReplay()
    controller.abort()
    fixture.service.listSessionEventsForStream = originalListSessionEvents
    fixture.service.listWorkspaceEventsForStream = originalListWorkspaceEvents
    await fixture.server.close()
  }
})
