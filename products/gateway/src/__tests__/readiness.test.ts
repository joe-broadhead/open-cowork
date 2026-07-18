import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildReadinessReport, evaluateReadiness, formatReadinessText, type ReadinessCheck, type ReadinessReport } from '../readiness.js'
import { detectGatewayProfileDrift } from '../profile-drift.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { appendWorkEvent, clearWorkStateForTest, completeWorkTaskRun, createWorkTask, startWorkTaskRun, upsertChannelBinding } from '../work-store.js'
import { clearCurrentDaemonLeadershipForTest, createDaemonLeadership, setCurrentDaemonLeadership } from '../daemon-leadership.js'

describe('production readiness', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-readiness-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN']
    delete process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['WHATSAPP_ACCESS_TOKEN']
    delete process.env['WHATSAPP_VERIFY_TOKEN']
    delete process.env['WHATSAPP_APP_SECRET']
    delete process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED']
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    clearWorkStateForTest(path.join(testDir, 'missing-state', 'gateway.db'))
    clearConfigCacheForTest()
    clearCurrentDaemonLeadershipForTest()
    vi.restoreAllMocks()
  })

  it('returns ready when all checks pass', () => {
    expect(evaluateReadiness([check('opencode', 'pass'), check('storage', 'pass')])).toEqual({
      state: 'ready',
      summary: 'Gateway is ready for public local beta operation',
    })
  })

  it('returns degraded for warning checks', () => {
    expect(evaluateReadiness([check('opencode', 'pass'), check('scheduler', 'warn')])).toMatchObject({ state: 'degraded' })
  })

  it('returns not_ready for critical failures', () => {
    expect(evaluateReadiness([check('opencode', 'fail', 'critical')])).toMatchObject({ state: 'not_ready' })
  })

  it('formats concise operator text', () => {
    const text = formatReadinessText({
      state: 'degraded',
      summary: '1 readiness check needs attention',
      generatedAt: '2026-06-13T00:00:00.000Z',
      version: '1.2.0',
      mode: 'local_personal',
      checks: [check('scheduler', 'warn')],
      queue: { pending: 1, running: 0, blocked: 0, paused: 0 },
      scheduler: {},
      storage: {},
      requests: { questions: 0, permissions: 0 },
      sessions: {},
    } as ReadinessReport)

    expect(text).toContain('Readiness: degraded')
    expect(text).toContain('[warn] scheduler')
  })

  it('degrades read-only readiness when local state databases are unavailable', async () => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = path.join(testDir, 'missing-state')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('OpenCode offline'))

    const report = await buildReadinessReport(undefined, { readOnly: true })

    expect(report.queue['total']).toBe(0)
    expect(report.state).toBe('not_ready')
    expect(report.checks.find(check => check.name === 'opencode')).toMatchObject({ status: 'fail' })
    expect(report.checks.find(check => check.name === 'storage')).toMatchObject({ status: 'fail' })
    expect(JSON.stringify(report)).not.toContain('Fatal')
  })

  it('fails unsafe OpenCode URLs before daemon-side fetches', async () => {
    updateConfig({ opencodeUrl: 'http://169.254.169.254/latest/meta-data' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)

    const report = await buildReadinessReport(undefined, { readOnly: true })

    const opencode = report.checks.find(check => check.name === 'opencode')
    expect(opencode).toMatchObject({ status: 'fail' })
    expect(opencode?.summary).toContain('not allowed')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('surfaces standby daemon leadership as a readiness warning without raw daemon identifiers', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)
    const dbPath = path.join(testDir, 'gateway.db')
    const writer = createDaemonLeadership({ filePath: dbPath, daemonId: 'writer-secret-daemon', instanceId: 'writer-secret-instance', leaseMs: 60_000 })
    const standby = createDaemonLeadership({ filePath: dbPath, daemonId: 'standby-secret-daemon', instanceId: 'standby-secret-instance', leaseMs: 60_000 })
    writer.acquireOrRenew()
    standby.acquireOrRenew()
    setCurrentDaemonLeadership(standby)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const leadership = report.checks.find(check => check.name === 'daemon_leadership')

    expect(leadership).toMatchObject({
      status: 'warn',
      severity: 'warning',
      summary: 'Another Gateway daemon owns the local writer lease',
      details: expect.objectContaining({ mode: 'standby', canWrite: false }),
    })
    const serialized = JSON.stringify(leadership)
    expect(serialized).not.toContain('writer-secret-instance')
    expect(serialized).not.toContain('standby-secret-instance')
  })

  it('includes backend mode and hosted/team caveats in readiness storage summary', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const backend = (report.storage['backend'] || {}) as any

    expect(backend).toMatchObject({
      mode: 'local_sqlite',
      releaseStatus: 'supported_public_local_beta',
      effectivePersistence: 'local_sqlite',
      hostedTeamStatus: 'unsupported_until_m25_decision',
      activation: expect.objectContaining({
        mode: 'backend_activation',
        status: 'local_sqlite_default',
        cutoverReadiness: 'not_selectable',
        rollbackReadiness: 'drill_available_requires_verified_backup',
        supportedCommands: expect.arrayContaining([
          expect.objectContaining({ id: 'consistency_proof', command: 'opencode-gateway backend consistency-proof --json' }),
          expect.objectContaining({ id: 'durable_state_adapter', command: 'opencode-gateway backend durable-state-adapter --json' }),
        ]),
      }),
    })
    expect(report.storage['consistency']).toMatchObject({
      mode: 'm28_backend_consistency_proof',
      runtimeBackend: 'local_sqlite',
      effectivePersistence: 'local_sqlite',
      releaseClaim: 'tested_backend_modes_only_no_hosted_or_multi_tenant_storage_claim',
      backup: expect.objectContaining({ status: 'missing' }),
      rollback: expect.objectContaining({ status: 'blocked_missing_verified_backup' }),
    })
    expect(report.storage['durableStateAdapter']).toMatchObject({
      mode: 'm49_local_durable_state_adapter',
      releaseClaim: 'local_durable_state_adapter_only_no_hosted_or_managed_storage_claim',
      repair: expect.objectContaining({ implicitRepairAllowed: false }),
    })
    const storage = report.checks.find(check => check.name === 'storage')
    expect(storage?.summary).toContain('backend activation is local_sqlite_default')
    expect(storage?.summary).toContain('consistency proof is')
    expect(storage?.summary).toContain('adapter is')
    expect(storage?.details).toMatchObject({
      backend: expect.objectContaining({
        activation: expect.objectContaining({ currentReleaseClaim: 'local_sqlite_public_beta' }),
      }),
      consistency: expect.objectContaining({ mode: 'm28_backend_consistency_proof' }),
      durableStateAdapter: expect.objectContaining({ mode: 'm49_local_durable_state_adapter' }),
    })
    expect(backend.caveats.join('\n')).toContain('current public local beta')
  })


  it('detects stale Gateway-owned review profiles for readiness warnings', () => {
    const config = getConfig()
    const drift = detectGatewayProfileDrift({ ...config, profiles: { ...config.profiles, reviewer: { ...config.profiles['reviewer']!, skills: ['gateway-stage'] } } })

    expect(drift).toEqual([expect.objectContaining({ profile: 'reviewer', issues: [expect.stringContaining('missing skills')] })])
  })

  it('fails readiness when a configured channel has no allowlist', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'fixture-telegram-value'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })

    expect(report.state).toBe('not_ready')
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'security_channel_trust', status: 'fail', severity: 'critical' })]))
  })

  it('reduces local readiness catalog truth into actionable redacted readiness output', async () => {
    process.env['TELEGRAM_BOT_TOKEN'] = 'fixture-telegram-value'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const catalog = report.checks.find(check => check.name === 'local_readiness_catalog')

    expect(catalog).toMatchObject({
      status: 'fail',
      severity: 'critical',
      details: {
        mode: 'local_readiness_catalog_v1',
        totals: expect.objectContaining({ blocked: expect.any(Number), partial: expect.any(Number), waived: expect.any(Number) }),
        entries: expect.arrayContaining([
          expect.objectContaining({ id: 'runtime:opencode', status: 'supported', statusCode: 'opencode_reachable' }),
          expect.objectContaining({ id: 'setup:channel_credentials', status: 'blocked', statusCode: 'channel_credentials_or_setup_blocked' }),
          expect.objectContaining({ id: 'channel:telegram', status: 'blocked', statusCode: 'channel_trusted_target_pending' }),
        ]),
      },
    })
    expect(JSON.stringify(catalog)).not.toContain('fixture-telegram-value')
  })

  it('reports scoped HTTP token posture without leaking token values', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_READ_TOKEN'] = 'fixture-read-value'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)
    updateConfig({ security: { httpHost: '0.0.0.0', allowNonLocalHttp: true } } as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const boundary = report.checks.find(check => check.name === 'security_http_boundary')

    expect(boundary).toMatchObject({ status: 'pass', summary: 'Exposed HTTP mode has capability-scoped controls' })
    expect(boundary?.details).toMatchObject({ configured: true, capabilities: ['read'], routePolicy: 'capability-scoped' })
    expect(JSON.stringify(boundary)).not.toContain('fixture-read-value')
  })


  it('reports support observability posture with service levels and audited operator actions', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)
    const task = createWorkTask({ title: 'Support observability task', pipeline: ['verify'] })
    startWorkTaskRun(task.id, 'verify', 'ses_support_private', 'verifier')
    upsertChannelBinding({ provider: 'telegram', chatId: '123456789012', sessionId: 'ses_support_private', mode: 'task', taskId: task.id })
    appendWorkEvent('audit.security', task.id, {
      operation: 'operator.pause',
      actor: 'local_operator',
      result: 'ok',
      authorization: 'Bearer secret-review-token',
      evidence: 'token=secret-value',
      path: '/Users/joe/private/support.md',
    })

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const support = report.checks.find(check => check.name === 'support_observability')

    expect(support).toMatchObject({
      status: 'warn',
      severity: 'warning',
      summary: expect.stringContaining('trace coverage includes'),
      details: {
        releaseClaim: 'local_preview_support_observability_only',
        currentMode: 'local_public_beta',
        traceCoverage: expect.objectContaining({
          scheduler: 1,
          workers: 1,
          channels: 1,
          auditLedger: expect.any(Number),
        }),
        operatorActions: expect.arrayContaining([
          expect.objectContaining({ id: 'pause', auditOperation: 'operator.pause', safeByDefault: true }),
          expect.objectContaining({ id: 'resume', auditOperation: 'operator.resume', safeByDefault: true }),
          expect.objectContaining({ id: 'retry', auditOperation: 'operator.recover', safeByDefault: true }),
          expect.objectContaining({ id: 'rollback', auditOperation: 'storage.restore', safeByDefault: false }),
          expect.objectContaining({ id: 'evidence_export', auditOperation: 'evidence.export.redacted', safeByDefault: true }),
          expect.objectContaining({ id: 'incident_bundle', auditOperation: 'incident.bundle.redacted', safeByDefault: true }),
        ]),
        incidentBundle: expect.objectContaining({
          status: 'redacted_local_supported',
          forbiddenContents: expect.arrayContaining(['raw provider payloads', 'private transcripts', 'chat IDs', 'local private paths']),
        }),
        serviceLevels: expect.arrayContaining([
          expect.objectContaining({ mode: 'local_public_beta', releaseStatus: 'supported' }),
          expect.objectContaining({ mode: 'hosted_deferred', releaseStatus: 'deferred' }),
          expect.objectContaining({ mode: 'unsupported', releaseStatus: 'unsupported' }),
        ]),
        unsupportedClaims: expect.arrayContaining(['hosted SLO/SLA', 'managed support readiness', 'raw transcript telemetry']),
      },
    })
    expect(JSON.stringify(support)).not.toContain('secret-review-token')
    expect(JSON.stringify(support)).not.toContain('secret-value')
    expect(JSON.stringify(support)).not.toContain('/Users/joe/private')
    expect(JSON.stringify(support)).not.toContain('123456789012')
  })

  it('keeps historical support failures visible without release-blocking readiness when live work is clean', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)
    const task = createWorkTask({ title: 'Historical support task', pipeline: ['verify'] })
    const started = startWorkTaskRun(task.id, 'verify', 'ses_historical_support_private', 'verifier')!.run
    completeWorkTaskRun(started.id, {
      status: 'fail',
      summary: 'old failure with private transcript',
      feedback: 'Bearer historical-secret-token',
      artifacts: [],
      evidence: [{ type: 'log', ref: '/Users/joe/private/historical-support.log', summary: 'token=historical-secret-token' }],
      raw: 'private transcript token=historical-secret-token',
    }, 1)
    appendWorkEvent('channel.delivery.failed', task.id, {
      provider: 'telegram',
      chatId: '123456789012',
      threadId: 'historical-topic',
      error: 'Bearer historical-secret-token',
      path: '/Users/joe/private/historical-support.log',
    })

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const support = report.checks.find(check => check.name === 'support_observability')!

    expect(support).toMatchObject({
      status: 'warn',
      severity: 'warning',
      details: {
        supportSignals: expect.arrayContaining([
          expect.objectContaining({
            id: 'slo_channel_delivery',
            status: 'attention',
            severity: 'warning',
            source: 'observability_slo.channel_delivery',
            recommendedAction: expect.stringContaining('historical channel failure'),
            releaseBlocking: false,
          }),
        ]),
      },
    })
    const serialized = JSON.stringify({ support })
    expect(serialized).not.toContain('historical-secret-token')
    expect(serialized).not.toContain('/Users/joe/private')
    expect(serialized).not.toContain('123456789012')
    expect(serialized).not.toContain('historical-topic')
    expect(serialized).not.toContain('ses_historical_support_private')
  })


  it('reports secret lifecycle posture without treating disabled channel flags as configured', async () => {
    process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] = 'false'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const secrets = report.checks.find(check => check.name === 'security_secret_lifecycle')

    expect(secrets).toMatchObject({
      status: 'pass',
      severity: 'info',
      summary: expect.stringContaining('value-free secret references'),
      details: {
        mode: 'local_operator_managed',
        releaseStatus: 'supported_public_local_beta',
        vaultStatus: 'local_reference_adapter_preview',
        hostedTeamStatus: 'unsupported_until_m25_decision',
        teamPreviewStatus: 'bounded_scoped_injection_preview',
        rawSecretPolicy: 'never_in_durable_work_or_evidence',
        scopedInjection: {
          implemented: true,
          defaultPolicy: 'deny_unknown_or_overbroad_requests',
          rawValuePolicy: 'in_memory_only',
          providerScopeEnforced: true,
          revokedReferencesDenied: true,
          staleRotationDenied: true,
        },
        operatorPosture: {
          mode: 'local_and_team_preview_secret_lifecycle',
          redacted: true,
          injectionGuardrails: expect.objectContaining({
            exactReferences: true,
            providerScopeEnforced: true,
            revokedReferencesDenied: true,
            staleRotationDenied: true,
          }),
        },
      },
    })
    expect((secrets?.details?.['configuredInputs'] as any[]) || []).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'discord_alpha_enabled' }),
    ]))
  })

  it('fails secret lifecycle readiness for WhatsApp credentials without an app secret and does not leak values', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)
    updateConfig({
      channels: {
        whatsapp: {
          accessToken: 'fixture-whatsapp-value',
          verifyToken: 'whatsapp-verify-secret',
        },
      },
    } as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const secrets = report.checks.find(check => check.name === 'security_secret_lifecycle')

    expect(secrets).toMatchObject({
      status: 'fail',
      severity: 'critical',
      details: {
        configuredInputs: expect.arrayContaining([
          expect.objectContaining({ id: 'whatsapp_access_token', configuredVia: ['local_config'], configKeys: ['channels.whatsapp.accessToken'] }),
          expect.objectContaining({ id: 'whatsapp_verify_token', configuredVia: ['local_config'], configKeys: ['channels.whatsapp.verifyToken'] }),
        ]),
        risks: expect.arrayContaining([
          expect.objectContaining({ code: 'local_config_secret_storage', inputId: 'whatsapp_access_token', severity: 'warning' }),
          expect.objectContaining({ code: 'whatsapp_signature_secret_missing', inputId: 'whatsapp_app_secret', severity: 'critical' }),
        ]),
        operatorPosture: expect.objectContaining({
          rotationHealth: expect.objectContaining({ blocked: expect.any(Number), due: expect.any(Number) }),
        }),
      },
    })
    expect(JSON.stringify(secrets)).not.toContain('fixture-whatsapp-value')
    expect(JSON.stringify(secrets)).not.toContain('whatsapp-verify-secret')
  })

  it('reports audit retention posture without claiming hosted compliance ledger support', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const audit = report.checks.find(check => check.name === 'compliance_audit_retention')

    expect(audit).toMatchObject({
      status: 'pass',
      severity: 'info',
      summary: expect.stringContaining('append-only local ledger foundation'),
      details: {
        mode: 'local_beta_redacted_evidence',
        releaseStatus: 'supported_public_local_beta',
        complianceLedgerStatus: 'local_append_only_foundation_not_certified',
        hostedStatus: 'unsupported',
        localEvidenceStatus: 'redacted_evidence_and_incident_bundles_supported',
        rawTranscriptPolicy: 'never_in_compliance_audit_or_shareable_evidence',
        eventClasses: expect.arrayContaining(['security_decision', 'evidence_export', 'extension_change']),
        retentionClasses: expect.arrayContaining(['security_audit', 'incident_evidence', 'team_compliance_ledger']),
        supportedSurfaces: expect.arrayContaining(['workflow_events', 'redacted_evidence_export', 'incident_bundles', 'append_only_audit_ledger']),
        designOnlySurfaces: expect.arrayContaining(['extension_package_governance']),
        ledger: expect.objectContaining({
          storage: 'gateway.db:audit_ledger',
          appendOnly: true,
          hashChained: true,
          certification: 'not_certified_compliance_storage',
        }),
      },
    })
    expect(JSON.stringify(audit)).not.toContain('synthetic-live-provider-token')
  })


  it('treats unsafe exposed HTTP no-auth mode as a critical failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }) as any)
    updateConfig({ security: { httpHost: '0.0.0.0', allowNonLocalHttp: true, unsafeAllowNoAuth: true } } as any)

    const report = await buildReadinessReport({ session: { list: async () => ({ data: [] }) } })
    const boundary = report.checks.find(check => check.name === 'security_http_boundary')

    expect(report.state).toBe('not_ready')
    expect(boundary).toMatchObject({ status: 'fail', severity: 'critical' })
  })
})

function check(name: string, status: ReadinessCheck['status'], severity: ReadinessCheck['severity'] = 'warning'): ReadinessCheck {
  return { name, status, severity, summary: `${name} ${status}` }
}
