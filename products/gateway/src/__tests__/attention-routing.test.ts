import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildProjectAttentionRoutes, deliverProjectAttention } from '../attention-routing.js'
import { clearConfigCacheForTest } from '../config.js'
import { buildNeedsAttentionReport } from '../human-loop.js'
import { appendWorkEvents, clearWorkStateForTest, createRoadmap, createRoadmapSupervisor, createWorkTask, listAlerts, listWorkEvents, loadWorkState, updateProjectBinding, updateRoadmapSupervisor, upsertProjectBinding } from '../work-store.js'

describe('project attention routing', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-attention-routing-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')
  const now = Date.parse('2026-06-13T12:00:00.000Z')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    clearWorkStateForTest(store)
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('routes project attention to project-bound channel surfaces and dedupes sends', async () => {
    const { report } = seededProject('Immediate routing')
    const sent: string[] = []

    const first = await deliverProjectAttention(channels(sent), { report, state: loadWorkState(store) }, { now, filePath: store })
    const second = await deliverProjectAttention(channels(sent), { report, state: loadWorkState(store) }, { now: now + 1000, filePath: store })

    expect(first.sent).toHaveLength(1)
    expect(sent[0]).toContain('Project Attention: Immediate routing')
    expect(second.sent).toHaveLength(0)
    expect(second.suppressed.some(route => route.delivery === 'deduped')).toBe(true)
    expect(listWorkEvents(50, store).map(event => event.type)).toContain('project.notification.sent')
  })

  it('honors digest mode while allowing critical items to bypass digest outside quiet hours', () => {
    const { binding, report } = seededProject('Digest routing')
    updateProjectBinding(binding.id, { notificationMode: 'digest', lastDigestAt: '2026-06-13T11:30:00.000Z' }, store)

    const deferred = buildProjectAttentionRoutes(report, loadWorkState(store), { now, filePath: store })
    const critical = buildProjectAttentionRoutes({ ...report, projects: report.projects.map(project => ({ ...project, severity: 'critical' as const, items: project.items.map(item => ({ ...item, severity: 'critical' as const })) })) }, loadWorkState(store), { now, filePath: store })

    expect(deferred.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'deferred', reason: 'digest interval not due' })
    expect(critical.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'immediate', reason: 'critical bypasses digest' })
  })

  it('defers project notification retries while a delivery attempt is still pending', () => {
    const { report } = seededProject('Pending project notification')
    const route = buildProjectAttentionRoutes(report, loadWorkState(store), { now, filePath: store }).find(row => row.target.provider === 'telegram')!
    const retryAt = new Date(now + 15_000).toISOString()

    appendWorkEvents([{
      type: 'project.notification.attempting',
      subjectId: route.dedupeKey,
      payload: {
        dedupeKey: route.dedupeKey,
        roadmapId: route.group.roadmapId,
        targetKey: 'pending-target',
        provider: 'telegram',
        delivery: 'immediate',
        reason: 'delivery attempt in progress',
        deferredUntil: retryAt,
        itemCount: route.group.items.length,
        severity: route.group.severity,
      },
    }], store)

    expect(buildProjectAttentionRoutes(report, loadWorkState(store), { now: now + 1_000, filePath: store })).toContainEqual(expect.objectContaining({
      dedupeKey: route.dedupeKey,
      delivery: 'deferred',
      reason: 'delivery attempt already in progress',
      deferredUntil: retryAt,
    }))
    expect(buildProjectAttentionRoutes(report, loadWorkState(store), { now: now + 16_000, filePath: store })).toContainEqual(expect.objectContaining({
      dedupeKey: route.dedupeKey,
      delivery: 'immediate',
    }))
  })

  it('defers notifications during quiet hours and suppresses muted surfaces', () => {
    const { binding, report } = seededProject('Quiet routing')
    updateProjectBinding(binding.id, { quietHours: { start: '11:00', end: '13:00' } }, store)

    const quiet = buildProjectAttentionRoutes(report, loadWorkState(store), { now, filePath: store })
    updateProjectBinding(binding.id, { notificationMode: 'muted' }, store)
    const muted = buildProjectAttentionRoutes(report, loadWorkState(store), { now: now + 3 * 60 * 60 * 1000, filePath: store })

    expect(quiet.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'deferred', reason: 'quiet hours active' })
    expect(muted.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'muted', reason: 'target muted' })
  })

  it('lets critical attention bypass quiet hours and records deferral state for normal attention', async () => {
    const { binding, report } = seededProject('Critical quiet routing')
    updateProjectBinding(binding.id, { quietHours: { start: '11:00', end: '13:00', timezone: 'UTC' } }, store)

    const normal = buildProjectAttentionRoutes(report, loadWorkState(store), { now, filePath: store })
    const critical = buildProjectAttentionRoutes({ ...report, projects: report.projects.map(project => ({ ...project, severity: 'critical' as const, items: project.items.map(item => ({ ...item, severity: 'critical' as const })) })) }, loadWorkState(store), { now, filePath: store })

    expect(normal.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'deferred', reason: 'quiet hours active', deferredUntil: '2026-06-13T13:00:00.000Z' })
    expect(critical.find(route => route.target.provider === 'telegram')).toMatchObject({ delivery: 'immediate', reason: 'critical bypasses quiet hours', escalationBypass: 'quiet_hours' })

    await deliverProjectAttention(channels([]), { report, state: loadWorkState(store) }, { now, filePath: store })
    expect(listWorkEvents(50, store).find(event => event.type === 'project.notification.suppressed')?.payload).toMatchObject({
      reason: 'quiet hours active',
      deferredUntil: '2026-06-13T13:00:00.000Z',
      quietHours: { start: '11:00', end: '13:00', timezone: 'UTC' },
    })
  })

  it('resolves supervisor session policy from a referenced project binding', () => {
    const { binding, report, supervisor } = seededProject('Supervisor policy routing')
    const refBinding = upsertProjectBinding({ alias: 'supervisor-policy-ref', roadmapId: supervisor.roadmapId, sessionId: 'ses_policy_ref', scope: 'opencode', notificationMode: 'digest', lastDigestAt: '2026-06-13T11:30:00.000Z' }, store)
    updateProjectBinding(binding.id, { notificationMode: 'immediate' }, store)
    updateRoadmapSupervisor(supervisor.supervisorId, { notificationPolicyRef: refBinding.id }, store)

    const routes = buildProjectAttentionRoutes(report, loadWorkState(store), { now, filePath: store })

    expect(routes.find(route => route.target.key === `session:${supervisor.sessionId}`)).toMatchObject({ delivery: 'deferred', reason: 'digest interval not due' })
  })

  it('records redacted failures and raises delivery alerts', async () => {
    const { report } = seededProject('Failure routing')

    const result = await deliverProjectAttention(new Map([['telegram', { sendMessage: async () => { throw new Error('HTTP 400 token=secret-token') } }]]), { report, state: loadWorkState(store) }, { now, filePath: store })

    expect(result.failed).toHaveLength(1)
    expect(listWorkEvents(50, store).find(event => event.type === 'project.notification.failed')?.payload['error']).toContain('token=<redacted>')
    expect(listAlerts({ status: 'open' }, store)).toContainEqual(expect.objectContaining({ source: 'project.notifications', severity: 'warning' }))
  })

  function seededProject(title: string) {
    const roadmap = createRoadmap({ title }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' }, store)
    const task = createWorkTask({ title: 'Needs user', roadmapId: roadmap.id, manualGate: 'approval_required' }, store)
    const binding = upsertProjectBinding({ alias: title, roadmapId: roadmap.id, sessionId: supervisor.sessionId, provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' }, store)
    const report = buildNeedsAttentionReport({ state: loadWorkState(store), now })
    expect(report.items).toContainEqual(expect.objectContaining({ taskId: task.id }))
    return { roadmap, supervisor, task, binding, report }
  }

  function channels(sent: string[]) {
    return new Map([['telegram', { sendMessage: async (_chatId: string, text: string) => { sent.push(text) } }]])
  }
})
