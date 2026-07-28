import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { addLiveClient, broadcastLiveEventForTest, clearLiveClientsForTest, closeAllLiveClients, consumeOpenCodeEventStream, liveClientCountForTest, livePrincipalCountForTest, liveSessionSnapshotCountForTest, liveSubscriptionStateForTest, parseSseFrame, primeSessionUpdatePayloadForTest, removeLiveClient, runLiveClientMaintenanceForTest, sanitizeOpenCodeEventForLive, stopLiveEvents, subscribeToOpenCodeEvents } from '../live.js'
import { clearRuntimeMetricsForTest, renderPrometheusMetrics } from '../runtime-metrics.js'

describe('opencode live events', () => {
  afterEach(async () => {
    await stopLiveEvents()
    clearLiveClientsForTest()
    clearRuntimeMetricsForTest()
  })

  it('parses SSE event frames', () => {
    expect(parseSseFrame('event: message.updated\ndata: {"sessionID":"ses_1"}')).toEqual({
      type: 'message.updated',
      payload: { sessionID: 'ses_1' },
    })
  })

  it('parses event and data fields with CR, LF, CRLF, and mixed line endings', () => {
    expect(parseSseFrame('event: cr-only\rdata: {"value":1}\rdata: continued')).toEqual({
      type: 'cr-only',
      payload: '{"value":1}\ncontinued',
    })
    expect(parseSseFrame('event: mixed\r\ndata: {"value":2}\rdata: continued')).toEqual({
      type: 'mixed',
      payload: '{"value":2}\ncontinued',
    })
  })

  it('ignores empty completion frames', () => {
    expect(parseSseFrame('data: [DONE]')).toBeNull()
  })

  it('projects native OpenCode events without raw payloads for browser SSE clients', () => {
    const projected = sanitizeOpenCodeEventForLive({
      type: 'message.updated',
      payload: {
        sessionID: 'ses_safe',
        message: {
          id: 'msg_safe',
          content: 'private transcript token=operator-secret-token',
          parts: [{ text: 'private transcript' }],
        },
      },
    })

    expect(projected).toMatchObject({
      type: 'opencode_event',
      eventType: 'message.updated',
      sessionId: 'ses_safe',
      messageId: 'msg_safe',
    })
    expect(projected).not.toHaveProperty('payload')
    expect(JSON.stringify(projected)).not.toContain('operator-secret-token')
    expect(JSON.stringify(projected)).not.toContain('private transcript')
  })

  it('reflects only a local origin on the SSE stream and denies remote/absent origins', () => {
    const capture = () => {
      const res: any = { writableLength: 0, destroyed: false, writes: [] as string[], headers: undefined as any }
      res.writeHead = (_status: number, headers: any) => { res.headers = headers }
      res.write = () => true
      res.destroy = () => {}
      return res
    }
    const local = capture(); addLiveClient('local', local, 'http://127.0.0.1:4097', 4097)
    expect(local.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4097')

    // A remote origin — including an opaque origin that serializes to the literal
    // 'null' — must get the canonical loopback value it can never match, not 'null'.
    const remote = capture(); addLiveClient('remote', remote, 'https://evil.example.com', 4097)
    expect(remote.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4097')

    const absent = capture(); addLiveClient('absent', absent, undefined, 4097)
    expect(absent.headers['Access-Control-Allow-Origin']).toBe('http://127.0.0.1:4097')
  })

  it('admits exactly the configured global and authenticated-principal limits', () => {
    const limits = {
      maxClients: 2,
      maxClientsPerPrincipal: 1,
      retryAfterSeconds: 7,
    }
    const first = fakeSseResponse(0)
    const samePrincipal = fakeSseResponse(0)
    const second = fakeSseResponse(0)
    const overGlobal = fakeSseResponse(0)

    expect(addLiveClient('first', first, undefined, undefined, { principal: 'principal-a', limits }).accepted).toBe(true)
    expect(addLiveClient('same', samePrincipal, undefined, undefined, { principal: 'principal-a', limits })).toMatchObject({
      accepted: false,
      reason: 'principal_capacity',
    })
    expect(samePrincipal.status).toBe(503)
    expect(samePrincipal.headers['Retry-After']).toBe('7')
    expect(JSON.parse(samePrincipal.ended[0]!)).toEqual({
      error: 'live SSE capacity exceeded',
      code: 'LIVE_SSE_CAPACITY',
      retryable: true,
    })

    expect(addLiveClient('second', second, undefined, undefined, { principal: 'principal-b', limits }).accepted).toBe(true)
    expect(addLiveClient('global', overGlobal, undefined, undefined, { principal: 'principal-c', limits })).toMatchObject({
      accepted: false,
      reason: 'global_capacity',
    })
    expect(liveClientCountForTest()).toBe(2)
  })

  it('releases request/response listeners and principal state exactly once across disconnect races', () => {
    const request = new EventEmitter()
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0))

    expect(addLiveClient('racy', response, undefined, undefined, {
      principal: 'principal-race',
      lifecycle: request,
    }).accepted).toBe(true)
    expect(request.listenerCount('aborted')).toBe(1)
    expect(response.listenerCount('error')).toBe(1)
    expect(livePrincipalCountForTest()).toBe(1)

    request.emit('aborted')
    request.emit('close')
    response.emit('close')

    expect(liveClientCountForTest()).toBe(0)
    expect(livePrincipalCountForTest()).toBe(0)
    expect(request.listenerCount('aborted')).toBe(0)
    expect(request.listenerCount('close')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
    expect(response.listenerCount('close')).toBe(0)
  })

  it('releases a dead client on socket error without leaving listeners behind', () => {
    const socket = new EventEmitter()
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0), { socket })
    addLiveClient('dead-socket', response, undefined, undefined, { principal: 'principal-dead' })

    socket.emit('error', new Error('socket reset'))

    expect(liveClientCountForTest()).toBe(0)
    expect(socket.listenerCount('error')).toBe(0)
    expect(response.listenerCount('error')).toBe(0)
  })

  it('keeps healthy clients alive with heartbeats and closes them when authentication expires', () => {
    let now = 1000
    let authorized = true
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0))
    addLiveClient('healthy', response, undefined, undefined, {
      principal: 'principal-healthy',
      authorize: () => authorized,
      now: () => now,
      limits: {
        heartbeatMs: 100,
        idleTimeoutMs: 300,
        maxConnectionMs: 1000,
        writeTimeoutMs: 50,
      },
    })
    response.writes.length = 0

    now = 1100
    runLiveClientMaintenanceForTest(now)
    expect(response.writes).toEqual([': heartbeat\n\n'])
    expect(liveClientCountForTest()).toBe(1)

    authorized = false
    now = 1200
    runLiveClientMaintenanceForTest(now)
    expect(liveClientCountForTest()).toBe(0)
    expect(response.ended.join('')).toContain('"reason":"authentication_expired"')
  })

  it('closes idle, maximum-lifetime, and persistently backpressured clients at their deadlines', () => {
    const idle = Object.assign(new EventEmitter(), fakeSseResponse(0))
    addLiveClient('idle', idle, undefined, undefined, {
      principal: 'principal-idle',
      now: () => 1000,
      limits: { heartbeatMs: 100, idleTimeoutMs: 300, maxConnectionMs: 1000, writeTimeoutMs: 50 },
    })
    runLiveClientMaintenanceForTest(1300)
    expect(idle.ended.join('')).toContain('"reason":"idle_timeout"')

    const lifetime = Object.assign(new EventEmitter(), fakeSseResponse(0))
    addLiveClient('lifetime', lifetime, undefined, undefined, {
      principal: 'principal-lifetime',
      now: () => 2000,
      limits: { heartbeatMs: 100, idleTimeoutMs: 300, maxConnectionMs: 500, writeTimeoutMs: 50 },
    })
    runLiveClientMaintenanceForTest(2500)
    expect(lifetime.ended.join('')).toContain('"reason":"maximum_lifetime"')

    const slow = Object.assign(new EventEmitter(), fakeSseResponse(0))
    slow.writeResult = false
    addLiveClient('slow', slow, undefined, undefined, {
      principal: 'principal-slow',
      now: () => 3000,
      limits: { heartbeatMs: 100, idleTimeoutMs: 300, maxConnectionMs: 1000, writeTimeoutMs: 50 },
    })
    runLiveClientMaintenanceForTest(3050)
    expect(slow.destroyed).toBe(true)
    expect(liveClientCountForTest()).toBe(0)
  })

  it('destroys backpressured transports on every deadline and shutdown closure path', () => {
    const cases = [
      {
        id: 'backpressured-auth',
        authorize: () => false,
        limits: { heartbeatMs: 100, idleTimeoutMs: 10_000, maxConnectionMs: 20_000, writeTimeoutMs: 10_000 },
        deadline: 1100,
      },
      {
        id: 'backpressured-lifetime',
        limits: { heartbeatMs: 100, idleTimeoutMs: 10_000, maxConnectionMs: 500, writeTimeoutMs: 10_000 },
        deadline: 1500,
      },
      {
        id: 'backpressured-idle',
        limits: { heartbeatMs: 100, idleTimeoutMs: 300, maxConnectionMs: 20_000, writeTimeoutMs: 10_000 },
        deadline: 1300,
      },
    ]

    for (const entry of cases) {
      const response = Object.assign(new EventEmitter(), fakeSseResponse(0))
      response.writeResult = false
      addLiveClient(entry.id, response, undefined, undefined, {
        principal: entry.id,
        authorize: entry.authorize,
        now: () => 1000,
        limits: entry.limits,
      })

      runLiveClientMaintenanceForTest(entry.deadline)

      expect(response.destroyed, entry.id).toBe(true)
      expect(response.ended, entry.id).toEqual([])
      expect(liveClientCountForTest()).toBe(0)
    }

    const shutdown = Object.assign(new EventEmitter(), fakeSseResponse(0))
    shutdown.writeResult = false
    addLiveClient('backpressured-shutdown', shutdown)
    closeAllLiveClients()
    expect(shutdown.destroyed).toBe(true)
    expect(shutdown.ended).toEqual([])
  })

  it('exposes bounded-label admission, timeout, and slow-consumer metrics', () => {
    clearRuntimeMetricsForTest()
    const limits = {
      maxClients: 2,
      maxClientsPerPrincipal: 1,
      retryAfterSeconds: 1,
      heartbeatMs: 100,
      idleTimeoutMs: 300,
      maxConnectionMs: 1000,
      writeTimeoutMs: 50,
    }
    addLiveClient('active', Object.assign(new EventEmitter(), fakeSseResponse(0)), undefined, undefined, {
      principal: 'private-principal',
      now: () => 1000,
      limits,
    })
    addLiveClient('rejected', fakeSseResponse(0), undefined, undefined, {
      principal: 'private-principal',
      now: () => 1000,
      limits,
    })
    addLiveClient('active-two', fakeSseResponse(0), undefined, undefined, {
      principal: 'second-private-principal',
      now: () => 1000,
      limits,
    })
    addLiveClient('global-rejected', fakeSseResponse(0), undefined, undefined, {
      principal: 'third-private-principal',
      now: () => 1000,
      limits,
    })
    runLiveClientMaintenanceForTest(1300)

    const slow = Object.assign(new EventEmitter(), fakeSseResponse(0))
    slow.writeResult = false
    addLiveClient('slow-metric', slow, undefined, undefined, {
      principal: 'other-private-principal',
      now: () => 2000,
      limits,
    })
    runLiveClientMaintenanceForTest(2050)

    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('gateway_live_sse_active 0')
    expect(metrics).toContain('gateway_live_sse_rejected_total{scope="principal"} 1')
    expect(metrics).toContain('gateway_live_sse_rejected_total{scope="global"} 1')
    expect(metrics).toContain('gateway_live_sse_timeouts_total{reason="idle"} 2')
    expect(metrics).toContain('gateway_live_sse_slow_consumers_total{reason="write_timeout"} 1')
    expect(metrics).not.toContain('private-principal')
  })

  it('counts oversized upstream frames without recording their contents', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('private-upstream-payload'))
      },
      cancel() {
        cancelled = true
      },
    })

    await expect(consumeOpenCodeEventStream(body, {
      maxBufferedBytes: 8,
      maxEventBytes: 8,
    }, () => {})).rejects.toMatchObject({ code: 'UPSTREAM_SSE_BUFFER_LIMIT' })

    const metrics = renderPrometheusMetrics()
    expect(cancelled).toBe(true)
    expect(metrics).toContain('gateway_live_upstream_frames_rejected_total{reason="buffer_limit"} 1')
    expect(metrics).not.toContain('private-upstream-payload')
  })

  it('consumes upstream events across mixed legal SSE line endings and blank-line boundaries', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode([
          'event: cr\rdata: {"id":1}\r\r',
          'event: mixed-one\r\ndata: {"id":2}\r\n\n',
          'event: mixed-two\ndata: {"id":3}\n\r\n',
        ].join(''))
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
        controller.close()
      },
    })
    const events: Array<{ type: string; payload: any }> = []

    await consumeOpenCodeEventStream(body, {
      maxBufferedBytes: 1024,
      maxEventBytes: 1024,
    }, event => { events.push(event) })

    expect(events).toEqual([
      { type: 'cr', payload: { id: 1 } },
      { type: 'mixed-one', payload: { id: 2 } },
      { type: 'mixed-two', payload: { id: 3 } },
    ])
  })

  it('keeps replay and principal bookkeeping bounded under repeated connection churn', () => {
    for (let index = 0; index < 1200; index++) {
      primeSessionUpdatePayloadForTest(`session-${index}`, { type: 'session_update', id: `session-${index}` })
    }
    expect(liveSessionSnapshotCountForTest()).toBe(1000)
    const replay = fakeSseResponse(0)
    addLiveClient('stable-replay', replay)
    const replayBody = replay.writes.join('')
    expect(replayBody).toContain('"id":"session-0"')
    expect(replayBody).toContain('"id":"session-999"')
    expect(replayBody).not.toContain('"id":"session-1000"')
    removeLiveClient('stable-replay')

    for (let index = 0; index < 500; index++) {
      const id = `churn-${index}`
      addLiveClient(id, fakeSseResponse(0), undefined, undefined, {
        principal: `principal-${index}`,
        limits: { maxClients: 1, maxClientsPerPrincipal: 1 },
      })
      removeLiveClient(id)
    }
    expect(liveClientCountForTest()).toBe(0)
    expect(livePrincipalCountForTest()).toBe(0)
  })

  it('aborts the upstream subscription and clears its poll timer during shutdown', async () => {
    const originalFetch = globalThis.fetch
    let started!: () => void
    const fetchStarted = new Promise<void>(resolve => { started = resolve })
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      started()
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true })
      })
    }) as typeof fetch

    try {
      subscribeToOpenCodeEvents({ session: { list: async () => ({ data: [] }) } } as any)
      await fetchStarted
      expect(liveSubscriptionStateForTest()).toEqual({ subscribed: true, polling: true })

      await stopLiveEvents()

      expect(liveSubscriptionStateForTest()).toEqual({ subscribed: false, polling: false })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('keeps fallback session polling single-flight and aborts an in-flight poll during shutdown', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    let pollCalls = 0
    let pollSignal: AbortSignal | undefined
    let releasePoll: (() => void) | undefined
    let stopping: Promise<void> | undefined
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true })
      })
    }) as typeof fetch
    const client = {
      session: {
        list: (options?: { signal?: AbortSignal }) => {
          pollCalls++
          pollSignal = options?.signal
          return new Promise(resolve => {
            releasePoll = () => resolve({ data: [] })
          })
        },
      },
    }

    try {
      addLiveClient('poll-observer', Object.assign(new EventEmitter(), fakeSseResponse(0)))
      subscribeToOpenCodeEvents(client as any)

      await vi.advanceTimersByTimeAsync(14_999)
      expect(pollCalls).toBe(1)
      expect(pollSignal?.aborted).toBe(false)

      stopping = stopLiveEvents()
      const stoppedBeforeDeadline = Promise.race([
        stopping.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1)),
      ])
      await vi.advanceTimersByTimeAsync(1)
      expect(pollSignal?.aborted).toBe(true)
      expect(await stoppedBeforeDeadline).toBe(true)
      expect(liveSubscriptionStateForTest()).toEqual({ subscribed: false, polling: false })
    } finally {
      releasePoll?.()
      await stopping
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('redacts configured secrets and token-shaped text from fallback session updates', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    const originalReadToken = process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
    const configuredSecret = ['fallback', 'configured', 'read', 'credential'].join('-')
    const titleToken = ['fallback', 'title', 'token'].join('-')
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true })
      })
    }) as typeof fetch
    process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = configuredSecret
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0))
    const client = {
      session: {
        list: async () => ({
          data: [{
            id: 'ses_poll_redaction',
            title: `GW: deploy ${configuredSecret} token=${titleToken}`,
            cost: 0,
            tokens: {},
            time: { updated: 1 },
          }],
        }),
      },
    }

    try {
      addLiveClient('poll-redaction-observer', response)
      subscribeToOpenCodeEvents(client as any)

      await vi.advanceTimersByTimeAsync(5_000)
      await flushPromises()

      const streamed = response.writes.join('')
      expect(streamed).toContain('ses_poll_redaction')
      expect(streamed).not.toContain(configuredSecret)
      expect(streamed).not.toContain(titleToken)
      expect(streamed).toContain('token=<redacted>')
    } finally {
      await stopLiveEvents()
      if (originalReadToken === undefined) delete process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
      else process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = originalReadToken
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('deadlines a hung fallback poll before admitting the next interval', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    const pollSignals: AbortSignal[] = []
    const releasePolls: Array<() => void> = []
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true })
      })
    }) as typeof fetch
    const client = {
      session: {
        list: (options?: { signal?: AbortSignal }) => {
          if (!options?.signal) throw new Error('fallback poll must carry a cancellation signal')
          pollSignals.push(options.signal)
          return new Promise(resolve => {
            releasePolls.push(() => resolve({ data: [] }))
          })
        },
      },
    }

    try {
      addLiveClient('poll-deadline-observer', Object.assign(new EventEmitter(), fakeSseResponse(0)))
      subscribeToOpenCodeEvents(client as any)

      await vi.advanceTimersByTimeAsync(15_000)
      expect(pollSignals).toHaveLength(1)
      expect(pollSignals[0]?.aborted).toBe(true)

      await vi.advanceTimersByTimeAsync(5_000)
      expect(pollSignals).toHaveLength(2)
    } finally {
      await stopLiveEvents()
      for (const release of releasePolls) release()
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('cancels a rejected upstream response body before bounded reconnect backoff', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    let calls = 0
    let cancelled = false
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('private rejected response'))
          },
          cancel() {
            cancelled = true
          },
        })
        return Promise.resolve(new Response(body, { status: 503 }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true })
      })
    }) as typeof fetch

    try {
      subscribeToOpenCodeEvents({ session: { list: async () => ({ data: [] }) } } as any)
      await flushPromises()

      expect(cancelled).toBe(true)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
    } finally {
      await stopLiveEvents()
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('backs off after a clean upstream EOF instead of reconnecting in a hot loop', async () => {
    vi.useFakeTimers()
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
      calls++
      if (calls === 1) {
        return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }), { status: 200 }))
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason || new Error('aborted')), { once: true })
      })
    }) as typeof fetch

    try {
      subscribeToOpenCodeEvents({ session: { list: async () => ({ data: [] }) } } as any)
      await flushPromises()

      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(2_999)
      expect(calls).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
    } finally {
      await stopLiveEvents()
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('disconnects SSE clients whose socket buffer exceeds the backpressure cap', () => {
    const healthy = fakeSseResponse(0)
    const stalled = fakeSseResponse(2_000_000)
    addLiveClient('healthy', healthy)
    addLiveClient('stalled', stalled)
    healthy.writes.length = 0
    stalled.writes.length = 0

    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_1' })
    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_2' })

    expect(healthy.writes).toHaveLength(2)
    expect(stalled.writes).toHaveLength(0)
    expect(stalled.destroyed).toBe(true)

    // The stalled client was removed, so later broadcasts skip it entirely.
    stalled.writableLength = 0
    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_3' })
    expect(stalled.writes).toHaveLength(0)
    expect(healthy.writes).toHaveLength(3)
  })

  it('queues broadcasts in order while a client is backpressured and flushes them on drain', () => {
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0))
    addLiveClient('ordered-slow-client', response)
    response.writes.length = 0
    response.writeResult = false

    const events = [
      { type: 'session_update', id: 'ses_ordered_1' },
      { type: 'session_update', id: 'ses_ordered_2' },
      { type: 'session_update', id: 'ses_ordered_3' },
    ]
    for (const event of events) broadcastLiveEventForTest(event)

    expect(response.writes).toEqual([
      `data: ${JSON.stringify(events[0])}\n\n`,
    ])

    response.writeResult = true
    response.emit('drain')

    expect(response.writes).toEqual(events.map(event => `data: ${JSON.stringify(event)}\n\n`))
    expect(liveClientCountForTest()).toBe(1)
  })

  it('preserves every bounded replay snapshot when the connected frame applies backpressure', () => {
    primeSessionUpdatePayloadForTest('replay-ordered-1', { type: 'session_update', id: 'replay-ordered-1' })
    primeSessionUpdatePayloadForTest('replay-ordered-2', { type: 'session_update', id: 'replay-ordered-2' })
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0))
    response.writeResult = false

    addLiveClient('backpressured-replay-client', response)
    expect(response.writes).toHaveLength(1)
    expect(response.writes[0]).toContain('"type":"connected"')

    response.writeResult = true
    response.emit('drain')

    expect(response.writes.slice(1)).toEqual([
      'data: ' + JSON.stringify({ type: 'session_update', id: 'replay-ordered-1' }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'session_update', id: 'replay-ordered-2' }) + '\n\n',
    ])
  })

  it('closes a backpressured client before its ordered queue can exceed the byte cap', () => {
    const response = Object.assign(new EventEmitter(), fakeSseResponse(0))
    const first = { type: 'session_update', id: 'bounded-queue-1' }
    const second = { type: 'session_update', id: 'bounded-queue-2' }
    const firstFrame = `data: ${JSON.stringify(first)}\n\n`
    const secondFrame = `data: ${JSON.stringify(second)}\n\n`
    addLiveClient('bounded-slow-client', response, undefined, undefined, {
      limits: { maxBufferedBytes: Buffer.byteLength(firstFrame) + Buffer.byteLength(secondFrame) - 1 },
    })
    response.writes.length = 0
    response.writeResult = false

    broadcastLiveEventForTest(first)
    broadcastLiveEventForTest(second)

    expect(response.writes).toEqual([firstFrame])
    expect(response.destroyed).toBe(true)
    expect(liveClientCountForTest()).toBe(0)
  })

  it('replays cached session snapshots to a newly connected client', () => {
    primeSessionUpdatePayloadForTest('ses_1', { type: 'session_update', id: 'ses_1' })
    primeSessionUpdatePayloadForTest('ses_2', { type: 'session_update', id: 'ses_2' })

    const fresh = fakeSseResponse(0)
    addLiveClient('fresh', fresh)

    expect(fresh.writes[0]).toContain('"type":"connected"')
    expect(fresh.writes.slice(1)).toEqual([
      'data: ' + JSON.stringify({ type: 'session_update', id: 'ses_1' }) + '\n\n',
      'data: ' + JSON.stringify({ type: 'session_update', id: 'ses_2' }) + '\n\n',
    ])
  })

  it('drops oversized replay payloads without retaining or exposing their contents', () => {
    const oversizedTitle = `private-${'x'.repeat(70 * 1024)}`
    primeSessionUpdatePayloadForTest('oversized-session', {
      type: 'session_update',
      id: 'oversized-session',
      title: oversizedTitle,
    })

    const fresh = fakeSseResponse(0)
    addLiveClient('oversized-replay-client', fresh)

    expect(liveSessionSnapshotCountForTest()).toBe(1)
    expect(fresh.writes).toHaveLength(1)
    const metrics = renderPrometheusMetrics()
    expect(metrics).toContain('gateway_live_sse_replay_dropped_total{reason="payload_limit"} 1')
    expect(metrics).not.toContain(oversizedTitle)
  })

  it('accounts a fixed-size identity for an oversized replay tombstone without exposing the raw session id', () => {
    const privatePrefix = 'private-oversized-session-identity-'
    const oversizedId = `${privatePrefix}${'x'.repeat(70 * 1024)}`
    primeSessionUpdatePayloadForTest(oversizedId, {
      type: 'session_update',
      id: oversizedId,
    })

    const fresh = fakeSseResponse(0)
    addLiveClient('oversized-identity-replay-client', fresh)

    const metrics = renderPrometheusMetrics()
    const replayBytes = Number(metrics.match(/^gateway_live_sse_replay_bytes (\d+)$/m)?.[1])
    expect(liveSessionSnapshotCountForTest()).toBe(1)
    expect(replayBytes).toBe(64)
    expect(metrics).not.toContain(privatePrefix)
    expect(fresh.writes).toHaveLength(1)
    expect(fresh.writes.join('')).not.toContain(privatePrefix)
  })

  it('bounds huge session-id tombstones by aggregate bytes during replay-cache churn', () => {
    const limits = {
      maxSnapshots: 100,
      maxPayloadBytes: 1024,
      maxTotalBytes: 1024,
    }
    const privatePrefix = 'private-tombstone-churn-'
    for (let index = 0; index < limits.maxSnapshots; index++) {
      const oversizedId = `${privatePrefix}${index}-${'x'.repeat(2 * 1024)}`
      primeSessionUpdatePayloadForTest(oversizedId, {
        type: 'session_update',
        id: oversizedId,
      }, limits)
    }

    const fresh = fakeSseResponse(0)
    addLiveClient('tombstone-churn-replay-client', fresh, undefined, undefined, {
      limits: { replay: limits },
    })

    const metrics = renderPrometheusMetrics()
    expect(liveSessionSnapshotCountForTest()).toBe(16)
    expect(metrics).toContain('gateway_live_sse_replay_bytes 1024')
    expect(metrics).toContain('gateway_live_sse_replay_dropped_total{reason="total_bytes_limit"}')
    expect(metrics).not.toContain(privatePrefix)
    expect(fresh.writes).toHaveLength(1)
    expect(fresh.writes.join('')).not.toContain(privatePrefix)
  })

  it('bounds aggregate replay payload bytes while retaining a stable session identity set', () => {
    for (let index = 0; index < 80; index++) {
      primeSessionUpdatePayloadForTest(`aggregate-${index}`, {
        type: 'session_update',
        id: `aggregate-${index}`,
        title: 'x'.repeat(60 * 1024),
      })
    }

    const fresh = fakeSseResponse(0)
    addLiveClient('aggregate-replay-client', fresh)
    const replayPayloadBytes = fresh.writes.slice(1).reduce((total, frame) => {
      return total + Buffer.byteLength(frame.slice('data: '.length, -2))
    }, 0)

    expect(liveSessionSnapshotCountForTest()).toBe(80)
    expect(replayPayloadBytes).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(fresh.writes.length).toBeGreaterThan(1)
    expect(renderPrometheusMetrics()).toContain('gateway_live_sse_replay_dropped_total{reason="total_bytes_limit"}')
  })

  it('ends every open SSE response during graceful shutdown', () => {
    const ended: string[] = []
    const response = {
      writableLength: 0,
      writeHead: () => {},
      write: () => true,
      end: (data: string) => { ended.push(data) },
    }
    addLiveClient('shutdown-client', response)
    expect(liveClientCountForTest()).toBe(1)

    closeAllLiveClients()

    expect(liveClientCountForTest()).toBe(0)
    expect(ended[0]).toContain('event: shutdown')
  })

  function fakeSseResponse(writableLength: number) {
    const res = {
      writableLength,
      destroyed: false,
      writes: [] as string[],
      ended: [] as string[],
      status: undefined as number | undefined,
      headers: {} as Record<string, string>,
      writeResult: true,
      writeHead(this: any, status: number, headers: Record<string, string>) {
        this.status = status
        this.headers = headers
      },
      write(this: any, data: string) { this.writes.push(data); return this.writeResult },
      destroy(this: any) { this.destroyed = true },
      end(this: any, data: string) { this.ended.push(data) },
    }
    return res
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
})
