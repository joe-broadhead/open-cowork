import { describe, expect, it } from 'vitest'
import { buildSupportOperationsContract, buildTraceCorrelationIndex, countChannelFailureEvents, evaluateObservabilitySLOs, summarizeObservabilityForCli, traceCorrelationId } from '../observability-contract.js'
import type { WorkState } from '../work-store.js'

describe('observability contract', () => {
  it('builds deterministic trace IDs across tasks, runs, channels, evidence, and alerts', () => {
    const state = fixtureState()
    const trace = buildTraceCorrelationIndex({
      state,
      generatedAt: '2026-06-21T12:00:00.000Z',
      events: [{ id: 7, type: 'delegation.progress', subjectId: 'task_trace', payload: {}, createdAt: '2026-06-21T12:00:05.000Z' } as any],
      channelBindings: [{ provider: 'telegram', chatId: 'private-chat-123', sessionId: 'ses_private', taskId: 'task_trace', mode: 'task', createdAt: '', updatedAt: '' } as any],
      alerts: [{ id: 'alert_trace', key: 'run:stale', severity: 'warning', status: 'active', source: 'scheduler', target: 'run_trace', summary: 'stale', nextAction: 'inspect', evidence: [], firstSeenAt: '', lastSeenAt: '', dedupeCount: 1, details: {} } as any],
      auditLedger: [{ eventId: 'audit_evt_1', traceId: 'trace_audit_demo', action: 'operator.pause', result: 'ok', retentionClass: 'security_audit', correlationId: 'ses_private', evidenceRefs: ['/Users/joe/private/support.md', 'incident:demo'] } as any],
    })

    expect(trace.traceRootId).toMatch(/^trace_root_[a-f0-9]{16}$/)
    expect(trace.tasks[0]).toMatchObject({
      taskId: 'task_trace',
      traceId: traceCorrelationId('task', 'task_trace'),
      runTraceIds: [traceCorrelationId('run', 'task_trace', 'run_trace', 'verify')],
    })
    expect(trace.runs[0]).toMatchObject({
      runId: 'run_trace',
      taskTraceId: traceCorrelationId('task', 'task_trace'),
      sessionHash: expect.stringMatching(/^[a-f0-9]{12}$/),
    })
    expect(trace.channels[0]).toMatchObject({
      provider: 'telegram',
      targetHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      taskTraceId: traceCorrelationId('task', 'task_trace'),
    })
    expect(trace.evidence[0]).toMatchObject({
      ref: 'file:artifact.md',
      runTraceId: traceCorrelationId('run', 'task_trace', 'run_trace', 'verify'),
    })
    expect(trace.auditLedger[0]).toMatchObject({
      eventId: 'audit_evt_1',
      traceId: 'trace_audit_demo',
      action: 'operator.pause',
      correlationId: expect.stringMatching(/^<redacted:session:[a-f0-9]{12}>$/),
      evidenceRefs: expect.arrayContaining(['incident:demo']),
    })
    expect(trace.auditLedger[0]!.evidenceRefs.join('\n')).toContain('<redacted:evidence-ref:')
    expect(JSON.stringify(trace)).not.toContain('private-chat-123')
    expect(JSON.stringify(trace)).not.toContain('ses_private')
  })

  it('evaluates local SLO budgets and formats a CLI summary', () => {
    const state = fixtureState({
      taskCreatedAt: '2026-06-21T11:30:00.000Z',
      runStartedAt: '2026-06-21T11:45:00.000Z',
    })
    const slo = evaluateObservabilitySLOs({
      state,
      now: Date.parse('2026-06-21T12:00:00.000Z'),
      events: [{ id: 8, type: 'channel.delivery.failed', subjectId: 'task_trace', payload: { error: 'provider failed' }, createdAt: '2026-06-21T11:40:00.000Z' } as any],
      channelFailureCount: 1,
      dashboardRenderMs: 1250,
    })
    const summary = summarizeObservabilityForCli({ traceRootId: 'trace_root_demo' }, slo)

    expect(slo.find(row => row.id === 'run_dispatch')?.status).toBe('fail')
    expect(slo.find(row => row.id === 'run_dispatch')?.releaseBlocking).toBe(true)
    expect(slo.find(row => row.id === 'channel_delivery')?.status).toBe('fail')
    expect(slo.find(row => row.id === 'channel_delivery')?.releaseBlocking).toBe(true)
    expect(slo.find(row => row.id === 'dashboard_render')?.status).toBe('warn')
    expect(summary.status).toBe('fail')
    expect(summary.line).toContain('Trace: trace_root_demo')
    expect(summary.line).toContain('SLO: fail')

    const skewed = evaluateObservabilitySLOs({
      state: fixtureState(),
      now: Date.parse('2026-06-21T12:00:00.000Z'),
      events: [{ id: 9, type: 'delegation.progress', subjectId: 'task_trace', payload: {}, createdAt: '2026-06-21T12:05:00.000Z' } as any],
    })
    expect(skewed.find(row => row.id === 'progress_freshness')?.observedMs).toBe(0)

    expect(countChannelFailureEvents([
      { id: 10, type: 'channel.delivery.failed', subjectId: 'task_trace', payload: { error: 'chat not found' }, createdAt: '2026-06-21T12:00:00.000Z' } as any,
      { id: 11, type: 'delegation.progress', subjectId: 'task_trace', payload: { status: 'sent' }, createdAt: '2026-06-21T12:00:00.000Z' } as any,
    ])).toBe(1)
  })

  it('keeps historical completed dispatch and channel failures visible without release-blocking support readiness', () => {
    const state = completedHistoricalState()
    const slo = evaluateObservabilitySLOs({
      state,
      now: Date.parse('2026-06-21T12:30:00.000Z'),
      events: [
        { id: 12, type: 'channel.delivery.failed', subjectId: 'task_done', payload: { error: 'old provider failure' }, createdAt: '2026-06-21T10:00:00.000Z' } as any,
      ],
      channelFailureCount: 1,
      dashboardRenderMs: 800,
    })
    const trace = buildTraceCorrelationIndex({ state, generatedAt: '2026-06-21T12:30:00.000Z' })
    const contract = buildSupportOperationsContract({ generatedAt: '2026-06-21T12:30:00.000Z', trace, slo })

    expect(slo.find(row => row.id === 'run_dispatch')).toMatchObject({
      status: 'pass',
      releaseBlocking: false,
    })
    expect(slo.find(row => row.id === 'channel_delivery')).toMatchObject({
      status: 'warn',
      releaseBlocking: false,
      recommendedAction: expect.stringContaining('historical channel failure'),
    })
    expect(contract.status).toBe('degraded')
    expect(contract.supportSignals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'slo_channel_delivery',
        status: 'attention',
        severity: 'warning',
        source: 'observability_slo.channel_delivery',
        observedAt: '2026-06-21T12:30:00.000Z',
        releaseBlocking: false,
        recommendedAction: expect.stringContaining('historical channel failure'),
        evidenceRefs: expect.arrayContaining(['observedMs=300001']),
      }),
    ]))
    expect(contract.supportSignals.filter(signal => signal.releaseBlocking)).toHaveLength(0)
  })

  it('builds a support operations contract without hosted or managed-support overclaims', () => {
    const trace = buildTraceCorrelationIndex({
      state: fixtureState(),
      generatedAt: '2026-06-21T12:00:00.000Z',
      auditLedger: [{ eventId: 'audit_evt_pause', traceId: 'trace_audit_pause', action: 'operator.pause', result: 'ok', retentionClass: 'security_audit', evidenceRefs: ['audit:pause'] } as any],
    })
    const slo = evaluateObservabilitySLOs({
      state: fixtureState(),
      now: Date.parse('2026-06-21T12:00:00.000Z'),
      dashboardRenderMs: 800,
    })
    const contract = buildSupportOperationsContract({ generatedAt: '2026-06-21T12:00:00.000Z', trace, slo })

    expect(contract.status).toBe('ready')
    expect(contract.releaseClaim).toBe('local_preview_support_observability_only')
    expect(contract.supportSignals.find(signal => signal.id === 'slo_run_dispatch')).toMatchObject({
      status: 'pass',
      severity: 'info',
      releaseBlocking: false,
      source: 'observability_slo.run_dispatch',
      observedAt: '2026-06-21T12:00:00.000Z',
      recommendedAction: expect.any(String),
    })
    expect(contract.traceCoverage).toMatchObject({ scheduler: 1, workers: 1, auditLedger: 1 })
    expect(contract.operatorActions.map(action => action.id)).toEqual(expect.arrayContaining(['pause', 'resume', 'retry', 'rollback', 'evidence_export', 'incident_bundle']))
    expect(contract.operatorActions.find(action => action.id === 'rollback')).toMatchObject({ safeByDefault: false, auditOperation: 'storage.restore' })
    expect(contract.incidentBundle.forbiddenContents).toEqual(expect.arrayContaining(['raw provider payloads', 'private transcripts', 'chat IDs', 'local private paths']))
    expect(contract.serviceLevels.find(level => level.mode === 'hosted_deferred')).toMatchObject({ releaseStatus: 'deferred' })
    expect(contract.unsupportedClaims).toEqual(expect.arrayContaining(['hosted SLO/SLA', 'managed support readiness']))
  })

  it('redacts provider payloads and raw task/run refs from support alert signals', () => {
    const contract = buildSupportOperationsContract({
      generatedAt: '2026-06-21T12:00:00.000Z',
      alerts: [{
        id: 'alert_provider_payload',
        key: 'telegram:delivery',
        severity: 'warning',
        status: 'active',
        source: 'telegram',
        target: 'task_private',
        summary: 'Provider payload should not leak',
        nextAction: 'Inspect provider payload',
        evidence: [
          'telegram:123456789012:private-topic',
          'HTTP 400: {"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
          'task=task_123456789 run=run_987654321',
        ],
        firstSeenAt: '2026-06-21T11:59:00.000Z',
        lastSeenAt: '2026-06-21T12:00:00.000Z',
        dedupeCount: 1,
        details: {},
      } as any],
    })
    const signal = contract.supportSignals.find(row => row.id.startsWith('alert_'))!
    const serialized = JSON.stringify(signal)

    expect(signal).toMatchObject({
      status: 'attention',
      severity: 'warning',
      source: 'alert.telegram',
      summary: 'Alert telegram is active with warning severity.',
      recommendedAction: 'Review the redacted alert context and resolve or suppress it before using support evidence.',
    })
    expect(serialized).toContain('<redacted:id>')
    expect(serialized).toContain('<redacted:provider-payload:')
    expect(serialized).not.toContain('123456789012')
    expect(serialized).not.toContain('private-topic')
    expect(serialized).not.toContain('"error_code"')
    expect(serialized).not.toContain('task_123456789')
    expect(serialized).not.toContain('run_987654321')
  })
})

function fixtureState(options: { taskCreatedAt?: string; runStartedAt?: string } = {}): WorkState {
  const createdAt = options.taskCreatedAt || '2026-06-21T11:59:00.000Z'
  const runStartedAt = options.runStartedAt || '2026-06-21T11:59:10.000Z'
  return {
    version: 1,
    roadmaps: [{ id: 'roadmap_trace', title: 'Trace Roadmap', status: 'active', priority: 'MEDIUM', createdAt, updatedAt: createdAt } as any],
    tasks: [{ id: 'task_trace', roadmapId: 'roadmap_trace', title: 'Trace task', description: 'Trace safely', status: 'running', priority: 'HIGH', agent: 'gateway', pipeline: ['verify'], currentRunId: 'run_trace', attempts: {}, createdAt, updatedAt: createdAt } as any],
    runs: [{ id: 'run_trace', taskId: 'task_trace', stage: 'verify', sessionId: 'ses_private', profile: 'verifier', status: 'running', attempt: 1, startedAt: runStartedAt, result: { evidence: [{ type: 'file', ref: 'file:artifact.md', summary: 'safe' }], artifacts: [], raw: '', status: 'unknown', summary: '' } } as any],
    dependencies: [],
    projectBindings: [],
    completionProposals: [],
    supervisors: [],
    humanGates: [],
    promotionScorecards: [],
    promotionDecisions: [],
    workEnvironments: [],
  } as any
}

function completedHistoricalState(): WorkState {
  const createdAt = '2026-06-21T09:00:00.000Z'
  const startedAt = '2026-06-21T09:30:00.000Z'
  const completedAt = '2026-06-21T09:45:00.000Z'
  return {
    version: 1,
    roadmaps: [{ id: 'roadmap_done', title: 'Done Roadmap', status: 'done', priority: 'MEDIUM', createdAt, updatedAt: completedAt } as any],
    tasks: [{ id: 'task_done', roadmapId: 'roadmap_done', title: 'Done task', description: 'Historical only', status: 'done', priority: 'HIGH', agent: 'gateway', pipeline: ['verify'], attempts: {}, createdAt, updatedAt: completedAt } as any],
    runs: [{ id: 'run_done', taskId: 'task_done', stage: 'verify', sessionId: 'ses_private_done', profile: 'verifier', status: 'failed', attempt: 1, startedAt, completedAt, result: { status: 'fail', summary: 'old failure', artifacts: [], evidence: [], raw: '' } } as any],
    dependencies: [],
    projectBindings: [],
    completionProposals: [],
    supervisors: [],
    humanGates: [],
    promotionScorecards: [],
    promotionDecisions: [],
    workEnvironments: [],
  } as any
}
