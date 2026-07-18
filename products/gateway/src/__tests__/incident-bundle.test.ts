import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { buildIncidentBundle, writeIncidentBundle } from '../incident-bundle.js'
import { appendWorkEvent, clearWorkStateForTest, createRoadmap, createWorkTask, startWorkTaskRun, upsertAlert, upsertChannelBinding } from '../work-store.js'

describe('incident bundle', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-incident-bundle-test-'))
  const repoDir = path.join(testDir, 'repo')
  const stateDir = path.join(testDir, 'state')
  const store = path.join(stateDir, 'gateway.db')
  const now = new Date('2026-06-21T13:00:00.000Z')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = stateDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = stateDir
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN'] = 'operator-secret-token'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    updateConfig({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } } } as any)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN']
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('builds and writes redacted diagnostics with trace and SLO evidence', () => {
    const fixture = seedIncidentFixture()
    const bundle = buildIncidentBundle({
      alertId: fixture.alertId,
      target: { taskId: fixture.taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now,
    })
    const written = writeIncidentBundle(bundle, path.join(testDir, 'incident'))
    const serialized = JSON.stringify(bundle)
    const markdown = fs.readFileSync(written.markdownPath, 'utf-8')

    expect(bundle.manifest.status).toBe('blocked')
    expect(bundle.manifest.traceRootId).toMatch(/^trace_root_[a-f0-9]{16}$/)
    expect(bundle.manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(bundle.manifest.counts.auditLedger).toBeGreaterThan(0)
    expect(bundle.manifest.auditLedger.map(row => row.sourceEventType)).toEqual(expect.arrayContaining(['channel.delivery.failed']))
    expect(bundle.manifest.slo.map(row => row.id)).toEqual(expect.arrayContaining(['scheduler_latency', 'channel_delivery', 'progress_freshness']))
    expect(bundle.manifest.support).toMatchObject({
      releaseClaim: 'local_preview_support_observability_only',
      incidentBundle: expect.objectContaining({ status: 'redacted_local_supported' }),
    })
    expect(bundle.manifest.sourceFreshness.map(row => row.status)).toEqual(expect.arrayContaining(['degraded', 'unknown']))
    expect(bundle.manifest.failureClassification.map(row => row.code)).toEqual(expect.arrayContaining([
      'alert_channel_critical',
      'slo_channel_delivery_fail',
      'missing_evidence_refs',
    ]))
    expect(bundle.manifest.failureClassification.find(row => row.code === 'missing_evidence_refs')).toMatchObject({
      severity: 'warning',
      source: 'evidence',
    })
    expect(bundle.manifest.windows.traceTasks).toMatchObject({ limit: 10, shown: 10, omitted: expect.any(Number) })
    expect(bundle.manifest.windows.traceTasks.total).toBeGreaterThan(bundle.manifest.windows.traceTasks.shown)
    expect(bundle.manifest.windows.auditLedger).toMatchObject({ scope: 'selected', sourceLimit: 100, limit: 20 })
    expect(bundle.manifest.redaction.forbiddenContents).toEqual(expect.arrayContaining(['raw provider payloads', 'private transcripts', 'chat IDs', 'webhook URLs', 'bearer tokens', 'local private paths']))
    expect(bundle.manifest.redaction.transformations).toEqual(expect.arrayContaining(['session IDs are hashed', 'token-like and key-like values are redacted']))
    expect(bundle.manifest.pipeline).toMatchObject({
      mode: 'm41_evidence_pipeline_v2',
      surface: 'incident_bundle',
      status: 'pass',
      decision: {
        state: 'decision_blocked',
        claimChange: 'blocked',
      },
      acceptance: {
        validationGatePass: true,
        redactionGatePass: true,
        decisionGatePass: true,
        noReleaseClaimExpansion: true,
      },
    })
    expect(bundle.manifest.support.operatorActions.map(action => action.auditOperation)).toEqual(expect.arrayContaining(['operator.pause', 'operator.resume', 'operator.recover', 'storage.restore', 'evidence.export.redacted', 'incident.bundle.redacted']))
    expect(bundle.manifest.support.traceCoverage.auditLedger).toBeGreaterThan(0)
    expect(bundle.manifest.alerts[0]).toMatchObject({
      id: fixture.alertId,
      severity: 'critical',
      traceId: expect.stringMatching(/^trace_alert_[a-f0-9]{16}$/),
    })
    expect(markdown).toContain('Gateway Incident Bundle')
    expect(markdown).toContain('Trace root')
    expect(markdown).toContain('Evidence pipeline: pass')
    expect(markdown).toContain('Audit Ledger')
    expect(markdown).toContain('SLO Status')
    expect(markdown).toContain('Support Operations')
    expect(markdown).toContain('Source Freshness')
    expect(markdown).toContain('Failure Classification')
    expect(markdown).toContain('Output Windows')
    expect(markdown).toContain('local_preview_support_observability_only')
    expect(fs.statSync(written.manifestPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(written.markdownPath).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(written.evidenceDir, 'manifest.json'))).toBe(true)
    for (const raw of [
      'trusted-chat-42',
      'topic-private',
      'telegram-secret-token-value',
      'operator-secret-token',
      'private transcript body',
      'ses_private_incident',
      '/Users/joe/private-notes/incident.md',
    ]) {
      expect(serialized).not.toContain(raw)
      expect(markdown).not.toContain(raw)
    }
  })

  function seedIncidentFixture(): { taskId: string; runId: string; alertId: string } {
    const roadmap = createRoadmap({ title: 'Incident Roadmap' }, store)
    const task = createWorkTask({
      title: 'Incident task',
      description: 'private transcript body',
      roadmapId: roadmap.id,
      pipeline: ['verify'],
    }, store)
    for (let index = 0; index < 12; index++) {
      createWorkTask({
        title: `Incident bulk task ${index}`,
        description: 'windowing fixture',
        roadmapId: roadmap.id,
      }, store)
    }
    upsertChannelBinding({
      provider: 'telegram',
      chatId: 'trusted-chat-42',
      threadId: 'topic-private',
      sessionId: 'ses_private_incident',
      mode: 'task',
      taskId: task.id,
      title: 'Incident channel',
    }, store)
    const run = startWorkTaskRun(task.id, 'verify', 'ses_private_incident', 'verifier', store)!.run
    appendWorkEvent('channel.delivery.failed', task.id, {
      provider: 'telegram',
      chatId: 'trusted-chat-42',
      threadId: 'topic-private',
      error: 'private transcript body token=operator-secret-token',
      path: '/Users/joe/private-notes/incident.md',
    }, store)
    const { alert } = upsertAlert({
      key: 'incident:test',
      severity: 'critical',
      source: 'channel',
      target: task.id,
      summary: 'Telegram target trusted-chat-42 leaked private transcript body',
      evidence: ['telegram:trusted-chat-42:topic-private', '/Users/joe/private-notes/incident.md'],
      nextAction: 'Inspect /Users/joe/private-notes/incident.md and token operator-secret-token',
      details: { token: '123456:telegram-secret-token-value' },
    }, { now: now.getTime() }, store)
    return { taskId: task.id, runId: run.id, alertId: alert.id }
  }
})
