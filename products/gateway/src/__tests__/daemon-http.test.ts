import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHmac } from 'node:crypto'
import { createDaemonHttpServer } from '../daemon.js'
import { whatsappChannel } from '../channels/whatsapp.js'
import { TransientInboundError, resetExposedHttpGuardsForTest } from '../security.js'
import { createJsonRoutes } from '../daemon-routes/index.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearWorkStateForTest, loadWorkState } from '../work-store.js'
import { clearCurrentDaemonLeadershipForTest } from '../daemon-leadership.js'
import { clearMissionDataCacheForTest } from '../mission-data.js'
import { broadcastLiveEventForTest, clearLiveClientsForTest, liveClientCountForTest } from '../live.js'

/**
 * Boots the ACTUAL daemon HTTP server (the handler daemon.ts serves in
 * production, via createDaemonHttpServer) on an ephemeral port and drives it
 * with real fetch() calls: security-before-dispatch ordering, the exact 403
 * denial body, CORS origin reflection, OPTIONS, SSE at /live/events, and an
 * authorized route end-to-end against the real SQLite store. The OpenCode
 * upstream is a stub client object, matching how route tests fake the SDK;
 * nothing here needs a live OpenCode server or port 4096/4097.
 */
describe.sequential('daemon HTTP server integration', () => {
  // Stub OpenCode SDK client: only the surface routes may touch on these paths.
  const fakeOpenCodeClient = { session: { list: async () => ({ data: [] }) } }
  let server: http.Server
  let port = 0
  let baseUrl = ''
  let testDir = ''

  beforeAll(async () => {
    server = createDaemonHttpServer({
      client: fakeOpenCodeClient,
      channels: new Map(),
      routes: createJsonRoutes(),
      resolvePort: () => port,
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    port = (server.address() as AddressInfo).port
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-daemon-http-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearMissionDataCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearCurrentDaemonLeadershipForTest()
    clearLiveClientsForTest()
    resetExposedHttpGuardsForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    clearLiveClientsForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('denies an unauthorized request with the security 403 before any route dispatch', async () => {
    const response = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'must never be created' }),
    })

    expect(response.status).toBe(403)
    expect(response.headers.get('content-type')).toBe('application/json')
    // Exact denial body the security layer writes: { error, requiredCapability }.
    const body = await response.json() as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['error', 'requiredCapability'])
    expect(body['requiredCapability']).toBe('operator')
    expect(String(body['error'])).toMatch(/denied/)
    // The 403 path never sets CORS headers, so the hostile origin is not reflected.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    // Security ran before dispatch: the route handler never created the task.
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks).toHaveLength(0)
  })

  it('reflects an allowed local origin and falls back to the daemon origin otherwise', async () => {
    const reflected = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://localhost:5173' } })
    expect(reflected.status).toBe(200)
    expect(reflected.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')

    const fallback = await fetch(`${baseUrl}/health`)
    expect(fallback.status).toBe(200)
    expect(fallback.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${port}`)
  })

  it('never reflects a non-local origin, even for an authenticated non-local actor; local origins are reflected', async () => {
    updateConfig({ security: { allowNonLocalHttp: true } } as any)
    process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = 'daemon-http-test-read-token'

    const denied = await fetch(`${baseUrl}/health`, { headers: { Origin: 'http://dashboard.example' } })
    expect(denied.status).toBe(403)
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()

    // Hardened: an authenticated non-local actor is served, but its arbitrary
    // remote Origin is never echoed back — it gets the canonical loopback value,
    // so a remote browser page cannot read the response cross-origin.
    const allowed = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://dashboard.example', Authorization: 'Bearer daemon-http-test-read-token' },
    })
    expect(allowed.status).toBe(200)
    expect(allowed.headers.get('access-control-allow-origin')).toBe(`http://127.0.0.1:${port}`)

    // A local origin (the same-origin dashboard) is still reflected.
    const localOrigin = `http://127.0.0.1:${port}`
    const localReflected = await fetch(`${baseUrl}/health`, {
      headers: { Origin: localOrigin, Authorization: 'Bearer daemon-http-test-read-token' },
    })
    expect(localReflected.status).toBe(200)
    expect(localReflected.headers.get('access-control-allow-origin')).toBe(localOrigin)
  })

  it('SEC1: brute-forcing exposed-mode auth trips the lockout with a 429 and Retry-After', async () => {
    updateConfig({ security: { allowNonLocalHttp: true, exposedHttp: { authLockout: { maxConsecutiveFailures: 3 } } } } as any)
    process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = 'daemon-http-valid-read-token'
    resetExposedHttpGuardsForTest()

    // Three wrong-token attempts are denied 403 (auth failure), not rate limited.
    for (let i = 0; i < 3; i++) {
      const denied = await fetch(`${baseUrl}/gateway/health`, { headers: { Origin: 'http://dashboard.example', Authorization: 'Bearer wrong-token-value' } })
      expect(denied.status).toBe(403)
    }
    // The next attempt is locked out with a 429 + Retry-After, before the security decision.
    const locked = await fetch(`${baseUrl}/gateway/health`, { headers: { Origin: 'http://dashboard.example', Authorization: 'Bearer wrong-token-value' } })
    expect(locked.status).toBe(429)
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await locked.json() as any).error).toMatch(/locked_out/)

    // The bad credential's lockout is isolated: a valid credential sharing the
    // same proxy/NAT address remains usable.
    const valid = await fetch(`${baseUrl}/gateway/health`, {
      headers: { Origin: 'http://dashboard.example', Authorization: 'Bearer daemon-http-valid-read-token' },
    })
    expect(valid.status).toBe(200)
  })

  it('SEC3: capability-scoped loopback keeps local reads open but requires a token for local writes', async () => {
    updateConfig({ security: { capabilityScopedLoopback: true } } as any)
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'Xk7pQ2rL9wMv3ZtB6nD4hJ8sF1aY0cG'
    try {
      const read = await fetch(`${baseUrl}/gateway/health`)
      expect(read.status).toBe(200)

      const denied = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'denied local write' }),
      })
      expect(denied.status).toBe(403)
      expect(String((await denied.json() as any).error)).toMatch(/capability-scoped bearer token/)

      const allowed = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer Xk7pQ2rL9wMv3ZtB6nD4hJ8sF1aY0cG' },
        body: JSON.stringify({ title: 'allowed local write' }),
      })
      expect(allowed.status).toBe(200)
    } finally {
      delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    }
  })

  it('answers OPTIONS preflight after the security gate', async () => {
    const response = await fetch(`${baseUrl}/tasks`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(response.headers.get('access-control-allow-headers')).toContain('Authorization')
    expect(response.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('serves an authorized route end-to-end against the real store', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'daemon-http-test-operator-token'
    const created = await fetch(`${baseUrl}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer daemon-http-test-operator-token' },
      body: JSON.stringify({ title: 'Integration task' }),
    })
    expect(created.status).toBe(200)
    expect((await created.json() as any).task).toMatchObject({ title: 'Integration task', status: 'pending' })

    const health = await fetch(`${baseUrl}/gateway/health`)
    expect(health.status).toBe(200)
    expect((await health.json() as any).counts).toMatchObject({ pending: 1, running: 0 })

    const missing = await fetch(`${baseUrl}/definitely-not-a-route`)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not found' })
  })

  it('returns 503 for a transiently failed WhatsApp webhook so Meta retries, then 200 once recovered', async () => {
    process.env['WHATSAPP_APP_SECRET'] = 'daemon-http-whatsapp-app-secret'
    try {
      clearConfigCacheForTest()
      updateConfig({ security: { channelAllowlists: { whatsapp: [{ chatId: 'wa-fixture-target' }], telegram: [], discord: [] } } } as any)
      const handled: string[] = []
      let attempts = 0
      whatsappChannel.onMessage(async msg => {
        attempts++
        if (attempts === 1) throw new TransientInboundError('bound channel session check failed transiently')
        handled.push(msg.text)
      })
      const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [
        { from: 'wa-fixture-target', type: 'text', text: { body: 'retry me after the outage' } },
      ] } }] }] })
      const signature = 'sha256=' + createHmac('sha256', 'daemon-http-whatsapp-app-secret').update(body).digest('hex')
      const post = () => fetch(`${baseUrl}/webhooks/whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': signature },
        body,
      })

      const deferred = await post()
      expect(deferred.status).toBe(503)
      expect(await deferred.json()).toEqual({ error: 'transient inbound failure; retry delivery' })
      expect(handled).toEqual([])

      // Meta retries the delivery; once the outage clears it is acknowledged.
      const retried = await post()
      expect(retried.status).toBe(200)
      expect(await retried.json()).toEqual({ ok: true, messages: 1 })
      expect(handled).toEqual(['retry me after the outage'])
    } finally {
      delete process.env['WHATSAPP_APP_SECRET']
      whatsappChannel.onMessage(async () => {})
    }
  })

  it('streams /live/events over SSE and cleans up when the client disconnects', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = 'daemon-http-test-admin-token'
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}/live/events`, {
      headers: { Accept: 'text/event-stream', Authorization: 'Bearer daemon-http-test-admin-token' },
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const readFrame = async (deadlineMs: number): Promise<string> => {
      const deadline = Date.now() + deadlineMs
      while (!buffer.includes('\n\n')) {
        if (Date.now() > deadline) throw new Error('timed out waiting for an SSE frame')
        const { done, value } = await reader.read()
        if (done) throw new Error('SSE stream ended before a frame arrived')
        buffer += decoder.decode(value, { stream: true })
      }
      const index = buffer.indexOf('\n\n')
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      return frame
    }

    const connected = await readFrame(5000)
    expect(connected).toContain('"type":"connected"')
    expect(liveClientCountForTest()).toBe(1)

    broadcastLiveEventForTest({ type: 'session_update', id: 'ses_live_http', title: 'Live integration', updated: Date.now() })
    const eventFrame = await readFrame(5000)
    expect(eventFrame).toContain('"id":"ses_live_http"')

    // Client disconnect must unregister the SSE client (no leaked handle).
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    const deadline = Date.now() + 5000
    while (liveClientCountForTest() > 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(liveClientCountForTest()).toBe(0)
  })
})
