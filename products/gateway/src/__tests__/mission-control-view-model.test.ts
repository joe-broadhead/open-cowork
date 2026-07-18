import { describe, expect, it } from 'vitest'
import {
  buildOperationsCockpit,
  buildMissionControlDashboardSummary,
  buildMissionControlDataPlaneV2,
  buildMissionControlSourceSummary,
  buildMissionControlSourceStateViewModel,
  buildObservabilitySourceContract,
  formatMissionControlDataPlaneText,
  formatMissionControlEnvironmentCounts,
  missionControlWindow,
  parseMissionControlWindowOptions,
  selectEvidenceWindowRows,
  validateMissionControlDashboardContract,
} from '../mission-control-view-model.js'

describe('Mission Control view-model contracts', () => {
  it('windows high-volume rows with stable ordering and source-specific search', () => {
    const rows = Array.from({ length: 75 }, (_, index) => ({
      id: `task_${String(index).padStart(2, '0')}`,
      title: index % 3 === 0 ? `Deploy issue ${index}` : `Other issue ${index}`,
      priority: index % 7 === 0 ? 'HIGH' : 'LOW',
    }))

    const result = missionControlWindow('tasks', rows, {
      all: { search: 'ignored-by-source-search' },
      tasks: { search: 'Deploy', limit: 5, offset: 3 },
    })

    expect(result.rows.map(row => row.id)).toEqual(['task_09', 'task_12', 'task_15', 'task_18', 'task_21'])
    expect(result.contract).toMatchObject({
      key: 'tasks',
      state: 'partial',
      total: 75,
      matched: 25,
      shown: 5,
      limit: 5,
      offset: 3,
      hasMore: true,
      truncated: true,
      search: 'Deploy',
    })
  })

  it('represents loading, empty, partial, stale, degraded, blocked, missing, and error source states without UI logic', () => {
    expect(missionControlWindow('runs', [], {}, true).contract).toMatchObject({ available: true, state: 'empty' })
    expect(missionControlWindow('runs', [{ id: 'run_1' }], { runs: { limit: 1 } }, true).contract).toMatchObject({ available: true, state: 'ready' })
    expect(missionControlWindow('runs', [{ id: 'run_1' }, { id: 'run_2' }], { runs: { limit: 1 } }, true).contract).toMatchObject({ available: true, state: 'partial' })
    expect(missionControlWindow('runs', [], {}, { state: 'loading' }).contract).toMatchObject({ available: true, state: 'loading' })
    expect(missionControlWindow('runs', [], {}, { state: 'stale', diagnostic: 'Cache older than freshness window.' }).contract).toMatchObject({ available: true, state: 'stale', diagnostic: 'Cache older than freshness window.' })
    expect(missionControlWindow('runs', [{ id: 'run_stale' }], {}, { checkedAt: '2026-06-23T10:00:00.000Z', nowMs: Date.parse('2026-06-23T10:10:01.000Z'), freshnessMs: 10 * 60 * 1000 }).contract)
      .toMatchObject({ available: true, state: 'stale', severity: 'warning', ageMs: 601000, nextAction: expect.stringContaining('Refresh Runs') })
    expect(missionControlWindow('runs', [], {}, { state: 'blocked', nextAction: 'Restart the OpenCode source adapter.' }).contract).toMatchObject({ available: true, state: 'blocked', severity: 'critical', nextAction: 'Restart the OpenCode source adapter.' })
    expect(missionControlWindow('runs', [], {}, { available: false, state: 'missing' }).contract).toMatchObject({ available: false, state: 'missing', severity: 'warning' })
    expect(missionControlWindow('runs', [], {}, false).contract).toMatchObject({ available: false, state: 'degraded' })
    expect(missionControlWindow('runs', [], {}, { available: false, state: 'error', diagnostic: 'Source adapter threw.' }).contract).toMatchObject({ available: false, state: 'error', diagnostic: 'Source adapter threw.' })
  })

  it('parses bounded Mission Control URL window options and clamps source limits', () => {
    const options = parseMissionControlWindowOptions(new URLSearchParams('q=run&tasksLimit=999&tasksOffset=4&sessions.search=alpha&runs.limit=7&runs.offset=2&runs.search=verify'))
    const taskRows = Array.from({ length: 700 }, (_, index) => ({ id: `task_${index}`, title: `run task ${index}` }))
    const sessionRows = [{ id: 'ses_alpha' }, { id: 'ses_beta' }]
    const runRows = Array.from({ length: 12 }, (_, index) => ({ id: `run_${index}`, stage: index % 2 === 0 ? 'verify' : 'implement' }))

    const tasks = missionControlWindow('tasks', taskRows, options)
    const sessions = missionControlWindow('sessions', sessionRows, options)
    const runs = missionControlWindow('runs', runRows, options)

    expect(tasks.contract).toMatchObject({ limit: 500, offset: 4, matched: 700, shown: 500, state: 'partial' })
    expect(sessions.contract).toMatchObject({ search: 'alpha', matched: 1, shown: 1, state: 'ready' })
    expect(runs.contract).toMatchObject({ search: 'verify', matched: 6, limit: 7, offset: 2, shown: 4, state: 'partial' })
    expect(runs.rows.map(row => row.id)).toEqual(['run_4', 'run_6', 'run_8', 'run_10'])
  })

  it('builds observability and evidence contracts as pure calculations', () => {
    const observability = buildObservabilitySourceContract(
      {
        traceRootId: 'trace_root',
        generatedAt: '2026-06-21T19:00:00.000Z',
        tasks: [{ taskId: 'task_1', traceId: 'trace_task_1', status: 'running', runTraceIds: ['trace_run_1'] }],
        runs: [{ runId: 'run_1', taskId: 'task_1', traceId: 'trace_run_1', taskTraceId: 'trace_task_1', stage: 'verify', status: 'passed', sessionHash: 'ses_hash' }],
        events: [],
        channels: [],
        evidence: [],
        alerts: [],
        auditLedger: [],
      },
      [{
        id: 'dashboard_render',
        label: 'Dashboard render',
        thresholdMs: 2000,
        warningMs: 1000,
        description: 'bounded',
        status: 'warn',
        observedMs: 1200,
        releaseBlocking: false,
        summary: 'render warning',
        recommendedAction: 'Capture Mission Control render timing.',
        evidence: [],
      }],
      { all: { search: 'render' } },
      true,
    )
    const evidence = [{ id: 'scorecard_1' }, { id: 'scorecard_2' }]
    const decisions = [{ id: 'decision_1' }, { id: 'scorecard_2' }]

    expect(observability).toMatchObject({ key: 'observability', state: 'ready', total: 4, matched: 1, shown: 4, search: 'render' })
    expect(selectEvidenceWindowRows(decisions, evidence)).toEqual([{ id: 'scorecard_2' }])
    expect(selectEvidenceWindowRows([{ id: 'decision_2' }], evidence)).toEqual([])
    expect(buildObservabilitySourceContract(undefined, [], {}, { available: false, state: 'error', diagnostic: 'observability source unavailable' })).toMatchObject({
      key: 'observability',
      available: false,
      state: 'error',
      diagnostic: 'observability source unavailable',
      total: 0,
      shown: 0,
    })
  })

  it('builds shared dashboard summary fields for Mission Control and MCP surfaces', () => {
    const summary = buildMissionControlDashboardSummary({
      health: { status: 'ok', scheduler: { enabled: false, maxConcurrent: 2, defaultPipeline: ['implement', 'verify'] } },
      taskData: {
        counts: { pending: 1, running: 1, done: 2, blocked: 0, paused: 1, archived: 4 },
        tasks: [
          { id: 'task_running', status: 'running', priority: 'HIGH', title: 'Running task', agent: 'gateway-implementer', currentStage: 'verify' },
          { id: 'task_done', status: 'done', priority: 'LOW', title: 'Done task', agent: 'gateway-verifier' },
        ],
        roadmaps: [
          { id: 'roadmap_active', status: 'active', priority: 'HIGH', title: 'Launch' },
          { id: 'roadmap_archived', status: 'archived', priority: 'LOW', title: 'Old' },
        ],
        runs: [{ id: 'run_1', status: 'running', sessionId: 'ses_run' }],
      },
      sessions: { sessions: [{ id: 'ses_known' }], counts: { running: 0, total: 1 } },
      questions: { questions: [{ id: 'q1' }] },
      permissions: { permissions: [{ id: 'p1' }, { id: 'p2' }] },
      attention: { attention: { summary: '1 item requires review' } },
      environments: { environments: [{ status: 'prepared' }, { status: 'blocked' }, { status: 'retained' }, { status: 'cleanup_failed' }] },
      operationsCockpit: buildOperationsCockpit({
        readiness: { checks: [] },
      }),
    })

    expect(summary).toMatchObject({
      status: 'ok',
      scheduler: 'paused | 2 max | implement -> verify',
      taskCounts: '1 pending | 1 running | 2 done | 0 blocked | 1 paused | 4 archived',
      gatewaySessions: '1 running / 2 total',
      environments: '2 active | 1 retained | 1 cleanup failed',
      requests: '1 questions | 2 permissions',
      attention: '1 item requires review',
      operationsCockpit: expect.objectContaining({ status: 'blocked' }),
      activeIssues: [{ id: 'task_running', status: 'running', priority: 'HIGH', title: 'Running task', agent: 'gateway-implementer', currentStage: 'verify' }],
      initiatives: [{ id: 'roadmap_active', status: 'active', priority: 'HIGH', title: 'Launch' }],
    })
    expect(summary.activeIssues.map(task => task.id)).not.toContain('task_done')
    expect(summary.initiatives.map(roadmap => roadmap.id)).not.toContain('roadmap_archived')
    expect(formatMissionControlEnvironmentCounts([{ status: 'blocked' }, { status: 'retained' }, { cleanup: { state: 'failed' } }]))
      .toBe('1 active | 1 retained | 1 cleanup failed')
  })

  it('validates dashboard summary input contracts before consumers assume object shapes', () => {
    const valid = validateMissionControlDashboardContract({
      health: { status: 'ok' },
      taskData: { counts: {}, tasks: [], roadmaps: [], runs: [] },
      sessions: { sessions: [], counts: {} },
      questions: { questions: [] },
      permissions: { permissions: [] },
    })
    expect(valid).toMatchObject({
      schemaVersion: 1,
      mode: 'mission_control_dashboard_input_contract',
      status: 'pass',
      deterministicOrdering: 'preserve_source_order_filter_in_view_model',
      redaction: 'support_safe_ids_only',
      failures: [],
    })
    expect(valid.requiredFields).toEqual(expect.arrayContaining([
      'health.status',
      'taskData.tasks',
      'sessions.sessions',
      'permissions.permissions',
    ]))

    const invalid = validateMissionControlDashboardContract({
      health: {},
      taskData: { counts: {}, tasks: [] },
      sessions: { sessions: [] },
      questions: {},
      permissions: { permissions: [] },
    } as any)
    expect(invalid.status).toBe('fail')
    expect(invalid.failures.map(row => row.field)).toEqual(expect.arrayContaining([
      'health.status',
      'taskData.roadmaps',
      'taskData.runs',
      'sessions.counts',
      'questions.questions',
    ]))

    const summary = buildMissionControlDashboardSummary({
      health: {},
      taskData: { counts: {}, tasks: [] },
      sessions: { sessions: [] },
      questions: {},
      permissions: { permissions: [] },
    } as any)
    expect(summary.attention).toContain('Mission Control input contract failed')
  })

  it('summarizes source-state contracts for dashboard and MCP consumers from the same query shape', () => {
    const query = {
      windows: { tasks: { limit: 1 }, sessions: { limit: 1 } },
      nowMs: Date.parse('2026-06-23T12:00:00.000Z'),
      freshnessMs: 5 * 60 * 1000,
    }
    const tasks = missionControlWindow('tasks', [{ id: 'task_1' }, { id: 'task_2' }], query.windows, true).contract
    const sessions = missionControlWindow('sessions', [{ id: 'ses_1' }], query.windows, {
      checkedAt: '2026-06-23T11:50:00.000Z',
      nowMs: query.nowMs,
      freshnessMs: query.freshnessMs,
    }).contract
    const runs = missionControlWindow('runs', [], query.windows, {
      available: false,
      state: 'error',
      diagnostic: 'OpenCode run source failed with Bearer abc123.',
      nextAction: 'Restart OpenCode with token=abc123 and retry the source query.',
    }).contract
    const sourceSummary = buildMissionControlSourceSummary([tasks, sessions, runs])
    const dashboardSummary = buildMissionControlDashboardSummary({
      health: { status: 'degraded' },
      taskData: { counts: {}, tasks: [], roadmaps: [] },
      sessions: { sessions: [], counts: {} },
      questions: { questions: [] },
      permissions: { permissions: [] },
      sourceContracts: [tasks, sessions, runs],
    })

    expect(sourceSummary).toMatchObject({
      status: 'error',
      severity: 'critical',
      counts: expect.objectContaining({ partial: 1, stale: 1, error: 1 }),
    })
    expect(sourceSummary.items.find(item => item.key === 'sessions')).toMatchObject({
      state: 'stale',
      nextAction: expect.stringContaining('Refresh Sessions'),
    })
    expect(sourceSummary.items.find(item => item.key === 'runs')).toMatchObject({
      diagnostic: 'OpenCode run source failed with Bearer <redacted>',
      nextAction: 'Restart OpenCode with token=<redacted> and retry the source query.',
    })
    expect(dashboardSummary.sources).toMatchObject({
      status: 'error',
      summary: sourceSummary.summary,
      items: expect.arrayContaining([expect.objectContaining({ key: 'runs', nextAction: 'Restart OpenCode with token=<redacted> and retry the source query.' })]),
    })
    expect(JSON.stringify({ sourceSummary, dashboardSources: dashboardSummary.sources })).not.toMatch(/abc123|Bearer abc123/)
  })

  it('builds a decomposed source-state view model for dashboard rendering and operator actions', () => {
    const query = {
      windows: {
        tasks: { limit: 2 },
        roadmaps: { limit: 2 },
        runs: { limit: 1 },
        sessions: { limit: 1 },
        environments: { limit: 5 },
      },
      nowMs: Date.parse('2026-06-30T12:00:00.000Z'),
      freshnessMs: 5 * 60 * 1000,
    }
    const sources = [
      missionControlWindow('roadmaps', [{ id: 'roadmap_alpha' }], query.windows, true).contract,
      missionControlWindow('tasks', Array.from({ length: 8 }, (_, index) => ({ id: `task_${index}`, title: `Task ${index}` })), query.windows, true).contract,
      missionControlWindow('runs', [], query.windows, true).contract,
      missionControlWindow('sessions', [{ id: 'ses_stale' }], query.windows, {
        checkedAt: '2026-06-30T11:50:00.000Z',
        nowMs: query.nowMs,
        freshnessMs: query.freshnessMs,
      }).contract,
      missionControlWindow('environments', [], query.windows, { available: false, state: 'missing', diagnostic: 'Adapter token=abc123 unavailable.' }).contract,
      buildObservabilitySourceContract(undefined, [], query.windows || {}, { available: false, state: 'error', diagnostic: 'Trace adapter failed with Bearer abc123.' }),
      missionControlWindow('alerts', [], query.windows, { state: 'blocked', nextAction: 'Clear the alert source blocker.' }).contract,
    ]
    const view = buildMissionControlSourceStateViewModel({
      sourceContracts: sources,
      generatedAt: '2026-06-30T12:00:00.000Z',
      highVolumeThreshold: 5,
      evidenceLinks: {
        all: ['doc:docs/operations/m53-mission-control-decomposition.md'],
        tasks: ['doc:docs/operations/m44-mission-control-cli-operator-cockpit-scale.md'],
      },
    })

    expect(view).toMatchObject({
      schemaVersion: 1,
      mode: 'mission_control_source_state_view_model',
      generatedAt: '2026-06-30T12:00:00.000Z',
      status: 'error',
      severity: 'critical',
      releaseClaimBoundary: 'local_beta_read_model_only_no_hosted_arbitrary_scale_or_unattended_claim',
      counts: {
        sources: 7,
        totalRows: 10,
        shownRows: 4,
        truncatedSources: 1,
        highVolumeSources: 1,
        unavailableSources: 2,
        staleSources: 1,
        blockedOrErrorSources: 2,
      },
      window: {
        bounded: true,
        deterministicOrdering: 'preserve_contract_order',
        sourceKeys: ['roadmaps', 'tasks', 'runs', 'sessions', 'environments', 'observability', 'alerts'],
        highVolumeThreshold: 5,
      },
      actionAvailability: {
        inspect: 1,
        paginate: 1,
        refresh: 1,
        repair: 3,
        wait: 0,
        none: 1,
      },
      redaction: 'support_safe_ids_routes_actions_only',
      acceptance: {
        deterministicOrdering: true,
        boundedWindows: true,
        degradedSourcesVisible: true,
        actionAvailabilityRecorded: true,
        evidenceLinksSupportSafe: true,
        noReleaseClaimExpansion: true,
      },
      issues: [],
    })
    expect(view.sources.map(source => source.key)).toEqual(['roadmaps', 'tasks', 'runs', 'sessions', 'environments', 'observability', 'alerts'])
    expect(view.sources.find(source => source.key === 'tasks')).toMatchObject({
      totals: { total: 8, shown: 2, highVolume: true },
      operatorAction: { kind: 'paginate', available: true },
      evidenceLinks: expect.arrayContaining([
        'source:tasks',
        'route:/tasks',
        'doc:docs/operations/m53-mission-control-decomposition.md',
        'doc:docs/operations/m44-mission-control-cli-operator-cockpit-scale.md',
      ]),
    })
    expect(view.sources.find(source => source.key === 'sessions')).toMatchObject({
      freshness: { state: 'stale', ageMs: 600000, freshnessMs: 300000 },
      operatorAction: { kind: 'refresh', available: true },
    })
    expect(view.sources.find(source => source.key === 'runs')).toMatchObject({
      state: 'empty',
      operatorAction: { kind: 'none', available: false },
    })
    expect(view.sources.find(source => source.key === 'environments')?.diagnostic).toContain('token=<redacted>')
    expect(view.sources.find(source => source.key === 'observability')?.operatorAction.reason).toContain('Bearer <redacted>')
    expect(view.attention).toEqual(expect.arrayContaining([
      expect.stringContaining('Issues: Use pagination'),
      expect.stringContaining('Sessions: Refresh Sessions'),
      expect.stringContaining('Trace and SLOs: Fix Trace and SLOs source errors'),
    ]))
    expect(JSON.stringify(view)).not.toMatch(/abc123|Bearer abc123|telegram:\d{6,}|whatsapp:\d{6,}|\/Users\/|\/var\/folders\//i)
  })

  it('builds the M41 Mission Control data plane from bounded source contracts', () => {
    const tasks = missionControlWindow('tasks', Array.from({ length: 25 }, (_, index) => ({ id: `task_${index}` })), { tasks: { limit: 10 } }).contract
    const sessions = missionControlWindow('sessions', [{ id: 'ses_1' }], {}, {
      checkedAt: '2026-06-25T10:00:00.000Z',
      nowMs: Date.parse('2026-06-25T10:04:00.000Z'),
      freshnessMs: 5 * 60 * 1000,
    }).contract
    const dataPlane = buildMissionControlDataPlaneV2({
      sourceContracts: [tasks, sessions],
      consumers: ['dashboard', 'mcp', 'support'],
      generatedAt: '2026-06-25T10:04:00.000Z',
    })
    const text = formatMissionControlDataPlaneText(dataPlane).join('\n')

    expect(dataPlane).toMatchObject({
      schemaVersion: 1,
      mode: 'm41_mission_control_data_plane_v2',
      status: 'bounded',
      releaseClaimBoundary: 'local_beta_high_volume_read_model_only_no_hosted_or_unattended_claim',
      windowTotals: {
        sources: 2,
        totalRows: 26,
        matchedRows: 26,
        shownRows: 11,
        truncatedSources: 1,
        blockedOrErrorSources: 0,
      },
      acceptance: {
        boundedWindows: true,
        readOnlyProjection: true,
        sharedTruthVocabulary: true,
        supportSafeSummary: true,
        noReleaseClaimExpansion: true,
      },
      errors: [],
    })
    expect(dataPlane.consumers.map(row => row.consumer)).toEqual(['dashboard', 'mcp', 'support'])
    expect(dataPlane.consumers.every(row => row.truthVocabulary === 'mission_control_source_contracts' && row.readOnly && row.redaction === 'support_safe')).toBe(true)
    expect(dataPlane.unsupportedClaims).toEqual(expect.arrayContaining([
      'hosted mission control readiness',
      'unattended production dashboard operation',
      'arbitrary-scale dashboard readiness',
    ]))
    expect(text).toContain('Data Plane: bounded')
    expect(text).toContain('Rows: 11/26 shown across 2 sources')
  })

  it('builds M27 operations cockpit statuses from readiness, channels, and partial sources', () => {
    const cockpit = buildOperationsCockpit({
      channels: {
        certification: {
          summary: 'Telegram certified; WhatsApp blocked; Discord deferred.',
          certifiedProviders: ['telegram'],
          partialProviders: [],
          blockedProviders: ['whatsapp'],
          deferredProviders: ['discord'],
          unsupportedClaims: ['universal channel readiness'],
        },
      },
      readiness: {
        checks: [
          { name: 'storage', status: 'pass', details: { backend: { mode: 'local_sqlite', activation: { status: 'local_sqlite_default', cutoverReadiness: 'not_selectable', rollbackReadiness: 'drill_available', supportedCommands: [{ id: 'consistency_proof', command: 'opencode-gateway backend consistency-proof --json' }, { id: 'preflight', command: 'opencode-gateway backend preflight --json' }] } }, consistency: { status: 'pass', backup: { status: 'verified' }, rollback: { status: 'drill_available' }, releaseClaim: 'tested_backend_modes_only_no_hosted_or_multi_tenant_storage_claim', blockedStates: [], unsupportedClaims: ['hosted managed database'] } } },
          { name: 'security_secret_lifecycle', status: 'pass', summary: 'Secret lifecycle is value-free.' },
          { name: 'compliance_audit_retention', status: 'pass', summary: 'Audit retention supports redacted local evidence.' },
        ],
      },
      operator: { generatedAt: '2026-06-22T00:00:00.000Z', releaseClaim: { productionCertified: false, scope: 'Public local beta only.', notes: ['Hosted and multi-tenant deferred.'] } },
      sourceDiagnostics: [{ source: 'opencode_sessions', available: false, summary: 'OpenCode session source unavailable' }],
    })

    expect(cockpit.status).toBe('attention')
    expect(cockpit.items.find(item => item.id === 'backend_activation')).toMatchObject({
      status: 'ready',
      command: 'opencode-gateway backend consistency-proof --json',
      summary: expect.stringContaining('consistency pass'),
      claim: 'tested_backend_modes_only_no_hosted_or_multi_tenant_storage_claim',
    })
    expect(cockpit.items.find(item => item.id === 'worker_fleet')).toBeUndefined()
    expect(cockpit.items.find(item => item.id === 'agent_evals')).toBeUndefined()
    expect(cockpit.items.find(item => item.id === 'mission_control_sources')).toMatchObject({ status: 'stale' })
    expect(JSON.stringify(cockpit)).not.toContain('Bearer')
    expect(cockpit.unsupportedClaims).toEqual(expect.arrayContaining(['hosted SaaS readiness', 'multi-tenant production readiness']))
  })
})
