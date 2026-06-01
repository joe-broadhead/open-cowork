import test from 'node:test'
import assert from 'node:assert/strict'
import { createGatewayWorkspaceAdapter } from '../apps/desktop/src/main/gateway-workspace-adapter.ts'
import type { GatewayWorkspaceConnectionRecord } from '../apps/desktop/src/main/gateway-workspace-registry.ts'

function connection(): GatewayWorkspaceConnectionRecord {
  return {
    id: 'gateway:test',
    baseUrl: 'https://gateway.example.test/',
    label: 'Gateway',
    lastSyncedAt: null,
    createdAt: '2026-05-27T10:00:00.000Z',
    updatedAt: '2026-05-27T10:00:00.000Z',
  }
}

test('gateway workspace adapter sends bearer auth and checks health and readiness', async () => {
  const calls: Array<{ url: string; authorization: string | null }> = []
  const adapter = createGatewayWorkspaceAdapter(connection(), 'gateway-token', {
    fetch: (async (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
      })
      const payload = String(url).endsWith('/health')
        ? { ok: true, productMode: 'standalone' }
        : { ok: true }
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })

  await adapter.sync()

  assert.deepEqual(calls, [
    {
      url: 'https://gateway.example.test/health',
      authorization: 'Bearer gateway-token',
    },
    {
      url: 'https://gateway.example.test/ready',
      authorization: 'Bearer gateway-token',
    },
  ])
})

test('gateway workspace adapter bounds hanging requests with a timeout', async () => {
  const adapter = createGatewayWorkspaceAdapter(connection(), null, {
    requestTimeoutMs: 100,
    fetch: (async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      throw new Error('unreachable')
    }) as typeof fetch,
  })

  const health = await adapter.health()

  assert.equal(health.ok, false)
  assert.match(health.error || '', /timed out/)
})

test('gateway workspace adapter does not reflect secret-bearing remote errors', async () => {
  const adapter = createGatewayWorkspaceAdapter(connection(), 'gateway-token', {
    fetch: (async (url) => {
      const payload = String(url).endsWith('/health')
        ? { ok: false, error: 'Authorization: Bearer gateway-token' }
        : { error: 'Authorization: Bearer gateway-token' }
      return new Response(JSON.stringify(payload), {
        status: String(url).endsWith('/health') ? 200 : 500,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch,
  })

  const health = await adapter.health()
  const readiness = await adapter.ready()

  assert.equal(health.ok, false)
  assert.equal(health.error, 'Gateway workspace reported unhealthy.')
  assert.equal(readiness.ok, false)
  assert.equal(readiness.error, 'Gateway workspace /ready returned HTTP 500')
  assert.doesNotMatch(`${health.error}\n${readiness.error}`, /gateway-token|Bearer|Authorization/i)
})
