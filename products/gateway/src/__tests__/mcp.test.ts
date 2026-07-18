import { afterEach, describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { GatewayDaemonError, activeRunControlToolText, activeRunListToolText, fetchJSON, formatArtifactManifestSummary, formatBulkTaskCreateText, formatDaemonError, formatEnvironmentActionText, formatEnvironmentListText, formatEnvironmentReconcileText, formatGatewayDashboardText, formatOpenCodeSessionWebUrlToolResult, formatReachableGatewayToolCatalogText, formatSchedulerRunOnceText, limitText, readResponseTextBounded, runTool } from '../mcp.js'
import { buildOperationsCockpit, buildMissionControlDashboardSummary, missionControlWindow } from '../mission-control-view-model.js'
import { formatTaskCounts, isActiveTaskStatus } from '../task-summary.js'

describe('mcp helpers', () => {
  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN']
    delete process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE']
    vi.restoreAllMocks()
  })

  it('bounds long tool output', () => {
    expect(limitText('abcdef', 3)).toBe('abc\n\n[truncated 3 characters]')
  })

  it('bounds daemon response consumption by bytes before JSON parsing', async () => {
    const response = new Response('12345', { status: 200 })
    await expect(readResponseTextBounded(response, 4)).rejects.toMatchObject({
      name: 'GatewayDaemonError',
      status: 200,
      message: 'Gateway daemon response exceeds 4 bytes',
    })
  })

  it('keeps the request deadline active while consuming the response body', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input: any, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'))
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
        },
      })
      return new Response(body, { status: 200 }) as any
    })

    const pending = fetchJSON('GET', '/health')
    const rejection = expect(pending).rejects.toThrow('timed out after 15000ms')
    await vi.advanceTimersByTimeAsync(15_001)
    await rejection
    vi.useRealTimers()
  })

  it('advertises only tools reachable in the active MCP tier', () => {
    const read = formatReachableGatewayToolCatalogText('read')
    const operate = formatReachableGatewayToolCatalogText('operate')
    const admin = formatReachableGatewayToolCatalogText('admin')

    expect(read).toContain('gateway_health [read]')
    expect(read).not.toContain('gateway_task_create')
    expect(operate).toContain('gateway_task_create [operate]')
    expect(operate).toContain('gateway_blueprint_preview [operate]')
    expect(operate).not.toContain('gateway_blueprint_apply')
    expect(admin).toContain('gateway_blueprint_apply [admin]')
    expect(admin).toContain('gateway_agent_team_validate [admin]')
  })

  it('formats daemon errors for tool output', () => {
    const text = formatDaemonError(new GatewayDaemonError('Gateway daemon unreachable at http://127.0.0.1:4097: connection failed. Start it with: opencode-gateway start'))
    expect(text).toContain('Gateway error:')
    expect(text).toContain('opencode-gateway start')
  })

  it('marks failed tool calls as MCP error results', async () => {
    const result = await runTool(async () => {
      throw new GatewayDaemonError('bad input', 400)
    })

    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Gateway error:')
    expect(result.content[0]!.text).toContain('bad input')
  })

  it('surfaces non-2xx daemon responses with bounded bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x'.repeat(3000), { status: 502, statusText: 'Bad Gateway' }) as any)

    try {
      await fetchJSON('GET', '/broken')
      throw new Error('expected fetchJSON to throw')
    } catch (err: any) {
      expect(err).toMatchObject({ name: 'GatewayDaemonError', status: 502 })
      expect(err.message).toContain('[truncated')
    }
  })

  it('rejects successful non-JSON daemon responses clearly', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>proxy login</html>', { status: 200 }) as any)

    try {
      await fetchJSON('GET', '/html')
      throw new Error('expected fetchJSON to throw')
    } catch (err: any) {
      expect(err.message).toContain('non-JSON response')
      expect(err.message).toContain('GET /html')
    }
  })

  it('returns empty objects for successful empty daemon responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 200 }) as any)

    await expect(fetchJSON('GET', '/empty')).resolves.toEqual({})
  })

  it('uses scoped admin token for daemon authorization when configured', async () => {
    process.env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] = ' scoped-admin-token '
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }) as any)

    await fetchJSON('GET', '/health')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer scoped-admin-token',
      'X-Gateway-Actor': 'mcp',
    })
  })

  it('reads an owner-only operator token file for daemon authorization', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-mcp-token-'))
    const tokenFile = path.join(dir, 'operator-token')
    fs.writeFileSync(tokenFile, 'scoped-operator-token\n', { mode: 0o600 })
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE'] = tokenFile
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }) as any)

    try {
      await fetchJSON('POST', '/tasks', { title: 'from MCP' })
      expect((fetchSpy.mock.calls[0]?.[1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer scoped-operator-token',
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed when an explicitly configured operator token file is not owner-only', async () => {
    if (process.platform === 'win32') return
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-mcp-token-'))
    const tokenFile = path.join(dir, 'operator-token')
    fs.writeFileSync(tokenFile, 'unsafe-operator-token\n', { mode: 0o644 })
    process.env['OPENCODE_GATEWAY_HTTP_OPERATOR_TOKEN_FILE'] = tokenFile
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    try {
      await expect(fetchJSON('POST', '/tasks', { title: 'from MCP' })).rejects.toThrow('could not safely read')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('proxies active run MCP helpers through operator-scoped daemon routes', async () => {
    const calls: Array<{ method: string; path: string; body?: any }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push({
        method: String(init?.method || 'GET'),
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (url.pathname === '/operator/status') return new Response(JSON.stringify({ operator: { activeRuns: [{ runId: 'run_1', heartbeatFreshness: 'fresh' }] } }), { status: 200 }) as any
      if (url.pathname === '/operator/runs/run_1/actions') return new Response(JSON.stringify({ activeRunControl: { control: { action: 'retry', outcome: 'applied', reason: 'applied', restartBehavior: 'durable_requeue_only', nextAction: 'Scheduler will retry durable Gateway work for the same stage without reusing the current session.' } } }), { status: 200 }) as any
      return new Response('{}', { status: 404 }) as any
    })

    const listed = await activeRunListToolText()
    const controlled = await activeRunControlToolText({ runId: 'run_1', action: 'retry', expectedLeaseOwner: 'daemon-a', expectedSchedulerGeneration: 'gen-a', note: 'operator retry' })

    expect(listed).toContain('"runId": "run_1"')
    expect(controlled).toContain('Run control: retry')
    expect(controlled).toContain('Restart behavior: durable_requeue_only')
    expect(calls).toEqual([
      { method: 'GET', path: '/operator/status' },
      { method: 'POST', path: '/operator/runs/run_1/actions', body: { action: 'retry', expectedLeaseOwner: 'daemon-a', expectedSchedulerGeneration: 'gen-a', note: 'operator retry' } },
    ])
  })

  it('preserves bare Web URL output for the opencode_session_web_url tool', () => {
    expect(formatOpenCodeSessionWebUrlToolResult({
      webUrl: 'http://127.0.0.1:4096/abc/session/ses_1',
      linksText: 'OpenCode Web: http://127.0.0.1:4096/abc/session/ses_1\nWeb recovery: use fallback',
    })).toBe('http://127.0.0.1:4096/abc/session/ses_1')
    expect(formatOpenCodeSessionWebUrlToolResult({
      webUrl: null,
      linksText: 'OpenCode Web: unavailable\nOpenCode TUI: opencode --session ses_1',
    })).toContain('OpenCode TUI: opencode --session ses_1')
  })

  it('formats malformed artifact manifest data without leaking raw refs or throwing', () => {
    expect(formatArtifactManifestSummary(null as any, true)).toContain('Artifact manifest: unknown')
    const malformed = formatArtifactManifestSummary({
      id: 'artifact_manifest_test',
      runId: 'run_1',
      taskId: 'task_1',
      stage: 'verify',
      counts: { available: 1 },
      retentionPolicies: [],
      workspace: { localOnly: true, hostedCollaboration: false },
      entries: 'not-an-array',
    }, true)

    expect(malformed).toContain('Artifact manifest: artifact_manifest_test')
    expect(malformed).toContain('Entries: available=1')
    expect(malformed).not.toContain('not-an-array')
  })

  it('formats dashboard text from plain data without daemon actions', () => {
    const operationsCockpit = buildOperationsCockpit({
      readiness: { checks: [{ name: 'security_authorization_model', status: 'pass', summary: 'Selected-surface team preview only.' }] },
    })
    const input = {
      health: { status: 'ok', scheduler: { enabled: true, maxConcurrent: 3, defaultPipeline: ['implement', 'review', 'verify'] } },
      taskData: {
        counts: { pending: 1, running: 1, done: 2, blocked: 1, paused: 0, archived: 3 },
        tasks: [
          { id: 'task_1', status: 'running', priority: 'HIGH', title: 'Ship it', agent: 'gateway-implementer', currentStage: 'implement' },
          { id: 'task_done', status: 'done', priority: 'LOW', title: 'Done already', agent: 'gateway-verifier' },
        ],
        roadmaps: [{ id: 'roadmap_1', status: 'active', priority: 'HIGH', title: 'Launch' }, { id: 'roadmap_old', status: 'archived', priority: 'LOW', title: 'Old' }],
      },
      sessions: { counts: { running: 1, total: 4 } },
      questions: { questions: [{ id: 'q1' }] },
      permissions: { permissions: [{ id: 'p1' }, { id: 'p2' }] },
      environments: { environments: [{ status: 'prepared' }, { status: 'retained' }, { status: 'cleanup_failed', cleanup: { state: 'failed' } }] },
      operationsCockpit,
      sourceContracts: [
        missionControlWindow('tasks', [{ id: 'task_1' }, { id: 'task_2' }], { tasks: { limit: 1 } }).contract,
        missionControlWindow('sessions', [], {}, { available: false, state: 'error', nextAction: 'Restart OpenCode session source.' }).contract,
      ],
    }
    const summary = buildMissionControlDashboardSummary(input)
    const text = formatGatewayDashboardText(input)

    expect(text).toContain(`Scheduler: ${summary.scheduler}`)
    expect(text).toContain(`Gateway Sessions: ${summary.gatewaySessions}`)
    expect(text).toContain(`Environments: ${summary.environments}`)
    expect(text).toContain(`Issues (tasks): ${summary.taskCounts}`)
    expect(text).toContain(`Requests: ${summary.requests}`)
    expect(text).toContain(`Sources: ${summary.sources?.summary}`)
    expect(text).toContain('- [partial] tasks:')
    expect(text).toContain('Restart OpenCode session source.')
    expect(text).toContain('Data Plane: blocked')
    expect(text).toContain('Consumers: mcp, dashboard, support share mission_control_source_contracts')
    expect(text).toContain('local_beta_high_volume_read_model_only_no_hosted_or_unattended_claim')
    expect(text).toContain(`Operations Cockpit: ${summary.operationsCockpit?.status}`)
    expect(text).toContain('- [running] HIGH: Ship it (task_1)')
    expect(text).toContain('- [active] HIGH: Launch (roadmap_1)')
    expect(text).not.toContain('task_done')
    expect(text).not.toContain('roadmap_old')
  })

  it('counts active durable runs as running Gateway sessions', () => {
    const text = formatGatewayDashboardText({
      health: { status: 'ok', scheduler: { enabled: true, maxConcurrent: 3, defaultPipeline: ['implement'] } },
      taskData: {
        counts: { pending: 0, running: 1, done: 0, blocked: 0, paused: 0, archived: 0 },
        tasks: [],
        roadmaps: [],
        runs: [{ id: 'run_1', status: 'running', sessionId: 'ses_active' }],
      },
      sessions: { sessions: [{ id: 'ses_old' }], counts: { running: 0, total: 1 } },
      questions: { questions: [] },
      permissions: { permissions: [] },
    })

    expect(text).toContain('Gateway Sessions: 1 running / 2 total')
  })

  it('formats dashboard scheduler health from component reports without legacy scheduler fields', () => {
    const text = formatGatewayDashboardText({
      health: {
        status: 'degraded',
        components: [{ id: 'scheduler', status: 'degraded', summary: 'Scheduler is enabled but has not completed a heartbeat yet.' }],
        counts: { ok: 7, degraded: 1, down: 0 },
      },
      taskData: { counts: {}, tasks: [], roadmaps: [] },
      sessions: { sessions: [], counts: { running: 0, total: 0 } },
      questions: { questions: [] },
      permissions: { permissions: [] },
    })

    expect(text).toContain('Scheduler: degraded | Scheduler is enabled but has not completed a heartbeat yet.')
    expect(text).not.toContain('Scheduler: paused | 0 max |')
  })

  it('formats environment operator tool results compactly', () => {
    const listed = formatEnvironmentListText({ environments: [
      { id: 'env_1', name: 'local-node', backend: 'local-process', status: 'prepared', runId: 'run_1', cleanup: { state: 'pending' }, runtimeProfile: { filesystem: { policy: 'local-workdir' }, network: { mode: 'restricted' }, cwd: { redacted: '~/repo' } } },
      { id: 'env_2', name: 'remote', backend: 'remote-crabbox', status: 'cleanup_failed', runId: 'run_2', cleanup: { state: 'failed' }, lifecycleDiagnostics: [{ severity: 'critical', code: 'cleanup_failed' }] },
    ] })
    const action = formatEnvironmentActionText({ eventType: 'environment.aborted', abortedSessionId: 'ses_1', environment: { id: 'env_1', name: 'local-node', status: 'released', cleanup: { state: 'released' } } })
    const reconciled = formatEnvironmentReconcileText({ reconciliation: { checked: 2, active: 1, retained: 0, cleanupFailed: 1, evidence: ['local-process: checked=1'] } })

    expect(listed).toContain('2 environment(s): 1 active | 0 retained | 1 cleanup failed')
    expect(listed).toContain('[cleanup_failed] remote')
    expect(listed).toContain('runtime local-workdir net=restricted cwd=~/repo')
    expect(listed).toContain('diagnostic critical:cleanup_failed')
    expect(action).toContain('environment.aborted: local-node')
    expect(action).toContain('Aborted session: ses_1')
    expect(reconciled).toContain('checked=2 active=1 retained=0 cleanupFailed=1')
  })

  it('formats bulk creates and scheduler runs as compact operator summaries', () => {
    const bulk = formatBulkTaskCreateText({ created: 2, tasks: [
      { id: 'task_1', title: 'One', priority: 'HIGH', pipeline: ['implement', 'verify'] },
      { id: 'task_2', title: 'Two', priority: 'LOW', pipeline: ['audit'] },
    ] })
    expect(bulk).toContain('Created 2 task(s)')
    expect(bulk).toContain('One (task_1)')
    expect(bulk).not.toContain('description')

    const run = formatSchedulerRunOnceText({ counts: { pending: 0, running: 1, done: 2, blocked: 0, paused: 0, cancelled: 1 }, activeTasks: [{ id: 'task_run', title: 'Running', status: 'running', currentStage: 'verify' }], recentRuns: [{ id: 'run_1', stage: 'verify', status: 'running', sessionId: 'ses_1' }] })
    expect(run).toContain('Scheduler cycle complete.')
    expect(run).toContain('0 pending | 1 running | 2 done')
    expect(run).toContain('Running (task_run)')
    expect(run.length).toBeLessThan(1000)
  })

  it('shares task count and active status formatting across surfaces', () => {
    expect(formatTaskCounts({ pending: 1, running: 2, done: 3, blocked: 4, paused: 5, cancelled: 6, archived: 7 }, { includeCancelled: true, includeArchived: true }))
      .toBe('1 pending | 2 running | 3 done | 4 blocked | 5 paused | 6 cancelled | 7 archived')
    expect(isActiveTaskStatus('pending')).toBe(true)
    expect(isActiveTaskStatus('running')).toBe(true)
    expect(isActiveTaskStatus('done')).toBe(false)
    expect(isActiveTaskStatus('archived')).toBe(false)
  })
})
