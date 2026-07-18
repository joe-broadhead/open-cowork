import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { aggregateServiceHealth, buildServiceHealthReport, type ServiceHealthComponent } from '../service-health.js'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { clearHeartbeatForTest } from '../heartbeat.js'
import { clearWorkStateForTest, createWorkTask, upsertChannelBinding, upsertProjectBinding } from '../work-store.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'

describe('service health', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-service-health-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearHeartbeatForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearCurrentDaemonLeadershipForTest()
    updateConfig({
      channels: {
        telegram: { botToken: '123456:test-token' },
        whatsapp: {},
      },
      security: {
        channelAllowlists: { telegram: [{ chatId: 'chat-1' }], whatsapp: [] },
      },
    } as any)
  })

  afterEach(() => {
    clearHeartbeatForTest()
    clearCurrentDaemonLeadershipForTest()
    clearConfigCacheForTest()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
  })

  it('aggregates component status and attention deterministically', () => {
    const rows: ServiceHealthComponent[] = [
      { id: 'daemon', label: 'Daemon', status: 'ok', summary: 'up', remediation: 'none' },
      { id: 'storage', label: 'Storage', status: 'degraded', summary: 'slow', remediation: 'inspect disk' },
      { id: 'opencode', label: 'OpenCode Connectivity', status: 'down', summary: 'offline', remediation: 'start OpenCode' },
    ]

    const report = aggregateServiceHealth(rows)

    expect(report.status).toBe('down')
    expect(report.counts).toEqual({ ok: 1, degraded: 1, down: 1 })
    expect(report.attention.map(row => row.id)).toEqual(['storage', 'opencode'])
    expect(report.summary).toContain('2 of 3')
  })

  it('keeps deferred/non-blocking components visible without blocking health', () => {
    const rows: ServiceHealthComponent[] = [
      { id: 'daemon', label: 'Daemon', status: 'ok', summary: 'up', remediation: 'none' },
      { id: 'storage', label: 'Storage', status: 'degraded', summary: 'stale historical session refs', remediation: 'rebind when proving recovery', releaseBlocking: false, deferred: true },
      { id: 'channel:whatsapp', label: 'WhatsApp Adapter', status: 'degraded', summary: 'optional credentials missing', remediation: 'configure when needed', releaseBlocking: false, deferred: true },
    ]

    const report = aggregateServiceHealth(rows)

    expect(report.status).toBe('ok')
    expect(report.counts).toEqual({ ok: 1, degraded: 2, down: 0 })
    expect(report.releaseBlockingCounts).toEqual({ ok: 1, degraded: 0, down: 0 })
    expect(report.attention).toEqual([])
    expect(report.deferred.map(row => row.id)).toEqual(['storage', 'channel:whatsapp'])
    expect(report.summary).toContain('deferred/non-blocking')
  })

  it('reports failed OpenCode connectivity with an actionable remediation', async () => {
    const report = await buildServiceHealthReport({
      daemon: { pid: 123, uptime: 45, port: 4097 },
      opencodeReachable: false,
    })

    const opencode = report.components.find(row => row.id === 'opencode')
    expect(report.status).toBe('down')
    expect(opencode).toMatchObject({
      status: 'down',
      summary: 'OpenCode health endpoint is unreachable.',
      remediation: expect.stringContaining('Start OpenCode'),
    })
    expect(report.attention.map(row => row.id)).toContain('opencode')
  })

  it('surfaces storage doctor warnings as service health attention', async () => {
    createWorkTask({ title: 'Storage health target' })
    fs.writeFileSync(path.join(testDir, 'events.json'), '{"broken"', { mode: 0o600 })

    const report = await buildServiceHealthReport({
      daemon: { pid: 123, uptime: 45, port: 4097 },
      opencodeReachable: true,
    })
    const storage = report.components.find(row => row.id === 'storage')

    expect(storage).toMatchObject({
      status: 'degraded',
      summary: 'Gateway storage has consistency warnings.',
      evidence: expect.objectContaining({
        status: 'degraded',
        issues: expect.arrayContaining([
          expect.objectContaining({ code: 'json_artifact_corrupt', sourceId: 'events_sidecar' }),
        ]),
      }),
    })
    expect(report.attention.map(row => row.id)).toContain('storage')
    expect(JSON.stringify(storage)).not.toContain(testDir)
  })

  it('classifies historical session/receipt storage drift as visible but non-blocking for local beta', async () => {
    const task = createWorkTask({ title: 'Historical storage drift target' })
    upsertProjectBinding({ alias: 'stale-session-project', roadmapId: task.roadmapId, sessionId: 'ses_missing_sidecar' })
    fs.writeFileSync(path.join(testDir, 'sessions.json'), JSON.stringify({ sessions: [] }), { mode: 0o600 })

    const report = await buildServiceHealthReport({
      daemon: { pid: 123, uptime: 45, port: 4097 },
      opencodeReachable: true,
    })
    const storage = report.components.find(row => row.id === 'storage')

    expect(storage).toMatchObject({
      status: 'degraded',
      summary: 'Gateway storage has non-blocking local-beta consistency warnings.',
      releaseBlocking: false,
      deferred: true,
      evidence: expect.objectContaining({
        releaseBlockingIssueCodes: [],
        nonBlockingIssueCodes: expect.arrayContaining(['project_binding_session_missing']),
        localBetaWaiver: 'historical_session_receipt_attention_visible_non_blocking',
      }),
    })
    expect(report.attention.map(row => row.id)).not.toContain('storage')
    expect(report.deferred.map(row => row.id)).toContain('storage')
    expect(storage?.remediation).toContain('project/channel rebind')
    expect(JSON.stringify(storage)).not.toContain('ses_missing_sidecar')
  })

  it('treats unconfigured optional providers as deferred local-beta notes', async () => {
    const report = await buildServiceHealthReport({
      daemon: { pid: 123, uptime: 45, port: 4097 },
      opencodeReachable: true,
    })

    const whatsapp = report.components.find(row => row.id === 'channel:whatsapp')
    const discord = report.components.find(row => row.id === 'channel:discord')
    expect(whatsapp).toMatchObject({
      status: 'degraded',
      releaseBlocking: false,
      deferred: true,
      evidence: expect.objectContaining({ localBetaOptional: true }),
    })
    expect(discord).toMatchObject({
      status: 'degraded',
      releaseBlocking: false,
      deferred: true,
      evidence: expect.objectContaining({ localBetaOptional: true }),
    })
    expect(report.attention.map(row => row.id)).not.toContain('channel:whatsapp')
    expect(report.attention.map(row => row.id)).not.toContain('channel:discord')
    expect(report.deferred.map(row => row.id)).toEqual(expect.arrayContaining(['channel:whatsapp', 'channel:discord']))
  })

  it('reports standby leadership state without raw daemon identifiers', async () => {
    const dbPath = path.join(testDir, 'gateway.db')
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'writer-secret-daemon', instanceId: 'writer-secret-instance', leaseMs: 60_000 })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'standby-secret-daemon', instanceId: 'standby-secret-instance', leaseMs: 60_000 })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    const report = await buildServiceHealthReport({ opencodeReachable: true })
    const leadership = report.components.find(row => row.id === 'leadership')

    expect(leadership).toMatchObject({
      status: 'degraded',
      summary: 'Another Gateway daemon owns the local writer lease.',
      evidence: expect.objectContaining({ mode: 'standby', canWrite: false }),
    })
    expect(JSON.stringify(leadership)).not.toContain('writer-secret-instance')
    expect(JSON.stringify(leadership)).not.toContain('standby-secret-instance')
  })

  it('surfaces the WhatsApp Cloud API setup path without leaking provider secrets', async () => {
    updateConfig({
      channels: {
        whatsapp: {
          setupMode: 'cloudApiDirect',
          accessToken: 'wa-access-token-placeholder',
        },
      },
    } as any)

    const report = await buildServiceHealthReport({ opencodeReachable: true })
    const whatsapp = report.components.find(row => row.id === 'channel:whatsapp')

    expect(whatsapp).toBeTruthy()
    expect(whatsapp?.evidence?.['activeSetupPath']).toBe('cloud_api_direct')
    expect(whatsapp?.evidence?.['setupPaths']).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'cloud_api_direct', status: 'implemented' }),
    ]))
    expect(JSON.stringify(report)).not.toContain('wa-access-token-placeholder')
  })

  it('reports Discord alpha health with precise signed-webhook and trust prerequisites', async () => {
    updateConfig({
      channels: {
        discord: { enabled: true, botToken: 'discord-secret-token', publicKey: '11'.repeat(32) },
      },
      security: {
        channelAllowlists: { discord: [] },
      },
    } as any)

    const degraded = await buildServiceHealthReport({ opencodeReachable: true })
    expect(degraded.components.find(row => row.id === 'channel:discord')).toMatchObject({
      status: 'degraded',
      summary: expect.stringContaining('no channel allowlist'),
      remediation: expect.stringContaining('security.channelAllowlists'),
    })
    expect(JSON.stringify(degraded)).not.toContain('discord-secret-token')

    updateConfig({
      channels: {
        discord: { enabled: true, botToken: 'discord-secret-token', publicKey: '11'.repeat(32) },
      },
      security: {
        channelAllowlists: { discord: [{ chatId: 'discord-channel-1' }] },
      },
    } as any)

    const boundProofPending = await buildServiceHealthReport({ opencodeReachable: true })
    expect(boundProofPending.components.find(row => row.id === 'channel:discord')).toMatchObject({
      status: 'degraded',
      summary: 'Discord interaction webhook route is not exposed to Discord.',
      remediation: expect.stringContaining('/webhooks/discord'),
      evidence: {
        connectorState: 'webhook_needed',
        diagnostics: expect.arrayContaining(['callback_url_missing', 'binding_missing']),
      },
    })
    expect(JSON.stringify(boundProofPending)).not.toContain('discord-secret-token')
  })

  it('reports Telegram service health as ready once trusted and bound', async () => {
    const pending = await buildServiceHealthReport({ opencodeReachable: true })
    expect(pending.components.find(row => row.id === 'channel:telegram')).toMatchObject({
      status: 'degraded',
      evidence: {
        connectorState: 'trusted_target_pending',
      },
    })

    upsertChannelBinding({ provider: 'telegram', chatId: 'chat-1', sessionId: 'ses_1' })

    const ready = await buildServiceHealthReport({ opencodeReachable: true })
    expect(ready.components.find(row => row.id === 'channel:telegram')).toMatchObject({
      status: 'ok',
      summary: 'Telegram adapter is ready.',
      evidence: {
        connectorState: 'ready',
      },
    })
    expect(JSON.stringify(ready)).not.toContain('chat-1')
  })
})
