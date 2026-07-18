import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { applyOperatorActiveRunControl, applyOperatorSafetyAction, buildOperatorSafetyReport, formatOperatorSafetyText } from '../operator-safety.js'
import { createJsonRoutes } from '../daemon-routes/index.js'
import { dispatchRoute } from '../daemon-router.js'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { clearWorkStateForTest, createWorkTask, createHumanGate, listWorkEventsReadOnly, loadWorkState, saveWorkState, startWorkTaskRun } from '../work-store.js'
import { setChannelSession } from '../channel-sessions.js'

describe.sequential('operator safety report', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-operator-'))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearChannelEnvForOperatorTest()
    clearConfigCacheForTest()
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
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
    clearChannelEnvForOperatorTest()
    clearConfigCacheForTest()
    try { if (testDir) fs.rmSync(testDir, { recursive: true, force: true }) } catch {}
  })

  it('builds a redacted beta operator report with explicit deferred gates', async () => {
    updateConfig({
      channels: { telegram: { botToken: '123456:telegram-secret-token' } },
      security: { channelAllowlists: { telegram: [{ chatId: 'private-chat-id' }], whatsapp: [], discord: [] } },
    } as any)
    createWorkTask({ title: 'Beta task', priority: 'HIGH' })
    createHumanGate({ type: 'manual', reason: 'Operator review', requestedBy: 'test', scopeKey: 'manual:test', details: {} })
    setChannelSession('telegram', 'private-chat-id', 'ses_beta', { mode: 'chat' })

    const report = await buildOperatorSafetyReport()
    const serialized = JSON.stringify(report)
    const text = formatOperatorSafetyText(report)

    expect(report.releaseClaim.productionCertified).toBe(false)
    expect(report.channels.ready).toContain('telegram')
    expect(report.channels.needsAttention.map((row: any) => row.provider)).not.toContain('telegram')
    expect(report.channels.deferred.map(row => row.gate)).toEqual(['whatsapp_live_parity', 'production_soak'])
    expect(report.queue.pending).toBe(1)
    expect(report.attention.gates).toBe(1)
    expect(text).toContain('opencode-gateway operator recover')
    expect(serialized).not.toContain('telegram-secret-token')
    expect(serialized).not.toContain('private-chat-id')
  })

  it('treats unavailable OpenCode request sources as operator attention', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input: any) => {
      const url = String(input)
      if (url.endsWith('/global/health')) return jsonResponse({ status: 'ok' })
      if (url.endsWith('/question') || url.endsWith('/permission')) throw new Error('OpenCode request API unavailable token=123456:telegram-secret-token-value')
      return jsonResponse({}, 404)
    })

    const report = await buildOperatorSafetyReport()
    const serialized = JSON.stringify(report)

    expect(report.state).toBe('attention')
    expect(report.requests).toMatchObject({ questionsAvailable: false, permissionsAvailable: false })
    expect(report.attention.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'requests', title: 'OpenCode request source unavailable' }),
    ]))
    expect(serialized).toContain('token=<redacted>')
    expect(serialized).not.toContain('telegram-secret-token-value')
  })

  it('formats malformed daemon operator payloads without throwing', () => {
    expect(() => formatOperatorSafetyText(undefined)).not.toThrow()

    const text = formatOperatorSafetyText({
      state: 'attention',
      summary: 'Daemon returned a partial operator payload.',
      capacity: {} as any,
      channels: {} as any,
      attention: {} as any,
    } as any)

    expect(text).toContain('Operator state: attention')
    expect(text).toContain('Daemon returned a partial operator payload.')
    expect(text).toContain('Capacity: 0 slots')
    expect(text).toContain('Channels ready: none')
    expect(text).toContain('Operator commands:')
  })

  it('builds operator status from a read-only state store without appending events', async () => {
    const store = path.join(testDir, 'gateway.db')
    createWorkTask({ title: 'Read-only status task', priority: 'HIGH' })
    createHumanGate({ type: 'manual', reason: 'Read-only status gate', requestedBy: 'test', scopeKey: 'manual:readonly', details: {} })
    const beforeEvents = listWorkEventsReadOnly(500, store).length

    fs.chmodSync(store, 0o400)
    fs.chmodSync(testDir, 0o500)
    try {
      const report = await buildOperatorSafetyReport(undefined, { readOnly: true })

      expect(report.queue.pending).toBe(1)
      expect(report.attention.gates).toBe(1)
      expect(report.actions.map(row => row.command)).toContain('opencode-gateway operator recover')
      expect(listWorkEventsReadOnly(500, store)).toHaveLength(beforeEvents)
    } finally {
      fs.chmodSync(testDir, 0o700)
      fs.chmodSync(store, 0o600)
    }
  })

  it('pauses and resumes scheduler dispatch through the operator action', async () => {
    expect(getConfig().scheduler.enabled).toBe(true)

    const paused = await applyOperatorSafetyAction('pause')
    expect(paused.applied).toBe(true)
    expect(getConfig().scheduler.enabled).toBe(false)
    expect(paused.report.state).toBe('paused')
    expect(formatOperatorSafetyText(paused.report)).toContain('Scheduler: paused')
    expect(formatOperatorSafetyText(paused.report)).toContain('opencode-gateway operator resume')

    const resumed = await applyOperatorSafetyAction('resume')
    expect(resumed.applied).toBe(true)
    expect(getConfig().scheduler.enabled).toBe(true)
  })

  it('recovers missing OpenCode runs through the operator action', async () => {
    const task = createWorkTask({ title: 'Missing OpenCode session', priority: 'HIGH' })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_missing_operator', 'implementer')!

    const result = await applyOperatorSafetyAction('recover', { session: { list: async () => ({ data: [] }), get: async () => { throw Object.assign(new Error('session not found'), { status: 404 }) } } })

    expect(result.applied).toBe(true)
    expect((result.result as any).orphaned).toMatchObject({ recovered: 1, blocked: 0, runIds: [started.run.id] })
    expect(result.report.queue.pending).toBe(1)
  })

  it('reports active runs with lease freshness and safe control commands', async () => {
    const task = createWorkTask({ title: 'Controllable run', priority: 'HIGH' })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_control', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000, generation: 'gen-a' })!

    const report = await buildOperatorSafetyReport(undefined, { readOnly: true })
    const text = formatOperatorSafetyText(report)

    expect(report.activeRuns).toEqual([expect.objectContaining({
      runId: started.run.id,
      taskId: task.id,
      heartbeatFreshness: 'fresh',
      cancellable: true,
      restartable: true,
      leaseOwner: 'daemon-a',
    })])
    expect(text).toContain(`opencode-gateway operator run ${started.run.id} cancel --lease-owner daemon-a`)
  })

  it('applies active run cancel once and records typed/audit evidence', async () => {
    const task = createWorkTask({ title: 'Cancel active run', priority: 'HIGH' })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_cancel', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000, generation: 'gen-a' })!

    const result = await applyOperatorActiveRunControl({
      runId: started.run.id,
      action: 'cancel',
      expectedLeaseOwner: 'daemon-a',
      expectedSchedulerGeneration: 'gen-a',
      note: 'operator cancel test',
    }, { session: { abort: vi.fn(async () => ({})) } })
    const state = loadWorkState()
    const events = listWorkEventsReadOnly(50)

    expect(result.control).toMatchObject({ applied: true, outcome: 'applied', reason: 'applied', abortedSessionId: 'ses_cancel' })
    expect(state.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'cancelled', currentRunId: undefined, note: 'operator cancel test' })
    expect(state.runs.find(row => row.id === started.run.id)).toMatchObject({ status: 'errored' })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.run.operator_controlled', payload: expect.objectContaining({ action: 'cancel', outcome: 'applied', runId: started.run.id }) }),
      expect.objectContaining({ type: 'audit.security', payload: expect.objectContaining({ operation: 'operator.run.cancel', target: started.run.id, result: 'ok' }) }),
    ]))

    const second = await applyOperatorActiveRunControl({ runId: started.run.id, action: 'cancel', expectedLeaseOwner: 'daemon-a' })
    expect(second.control).toMatchObject({ applied: false, outcome: 'no_op', reason: 'run_not_active' })
  })

  it('rejects stale or non-owned active run controls without mutating the task', async () => {
    const ownerTask = createWorkTask({ title: 'Owner mismatch run', priority: 'HIGH' })
    const ownerRun = startWorkTaskRun(ownerTask.id, 'implement', 'ses_owner', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000, generation: 'gen-a' })!
    const mismatch = await applyOperatorActiveRunControl({ runId: ownerRun.run.id, action: 'cancel', expectedLeaseOwner: 'daemon-b' })

    expect(mismatch.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'lease_owner_mismatch' })
    expect(loadWorkState().tasks.find(row => row.id === ownerTask.id)).toMatchObject({ status: 'running', currentRunId: ownerRun.run.id })

    const boundaryTask = createWorkTask({ title: 'Exact expiry boundary run', priority: 'HIGH' })
    const boundaryRun = startWorkTaskRun(boundaryTask.id, 'implement', 'ses_boundary', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000 })!
    const boundaryNow = Date.parse(loadWorkState().runs.find(row => row.id === boundaryRun.run.id)!.leaseExpiresAt!)
    const boundary = await applyOperatorActiveRunControl({ runId: boundaryRun.run.id, action: 'cancel', expectedLeaseOwner: 'daemon-a', now: boundaryNow })

    expect(boundary.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'lease_expired' })
    expect(loadWorkState().tasks.find(row => row.id === boundaryTask.id)).toMatchObject({ status: 'running', currentRunId: boundaryRun.run.id })

    const staleTask = createWorkTask({ title: 'Expired lease run', priority: 'HIGH' })
    const staleRun = startWorkTaskRun(staleTask.id, 'implement', 'ses_stale', 'implementer', undefined, { owner: 'daemon-a', leaseMs: -1000 })!
    const stale = await applyOperatorActiveRunControl({ runId: staleRun.run.id, action: 'restart', expectedLeaseOwner: 'daemon-a' })

    expect(stale.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'lease_expired' })
    expect(stale.control.nextAction).toContain('operator recover')
    expect(loadWorkState().tasks.find(row => row.id === staleTask.id)).toMatchObject({ status: 'running', currentRunId: staleRun.run.id })

    const generationTask = createWorkTask({ title: 'Generation mismatch run', priority: 'HIGH', pipeline: ['verify'] })
    const generationRun = startWorkTaskRun(generationTask.id, 'verify', 'ses_generation', 'reviewer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000, generation: 'gen-current' })!
    const generationMismatch = await applyOperatorActiveRunControl({ runId: generationRun.run.id, action: 'retry', expectedLeaseOwner: 'daemon-a', expectedSchedulerGeneration: 'gen-old' })

    expect(generationMismatch.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'scheduler_generation_mismatch' })
    expect(generationMismatch.control.nextAction).toContain('current lease owner/generation')
    expect(loadWorkState().tasks.find(row => row.id === generationTask.id)).toMatchObject({ status: 'running', currentRunId: generationRun.run.id })

    const missing = await applyOperatorActiveRunControl({ runId: 'run_missing_operator_control', action: 'cancel' })

    expect(missing.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'run_not_found' })
  })

  it('rejects corrupt active-run ownership states without mutating unrelated task state', async () => {
    const missingTask = createWorkTask({ title: 'Missing task for run', priority: 'HIGH' })
    const missingTaskRun = startWorkTaskRun(missingTask.id, 'implement', 'ses_missing_task', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000 })!
    const missingTaskState = loadWorkState()
    missingTaskState.tasks = missingTaskState.tasks.filter(row => row.id !== missingTask.id)
    saveWorkState(missingTaskState)

    const missingTaskResult = await applyOperatorActiveRunControl({ runId: missingTaskRun.run.id, action: 'cancel', expectedLeaseOwner: 'daemon-a' })

    expect(missingTaskResult.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'task_not_found' })

    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    const mismatchTask = createWorkTask({ title: 'Mismatched run owner', priority: 'HIGH' })
    const mismatchRun = startWorkTaskRun(mismatchTask.id, 'implement', 'ses_mismatch', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000 })!
    const mismatchState = loadWorkState()
    const storedMismatchTask = mismatchState.tasks.find(row => row.id === mismatchTask.id)!
    storedMismatchTask.currentRunId = 'run_other_owner'
    saveWorkState(mismatchState)

    const mismatch = await applyOperatorActiveRunControl({ runId: mismatchRun.run.id, action: 'cancel', expectedLeaseOwner: 'daemon-a' })

    expect(mismatch.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'task_not_owned_by_run' })
    expect(loadWorkState().tasks.find(row => row.id === mismatchTask.id)).toMatchObject({ status: 'running', currentRunId: 'run_other_owner' })

    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
    const leaseTask = createWorkTask({ title: 'Missing lease run', priority: 'HIGH' })
    const leaseRun = startWorkTaskRun(leaseTask.id, 'implement', 'ses_missing_lease', 'implementer')!
    const leaseMissing = await applyOperatorActiveRunControl({ runId: leaseRun.run.id, action: 'cancel' })

    expect(leaseMissing.control).toMatchObject({ applied: false, outcome: 'denied', reason: 'lease_missing' })
    expect(loadWorkState().tasks.find(row => row.id === leaseTask.id)).toMatchObject({ status: 'running', currentRunId: leaseRun.run.id })
  })

  it('stops active runs by blocking the task and recording blocked progress', async () => {
    const task = createWorkTask({ title: 'Stop active run', priority: 'HIGH', pipeline: ['review'] })
    const started = startWorkTaskRun(task.id, 'review', 'ses_stop', 'reviewer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000 })!

    const result = await applyOperatorActiveRunControl({ runId: started.run.id, action: 'stop', expectedLeaseOwner: 'daemon-a', note: 'operator stop test' })
    const state = loadWorkState()
    const events = listWorkEventsReadOnly(50)

    expect(result.control).toMatchObject({
      applied: true,
      outcome: 'applied',
      restartBehavior: 'not_applicable',
      abortedSessionId: 'ses_stop',
    })
    expect(state.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'blocked', currentRunId: undefined, note: 'operator stop test' })
    expect(state.runs.find(row => row.id === started.run.id)).toMatchObject({ status: 'errored' })
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.run.operator_controlled', payload: expect.objectContaining({ action: 'stop', outcome: 'applied', runId: started.run.id, taskStatus: 'blocked' }) }),
      expect.objectContaining({ type: 'audit.security', payload: expect.objectContaining({ operation: 'operator.run.stop', target: started.run.id, result: 'ok' }) }),
    ]))
  })

  it('retries active runs by preserving the stage and requeueing durable work only', async () => {
    const task = createWorkTask({
      title: 'Retry active run',
      priority: 'HIGH',
      pipeline: ['implement', 'verify'],
    })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_retry', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000 })!

    const result = await applyOperatorActiveRunControl({ runId: started.run.id, action: 'retry', expectedLeaseOwner: 'daemon-a' })
    const stored = loadWorkState().tasks.find(row => row.id === task.id)

    expect(result.control).toMatchObject({
      applied: true,
      outcome: 'applied',
      restartBehavior: 'durable_requeue_only',
      abortedSessionId: 'ses_retry',
    })
    expect(result.control.nextAction).toContain('same stage')
    expect(stored).toMatchObject({ status: 'pending', currentStage: 'implement', currentRunId: undefined, earliestStartAt: undefined })
  })

  it('makes restart semantics explicit and requeues durable work for a fresh OpenCode session', async () => {
    const task = createWorkTask({ title: 'Restart active run', priority: 'HIGH', pipeline: ['implement', 'verify'] })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_restart', 'implementer', undefined, { owner: 'daemon-a', leaseMs: 60 * 60 * 1000 })!

    const result = await applyOperatorActiveRunControl({ runId: started.run.id, action: 'restart', expectedLeaseOwner: 'daemon-a' })

    expect(result.control).toMatchObject({
      applied: true,
      outcome: 'applied',
      restartBehavior: 'new_opencode_session_on_next_scheduler_dispatch',
      abortedSessionId: 'ses_restart',
    })
    expect(result.control.nextAction).toContain('fresh OpenCode session')
    expect(loadWorkState().tasks.find(row => row.id === task.id)).toMatchObject({ status: 'pending', currentStage: 'implement', currentRunId: undefined })
  })

  it('exposes operator status and actions over daemon JSON routes', async () => {
    const routes = createJsonRoutes()
    const task = createWorkTask({ title: 'Route active run', priority: 'HIGH' })
    const started = startWorkTaskRun(task.id, 'implement', 'ses_route', 'implementer', undefined, { owner: 'route-owner', leaseMs: 60 * 60 * 1000 })!

    const status = await dispatchRoute(routes, context('GET', '/operator/status'))
    expect(status?.status).toBe(200)
    expect((status?.body as any).operator.actions.map((row: any) => row.action)).toContain('recover')
    expect((status?.body as any).operator.activeRuns.map((row: any) => row.runId)).toContain(started.run.id)

    const paused = await dispatchRoute(routes, context('POST', '/operator/actions', { action: 'pause' }))
    expect(paused?.status).toBe(200)
    expect((paused?.body as any).operatorAction.report.scheduler.enabled).toBe(false)

    const controlled = await dispatchRoute(routes, context('POST', `/operator/runs/${started.run.id}/actions`, { action: 'retry', expectedLeaseOwner: 'route-owner' }))
    expect(controlled?.status).toBe(200)
    expect((controlled?.body as any).activeRunControl.control).toMatchObject({ applied: true, action: 'retry', restartBehavior: 'durable_requeue_only' })

    await expect(dispatchRoute(routes, context('POST', `/operator/runs/${started.run.id}/actions`, { action: 'format-disk' }))).rejects.toThrow(/action/)

    await expect(dispatchRoute(routes, context('POST', '/operator/actions', { action: 'format-disk' }))).rejects.toThrow(/action/)
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

function clearChannelEnvForOperatorTest(): void {
  delete process.env['TELEGRAM_BOT_TOKEN']
  delete process.env['WHATSAPP_ACCESS_TOKEN']
  delete process.env['WHATSAPP_PHONE_NUMBER_ID']
  delete process.env['WHATSAPP_VERIFY_TOKEN']
  delete process.env['WHATSAPP_APP_SECRET']
  delete process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED']
  delete process.env['DISCORD_BOT_TOKEN']
  delete process.env['DISCORD_APPLICATION_ID']
  delete process.env['DISCORD_PUBLIC_KEY']
}
