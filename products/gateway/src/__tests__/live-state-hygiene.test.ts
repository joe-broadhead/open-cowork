import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createJsonRoutes } from '../daemon-routes/index.js'
import { dispatchRoute } from '../daemon-router.js'
import { applyLiveStateHygieneReset, buildLiveStateHygieneReport, formatLiveStateHygieneText } from '../live-state-hygiene.js'
import { clearChannelSessionsForTest, setChannelSession } from '../channel-sessions.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import {
  appendWorkEvent,
  clearWorkStateForTest,
  createChannelClaimCodeRecord,
  createHumanGate,
  createWorkTask,
  listChannelClaimCodes,
  listHumanGates,
  listWorkEventsReadOnly,
} from '../work-store.js'

describe.sequential('live-state hygiene', () => {
  let testDir: string
  let store: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-live-hygiene-'))
    store = path.join(testDir, 'gateway.db')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    clearChannelSessionsForTest(store)
    updateConfig({
      humanLoop: { enabled: true, defaultTimeoutMs: 60_000, timeoutAction: 'block' },
      channels: { telegram: { botToken: '123456:telegram-secret-token' } },
    } as any)
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return jsonResponse({ status: 'ok' })
      if (url.endsWith('/question') || url.endsWith('/permission')) return jsonResponse([])
      return jsonResponse({}, 404)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
    try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('reports stale live-state signals without leaking channel targets or session IDs', async () => {
    const now = new Date('2026-06-26T12:00:00.000Z')
    createChannelClaimCodeRecord({
      id: 'claim_private_expired',
      provider: 'telegram',
      action: 'trust_target',
      codeHash: 'a'.repeat(64),
      codeFingerprint: 'secretfp1234',
      expiresAt: '2026-06-26T11:55:00.000Z',
    }, store)
    const task = createWorkTask({ title: 'Private support task', pipeline: ['verify'] }, store)
    createHumanGate({
      type: 'manual',
      taskId: task.id,
      reason: 'operator private text token=secret',
      requestedBy: 'test',
      expiresAt: '2026-06-26T11:50:00.000Z',
      timeoutAction: 'block',
      scopeKey: 'manual:private-hygiene',
      details: {},
    }, store)
    setChannelSession('telegram', 'private-chat-123456', 'ses_private_missing', { threadId: 'private-topic' }, store)
    appendWorkEvent('delegation.progress.suppressed', 'private-idempotency-key', {
      dedupeKey: 'private-idempotency-key:completed',
      idempotencyKey: 'private-idempotency-key',
      progress: 'completed',
      progressKey: 'private-idempotency-key:completed',
      delivery: 'deferred',
      reason: 'session client unavailable',
      provider: 'telegram',
      sessionId: 'ses_parent_private',
    }, store)

    const report = await buildLiveStateHygieneReport({ session: { list: async () => ({ data: [{ id: 'ses_visible' }] }) } }, { now })
    const serialized = JSON.stringify(report)
    const text = formatLiveStateHygieneText(report)

    expect(report.status).toBe('attention')
    expect(report.counts).toMatchObject({
      expired_claim_code: 1,
      stale_human_gate: 1,
      stale_session_link: 1,
      stale_parent_receipt: 1,
    })
    expect(report.resettable).toMatchObject({ expiredClaimCodes: 1, expiredHumanGates: 1, total: 2 })
    expect(text).toContain('opencode-gateway operator reset-stale')
    expect(serialized).not.toContain('private-chat-123456')
    expect(serialized).not.toContain('private-topic')
    expect(serialized).not.toContain('ses_private_missing')
    expect(serialized).not.toContain('ses_parent_private')
    expect(serialized).not.toContain('telegram-secret-token')
    expect(serialized).not.toContain('token=secret')
  })

  it('resets only expired claim codes and expired human gates', async () => {
    const now = new Date('2026-06-26T12:00:00.000Z')
    const task = createWorkTask({ title: 'Gate timeout task', pipeline: ['verify'] }, store)
    const gate = createHumanGate({
      type: 'manual',
      taskId: task.id,
      reason: 'operator approval',
      requestedBy: 'test',
      expiresAt: '2026-06-26T11:50:00.000Z',
      timeoutAction: 'block',
      scopeKey: 'manual:timeout',
      details: {},
    }, store)
    createChannelClaimCodeRecord({
      id: 'claim_reset_expired',
      provider: 'telegram',
      action: 'trust_target',
      codeHash: 'b'.repeat(64),
      codeFingerprint: 'resetfp12345',
      expiresAt: '2026-06-26T11:55:00.000Z',
    }, store)
    createChannelClaimCodeRecord({
      id: 'claim_reset_fresh',
      provider: 'telegram',
      action: 'trust_target',
      codeHash: 'c'.repeat(64),
      codeFingerprint: 'freshfp12345',
      expiresAt: '2026-06-26T12:30:00.000Z',
    }, store)

    const result = await applyLiveStateHygieneReset(undefined, { now })
    const claims = listChannelClaimCodes({}, store)
    const gates = listHumanGates({}, store)
    const events = listWorkEventsReadOnly(100, store).map(event => event.type)

    expect(result.applied).toBe(true)
    expect(result.expiredClaimCodes).toEqual(['claim:telegram:trust_target:resetfp12345'])
    expect(result.processedHumanGates).toHaveLength(1)
    expect(claims.find(claim => claim.id === 'claim_reset_expired')).toMatchObject({ status: 'expired', denialReason: 'live_state_hygiene_expired' })
    expect(claims.find(claim => claim.id === 'claim_reset_fresh')).toMatchObject({ status: 'pending' })
    expect(gates.find(row => row.id === gate.id)).toMatchObject({ status: 'timed_out' })
    expect(events).toContain('live_state_hygiene.reset')
  })

  it('exposes read-only hygiene and reset-stale through operator daemon routes', async () => {
    createChannelClaimCodeRecord({
      id: 'claim_route_expired',
      provider: 'telegram',
      action: 'trust_target',
      codeHash: 'd'.repeat(64),
      codeFingerprint: 'routefp12345',
      expiresAt: '2026-06-26T11:55:00.000Z',
    }, store)
    const routes = createJsonRoutes()

    const hygiene = await dispatchRoute(routes, context('GET', '/operator/hygiene'))
    expect(hygiene?.status).toBe(200)
    expect((hygiene?.body as any).hygiene.resettable.expiredClaimCodes).toBe(1)

    const reset = await dispatchRoute(routes, context('POST', '/operator/actions', { action: 'reset-stale' }))
    expect(reset?.status).toBe(200)
    expect((reset?.body as any).operatorAction.action).toBe('reset-stale')
    expect((reset?.body as any).operatorAction.result.hygiene.resettable.expiredClaimCodes).toBe(0)
  })
})

function context(method: string, pathname: string, body?: unknown): any {
  return {
    req: {
      method,
      url: pathname,
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
      on(event: string, callback: (...args: any[]) => void) {
        if (event === 'data' && body !== undefined) callback(Buffer.from(JSON.stringify(body)))
        if (event === 'end') callback()
        return this
      },
      removeAllListeners() { return this },
      resume() { return this },
    },
    url: new URL(`http://127.0.0.1${pathname}`),
    client: { session: { list: async () => ({ data: [] }) } },
    channels: new Map(),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
