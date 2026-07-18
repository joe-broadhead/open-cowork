import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Readable } from 'node:stream'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createJsonRoutes } from '../daemon-routes/index.js'
import { dispatchRoute } from '../daemon-router.js'
import { appendWorkEvent, clearWorkStateForTest, completeWorkTaskRun, createHumanGate, createRoadmap, createWorkTask, decideHumanGate, getDelegationReceipt, getHumanGate, journalTaskDispatchAcquisitionIntent, listHumanGates, listTaskDispatchAcquisitions, listWorkEvents, loadWorkState, reserveTaskDispatchStart, saveWorkState, startWorkTaskRun, upsertAlert, upsertChannelBinding, upsertProjectBinding } from '../work-store.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { createStorageBackup } from '../storage.js'
import type { EnvironmentRunRecord } from '../environments.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'
import { clearMissionDataCacheForTest } from '../mission-data.js'

describe.sequential('daemon JSON routes', () => {
  const routes = createJsonRoutes()
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-daemon-routes-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearMissionDataCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearCurrentDaemonLeadershipForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN']
    delete process.env['OPENCODE_CONFIG_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['WHATSAPP_ACCESS_TOKEN']
    delete process.env['WHATSAPP_PHONE_NUMBER_ID']
    delete process.env['WHATSAPP_VERIFY_TOKEN']
    delete process.env['WHATSAPP_APP_SECRET']
    delete process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED']
    delete process.env['DISCORD_BOT_TOKEN']
    delete process.env['DISCORD_PUBLIC_KEY']
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    try { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('dispatches health through explicit route modules', async () => {
    const response = await dispatchRoute(routes, context('GET', '/health'))

    expect(response?.status).toBe(200)
    expect(response?.body).toMatchObject({ status: 'ok' })
  })

  it('returns HTTP 503 when readiness is not_ready', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode unavailable'))
    try {
      const response = await dispatchRoute(routes, context('GET', '/readiness'))
      expect((response?.body as any).state).toBe('not_ready')
      expect(response?.status).toBe(503)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps GET /alerts read-only and evaluates alerts only on POST', async () => {
    upsertAlert({
      key: 'test:read-only-alert',
      severity: 'warning',
      source: 'test',
      summary: 'Read-only alert snapshot',
      evidence: [],
      nextAction: 'Inspect it.',
    })
    const dbPath = path.join(testDir, 'gateway.db')
    const before = fs.readFileSync(dbPath)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode unavailable'))
    try {
      const response = await dispatchRoute(routes, context('GET', '/alerts'))
      expect(response?.status).toBe(200)
      expect((response?.body as any).alerts).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'test:read-only-alert' }),
      ]))
      expect(fs.readFileSync(dbPath).equals(before)).toBe(true)

      const evaluated = await dispatchRoute(routes, context('POST', '/alerts/evaluate'))
      expect(evaluated?.status).toBe(200)
      expect((evaluated?.body as any).detected).toBeInstanceOf(Array)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects malformed percent-encoded paths with HTTP 400', async () => {
    await expect(dispatchRoute(routes, context('GET', '/tasks/%ZZ'))).rejects.toMatchObject({
      status: 400,
      message: 'malformed URL path encoding',
    })
  })

  it('validates persona creation as a client error instead of leaking a 500', async () => {
    await expect(dispatchRoute(routes, context('POST', '/personas', { name: 'Bad Persona' }))).rejects.toMatchObject({
      status: 400,
    })
  })

  it('rejects invalid message limits and forwards a valid bound upstream', async () => {
    const messages = vi.fn().mockResolvedValue({ data: Array.from({ length: 5 }, (_, index) => ({ id: `msg_${index}` })) })
    const valid = context('GET', '/opencode/sessions/ses_1/messages?limit=2')
    valid.client = { session: { messages } }
    const response = await dispatchRoute(routes, valid)

    expect(messages).toHaveBeenCalledWith({ path: { id: 'ses_1' }, query: { limit: 2 } })
    expect((response?.body as any).messages).toHaveLength(2)

    for (const limit of ['0', '201', '1.5', 'nope', '-1']) {
      const invalid = context('GET', `/opencode/sessions/ses_1/messages?limit=${encodeURIComponent(limit)}`)
      invalid.client = { session: { messages } }
      await expect(dispatchRoute(routes, invalid), limit).rejects.toMatchObject({ status: 400 })
    }
  })

  it('serves Prometheus metrics as a read surface with expected names and histograms', async () => {
    createWorkTask({ title: 'Metrics queue task' })

    const response = await dispatchRoute(routes, context('GET', '/metrics'))
    const body = response?.body as string

    expect(response?.status).toBe(200)
    expect(response?.contentType).toContain('text/plain')
    expect(typeof body).toBe('string')
    expect(body).toContain('# TYPE gateway_scheduler_cycles_total counter')
    expect(body).toContain('# TYPE gateway_queue_depth gauge')
    expect(body).toContain('# TYPE gateway_slo_latency_ms histogram')
    expect(body).toContain('gateway_process_resident_memory_bytes')
    // SLO histograms are fed from the durable snapshot, so buckets exist.
    expect(body).toMatch(/gateway_slo_latency_ms_bucket\{[^}]*le="\+Inf"\}/)
  })

  it('preserves legacy queue counts on gateway health while adding service counts', async () => {
    createWorkTask({ title: 'Queued health task' })

    const response = await dispatchRoute(routes, context('GET', '/gateway/health'))
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body.scheduler).toMatchObject({ enabled: expect.any(Boolean) })
    expect(body.counts).toMatchObject({ pending: 1, running: 0, blocked: 0 })
    expect(body.queueCounts).toEqual(body.counts)
    expect(body.serviceCounts).toMatchObject({ ok: expect.any(Number), degraded: expect.any(Number), down: expect.any(Number) })
    expect(body.counts.ok).toBeUndefined()
  })

  it('requires a matching human gate before applying destructive admin routes', async () => {
    const pending = await dispatchRoute(routes, context('PATCH', '/config', { httpPort: 4999 }))
    const gate = (pending?.body as any).gate

    expect(pending?.status).toBe(428)
    expect(gate).toMatchObject({ type: 'destructive_action', status: 'pending' })
    expect(getConfig().httpPort).not.toBe(4999)
    expect(listHumanGates({ status: 'open' })).toHaveLength(1)

    decideHumanGate(gate.id, { decision: 'approve', actor: 'operator', source: 'test' })
    const applied = await dispatchRoute(routes, context('PATCH', '/config', { httpPort: 4999, approvedGateId: gate.id }))

    expect(applied?.status).toBe(200)
    expect((applied?.body as any).config.httpPort).toBe(4999)
    expect(getConfig().httpPort).toBe(4999)
    expect(getHumanGate(gate.id)?.status).toBe('consumed')

    const replay = await dispatchRoute(routes, context('PATCH', '/config', { httpPort: 4999, approvedGateId: gate.id }))
    expect(replay?.status).toBe(428)
    expect((replay?.body as any).message).toContain('approved destructive-action gate')
  })

  it('does not trust caller-supplied actor headers as destructive approval identity', async () => {
    const request = context('PATCH', '/config', { httpPort: 4996 })
    request.req.headers['x-gateway-actor'] = 'prod-admin'

    const pending = await dispatchRoute(routes, request)
    const gate = (pending?.body as any).gate

    expect(pending?.status).toBe(428)
    expect(gate).toMatchObject({
      type: 'destructive_action',
      requestedBy: 'http',
      details: expect.objectContaining({ claimedActor: 'prod-admin' }),
    })
  })

  it('SEC2: task delete previews blast radius and requires a destructive gate before mutating', async () => {
    const task = createWorkTask({ title: 'Dry-run target task' })

    const preview = await dispatchRoute(routes, context('DELETE', `/tasks/${task.id}?dryRun=true`))
    expect(preview?.status).toBe(200)
    expect((preview?.body as any).preview).toMatchObject({ operation: 'task_delete', dryRun: true, mutates: false, found: true, taskId: task.id })
    // Nothing was deleted.
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks.map(t => t.id)).toContain(task.id)

    const pending = await dispatchRoute(routes, context('DELETE', `/tasks/${task.id}`))
    const gate = (pending?.body as any).gate
    expect(pending?.status).toBe(428)
    expect(gate).toMatchObject({ type: 'destructive_action', status: 'pending', requestedBy: 'http' })
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks.map(t => t.id)).toContain(task.id)

    decideHumanGate(gate.id, { decision: 'approve', actor: 'operator', source: 'test' })
    const deleted = await dispatchRoute(routes, context('DELETE', `/tasks/${task.id}`, { approvedGateId: gate.id }))
    expect(deleted?.status).toBe(200)
    expect(getHumanGate(gate.id)?.status).toBe('consumed')
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks.map(t => t.id)).not.toContain(task.id)
  })

  it('SEC2: dry-run roadmap delete and bulk update preview without mutating', async () => {
    const roadmap = createRoadmap({ title: 'Dry-run initiative' })
    const task = createWorkTask({ title: 'Child task', roadmapId: roadmap.id })

    const roadmapPreview = await dispatchRoute(routes, context('DELETE', `/roadmaps/${roadmap.id}?preview=true`))
    expect((roadmapPreview?.body as any).preview).toMatchObject({ operation: 'roadmap_delete', mutates: false, found: true, tasksDeleted: 1 })
    expect(loadWorkState(path.join(testDir, 'gateway.db')).roadmaps.map(r => r.id)).toContain(roadmap.id)
    const pendingDelete = await dispatchRoute(routes, context('DELETE', `/roadmaps/${roadmap.id}`))
    expect(pendingDelete?.status).toBe(428)
    expect((pendingDelete?.body as any).gate).toMatchObject({ type: 'destructive_action', status: 'pending' })
    expect(loadWorkState(path.join(testDir, 'gateway.db')).roadmaps.map(r => r.id)).toContain(roadmap.id)

    const bulkPreview = await dispatchRoute(routes, context('PATCH', '/tasks/bulk', { updates: [{ taskId: task.id, status: 'done' }], dryRun: true }))
    expect((bulkPreview?.body as any).preview).toMatchObject({ operation: 'task_bulk_update', mutates: false, matched: 1, missing: 0 })
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks.find(t => t.id === task.id)?.status).not.toBe('done')
  })

  it('validates common mutating route bodies before changing durable state', async () => {
    const before = loadWorkState(path.join(testDir, 'gateway.db'))
    await expect(dispatchRoute(routes, context('POST', '/tasks', { priority: 'HIGH' }))).rejects.toThrow(/title/)
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks).toHaveLength(before.tasks.length)

    const task = createWorkTask({ title: 'Validation target' })
    await expect(dispatchRoute(routes, context('POST', `/tasks/${encodeURIComponent(task.id)}/action`, { action: 'launch' }))).rejects.toThrow(/action/)
    expect(loadWorkState(path.join(testDir, 'gateway.db')).tasks.find(row => row.id === task.id)?.status).toBe('pending')

    await expect(dispatchRoute(routes, context('POST', '/scheduler', { action: 'warp' }))).rejects.toThrow(/action/)
    await expect(dispatchRoute(routes, context('POST', '/human-gates', { type: 'manual' }))).rejects.toThrow(/reason/)
  })

  it('SEC2: dry-run config update previews affected keys without writing', async () => {
    const preview = await dispatchRoute(routes, context('PATCH', '/config', { httpPort: 4998, dryRun: true }))
    expect(preview?.status).toBe(200)
    expect((preview?.body as any).preview).toMatchObject({ operation: 'config.update', mutates: false, affectedKeys: ['httpPort'] })
    expect(getConfig().httpPort).not.toBe(4998)
    // No human gate was created for a preview.
    expect(listHumanGates({ status: 'open' })).toHaveLength(0)
  })

  it('SEC2: an MCP-tier approval of a destructive gate is rejected while an operator approval succeeds when requireNonMcpDestructiveApproval is on', async () => {
    updateConfig({ security: { requireNonMcpDestructiveApproval: true } } as any)

    const pending = await dispatchRoute(routes, context('PATCH', '/config', { httpPort: 4997 }))
    const gate = (pending?.body as any).gate
    expect(gate).toMatchObject({ type: 'destructive_action' })

    // Agent self-approval through the MCP proxy trust tier is rejected even if
    // the JSON body claims to be an operator HTTP decision.
    const mcpRequest = context('POST', `/human-gates/${gate.id}/decision`, { decision: 'approve', source: 'http', actor: 'operator' })
    mcpRequest.req.headers['x-gateway-request-surface'] = 'mcp'
    mcpRequest.req.headers['x-gateway-actor'] = 'mcp'
    const mcpDenied = await dispatchRoute(routes, mcpRequest)
    expect(mcpDenied?.status).toBe(403)
    expect((mcpDenied?.body as any).error).toMatch(/non-MCP surface/)
    expect(getHumanGate(gate.id)?.status).toBe('pending')

    // The operator HTTP surface can still approve.
    const operatorApproved = await dispatchRoute(routes, context('POST', `/human-gates/${gate.id}/decision`, { decision: 'approve', source: 'http', actor: 'operator' }))
    expect(operatorApproved?.status).toBe(200)
    expect(getHumanGate(gate.id)?.status).toBe('approved')

    const applied = await dispatchRoute(routes, context('PATCH', '/config', { httpPort: 4997, approvedGateId: gate.id }))
    expect(applied?.status).toBe(200)
    expect(getConfig().httpPort).toBe(4997)
  })

  it('SEC2: MCP approval is rejected for every external-authority gate type but allowed for a procedural gate', async () => {
    updateConfig({ security: { requireNonMcpDestructiveApproval: true } } as any)

    const mcpDecision = (gateId: string) => {
      const c = context('POST', `/human-gates/${gateId}/decision`, { decision: 'approve', source: 'http', actor: 'operator' })
      c.req.headers['x-gateway-request-surface'] = 'mcp'
      c.req.headers['x-gateway-actor'] = 'mcp'
      return c
    }

    // Every gate type that authorizes an external effect is non-MCP-approvable.
    for (const type of ['external_side_effect', 'budget_exception', 'credential_use'] as const) {
      const gate = createHumanGate({ type, reason: `test ${type}` })
      const denied = await dispatchRoute(routes, mcpDecision(gate.id))
      expect(denied?.status).toBe(403)
      expect((denied?.body as any).error).toMatch(/non-MCP surface/)
      expect(getHumanGate(gate.id)?.status).toBe('pending')
    }

    // A procedural gate authorizes no external effect and stays MCP-approvable.
    const procedural = createHumanGate({ type: 'task_start', reason: 'proceed' })
    const approved = await dispatchRoute(routes, mcpDecision(procedural.id))
    expect(approved?.status).toBe(200)
    expect(getHumanGate(procedural.id)?.status).toBe('approved')
  })

  it('refuses mutating JSON routes while this daemon is standby and reports the writer fence', async () => {
    const dbPath = path.join(testDir, 'gateway.db')
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'writer-secret-daemon', instanceId: 'writer-secret-instance', leaseMs: 60_000 })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'standby-secret-daemon', instanceId: 'standby-secret-instance', leaseMs: 60_000 })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    const denied = await dispatchRoute(routes, context('POST', '/tasks', { title: 'must not be created' }))
    const listed = await dispatchRoute(routes, context('GET', '/tasks'))
    const events = listWorkEvents(20)

    expect(denied?.status).toBe(409)
    expect(denied?.body).toMatchObject({
      required: 'daemon_writer',
      leadership: expect.objectContaining({ mode: 'standby', canWrite: false }),
    })
    expect((listed?.body as any).tasks).toHaveLength(0)
    expect(events.some(event => event.type === 'audit.security' && event.payload['operation'] === 'daemon.mutation.denied')).toBe(true)
    const serialized = JSON.stringify(denied?.body)
    expect(serialized).not.toContain('writer-secret-instance')
    expect(serialized).not.toContain('standby-secret-instance')
  })

  it('lists and force-settles dispatch acquisitions for operator recovery', async () => {
    const task = createWorkTask({ title: 'stuck acquisition' })
    const receipt = reserveTaskDispatchStart({ taskId: task.id, stage: 'implement', leaseOwner: 'route-test' })!
    journalTaskDispatchAcquisitionIntent(receipt.id, { kind: 'session', provider: 'opencode', metadata: { directory: '/tmp/private-project' } })

    const listed = await dispatchRoute(routes, context('GET', '/dispatch-acquisitions?status=intent'))
    expect((listed?.body as any)).toMatchObject({
      counts: { total: 1, unsettled: 1 },
      acquisitions: [expect.objectContaining({ dispatchId: receipt.id, kind: 'session', status: 'intent' })],
    })

    const settled = await dispatchRoute(routes, context('POST', `/dispatch-acquisitions/${receipt.id}/session/settle`, { status: 'failed', reason: 'operator verified no remote session remains' }))
    expect(settled?.status).toBe(200)
    expect((settled?.body as any).acquisition).toMatchObject({ dispatchId: receipt.id, kind: 'session', status: 'failed' })
    expect(listTaskDispatchAcquisitions().find(row => row.dispatchId === receipt.id && row.kind === 'session')).toMatchObject({ status: 'failed', error: 'operator verified no remote session remains' })
  })

  it('exposes scoped HTTP auth posture through doctor without leaking token values', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode offline'))

    const response = await dispatchRoute(routes, { ...context('GET', '/doctor'), client: { session: { list: async () => ({ data: [] }) } } })
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body.security).toMatchObject({
      httpAuth: {
        configured: true,
        capabilities: ['operator'],
        routePolicy: 'capability-scoped',
      },
    })
    expect(JSON.stringify(body.security)).not.toContain('operator-secret-token')
  })

  it('exposes redacted channel connector diagnostics over HTTP', async () => {
    updateConfig({
      channels: {
        telegram: { botToken: '123456:telegram-secret-token-value' },
        whatsapp: {},
      },
      security: {
        channelAllowlists: { telegram: [{ chatId: 'private-chat-id' }], whatsapp: [] },
      },
    } as any)
    upsertChannelBinding({ provider: 'telegram', chatId: 'private-chat-id', sessionId: 'ses_private' })

    const response = await dispatchRoute(routes, context('GET', '/channels/connectors'))
    const body = response?.body as any
    const telegram = body.connectors.find((row: any) => row.provider === 'telegram')
    const whatsapp = body.connectors.find((row: any) => row.provider === 'whatsapp')

    expect(response?.status).toBe(200)
    expect(body.connectorRegistry.counts).toMatchObject({ credentials_needed: expect.any(Number) })
    expect(telegram).toMatchObject({ state: 'ready', bindingCount: 1, trusted: true, redacted: true })
    expect(whatsapp).toMatchObject({ state: 'credentials_needed', redacted: true })
    expect(whatsapp.missingPrerequisites).toEqual(expect.arrayContaining([
      expect.objectContaining({ env: 'WHATSAPP_ACCESS_TOKEN', configKey: 'channels.whatsapp.accessToken' }),
    ]))
    expect(whatsapp.callback.verifier).toMatchObject({
      provider: 'whatsapp',
      required: true,
      exposureMode: 'local_only',
      publicWebhookRoutesOnly: true,
      nonWebhookRoutesProtected: true,
      routes: [
        expect.objectContaining({ method: 'GET', path: '/webhooks/whatsapp', documentedPublicRoute: true }),
        expect.objectContaining({ method: 'POST', path: '/webhooks/whatsapp', documentedPublicRoute: true }),
      ],
    })
    expect(JSON.stringify(body)).not.toContain('telegram-secret-token-value')
    expect(JSON.stringify(body)).not.toContain('private-chat-id')
  })

  it('exposes the canonical channel action parity matrix with provider capabilities', async () => {
    const response = await dispatchRoute(routes, context('GET', '/channels/capabilities'))
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body.capabilities.map((row: any) => row.provider)).toEqual(expect.arrayContaining(['telegram', 'whatsapp', 'discord']))
    expect(body.nativeControlCoverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'telegram', typedCommand: 'supported', slash: 'supported', argumentAutocomplete: 'deferred', nativeAction: 'partial', presence: 'supported' }),
      expect.objectContaining({ provider: 'whatsapp', typedCommand: 'supported', slash: 'not_applicable', argumentAutocomplete: 'not_applicable', nativeAction: 'partial', presence: 'deferred' }),
      expect.objectContaining({ provider: 'discord', typedCommand: 'supported', slash: 'deferred', argumentAutocomplete: 'deferred', nativeAction: 'deferred', presence: 'deferred' }),
    ]))
    expect(body.operatorJourneys).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'channel:telegram:slash', channelCapability: 'supported', proofState: 'passed' }),
      expect.objectContaining({ id: 'channel:telegram:presence', channelCapability: 'supported', proofState: 'passed' }),
      expect.objectContaining({ id: 'channel:telegram:argument_autocomplete', channelCapability: 'deferred', proofState: 'deferred' }),
      expect.objectContaining({ id: 'channel:whatsapp:slash', channelCapability: 'fallback', proofState: 'partial' }),
      expect.objectContaining({ id: 'channel:whatsapp:argument_autocomplete', channelCapability: 'fallback', proofState: 'partial' }),
      expect.objectContaining({ id: 'channel:whatsapp:presence', channelCapability: 'deferred', proofState: 'deferred' }),
      expect.objectContaining({ id: 'channel:discord:slash', channelCapability: 'deferred', proofState: 'deferred' }),
    ]))
    expect(body.actionParity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'status.summary',
        command: '/status',
        surfaces: expect.objectContaining({ typedCommand: 'supported', telegramSlash: 'supported' }),
        safetyClass: 'read_only',
        nativeUi: expect.objectContaining({ fallbackCopy: '/status', slashCommand: 'status' }),
        providerControls: expect.objectContaining({
          telegram: expect.objectContaining({ slash: 'supported', argumentAutocomplete: 'not_applicable', presence: 'supported' }),
          whatsapp: expect.objectContaining({ slash: 'not_applicable', argumentAutocomplete: 'not_applicable', presence: 'deferred' }),
          discord: expect.objectContaining({ slash: 'deferred', argumentAutocomplete: 'deferred', presence: 'deferred' }),
        }),
        presence: expect.objectContaining({ status: 'supported', indicator: 'typing', masksBlockedState: false }),
      }),
      expect.objectContaining({
        id: 'permission.approve',
        command: '/approve',
        trust: 'trusted_privileged',
        safetyClass: 'human_decision',
      }),
    ]))
    expect(JSON.stringify(body.nativeControlCoverage)).not.toContain('private-chat-id')
    expect(JSON.stringify(body.actionParity)).not.toContain('private-chat-id')
    expect(JSON.stringify(body.operatorJourneys)).not.toContain('private-chat-id')
  })

  it('reports webhook verifier warnings without leaking secret setup values', async () => {
    updateConfig({
      security: {
        httpHost: '0.0.0.0',
        allowNonLocalHttp: true,
        publicWebhookMode: true,
        channelAllowlists: { telegram: [], whatsapp: [{ chatId: 'wa-private-target' }], discord: [] },
      },
      channels: {
        whatsapp: {
          accessToken: 'whatsapp-access-secret',
          phoneNumberId: '15551234567',
          verifyToken: 'verify-secret-token',
          appSecret: 'app-secret-value',
        },
      },
    } as any)

    const response = await dispatchRoute(routes, context('GET', '/channels/connectors?provider=whatsapp'))
    const body = response?.body as any
    const connector = body.connector

    expect(response?.status).toBe(200)
    expect(connector.callback.verifier).toMatchObject({
      state: 'warning',
      exposureMode: 'public_webhook_mode',
      publicWebhookMode: true,
      publicWebhookRoutesOnly: true,
      nonWebhookRoutesProtected: true,
      httpAuthConfigured: false,
    })
    expect(connector.callback.verifier.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'no_http_capability_tokens', severity: 'warning' }),
    ]))
    expect(JSON.stringify(body)).not.toContain('whatsapp-access-secret')
    expect(JSON.stringify(body)).not.toContain('15551234567')
    expect(JSON.stringify(body)).not.toContain('verify-secret-token')
    expect(JSON.stringify(body)).not.toContain('app-secret-value')
    expect(JSON.stringify(body)).not.toContain('wa-private-target')
  })

  it('blocks connector readiness when unsafe exposed HTTP would publish non-webhook routes', async () => {
    updateConfig({
      security: {
        httpHost: '0.0.0.0',
        allowNonLocalHttp: true,
        publicWebhookMode: true,
        unsafeAllowNoAuth: true,
        channelAllowlists: { telegram: [], whatsapp: [{ chatId: 'wa-private-target' }], discord: [] },
      },
      channels: {
        whatsapp: {
          accessToken: 'whatsapp-access-secret',
          phoneNumberId: '15551234567',
          verifyToken: 'verify-secret-token',
          appSecret: 'app-secret-value',
        },
      },
    } as any)

    const response = await dispatchRoute(routes, context('GET', '/channels/connectors?provider=whatsapp'))
    const connector = (response?.body as any).connector

    expect(connector.state).toBe('blocked')
    expect(connector.callback.verifier).toMatchObject({
      state: 'blocked',
      exposureMode: 'unsafe_public',
      publicWebhookRoutesOnly: true,
      nonWebhookRoutesProtected: false,
    })
    expect(connector.callback.verifier.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsafe_broad_exposure', severity: 'blocked' }),
    ]))
    expect(connector.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unsafe_route_exposure' }),
    ]))
    expect(JSON.stringify(response?.body)).not.toContain('whatsapp-access-secret')
    expect(JSON.stringify(response?.body)).not.toContain('15551234567')
  })

  it('blocks authenticated webhook mode when HTTP tokens cannot satisfy webhook capability', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = 'read-secret-token'
    updateConfig({
      security: {
        httpHost: '0.0.0.0',
        allowNonLocalHttp: true,
        publicWebhookMode: false,
        channelAllowlists: { telegram: [], whatsapp: [{ chatId: 'wa-private-target' }], discord: [] },
      },
      channels: {
        whatsapp: {
          accessToken: 'whatsapp-access-secret',
          phoneNumberId: '15551234567',
          verifyToken: 'verify-secret-token',
          appSecret: 'app-secret-value',
        },
      },
    } as any)

    const blocked = await dispatchRoute(routes, context('GET', '/channels/connectors?provider=whatsapp'))
    const connector = (blocked?.body as any).connector

    expect(connector.state).toBe('blocked')
    expect(connector.callback.verifier).toMatchObject({
      state: 'blocked',
      exposureMode: 'authenticated_reverse_proxy',
      httpAuthConfigured: true,
      httpWebhookAuthConfigured: false,
      httpAuthCapabilities: ['read'],
    })
    expect(connector.callback.verifier.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'webhook_http_token_missing', severity: 'blocked' }),
    ]))

    process.env['OPENCODE_GATEWAY_HTTP_WEBHOOK_TOKEN'] = 'webhook-secret-token'
    delete process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
    const ready = await dispatchRoute(routes, context('GET', '/channels/connectors?provider=whatsapp'))
    expect((ready?.body as any).connector.callback.verifier).toMatchObject({
      exposureMode: 'authenticated_reverse_proxy',
      httpAuthConfigured: true,
      httpWebhookAuthConfigured: true,
      httpAuthCapabilities: ['webhook'],
    })
    expect(JSON.stringify(ready?.body)).not.toContain('webhook-secret-token')
  })

  it('generates channel claim codes over HTTP and exposes only redacted connector evidence', async () => {
    const baseConfigDir = process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    const baseStateDir = process.env['OPENCODE_GATEWAY_STATE_DIR']
    const claimDir = path.join(testDir, 'claim-route')
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = claimDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = claimDir
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(claimDir, 'gateway.db'))
    try {
      updateConfig({
        channels: { telegram: { botToken: '123456:telegram-secret-token-value' } },
        security: { channelAllowlists: { telegram: [], whatsapp: [], discord: [] } },
      } as any)

      const created = await dispatchRoute(routes, context('POST', '/channels/claims', { provider: 'telegram', ttlSeconds: 120 }))
      const claimBody = created?.body as any
      const status = await dispatchRoute(routes, context('GET', '/channels/connectors?provider=telegram'))
      const connectorBody = status?.body as any

      expect(created?.status).toBe(201)
      expect(claimBody.code).toMatch(/^GW-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/)
      expect(claimBody.claim).toMatchObject({ provider: 'telegram', action: 'trust_target', status: 'pending' })
      expect(JSON.stringify(claimBody.claim)).not.toContain(claimBody.code)
      expect(connectorBody.connector.evidenceRefs).toEqual(expect.arrayContaining([
        expect.stringContaining('claim-code:telegram:trust_target:'),
      ]))
      expect(JSON.stringify(connectorBody)).not.toContain(claimBody.code)
      expect(JSON.stringify(connectorBody)).not.toContain('telegram-secret-token-value')
    } finally {
      process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = baseConfigDir
      process.env['OPENCODE_GATEWAY_STATE_DIR'] = baseStateDir
      clearConfigCacheForTest()
    }
  })

  it('returns the alpha health aggregate over HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode offline'))
    try {
      const response = await dispatchRoute(routes, context('GET', '/alpha-health'))
      const body = response?.body as any

      expect(response?.status).toBe(200)
      expect(body.alphaHealth).toMatchObject({
        status: expect.stringMatching(/blocked|not_proven|attention|healthy/),
        indicators: expect.arrayContaining([
          expect.objectContaining({ id: 'service_health' }),
          expect.objectContaining({ id: 'backup_restore' }),
        ]),
      })
      expect(body.alphaHealth.sources.map((source: any) => source.label)).toContain('Service health')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('exposes support observability contract over HTTP without leaking private refs', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    const task = createWorkTask({ title: 'HTTP support observability task', pipeline: ['verify'] })
    const started = startWorkTaskRun(task.id, 'verify', 'ses_http_support_private', 'verifier')!
    completeWorkTaskRun(started.run.id, {
      status: 'pass',
      summary: 'support evidence ready',
      feedback: 'private text token=operator-secret-token',
      artifacts: [],
      evidence: [{ type: 'note', ref: '/Users/joe/private/support-token.txt', summary: 'Bearer operator-secret-token' }],
      raw: 'private text token=operator-secret-token',
    }, 2)
    upsertChannelBinding({ provider: 'telegram', chatId: '123456789012', threadId: 'thread_private', sessionId: 'ses_http_support_private', mode: 'task', taskId: task.id })
    appendWorkEvent('audit.security', task.id, {
      operation: 'operator.pause',
      actor: 'local_operator',
      result: 'ok',
      authorization: 'Bearer operator-secret-token',
      evidence: 'token=operator-secret-token',
      path: '/Users/joe/private/support-token.txt',
    })

    const response = await dispatchRoute(routes, context('GET', '/observability'))
    const body = response?.body as any
    const serialized = JSON.stringify(body)

    expect(response?.status).toBe(200)
    expect(body.support).toMatchObject({
      releaseClaim: 'local_preview_support_observability_only',
      currentMode: 'local_public_beta',
      traceCoverage: expect.objectContaining({
        scheduler: 1,
        workers: 1,
        channels: 1,
        evidence: 1,
        auditLedger: expect.any(Number),
      }),
      operatorActions: expect.arrayContaining([
        expect.objectContaining({ id: 'pause', auditOperation: 'operator.pause', safeByDefault: true }),
        expect.objectContaining({ id: 'rollback', auditOperation: 'storage.restore', safeByDefault: false }),
        expect.objectContaining({ id: 'incident_bundle', auditOperation: 'incident.bundle.redacted', safeByDefault: true }),
      ]),
      incidentBundle: expect.objectContaining({
        status: 'redacted_local_supported',
        forbiddenContents: expect.arrayContaining(['raw provider payloads', 'private transcripts', 'chat IDs', 'bearer tokens']),
      }),
      unsupportedClaims: expect.arrayContaining(['hosted SLO/SLA', 'managed support readiness']),
    })
    expect(body.trace.auditLedger).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'operator.pause', result: 'ok', retentionClass: 'security_audit' }),
    ]))
    expect(serialized).not.toContain('operator-secret-token')
    expect(serialized).not.toContain('/Users/joe/private')
    expect(serialized).not.toContain('123456789012')
    expect(serialized).not.toContain('thread_private')
    expect(serialized).not.toContain('ses_http_support_private')
  })

  it('uses the full durable run set for alpha duplicate-run blockers', async () => {
    const duplicate = createWorkTask({ title: 'Old duplicate run task' })
    const recentTasks = Array.from({ length: 25 }, (_, index) => createWorkTask({ title: `Recent completed run ${index}` }))
    const state = loadWorkState()
    const now = '2026-06-15T12:00:00.000Z'
    const duplicateTask = state.tasks.find(task => task.id === duplicate.id)!
    duplicateTask.status = 'running'
    duplicateTask.currentRunId = 'run_old_duplicate_a'
    state.runs = [
      { id: 'run_old_duplicate_a', taskId: duplicate.id, stage: 'implement', sessionId: 'ses_old_a', profile: 'implementer', status: 'running', attempt: 1, startedAt: '2026-06-01T00:00:00.000Z' },
      { id: 'run_old_duplicate_b', taskId: duplicate.id, stage: 'review', sessionId: 'ses_old_b', profile: 'reviewer', status: 'running', attempt: 1, startedAt: '2026-06-01T00:01:00.000Z' },
      ...recentTasks.map((task, index) => ({ id: `run_recent_${index}`, taskId: task.id, stage: 'verify', sessionId: `ses_recent_${index}`, profile: 'verifier', status: 'passed' as const, attempt: 1, startedAt: now, completedAt: now })),
    ]
    saveWorkState(state)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode offline'))
    try {
      const response = await dispatchRoute(routes, context('GET', '/alpha-health'))
      const body = response?.body as any

      expect(response?.status).toBe(200)
      expect(body.alphaHealth.blockers.map((blocker: any) => blocker.label)).toContain(`Duplicate active runs for ${duplicate.id}`)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('does not expose direct ephemeral spawn routes', async () => {
    await expect(dispatchRoute(routes, context('POST', '/spawn'))).resolves.toBeUndefined()
    await expect(dispatchRoute(routes, context('POST', '/spawn-async'))).resolves.toBeUndefined()
  })

  it('uses current Gateway session inspection route names only', async () => {
    const response = await dispatchRoute(routes, context('GET', '/session-state'))

    expect(response?.body).toMatchObject({ sessions: expect.any(Array), counts: expect.any(Object) })
    await expect(dispatchRoute(routes, context('GET', '/list'))).resolves.toBeUndefined()
    await expect(dispatchRoute(routes, context('GET', '/status/session_1'))).resolves.toBeUndefined()
    await expect(dispatchRoute(routes, context('POST', '/stop/session_1'))).resolves.toBeUndefined()
    await expect(dispatchRoute(routes, context('GET', '/workers'))).resolves.toBeUndefined()
  })

  it('returns deterministic OpenCode Web and TUI session links', async () => {
    const redacted = await dispatchRoute(routes, {
      ...context('GET', '/opencode/sessions/ses_route'),
      client: { session: { get: async () => ({ data: { id: 'ses_route', title: 'private project', directory: '/tmp/route-project' } }) } },
    })
    const withDirectory = await dispatchRoute(routes, {
      ...context('GET', '/opencode/sessions/ses_route?raw=true'),
      client: { session: { get: async () => ({ data: { id: 'ses_route', directory: '/tmp/route-project' } }) } },
    })
    const withoutDirectory = await dispatchRoute(routes, {
      ...context('GET', '/opencode/sessions/ses_nopath'),
      client: { session: { get: async () => ({ data: { id: 'ses_nopath' } }) } },
    })

    expect((redacted?.body as any)).toMatchObject({
      session: { id: 'ses_route', title: 'private project' },
      webUrl: null,
      tuiCommand: 'opencode --session ses_route',
      links: { sessionId: 'ses_route', webStatus: 'unavailable' },
    })
    expect(JSON.stringify(redacted?.body)).not.toContain('/tmp/route-project')
    expect((withDirectory?.body as any)).toMatchObject({
      webUrl: expect.stringContaining('/session/ses_route'),
      tuiCommand: 'opencode /tmp/route-project --session ses_route',
      links: {
        sessionId: 'ses_route',
        directory: '/tmp/route-project',
        webStatus: 'metadata_only',
        missionControlUrl: 'http://127.0.0.1:4097/dashboard',
        sessionEvidenceUrl: 'http://127.0.0.1:4097/opencode/sessions/ses_route',
      },
    })
    expect((withDirectory?.body as any).linksText).toContain('OpenCode TUI: opencode /tmp/route-project --session ses_route')
    expect((withDirectory?.body as any).linksText).toContain('Web recovery: if Web says the session was not found')
    expect((withoutDirectory?.body as any)).toMatchObject({
      webUrl: null,
      tuiCommand: 'opencode --session ses_nopath',
      links: { sessionId: 'ses_nopath', webUrl: undefined, webStatus: 'unavailable' },
    })
    expect((withoutDirectory?.body as any).linksText).toContain('OpenCode Web: unavailable (session metadata missing directory/path)')
    expect((withoutDirectory?.body as any).linksText).toContain('Session evidence: http://127.0.0.1:4097/opencode/sessions/ses_nopath')
  })

  it('returns structured recovery when OpenCode no longer has a requested session', async () => {
    const response = await dispatchRoute(routes, {
      ...context('GET', '/opencode/sessions/ses_missing'),
      client: { session: { get: async () => { throw new Error('Session not found: ses_missing') } } },
    })
    const body = response?.body as any

    expect(response?.status).toBe(404)
    expect(body).toMatchObject({
      session: null,
      webUrl: null,
      tuiCommand: 'opencode --session ses_missing',
      links: {
        sessionId: 'ses_missing',
        webStatus: 'unavailable',
        webStatusReason: 'session not found in OpenCode API',
        webRecoveryHint: 'Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind to recover a fresh session.',
      },
      recovery: {
        state: 'stale_or_missing',
        reason: 'session not found in OpenCode API',
        nextAction: 'Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind to recover a fresh session.',
        missionControlUrl: 'http://127.0.0.1:4097/dashboard',
        sessionEvidenceUrl: 'http://127.0.0.1:4097/opencode/sessions/ses_missing',
      },
    })
    expect(body.linksText).toContain('OpenCode Web: unavailable (session not found in OpenCode API)')
    expect(body.linksText).toContain('Web recovery: Use /new [title], /switch <sessionId>, or /project bind <alias> <roadmapId> --rebind')
    expect(body.linksText).not.toContain('/session/ses_missing')
  })

  it('keeps task list responses compact by omitting raw run output', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = createWorkTask({ title: 'Compact task', pipeline: ['verify'] }, store)
    startWorkTaskRun(task.id, 'verify', 'ses_compact', 'verifier', store)
    const state = loadWorkState(store)
    const run = state.runs[0]
    state.tasks[0]!.status = 'running'
    state.tasks[0]!.currentRunId = run!.id
    saveWorkState(state, store)
    completeWorkTaskRun(run!.id, { status: 'pass', summary: 'ok', feedback: 'fine', artifacts: [], raw: 'x'.repeat(5000) }, 2, store)

    const response = await dispatchRoute(routes, context('GET', '/tasks'))
    const lastRun = (response?.body as any).tasks[0].lastRun

    expect(lastRun.result).toMatchObject({ status: 'pass', summary: 'ok' })
    expect(lastRun.result.raw).toBeUndefined()
  })

  it('keeps single-run responses compact unless explicit raw local admin intent is provided', async () => {
    const store = path.join(testDir, 'gateway.db')
    const task = createWorkTask({ title: 'Sensitive run', pipeline: ['verify'] }, store)
    const started = startWorkTaskRun(task.id, 'verify', 'ses_sensitive', 'verifier', store)!
    completeWorkTaskRun(started.run.id, {
      status: 'pass',
      summary: 'ok',
      feedback: 'private channel content token=operator-secret-token',
      artifacts: [{ type: 'note', ref: 'artifact.txt', token: 'artifact-secret-value' }],
      evidence: [{ type: 'note', ref: 'telegram:private-chat', summary: 'Bearer evidence-secret-value' }],
      decisions: [{ apiKey: 'decision-secret-value', summary: 'token=decision-summary-secret' }],
      raw: 'raw private channel content 123456:telegram-secret-token-value',
    } as any, 2, store)

    const compact = await dispatchRoute(routes, context('GET', `/runs/${encodeURIComponent(started.run.id)}`))
    const compactRun = (compact?.body as any).run

    expect(compactRun.result).toMatchObject({ status: 'pass', summary: 'ok' })
    expect(compactRun.result.raw).toBeUndefined()
    expect(JSON.stringify(compactRun)).not.toContain('telegram-secret-token-value')
    expect(JSON.stringify(compactRun)).not.toContain('artifact-secret-value')
    expect(JSON.stringify(compactRun)).not.toContain('evidence-secret-value')
    expect(JSON.stringify(compactRun)).not.toContain('decision-secret-value')
    expect(JSON.stringify(compactRun)).not.toContain('decision-summary-secret')
    await expect(dispatchRoute(routes, context('GET', `/runs/${encodeURIComponent(started.run.id)}?raw=true`))).rejects.toThrow('explicit local/admin intent')

    const raw = await dispatchRoute(routes, context('GET', `/runs/${encodeURIComponent(started.run.id)}?raw=true&localAdmin=true`))
    expect((raw?.body as any).run.result.raw).toContain('raw private channel content')
  })

  it('exposes the main-agent briefing route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode offline'))
    try {
      createWorkTask({ title: 'Briefed task', priority: 'HIGH' })

      const response = await dispatchRoute(routes, context('GET', '/briefing?limit=5'))

      expect(response?.status).toBe(200)
      expect((response?.body as any).briefing).toMatchObject({ counts: expect.objectContaining({ changedWork: expect.any(Number) }) })
      expect((response?.body as any).text).toContain('Gateway Briefing')
      expect((response?.body as any).text).toContain('Briefed task')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('returns actionable recovery drill refusal errors over HTTP', async () => {
    createWorkTask({ title: 'Invalid drill source' })
    const backup = createStorageBackup()
    fs.writeFileSync(path.join(backup.path, 'config.json'), '{"token":"secret"}')

    const response = await dispatchRoute(routes, context('POST', '/storage/recovery-drills', { path: backup.path, label: 'bad-http-drill' }))

    expect(response?.status).toBe(422)
    expect((response?.body as any).error).toContain('recovery drill refused backup')
    expect((response?.body as any).error).toContain('unexpected file in backup directory: config.json')
    expect((response?.body as any).error).toContain('evidence:')
  })

  it('exposes durable delegation submission over HTTP', async () => {
    const roadmap = createRoadmap({ title: 'HTTP delegation project' })
    const response = await dispatchRoute(routes, context('POST', '/delegations', {
      version: 1,
      idempotencyKey: 'http-delegation-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'HTTP delegated issue' },
      objective: 'Create a delegated task through HTTP',
      context: { summary: 'HTTP route context', references: [], constraints: [], nonGoals: [] },
      acceptanceCriteria: ['Task exists'],
      definitionOfDone: ['Receipt returned'],
      desired: {},
      schedule: {},
      budget: {},
      evidence: [],
      notificationTarget: { mode: 'parent_session' },
      parentSession: { sessionId: 'ses_http_parent' },
      completionPolicy: 'assistant_proposes_user_approves',
    }))

    expect(response?.status).toBe(200)
    expect((response?.body as any)).toMatchObject({ ok: true, receipt: { roadmapId: roadmap.id, idempotencyStatus: 'created' } })
    expect(loadWorkState().tasks[0]).toMatchObject({ title: 'HTTP delegated issue', roadmapId: roadmap.id })
  })

  it('redacts inline environment secrets from task responses', async () => {
    const body = {
      title: 'Secret environment task',
      environment: {
        backend: 'local-process',
        env: { GITHUB_TOKEN: 'secret-value' },
        secrets: { allow: ['GITHUB_TOKEN'] },
      },
    }

    const created = await dispatchRoute(routes, context('POST', '/tasks', body))
    const listed = await dispatchRoute(routes, context('GET', '/tasks'))

    expect(JSON.stringify(created?.body)).not.toContain('secret-value')
    expect(JSON.stringify(listed?.body)).not.toContain('secret-value')
    expect(JSON.stringify(loadWorkState())).not.toContain('secret-value')
    expect(JSON.stringify(created?.body)).toContain('<redacted>')
  })

  it('threads an idempotency key through POST /tasks so a repeated create returns the same task', async () => {
    const body = { title: 'Ingest GitHub issue 99', idempotencyKey: 'gh:issue:99', sourceType: 'github' }

    const first = await dispatchRoute(routes, context('POST', '/tasks', body))
    const second = await dispatchRoute(routes, context('POST', '/tasks', { ...body, title: 'Ingest GitHub issue 99 (retry)' }))

    const firstId = (first?.body as any).task.id
    const secondId = (second?.body as any).task.id
    expect(secondId).toBe(firstId)
    // The original wins; the retry does not overwrite the title or insert a duplicate.
    expect((second?.body as any).task.title).toBe('Ingest GitHub issue 99')
    expect(loadWorkState().tasks.filter(task => task.sourceType === 'github' && task.sourceKey === 'gh:issue:99')).toHaveLength(1)
    expect(loadWorkState().tasks.filter(task => task.title.startsWith('Ingest GitHub issue 99'))).toHaveLength(1)
  })

  it('threads idempotency keys through POST /tasks/bulk and dedupes across a repeat call', async () => {
    const tasks = [
      { title: 'bulk ingest A', idempotencyKey: 'bulk:a', sourceType: 'importer' },
      { title: 'bulk ingest B', idempotencyKey: 'bulk:b', sourceType: 'importer' },
    ]

    const first = await dispatchRoute(routes, context('POST', '/tasks/bulk', { tasks }))
    expect((first?.body as any).created).toBe(2)

    // Replaying the same batch must not create duplicates.
    const replay = await dispatchRoute(routes, context('POST', '/tasks/bulk', { tasks }))
    const replayIds = (replay?.body as any).tasks.map((task: any) => task.id).sort()
    const firstIds = (first?.body as any).tasks.map((task: any) => task.id).sort()
    expect(replayIds).toEqual(firstIds)
    expect(loadWorkState().tasks.filter(task => task.sourceType === 'importer')).toHaveLength(2)
  })

  it('aborts the active OpenCode session when PATCH /tasks/:id terminalizes a task', async () => {
    const task = createWorkTask({ title: 'Patch abort task' })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_patch_abort', 'implementer')!
    const abort = vi.fn().mockResolvedValue({})

    const patched = await dispatchRoute(routes, {
      ...context('PATCH', `/tasks/${encodeURIComponent(task.id)}`, { status: 'blocked', note: 'operator patch block' }),
      client: { session: { abort } },
    })
    const state = loadWorkState()

    expect((patched?.body as any)).toMatchObject({ abortedSessionId: 'ses_patch_abort', task: { status: 'blocked', currentRunId: undefined } })
    expect(state.runs.find(run => run.id === started.run.id)).toMatchObject({ status: 'errored', result: { summary: 'blocked requested by Gateway' } })
    expect(abort).toHaveBeenCalledTimes(1)
    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_patch_abort' } })
  })

  it('exposes environment inventory and operator actions with redacted metadata', async () => {
    const task = createWorkTask({ title: 'HTTP env task' })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_http_env', 'implementer', undefined, {}, { environment: envRun({ metadata: { apiToken: 'secret-token-value', slug: 'safe' } }) })!
    const abort = vi.fn().mockResolvedValue({})

    const listed = await dispatchRoute(routes, context('GET', '/environments'))
    const inspected = await dispatchRoute(routes, context('GET', `/environments/${encodeURIComponent('env_http')}`))
    const retained = await dispatchRoute(routes, { ...context('POST', `/environments/${encodeURIComponent('env_http')}/action`, { action: 'retain', note: 'debug' }), client: { session: { abort } } })
    const aborted = await dispatchRoute(routes, { ...context('POST', `/environments/${encodeURIComponent('env_http')}/action`, { action: 'abort' }), client: { session: { abort } } })

    expect((listed?.body as any).environments).toEqual([expect.objectContaining({ id: 'env_http', runId: started.run.id, metadata: { apiToken: '<redacted>', slug: 'safe' } })])
    expect(JSON.stringify(listed?.body)).not.toContain('secret-token-value')
    expect((inspected?.body as any).environment).toMatchObject({ id: 'env_http', taskTitle: 'HTTP env task' })
    expect((retained?.body as any)).toMatchObject({ eventType: 'environment.retained', environment: { status: 'retained' } })
    expect((aborted?.body as any)).toMatchObject({ eventType: 'environment.aborted', abortedSessionId: 'ses_http_env', run: { status: 'errored' } })
    expect(loadWorkState().tasks.find(row => row.id === task.id)).toMatchObject({ status: 'blocked', currentRunId: undefined })
    expect(abort).toHaveBeenCalledWith({ path: { id: 'ses_http_env' } })
  })

  it('scopes and redacts sensitive OpenCode read routes by default', async () => {
    const opencodeConfigDir = path.join(testDir, 'opencode-profile')
    fs.mkdirSync(opencodeConfigDir, { recursive: true })
    fs.writeFileSync(path.join(opencodeConfigDir, 'opencode.jsonc'), JSON.stringify({
      mcp: {
        privateServer: {
          type: 'local',
          command: ['node', 'server.js'],
          env: { API_KEY: 'private-mcp-key' },
        },
      },
    }))
    process.env['OPENCODE_CONFIG_DIR'] = opencodeConfigDir
    const client = {
      session: {
        list: vi.fn(async () => ({ data: [
          { id: 'ses_gateway', title: 'GW: task', authorization: 'Bearer private-session-token' },
          { id: 'ses_personal', title: 'Personal private session' },
        ] })),
      },
    }

    const sessions = await dispatchRoute(routes, { ...context('GET', '/opencode/sessions'), client })
    const mcp = await dispatchRoute(routes, context('GET', '/opencode/mcp'))
    const serialized = JSON.stringify({ sessions: sessions?.body, mcp: mcp?.body })

    expect((sessions?.body as any).sessions).toHaveLength(1)
    expect(serialized).not.toContain('Personal private session')
    expect(serialized).not.toContain('private-session-token')
    expect(serialized).not.toContain('private-mcp-key')
    expect(serialized).toContain('<redacted')
  })

  it('exposes known artifact refs', async () => {
    const artifactPath = path.join(testDir, 'run.log')
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true })
    fs.writeFileSync(artifactPath, 'artifact log\n')
    const task = createWorkTask({ title: 'Artifact route task', pipeline: ['implement'] })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_artifact', 'implementer', undefined, {}, { environment: envRun({ artifacts: [`file:${artifactPath}`] }) })!

    const artifact = await dispatchRoute(routes, context('GET', `/artifacts?ref=${encodeURIComponent(`file:${artifactPath}`)}`))
    const manifest = await dispatchRoute(routes, context('GET', `/artifacts/manifest?runId=${encodeURIComponent(started.run.id)}`))
    const manifestList = await dispatchRoute(routes, context('GET', `/artifacts/manifest?taskId=${encodeURIComponent(task.id)}&limit=5`))
    const unknown = await dispatchRoute(routes, context('GET', `/artifacts?ref=${encodeURIComponent('file:/tmp/not-attached.log')}`))

    expect(artifact?.body).toBe('artifact log\n')
    expect((manifest?.body as any).artifactManifest).toMatchObject({
      runId: started.run.id,
      manifestFound: false,
      counts: { available: 1, missing: 0, unsupported: 0, blocked: 0 },
      entries: [expect.objectContaining({ ref: expect.stringMatching(/^file:<gateway-artifact:run\.log#/) })],
    })
    expect((manifestList?.body as any).artifactManifests).toHaveLength(1)
    expect((manifestList?.body as any).artifactManifests[0]).toMatchObject({ runId: started.run.id })
    expect(unknown?.status).toBe(404)
  })

  it('exports redacted evidence bundles over HTTP without leaking channel targets', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    updateConfig({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } } } as any)
    const roadmap = createRoadmap({ title: 'HTTP evidence project' })
    const task = createWorkTask({
      title: 'JOE-100 live WF3 receipt drill',
      description: 'private channel content',
      roadmapId: roadmap.id,
      pipeline: ['verify'],
    })
    upsertProjectBinding({
      alias: 'j100wf3',
      roadmapId: roadmap.id,
      sessionId: 'ses_http_evidence',
      scope: 'telegram',
      provider: 'telegram',
      chatId: 'trusted-chat-http',
      threadId: 'topic-http',
      allowRebind: true,
    })
    upsertChannelBinding({
      provider: 'telegram',
      chatId: 'trusted-chat-http',
      threadId: 'topic-http',
      sessionId: 'ses_http_evidence',
      mode: 'task',
      taskId: task.id,
    })
    const started = startWorkTaskRun(task.id, 'verify', 'ses_http_evidence', 'verifier')!
    completeWorkTaskRun(started.run.id, {
      status: 'pass',
      summary: 'completed in trusted-chat-http',
      feedback: 'private channel content',
      artifacts: [],
      evidence: [{ type: 'note', ref: 'telegram:trusted-chat-http', summary: 'private channel content token=operator-secret-token' }],
      raw: 'private channel content trusted-chat-http topic-http 123456:telegram-secret-token-value',
    }, 2)
    appendWorkEvent('delegation.progress', task.id, {
      notificationTarget: { provider: 'telegram', chatId: 'trusted-chat-http', threadId: 'topic-http' },
      message: { text: 'private channel content token=operator-secret-token' },
      authorization: 'Bearer operator-secret-token',
      path: '/Users/joe/private-notes/wf3.txt',
    })

    const jsonResponse = await dispatchRoute(routes, context('GET', `/evidence/export?taskId=${encodeURIComponent(task.id)}`))
    const markdownResponse = await dispatchRoute(routes, context('GET', `/evidence/export?taskId=${encodeURIComponent(task.id)}&format=markdown`))
    const serialized = JSON.stringify(jsonResponse?.body)

    expect(jsonResponse?.status).toBe(200)
    expect((jsonResponse?.body as any).manifest.counts.tasks).toBe(1)
    expect(markdownResponse?.contentType).toContain('text/markdown')
    expect(serialized).not.toContain('trusted-chat-http')
    expect(serialized).not.toContain('topic-http')
    expect(serialized).not.toContain('operator-secret-token')
    expect(serialized).not.toContain('telegram-secret-token-value')
    expect(serialized).not.toContain('private channel content')
    expect(serialized).not.toContain('/Users/joe/private-notes')
    expect(String(markdownResponse?.body)).not.toContain('trusted-chat-http')
    expect(serialized).toContain('<redacted:telegram.chat:')
    await expect(dispatchRoute(routes, context('GET', '/evidence/export?redact=false'))).rejects.toThrow('explicit local/admin intent')
  })

  it('exposes roadmap supervisor CRUD routes', async () => {
    const roadmap = createRoadmap({ title: 'HTTP supervised project' })

    const created = await dispatchRoute(routes, context('POST', '/roadmap-supervisors', { roadmapId: roadmap.id, sessionId: 'ses_http', cadence: { intervalMs: 60000 } }))
    const supervisor = (created?.body as any).supervisor
    expect(supervisor).toMatchObject({ roadmapId: roadmap.id, sessionId: 'ses_http', isDefault: true })

    const listed = await dispatchRoute(routes, context('GET', `/roadmap-supervisors?roadmapId=${encodeURIComponent(roadmap.id)}`))
    expect((listed?.body as any).supervisors).toHaveLength(1)

    const updated = await dispatchRoute(routes, context('PATCH', `/roadmap-supervisors/${encodeURIComponent(supervisor.supervisorId)}`, { status: 'paused', nextReviewAt: '2026-06-13T12:00:00Z' }))
    expect((updated?.body as any).supervisor).toMatchObject({ status: 'paused', nextReviewAt: '2026-06-13T12:00:00.000Z' })

    const archived = await dispatchRoute(routes, context('POST', `/roadmap-supervisors/${encodeURIComponent(supervisor.supervisorId)}/archive`, { note: 'done' }))
    expect((archived?.body as any).supervisor).toMatchObject({ status: 'archived', note: 'done' })
  })

  it('exposes roadmap completion proposal routes', async () => {
    const roadmap = createRoadmap({ title: 'HTTP completion project' })

    const created = await dispatchRoute(routes, context('POST', '/roadmap-completion-proposals', { roadmapId: roadmap.id, evidence: ['npm run verify'], recommendation: 'ready' }))
    const proposal = (created?.body as any).proposal
    expect(proposal).toMatchObject({ roadmapId: roadmap.id, status: 'pending' })

    const listed = await dispatchRoute(routes, context('GET', `/roadmap-completion-proposals?roadmapId=${encodeURIComponent(roadmap.id)}&status=open`))
    expect((listed?.body as any).proposals).toHaveLength(1)

    const approved = await dispatchRoute(routes, context('POST', `/roadmap-completion-proposals/${encodeURIComponent(proposal.id)}/decision`, { decision: 'approve', actor: 'operator', note: 'accepted' }))
    expect((approved?.body as any).proposal).toMatchObject({ status: 'approved', decisionBy: 'http' })
    expect(loadWorkState().roadmaps.find(row => row.id === roadmap.id)).toMatchObject({ status: 'done' })
  })

  it('exposes project assistant UX routes without requiring internal ids for common flows', async () => {
    const created = await dispatchRoute(routes, context('POST', '/projects', { alias: 'http-project', title: 'HTTP project', sessionId: 'ses_project' }))
    const roadmap = (created?.body as any).roadmap

    const status = await dispatchRoute(routes, context('GET', '/projects/summary?alias=http-project'))
    const digest = await dispatchRoute(routes, context('GET', '/projects/digest?alias=http-project'))
    const review = await dispatchRoute(routes, context('POST', '/projects/review-now', { alias: 'http-project' }))
    await dispatchRoute(routes, context('POST', '/roadmap-completion-proposals', { roadmapId: roadmap.id, evidence: ['verified'], recommendation: 'ready' }))
    const completed = await dispatchRoute(routes, context('POST', '/projects/completion-decision', { alias: 'http-project', decision: 'approve', actor: 'operator' }))
    const paused = await dispatchRoute(routes, context('POST', '/projects/supervisor-action', { alias: 'http-project', action: 'pause' }))

    expect((created?.body as any).text).toContain('Project: http-project')
    expect((status?.body as any).text).toContain('Issues: 0 pending')
    expect((digest?.body as any).text).toContain('Project digest: http-project')
    expect((review?.body as any)).toMatchObject({ queued: true })
    expect((completed?.body as any).proposal).toMatchObject({ status: 'approved' })
    expect(loadWorkState().roadmaps.find(row => row.id === roadmap.id)?.status).toBe('done')
    expect((paused?.body as any).supervisor).toMatchObject({ status: 'paused' })
  })

  it('creates project wizard tasks through the daemon route and replays idempotent creates', async () => {
    const first = await dispatchRoute(routes, context('POST', '/projects', {
      alias: 'idem-project',
      title: 'Idempotent project',
      sessionId: 'ses_idem_project',
      idempotencyKey: 'project-create:idem-project',
      tasks: [{ title: 'First issue' }, { title: 'Second issue', description: 'daemon-created child task' }],
    }))
    const replay = await dispatchRoute(routes, context('POST', '/projects', {
      alias: 'idem-project',
      title: 'Idempotent project',
      sessionId: 'ses_idem_project',
      idempotencyKey: 'project-create:idem-project',
      tasks: [{ title: 'First issue' }, { title: 'Second issue' }],
    }))
    const differentAliasSameKey = await dispatchRoute(routes, context('POST', '/projects', {
      alias: 'idem-project-renamed',
      title: 'Should replay original project',
      sessionId: 'ses_other_project',
      idempotencyKey: 'project-create:idem-project',
      tasks: [{ title: 'Should not be created' }],
    }))
    const receipt = getDelegationReceipt('project-create:idem-project')
    const db = new DatabaseSync(path.join(testDir, 'gateway.db'))
    try {
      db.prepare("DELETE FROM events WHERE type = 'project.wizard.created'").run()
    } finally {
      db.close()
    }
    const replayAfterEventPrune = await dispatchRoute(routes, context('POST', '/projects', {
      alias: 'idem-project',
      title: 'Replay after event prune',
      sessionId: 'ses_idem_project',
      idempotencyKey: 'project-create:idem-project',
    }))
    const conflict = await dispatchRoute(routes, context('POST', '/projects', {
      alias: 'idem-project',
      title: 'Duplicate without replay key',
      sessionId: 'ses_other_project',
    })).catch(err => err)
    const differentKey = await dispatchRoute(routes, context('POST', '/projects', {
      alias: 'idem-project',
      title: 'Duplicate with different replay key',
      sessionId: 'ses_other_project',
      idempotencyKey: 'project-create:idem-project:different',
    })).catch(err => err)

    expect((first?.body as any).tasks.map((task: any) => task.title)).toEqual(['First issue', 'Second issue'])
    expect((first?.body as any).idempotencyStatus).toBe('created')
    expect((replay?.body as any).idempotencyStatus).toBe('replayed')
    expect((replay?.body as any).roadmap.id).toBe((first?.body as any).roadmap.id)
    expect((replay?.body as any).tasks.map((task: any) => task.id)).toEqual((first?.body as any).tasks.map((task: any) => task.id))
    expect((differentAliasSameKey?.body as any).roadmap.id).toBe((first?.body as any).roadmap.id)
    expect((differentAliasSameKey?.body as any).binding.alias).toBe('idem-project')
    expect((replayAfterEventPrune?.body as any).idempotencyStatus).toBe('replayed')
    expect((replayAfterEventPrune?.body as any).roadmap.id).toBe((first?.body as any).roadmap.id)
    expect(receipt).toMatchObject({ targetType: 'project_create', roadmapId: (first?.body as any).roadmap.id, taskIds: (first?.body as any).tasks.map((task: any) => task.id) })
    expect(conflict).toMatchObject({ status: 409 })
    expect(differentKey).toMatchObject({ status: 409 })
    expect(loadWorkState().roadmaps.filter(row => row.title === 'Idempotent project')).toHaveLength(1)
    expect(loadWorkState().tasks.filter(row => row.roadmapId === (first?.body as any).roadmap.id)).toHaveLength(2)
  })

  it('rejects project channel bindings outside the configured trust policy', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    const roadmap = createRoadmap({ title: 'Trusted project' })

    await expect(dispatchRoute(routes, context('POST', '/project-bindings', { alias: 'bad', roadmapId: roadmap.id, sessionId: 'ses_project', scope: 'telegram', chatId: 'chat-1' }))).rejects.toMatchObject({ status: 403 })

    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1' }], whatsapp: [] } } } as any)
    const response = await dispatchRoute(routes, context('POST', '/project-bindings', { alias: 'good', roadmapId: roadmap.id, sessionId: 'ses_project', scope: 'telegram', chatId: 'chat-1' }))

    expect((response?.body as any).binding).toMatchObject({ alias: 'good', provider: 'telegram', chatId: 'chat-1' })
  })

  it('manages agent teams through validation and human-gated mutations', async () => {
    const team = { roles: { implement: 'implementer', verify: 'verifier' }, capabilityRequirements: { implement: ['gateway-stage'] }, qualitySpecDefaults: { verificationCommands: ['npm test'] } }

    const validated = await dispatchRoute(routes, context('POST', '/agent-teams/validate', { name: 'analytics', team }))
    expect((validated?.body as any)).toMatchObject({ ok: true, name: 'analytics', agentTeam: { roles: { implement: 'implementer' } } })

    const pendingApply = await dispatchRoute(routes, context('POST', '/agent-teams/analytics/apply', { team }))
    const applyGate = (pendingApply?.body as any).gate
    expect(pendingApply?.status).toBe(202)
    expect(applyGate).toMatchObject({ status: 'pending', scopeKey: 'agent_team:apply:analytics' })
    expect(getConfig().agentTeams['analytics']).toBeUndefined()

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(applyGate.id)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/agent-teams/analytics/apply', { team, gateId: applyGate.id }))
    expect((applied?.body as any).agentTeam).toMatchObject({ roles: { implement: 'implementer', verify: 'verifier' } })
    expect(getConfig().agentTeams['analytics']).toBeDefined()

    const roadmap = createRoadmap({ title: 'Agent team project' })
    const pendingBind = await dispatchRoute(routes, context('POST', '/agent-teams/analytics/bind', { roadmapId: roadmap.id }))
    const bindGate = (pendingBind?.body as any).gate
    expect(bindGate.scopeKey).toBe(`agent_team:bind:analytics:roadmap:${roadmap.id}`)
    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(bindGate.id)}/decision`, { decision: 'approve', actor: 'operator' }))
    const bound = await dispatchRoute(routes, context('POST', '/agent-teams/analytics/bind', { roadmapId: roadmap.id, gateId: bindGate.id }))
    expect((bound?.body as any).roadmap).toMatchObject({ id: roadmap.id, agentTeam: 'analytics' })

    await expect(dispatchRoute(routes, context('DELETE', '/agent-teams/analytics', {}))).rejects.toMatchObject({ status: 409 })
    await dispatchRoute(routes, context('PATCH', `/roadmaps/${encodeURIComponent(roadmap.id)}`, { agentTeam: null }))

    const pendingDelete = await dispatchRoute(routes, context('DELETE', '/agent-teams/analytics', {}))
    const deleteGate = (pendingDelete?.body as any).gate
    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(deleteGate.id)}/decision`, { decision: 'approve', actor: 'operator' }))
    const deleted = await dispatchRoute(routes, context('DELETE', '/agent-teams/analytics', { gateId: deleteGate.id }))
    expect((deleted?.body as any)).toEqual({ deleted: true })
    expect(getConfig().agentTeams['analytics']).toBeUndefined()
  })

  it('exposes promotion scorecards, gated decisions, and profile state projection', async () => {
    const scorecardResponse = await dispatchRoute(routes, context('POST', '/promotion/scorecards', {
      subjectKind: 'profile',
      subjectName: 'implementer',
      sourceKind: 'eval',
      sourceId: 'suite.http',
      metrics: [{ id: 'quality', score: 1, maxScore: 1, passed: true }],
      thresholds: [{ id: 'quality.min', metric: 'quality', minPercentage: 1 }],
      evidence: ['http route evidence'],
    }))
    const scorecard = (scorecardResponse?.body as any).scorecard
    expect(scorecardResponse?.status).toBe(201)
    expect(scorecard).toMatchObject({ subjectKind: 'profile', subjectName: 'implementer', recommendation: 'promote', status: 'evaluated' })

    const profiles = await dispatchRoute(routes, context('GET', '/profiles'))
    expect((profiles?.body as any).profiles.implementer.promotion).toMatchObject({ state: 'evaluated', scorecardId: scorecard.id })

    const pending = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'promote', scorecardId: scorecard.id }))
    const decision = (pending?.body as any).decision
    expect(pending?.status).toBe(202)
    expect(decision).toMatchObject({ status: 'pending', gateId: expect.any(String), toStatus: 'promoted' })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('evaluated')

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(decision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: decision.id, gateId: decision.gateId }))
    expect((applied?.body as any).decision).toMatchObject({ status: 'applied', toStatus: 'promoted' })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('promoted')

    const state = await dispatchRoute(routes, context('GET', '/promotion/state?subjectKind=profile&subjectName=implementer'))
    expect((state?.body as any)).toMatchObject({ promotion: { state: 'promoted' }, decisions: [expect.objectContaining({ action: 'promote' })] })

    const deprecated = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'deprecate', scorecardId: scorecard.id }))
    const deprecateDecision = (deprecated?.body as any).decision
    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(deprecateDecision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: deprecateDecision.id, gateId: deprecateDecision.gateId }))
    expect(getConfig().profiles['implementer']!.promotionState).toBe('deprecated')
  })

  it('rolls back a blocked profile promotion to the previous valid promoted baseline', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.rollback', 1)
    const promote = await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    expect(promote).toMatchObject({ status: 'applied', toStatus: 'promoted' })

    const degraded = await createPromotionScorecard(routes, 'degraded.rollback', 0.7)
    expect(degraded).toMatchObject({ status: 'blocked', recommendation: 'block', regression: { status: 'blocked', baselineScorecardId: baseline.id } })
    const blocked = await requestAndApprovePromotion(routes, { action: 'block', scorecardId: degraded.id })
    expect(blocked).toMatchObject({ status: 'applied', toStatus: 'blocked' })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('blocked')

    const state = await dispatchRoute(routes, context('GET', '/promotion/state?subjectKind=profile&subjectName=implementer'))
    expect((state?.body as any).promotion.rollback).toMatchObject({ eligible: true, baselineScorecardId: baseline.id, targetStatus: 'promoted' })

    const pendingRollback = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' }))
    const rollbackDecision = (pendingRollback?.body as any).decision
    expect(pendingRollback?.status).toBe(202)
    expect(rollbackDecision).toMatchObject({
      action: 'rollback',
      fromStatus: 'blocked',
      toStatus: 'promoted',
      scorecardId: baseline.id,
      metadata: { rollback: expect.objectContaining({ eligible: true, baselineScorecardId: baseline.id }) },
    })

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(rollbackDecision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: rollbackDecision.id, gateId: rollbackDecision.gateId }))
    expect((applied?.body as any).decision).toMatchObject({ status: 'applied', action: 'rollback', toStatus: 'promoted' })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('promoted')
    expect(listWorkEvents().find(event => event.type === 'promotion.decision.applied' && (event.payload as any).action === 'rollback')?.payload).toMatchObject({
      metadata: { rollback: expect.objectContaining({ baselineScorecardId: baseline.id }) },
    })
  })

  it('rolls back a blocked team promotion to the previous valid promoted baseline', async () => {
    updateConfig({
      agentTeams: {
        delivery: {
          version: '1.0.0',
          roles: { default: 'reviewer', implement: 'reviewer', verify: 'verifier' },
          capabilityRequirements: { implement: [], verify: [] },
          qualitySpecDefaults: { verificationCommands: ['npm test'] },
        },
      },
    } as any)

    const baseline = await createSubjectPromotionScorecard(routes, { subjectKind: 'team', subjectName: 'delivery', sourceId: 'baseline.team-rollback', score: 1 })
    await requestAndApproveSubjectPromotion(routes, { subjectKind: 'team', subjectName: 'delivery', action: 'promote', scorecardId: baseline.id })
    const degraded = await createSubjectPromotionScorecard(routes, { subjectKind: 'team', subjectName: 'delivery', sourceId: 'degraded.team-rollback', score: 0.7 })
    expect(degraded).toMatchObject({ status: 'blocked', recommendation: 'block', regression: { status: 'blocked', baselineScorecardId: baseline.id } })
    await requestAndApproveSubjectPromotion(routes, { subjectKind: 'team', subjectName: 'delivery', action: 'block', scorecardId: degraded.id })
    expect(getConfig().agentTeams['delivery']!.promotionState).toBe('blocked')

    const state = await dispatchRoute(routes, context('GET', '/promotion/state?subjectKind=team&subjectName=delivery'))
    expect((state?.body as any).promotion.rollback).toMatchObject({ eligible: true, baselineScorecardId: baseline.id, targetStatus: 'promoted' })

    const pendingRollback = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'team', subjectName: 'delivery', action: 'rollback' }))
    const rollbackDecision = (pendingRollback?.body as any).decision
    expect(pendingRollback?.status).toBe(202)
    expect(rollbackDecision).toMatchObject({
      action: 'rollback',
      fromStatus: 'blocked',
      toStatus: 'promoted',
      scorecardId: baseline.id,
      metadata: { rollback: expect.objectContaining({ eligible: true, baselineScorecardId: baseline.id }) },
    })

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(rollbackDecision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: rollbackDecision.id, gateId: rollbackDecision.gateId }))

    expect((applied?.body as any).decision).toMatchObject({ status: 'applied', action: 'rollback', toStatus: 'promoted' })
    expect(getConfig().agentTeams['delivery']!.promotionState).toBe('promoted')
  })

  it('rolls back a deprecated profile to the promoted baseline', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.deprecated-rollback', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const deprecated = await requestAndApprovePromotion(routes, { action: 'deprecate', scorecardId: baseline.id })
    expect(deprecated).toMatchObject({ status: 'applied', fromStatus: 'promoted', toStatus: 'deprecated' })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('deprecated')

    const pendingRollback = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' }))
    const rollbackDecision = (pendingRollback?.body as any).decision
    expect(pendingRollback?.status).toBe(202)
    expect(rollbackDecision).toMatchObject({
      action: 'rollback',
      fromStatus: 'deprecated',
      toStatus: 'promoted',
      scorecardId: baseline.id,
      metadata: { rollback: expect.objectContaining({ eligible: true, baselineScorecardId: baseline.id }) },
    })

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(rollbackDecision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: rollbackDecision.id, gateId: rollbackDecision.gateId }))

    expect((applied?.body as any).decision).toMatchObject({ status: 'applied', action: 'rollback', fromStatus: 'deprecated', toStatus: 'promoted' })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('promoted')
  })

  it('accepts an explicit rollback scorecard override when it matches the selected baseline', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.rollback-match', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const degraded = await createPromotionScorecard(routes, 'degraded.rollback-match', 0.7)
    await requestAndApprovePromotion(routes, { action: 'block', scorecardId: degraded.id })

    const pendingRollback = await dispatchRoute(routes, context('POST', '/promotion/decisions', {
      subjectKind: 'profile',
      subjectName: 'implementer',
      action: 'rollback',
      scorecardId: baseline.id,
    }))
    const rollbackDecision = (pendingRollback?.body as any).decision

    expect(pendingRollback?.status).toBe(202)
    expect(rollbackDecision).toMatchObject({
      action: 'rollback',
      scorecardId: baseline.id,
      metadata: { rollback: expect.objectContaining({ baselineScorecardId: baseline.id }) },
    })
  })

  it('rejects an explicit rollback scorecard override that differs from the selected baseline', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.rollback-mismatch', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const degraded = await createPromotionScorecard(routes, 'degraded.rollback-mismatch', 0.7)
    await requestAndApprovePromotion(routes, { action: 'block', scorecardId: degraded.id })

    await expect(dispatchRoute(routes, context('POST', '/promotion/decisions', {
      subjectKind: 'profile',
      subjectName: 'implementer',
      action: 'rollback',
      scorecardId: degraded.id,
    }))).rejects.toThrow(new RegExp(`scorecardId must match the selected eligible baseline ${baseline.id}`))
  })

  it('refuses rollback when the current subject no longer matches the promoted baseline revision', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.revision', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const current = getConfig().profiles['implementer']
    updateConfig({ profiles: { implementer: { ...current, capabilities: [...(current!.capabilities || []), 'new-capability'] } } } as any)

    const degraded = await createPromotionScorecard(routes, 'degraded.revision', 0.7)
    await requestAndApprovePromotion(routes, { action: 'block', scorecardId: degraded.id })

    await expect(dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' })))
      .rejects.toThrow(/rollback is not eligible: current profile revision/)
  })

  it('refuses rollback when the current subject is unsafe even with a promoted baseline', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.unsafe-subject', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const degraded = await createPromotionScorecard(routes, 'degraded.unsafe-subject', 0.7)
    await requestAndApprovePromotion(routes, { action: 'block', scorecardId: degraded.id })
    const current = getConfig().profiles['implementer']
    updateConfig({ profiles: { implementer: { ...current, permission: { ...current!.permission, '': 'allow' } } } } as any)

    const state = await dispatchRoute(routes, context('GET', '/promotion/state?subjectKind=profile&subjectName=implementer'))
    expect((state?.body as any).promotion.rollback).toMatchObject({
      eligible: false,
      status: 'unsafe_subject',
      baselineScorecardId: baseline.id,
      reason: expect.stringContaining('unsafe broad permission grant'),
    })
    await expect(dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' })))
      .rejects.toThrow(/rollback is not eligible: unsafe broad permission grant/)
  })

  it('refuses rollback when no promoted baseline exists', async () => {
    updateConfig({ profiles: { implementer: { ...getConfig().profiles['implementer'], promotionState: 'blocked' } } } as any)

    const state = await dispatchRoute(routes, context('GET', '/promotion/state?subjectKind=profile&subjectName=implementer'))
    expect((state?.body as any).promotion.rollback).toMatchObject({
      eligible: false,
      status: 'no_baseline',
      reason: expect.stringContaining('previous applied promoted baseline'),
    })
    await expect(dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' })))
      .rejects.toThrow(/rollback requires a previous applied promoted baseline/)
  })

  it('refuses rollback when the promoted baseline scorecard has been invalidated', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.invalidated-scorecard', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const invalidatedBaseline = await createPromotionScorecard(routes, 'baseline.invalidated-scorecard', 0.7)
    expect(invalidatedBaseline.id).toBe(baseline.id)
    expect(invalidatedBaseline).toMatchObject({ status: 'blocked', recommendation: 'block' })
    await requestAndApprovePromotion(routes, { action: 'block', scorecardId: invalidatedBaseline.id })

    const state = await dispatchRoute(routes, context('GET', '/promotion/state?subjectKind=profile&subjectName=implementer'))
    expect((state?.body as any).promotion.rollback).toMatchObject({
      eligible: false,
      status: 'no_baseline',
      reason: expect.stringContaining('previous applied promoted baseline'),
    })
    await expect(dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' })))
      .rejects.toThrow(/rollback requires a previous applied promoted baseline/)
  })

  it('rejects a pending rollback at apply time when the subject drifts after gate creation', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.apply-drift', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })
    const degraded = await createPromotionScorecard(routes, 'degraded.apply-drift', 0.7)
    await requestAndApprovePromotion(routes, { action: 'block', scorecardId: degraded.id })

    const pending = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'rollback' }))
    const rollbackDecision = (pending?.body as any).decision
    const current = getConfig().profiles['implementer']
    updateConfig({ profiles: { implementer: { ...current, capabilities: [...(current!.capabilities || []), 'drift-after-gate'] } } } as any)

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(rollbackDecision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: rollbackDecision.id, gateId: rollbackDecision.gateId }))

    expect((applied?.body as any).decision).toMatchObject({
      status: 'rejected',
      action: 'rollback',
      toStatus: 'promoted',
      metadata: { applyValidation: { reason: expect.stringContaining('current profile revision') } },
    })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('blocked')
  })

  it('warns or blocks scorecards when they regress against the promoted baseline', async () => {
    const baseline = await createPromotionScorecard(routes, 'baseline.regression', 1)
    await requestAndApprovePromotion(routes, { action: 'promote', scorecardId: baseline.id })

    const warning = await createPromotionScorecard(routes, 'warning.regression', 0.93)
    expect(warning).toMatchObject({
      recommendation: 'promote',
      status: 'evaluated',
      regression: { status: 'warning', baselineScorecardId: baseline.id, delta: expect.any(Number) },
    })

    const blocked = await createPromotionScorecard(routes, 'blocked.regression', 0.7)
    expect(blocked).toMatchObject({
      recommendation: 'block',
      status: 'blocked',
      regression: { status: 'blocked', baselineScorecardId: baseline.id },
    })
    await expect(dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'promote', scorecardId: blocked.id })))
      .rejects.toThrow(/scorecard is blocked/)
  })

  it('rejects a pending promote at apply time when its scorecard is re-upserted as blocked', async () => {
    const candidate = await createPromotionScorecard(routes, 'candidate.apply-blocked', 1)
    const pending = await dispatchRoute(routes, context('POST', '/promotion/decisions', { subjectKind: 'profile', subjectName: 'implementer', action: 'promote', scorecardId: candidate.id }))
    const decision = (pending?.body as any).decision

    const blocked = await createPromotionScorecard(routes, 'candidate.apply-blocked', 0.7)
    expect(blocked.id).toBe(candidate.id)
    expect(blocked).toMatchObject({ status: 'blocked', recommendation: 'block' })

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(decision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: decision.id, gateId: decision.gateId }))

    expect((applied?.body as any).decision).toMatchObject({
      status: 'rejected',
      action: 'promote',
      metadata: { applyValidation: { reason: expect.stringContaining('scorecard is blocked') } },
    })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('evaluated')
  })

  it('exposes access inspection and fails closed for unknown profile skills', async () => {
    const inspection = await dispatchRoute(routes, context('GET', '/profiles/implementer/inspection'))
    expect((inspection?.body as any).inspection).toMatchObject({
      kind: 'profile',
      name: 'implementer',
      grants: expect.objectContaining({ skills: ['gateway-stage'] }),
    })

    const unsafeProfile = {
      ...getConfig().profiles['implementer'],
      tools: ['gateway_not_real'],
    }
    await expect(dispatchRoute(routes, context('PUT', '/profiles/unsafe', unsafeProfile))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('LP_TOOL_UNKNOWN'),
    })
  })

  it('previews and applies blueprints through human-gated Gateway config mutations', async () => {
    const blueprint = {
      name: 'support',
      version: '1.0.0',
      requiredOpenCode: { agents: ['gateway-coordinator'], skills: ['gateway-coordinator'], mcpServers: ['gateway'], tools: ['gateway_task_update'] },
      profiles: {
        support: {
          model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
          agent: 'gateway-coordinator',
          skills: ['gateway-coordinator'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          permission: { read: 'allow', question: 'allow', gateway_task_update: 'allow', edit: 'deny', bash: 'ask' },
          heartbeatMs: 0,
          maxTokens: 80000,
          role: 'planning',
          capabilities: ['support-triage'],
          promotionState: 'evaluated',
        },
      },
      teams: {
        support: {
          version: '1.0.0',
          roles: { default: 'support', implement: 'support', verify: 'verifier' },
          capabilityRequirements: { default: ['support-triage'] },
          qualitySpecDefaults: { evidenceRequirements: ['operator-visible outcome'] },
        },
      },
      rollback: { rollbackTargets: ['support'] },
    }

    const preview = await dispatchRoute(routes, context('POST', '/blueprints/preview', { blueprint }))
    expect((preview?.body as any).preview).toMatchObject({ ok: true, blueprint: { name: 'support', version: '1.0.0' } })
    expect((preview?.body as any).preview.diff).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: 'profile', name: 'support', action: 'create' }),
      expect.objectContaining({ target: 'agentTeam', name: 'support', action: 'create' }),
    ]))

    const pendingApply = await dispatchRoute(routes, context('POST', '/blueprints/apply', { blueprint }))
    const gate = (pendingApply?.body as any).gate
    expect(pendingApply?.status).toBe(202)
    expect(gate).toMatchObject({ status: 'pending', scopeKey: expect.stringContaining('blueprint:apply:support:1.0.0:') })
    expect(getConfig().profiles['support']).toBeUndefined()

    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(gate.id)}/decision`, { decision: 'approve', actor: 'operator' }))
    const applied = await dispatchRoute(routes, context('POST', '/blueprints/apply', { blueprint, gateId: gate.id }))

    expect((applied?.body as any)).toMatchObject({
      applied: true,
      profiles: { support: expect.objectContaining({ agent: 'gateway-coordinator', version: '1.0.0', updatedAt: expect.any(String) }) },
      receipt: {
        blueprint: { name: 'support', version: '1.0.0' },
        gateId: gate.id,
        auditEventId: expect.any(Number),
        changed: expect.arrayContaining([expect.objectContaining({ target: 'profile', name: 'support', action: 'create' })]),
      },
    })
    expect(getConfig().agentTeams['support']).toMatchObject({ roles: { default: 'support', implement: 'support', verify: 'verifier' } })
    expect(listWorkEvents(10).filter(event => event.type === 'audit.security')).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: 'support@1.0.0', payload: expect.objectContaining({ operation: 'blueprint.apply' }) }),
    ]))
  })

  it('rejects approved blueprint apply when previewed revisions drift', async () => {
    updateConfig({
      profiles: {
        support: {
          model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
          agent: 'gateway-coordinator',
          skills: ['gateway-coordinator'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          permission: { read: 'allow', question: 'allow', gateway_task_update: 'allow', edit: 'deny', bash: 'ask' },
          heartbeatMs: 0,
          maxTokens: 80000,
          role: 'planning',
        },
      },
      agentTeams: {
        support: {
          version: '1.0.0',
          roles: { default: 'support', implement: 'support', verify: 'verifier' },
          capabilityRequirements: { default: ['support-triage'] },
          qualitySpecDefaults: { evidenceRequirements: ['operator-visible outcome'] },
        },
      },
    } as any)
    const blueprint = {
      name: 'support',
      version: '2.0.0',
      requiredOpenCode: { agents: ['gateway-coordinator'], skills: ['gateway-coordinator'], mcpServers: ['gateway'], tools: ['gateway_task_update'] },
      profiles: {
        support: {
          ...getConfig().profiles['support'],
          description: 'Support profile v2',
          capabilities: ['support-triage'],
        },
      },
      teams: {
        support: {
          version: '2.0.0',
          roles: { default: 'support', implement: 'support', verify: 'verifier' },
          capabilityRequirements: { default: ['support-triage'] },
          qualitySpecDefaults: { evidenceRequirements: ['operator-visible outcome'], verificationCommands: ['npm test'] },
        },
      },
    }

    const pendingApply = await dispatchRoute(routes, context('POST', '/blueprints/apply', { blueprint }))
    const gate = (pendingApply?.body as any).gate
    updateConfig({
      profiles: { support: { ...getConfig().profiles['support'], description: 'Concurrent operator change' } },
      agentTeams: { support: { ...getConfig().agentTeams['support'], description: 'Concurrent operator change' } },
    } as any)
    await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(gate.id)}/decision`, { decision: 'approve', actor: 'operator' }))

    await expect(dispatchRoute(routes, context('POST', '/blueprints/apply', { blueprint, gateId: gate.id }))).rejects.toMatchObject({ status: 409 })
    expect(getConfig().profiles['support']!.description).toBe('Concurrent operator change')
  })

  it('exposes the Agent Factory catalog over HTTP', async () => {
    const blueprintDir = path.join(testDir, 'blueprints')
    fs.mkdirSync(blueprintDir, { recursive: true })
    fs.writeFileSync(path.join(blueprintDir, 'catalog.json'), JSON.stringify({
      name: 'catalog',
      version: '1.0.0',
      metadata: { title: 'Catalog team', description: 'Persisted catalog blueprint', updatedAt: '2026-06-15T12:00:00Z' },
      requiredOpenCode: { agents: ['gateway-implementer'], skills: ['gateway-stage'], mcpServers: ['gateway'], tools: ['gateway_task_update'] },
      profiles: {
        catalog: {
          model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          permission: { read: 'allow', gateway_task_update: 'allow', edit: 'ask', bash: 'ask' },
          heartbeatMs: 0,
          maxTokens: 80000,
          role: 'execution',
          capabilities: ['catalog'],
        },
      },
      teams: {
        catalog: {
          version: '1.0.0',
          roles: { implement: 'catalog', verify: 'verifier' },
          capabilityRequirements: { implement: ['catalog'] },
          qualitySpecDefaults: { evidenceRequirements: ['catalog evidence'] },
        },
      },
    }, null, 2))

    const catalog = await dispatchRoute(routes, context('GET', '/agent-factory/catalog'))
    const blueprints = await dispatchRoute(routes, context('GET', '/blueprints'))

    expect((catalog?.body as any).catalog).toMatchObject({
      profiles: expect.arrayContaining([expect.objectContaining({ id: 'profile:implementer' })]),
      blueprints: [expect.objectContaining({ id: 'blueprint:catalog@1.0.0', status: 'valid' })],
      localReadiness: expect.objectContaining({
        mode: 'local_readiness_catalog_v1',
        entries: expect.arrayContaining([
          expect.objectContaining({ id: 'mcp:gateway' }),
          expect.objectContaining({ id: 'setup:channel_credentials' }),
        ]),
        redaction: expect.objectContaining({ providerSecrets: 'excluded' }),
      }),
    })
    expect((blueprints?.body as any).blueprints).toEqual([expect.objectContaining({ name: 'catalog', version: '1.0.0' })])
  })

  it('assembles bounded Agent Factory teams over HTTP and records an audit receipt', async () => {
    const blueprintDir = path.join(testDir, 'blueprints')
    fs.mkdirSync(blueprintDir, { recursive: true })
    fs.writeFileSync(path.join(blueprintDir, 'bounded.json'), JSON.stringify({
      name: 'bounded',
      version: '1.0.0',
      requiredOpenCode: { agents: ['gateway-implementer'], skills: ['gateway-stage'], mcpServers: ['gateway'], tools: ['gateway_task_update'] },
      profiles: {
        bounded: {
          model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          permission: { read: 'allow', gateway_task_update: 'allow', edit: 'ask', bash: 'ask' },
          heartbeatMs: 0,
          maxTokens: 80000,
          role: 'execution',
          capabilities: ['repo-write'],
          promotionState: 'promoted',
        },
      },
      teams: {
        bounded: {
          version: '1.0.0',
          promotionState: 'promoted',
          roles: { implement: 'bounded' },
          capabilityRequirements: { implement: ['repo-write'] },
          qualitySpecDefaults: {},
        },
      },
    }, null, 2))

    const response = await dispatchRoute(routes, context('POST', '/agent-factory/teams/assemble', {
      idempotencyKey: 'team:req:http:1',
      blueprintName: 'bounded',
      blueprintVersion: '1.0.0',
      teamName: 'bounded',
      roles: [{ role: 'implement', requiredCapabilities: ['repo-write'] }],
    }))
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.receipt).toMatchObject({
      receiptKind: 'team_assembly',
      status: 'accepted',
      auditEventId: expect.any(Number),
      selectedTeam: { name: 'bounded', version: '1.0.0' },
      members: [expect.objectContaining({ role: 'implement', profile: 'bounded', profileVersion: '1.0.0' })],
    })
    expect(listWorkEvents(10).filter(event => event.type === 'audit.security')).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: 'bounded', payload: expect.objectContaining({ operation: 'team.assemble', result: 'ok' }) }),
    ]))
  })

  it('creates team assignments over HTTP and records review receipts', async () => {
    const blueprintDir = path.join(testDir, 'blueprints')
    fs.mkdirSync(blueprintDir, { recursive: true })
    fs.writeFileSync(path.join(blueprintDir, 'bounded.json'), JSON.stringify({
      name: 'bounded',
      version: '1.0.0',
      requiredOpenCode: { agents: ['gateway-implementer'], skills: ['gateway-stage'], mcpServers: ['gateway'], tools: ['gateway_task_update'] },
      profiles: {
        bounded: {
          model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          permission: { read: 'allow', gateway_task_update: 'allow', edit: 'ask', bash: 'ask' },
          heartbeatMs: 0,
          maxTokens: 80000,
          role: 'execution',
          capabilities: ['repo-write'],
          promotionState: 'promoted',
        },
      },
      teams: {
        bounded: {
          version: '1.0.0',
          promotionState: 'promoted',
          roles: { implement: 'bounded' },
          capabilityRequirements: { implement: ['repo-write'] },
          qualitySpecDefaults: {},
        },
      },
    }, null, 2))
    const task = createWorkTask({ title: 'HTTP assigned task' })

    const created = await dispatchRoute(routes, context('POST', '/team-assignments', {
      idempotencyKey: 'team:assignment:http:1',
      blueprintName: 'bounded',
      blueprintVersion: '1.0.0',
      teamName: 'bounded',
      taskId: task.id,
      roles: [{ role: 'implement', requiredCapabilities: ['repo-write'] }],
      budget: { maxRuntimeMs: 300000, maxTokens: 50000, retryLimit: 1 },
      gates: [{ id: 'review-pass', type: 'review', requiredBefore: 'complete' }],
      evidenceRequirements: [{ id: 'review-log', type: 'artifact', summary: 'Review evidence' }],
    }))
    const createdBody = created?.body as any
    const assignment = createdBody.receipt.assignments[0]
    const receipt = await dispatchRoute(routes, context('POST', `/team-assignments/${encodeURIComponent(assignment.id)}/receipts`, {
      receiptKind: 'review_outcome',
      gateId: 'review-pass',
      status: 'approved',
      summary: 'HTTP review passed.',
      evidence: ['review-log: artifact:review.md'],
    }))
    const listed = await dispatchRoute(routes, context('GET', `/team-assignments?taskId=${encodeURIComponent(task.id)}`))
    const linked = await dispatchRoute(routes, context('GET', createdBody.receipt.links.assignments))

    expect(created?.status).toBe(200)
    expect(createdBody).toMatchObject({ ok: true, receipt: { status: 'accepted', links: { assignments: expect.stringContaining('/team-assignments?receiptId=') } } })
    expect(receipt?.status).toBe(200)
    expect((listed?.body as any).assignments).toEqual([
      expect.objectContaining({ id: assignment.id, receipts: [expect.objectContaining({ receiptKind: 'review_outcome', status: 'approved' })] }),
    ])
    expect((linked?.body as any).assignments).toEqual((listed?.body as any).assignments)
  })

  it('plans an Initiative with tasks, dependencies, and a supervisor in one call', async () => {
    const response = await dispatchRoute(routes, context('POST', '/workflows/plan-initiative', {
      title: 'Composite initiative',
      priority: 'HIGH',
      tasks: [{ title: 'First' }, { title: 'Second' }],
      dependencies: [{ taskRef: 1, dependsOnRef: 0 }],
      supervisor: { sessionId: 'ses_plan_route', isDefault: true },
    }))
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body.roadmap).toMatchObject({ title: 'Composite initiative', priority: 'HIGH' })
    expect(body.tasks).toHaveLength(2)
    expect(body.dependencies).toEqual([expect.objectContaining({ taskId: body.tasks[1].id, dependsOnTaskId: body.tasks[0].id })])
    expect(body.supervisor).toMatchObject({ sessionId: 'ses_plan_route', roadmapId: body.roadmap.id })

    const state = loadWorkState()
    expect(state.tasks.filter((task: any) => task.roadmapId === body.roadmap.id)).toHaveLength(2)
  })

  it('rejects an atomic plan-initiative with an invalid dependency ref without persisting anything', async () => {
    const before = loadWorkState().roadmaps.length
    await expect(dispatchRoute(routes, context('POST', '/workflows/plan-initiative', {
      title: 'Doomed initiative',
      tasks: [{ title: 'Only' }],
      dependencies: [{ taskRef: 0, dependsOnRef: 9 }],
    }))).rejects.toThrow(/index out of range/)

    expect(loadWorkState().roadmaps).toHaveLength(before)
    expect(loadWorkState().tasks.some((task: any) => task.title === 'Only')).toBe(false)
  })

  it('rejects a plan-initiative supervisor missing a sessionId instead of silently dropping it', async () => {
    const before = loadWorkState().roadmaps.length
    await expect(dispatchRoute(routes, context('POST', '/workflows/plan-initiative', {
      title: 'Silent supervisor drop',
      tasks: [{ title: 'Task' }],
      supervisor: { isDefault: true },
    }))).rejects.toThrow(/sessionId/)

    // Atomic rollback: nothing persisted.
    expect(loadWorkState().roadmaps).toHaveLength(before)
    expect(loadWorkState().tasks.some((task: any) => task.title === 'Task')).toBe(false)
  })

  it('dispatch-now honors a paused scheduler: no durable config change, truthful paused no-op', async () => {
    // A ready task exists, but a paused scheduler must dispatch nothing.
    const task = createWorkTask({ title: 'Should not dispatch while paused', pipeline: ['implement'] })
    await dispatchRoute(routes, context('POST', '/scheduler', { action: 'pause' }))
    expect(getConfig().scheduler.enabled).toBe(false)

    const response = await dispatchRoute(routes, { ...context('POST', '/workflows/dispatch-now', { taskId: task.id }), client: fakeSessionClient() })
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body).toMatchObject({ schedulerPaused: true, schedulerEnabled: false, dispatchedTotal: 0, resumedTask: false })
    expect(body.dispatched).toEqual([])
    expect(typeof body.guidance).toBe('string')
    // The global scheduler.enabled must be UNCHANGED — dispatch_now must never
    // durably un-pause a scheduler an operator paused for maintenance.
    expect(getConfig().scheduler.enabled).toBe(false)
  })

  it('dispatch-now dispatches the full ready set and highlights the requested target, then no-ops under lease', async () => {
    const task = createWorkTask({ title: 'Dispatch me', pipeline: ['implement'] })
    const other = createWorkTask({ title: 'Also ready', pipeline: ['implement'] })
    // Reuse one client so the dispatched session persists across cycles; a
    // fresh client would make the session look missing and trigger recovery.
    const client = fakeSessionClient()

    const first = await dispatchRoute(routes, { ...context('POST', '/workflows/dispatch-now', { taskId: task.id }), client })
    const firstBody = first?.body as any
    expect(first?.status).toBe(200)
    // The unscoped cycle dispatches ALL ready work up to maxConcurrent, and the
    // report lists the full set — not just the requested target.
    expect(firstBody.dispatchedTotal).toBe(2)
    expect(firstBody.dispatched.map((run: any) => run.taskId).sort()).toEqual([task.id, other.id].sort())
    expect(firstBody.requested).toMatchObject({ taskId: task.id })
    expect(firstBody.requestedDispatched).toBe(true)

    const second = await dispatchRoute(routes, { ...context('POST', '/workflows/dispatch-now', { taskId: task.id }), client })
    const secondBody = second?.body as any
    expect(second?.status).toBe(200)
    expect(secondBody.dispatchedTotal).toBe(0)
  })

  it('dispatch-now rejects an unknown task', async () => {
    await expect(dispatchRoute(routes, { ...context('POST', '/workflows/dispatch-now', { taskId: 'task_missing' }), client: fakeSessionClient() }))
      .rejects.toThrow('task not found')
  })

  it('triage returns a read-only composite of gates, blocked tasks, and active alerts', async () => {
    const blockedTask = createWorkTask({ title: 'Blocked triage task' })
    await dispatchRoute(routes, context('POST', `/tasks/${encodeURIComponent(blockedTask.id)}/action`, { action: 'block', note: 'needs input' }))
    const gateTask = createWorkTask({ title: 'Gated triage task' })
    await dispatchRoute(routes, context('POST', '/human-gates', { type: 'manual', reason: 'Approve triage step', taskId: gateTask.id }))
    upsertAlert({ key: 'triage:test', severity: 'critical', source: 'gateway.alerts', summary: 'triage alert', nextAction: 'inspect' })

    const eventsBefore = listWorkEvents(200).length
    const response = await dispatchRoute(routes, context('GET', '/triage'))
    const body = response?.body as any

    expect(response?.status).toBe(200)
    expect(body.triage.counts.gates).toBeGreaterThanOrEqual(1)
    expect(body.triage.counts.blockedTasks).toBeGreaterThanOrEqual(1)
    expect(body.triage.counts.alerts).toBeGreaterThanOrEqual(1)
    expect(body.triage.alerts.some((alert: any) => alert.key === 'triage:test')).toBe(true)
    expect(body.triage.attention.items.some((item: any) => item.kind === 'gateway_gate')).toBe(true)
    expect(body.triage.attention.items.some((item: any) => item.kind === 'task')).toBe(true)
    // Read-only: the triage read must not append work events.
    expect(listWorkEvents(200).length).toBe(eventsBefore)
  })

  it('triage surfaces a not-yet-materialized manual gate as a virtual item without any write', async () => {
    // Create WITHOUT a manual gate (create-time would materialize a real gate
    // row), then PATCH the manual gate on — the update path sets manualGate but
    // does NOT insert a gate row, reproducing the un-materialized state that
    // GET /attention would synthesize but read-only triage previously omitted.
    const task = createWorkTask({ title: 'Pending manual gate task' })
    // Set manualGate directly in durable state (bypassing the create/update paths
    // that materialize a gate row) so the gate is genuinely un-materialized.
    const state = loadWorkState()
    state.tasks.find((row: any) => row.id === task.id)!.manualGate = 'approval_required'
    saveWorkState(state)
    expect(listHumanGates({ status: 'open' }).some((gate: any) => gate.taskId === task.id)).toBe(false)

    const eventsBefore = listWorkEvents(200).length
    const response = await dispatchRoute(routes, context('GET', '/triage'))
    const body = response?.body as any

    expect(response?.status).toBe(200)
    const virtualItem = body.triage.attention.items.find((item: any) => item.kind === 'gateway_gate' && item.taskId === task.id)
    expect(virtualItem).toBeTruthy()
    expect(body.triage.counts.gates).toBeGreaterThanOrEqual(1)
    // Strictly non-mutating: no work events appended AND no gate row materialized.
    expect(listWorkEvents(200).length).toBe(eventsBefore)
    expect(listHumanGates({ status: 'open' }).some((gate: any) => gate.taskId === task.id)).toBe(false)
  })
})

function fakeSessionClient(): any {
  let counter = 0
  const sessions: any[] = []
  return {
    session: {
      create: async (options: any) => {
        const id = `ses_dispatch_${++counter}`
        const created = { id, title: options?.body?.title, directory: options?.query?.directory }
        sessions.push(created)
        return { data: created }
      },
      prompt: async (options: any) => ({ data: { info: { id: `msg_${++counter}`, role: 'assistant', sessionID: options.path.id, time: { created: 1 } }, parts: [] } }),
      messages: async () => ({ data: [] }),
      get: async (options: any) => ({ data: sessions.find(session => session.id === options.path.id) || { id: options.path.id } }),
      list: async () => ({ data: sessions }),
      abort: async () => ({ data: true }),
    },
  }
}

function context(method: string, path: string, body?: unknown) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(raw ? [Buffer.from(raw)] : []) as any
  req.method = method
  req.headers = {}
  return {
    req,
    url: new URL(path, 'http://127.0.0.1:4097'),
    client: {},
    channels: new Map<string, any>(),
  }
}

async function createPromotionScorecard(routes: ReturnType<typeof createJsonRoutes>, sourceId: string, score: number) {
  return createSubjectPromotionScorecard(routes, { subjectKind: 'profile', subjectName: 'implementer', sourceId, score })
}

async function createSubjectPromotionScorecard(routes: ReturnType<typeof createJsonRoutes>, input: { subjectKind: string; subjectName: string; sourceId: string; score: number }) {
  const response = await dispatchRoute(routes, context('POST', '/promotion/scorecards', {
    subjectKind: input.subjectKind,
    subjectName: input.subjectName,
    sourceKind: 'eval',
    sourceId: input.sourceId,
    metrics: [{ id: 'quality', score: input.score, maxScore: 1, passed: input.score >= 0.8 }],
    thresholds: [{ id: 'quality.min', metric: 'quality', minPercentage: 0.8 }],
    evidence: [`eval:${input.sourceId}`],
  }))
  expect(response?.status).toBe(201)
  return (response?.body as any).scorecard
}

async function requestAndApprovePromotion(routes: ReturnType<typeof createJsonRoutes>, input: { action: string; scorecardId?: string }) {
  return requestAndApproveSubjectPromotion(routes, { subjectKind: 'profile', subjectName: 'implementer', ...input })
}

async function requestAndApproveSubjectPromotion(routes: ReturnType<typeof createJsonRoutes>, input: { subjectKind: string; subjectName: string; action: string; scorecardId?: string }) {
  const pending = await dispatchRoute(routes, context('POST', '/promotion/decisions', input))
  const decision = (pending?.body as any).decision
  expect(pending?.status).toBe(202)
  await dispatchRoute(routes, context('POST', `/human-gates/${encodeURIComponent(decision.gateId)}/decision`, { decision: 'approve', actor: 'operator' }))
  const applied = await dispatchRoute(routes, context('POST', '/promotion/decisions', { decisionId: decision.id, gateId: decision.gateId }))
  return (applied?.body as any).decision
}

function envRun(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  return {
    id: 'env_http',
    name: 'local-node',
    backend: 'local-process',
    status: 'prepared',
    specHash: 'abc123',
    workdir: '/tmp/project',
    runtime: process.execPath,
    startedAt: '2026-06-14T00:00:00.000Z',
    updatedAt: '2026-06-14T00:00:00.000Z',
    ttlMs: 3600000,
    cleanup: { retainOnFailure: false, retainOnSuccess: false, state: 'pending' },
    resources: { timeoutMs: 3600000 },
    network: { mode: 'restricted' },
    secrets: { allowedNames: [] },
    preflight: { ok: true, checked: ['node'], missing: [], warnings: [], commandRefs: ['command -v node'] },
    artifacts: [],
    metadata: {},
    ...overrides,
  }
}
