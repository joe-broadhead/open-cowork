import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest, getConfig, updateConfig } from '../config.js'
import { acquireDueRoadmapSupervisorWakeups, addWorkDependency, appendAuditEvent, appendWorkEvent, MAX_WORK_EVENT_ROWS, applyWorkEnvironmentAction, applyWorkTaskAction, archiveRoadmap, archiveRoadmapSupervisor, archiveWorkTask, clearWorkStateForTest, completeRoadmapSupervisorWakeup, completeWorkTaskRun, createDelegatedWork, createRoadmap, createRoadmapSupervisor, createRoadmapWithTasks, createRun, createWorkTask, createWorkTasks, decideHumanGate, decideRoadmapCompletionProposal, deleteProjectBinding, deleteRoadmap, deleteWorkTask, getChannelBinding, getDefaultRoadmapSupervisor, getProjectBinding, getRoadmapSupervisor, getWorkEnvironment, getWorkTaskReadiness, listProjectBindings, listRoadmapCompletionProposals, listRoadmapSupervisors, listSupervisorWakeupReceipts, listWorkDependencies, listWorkEnvironments, listWorkEvents, listWorkEventsByType, loadWorkState, markWorkTaskDone, planInitiative, proposeRoadmapCompletion, recoverExpiredWorkLeases, recoverOrphanedWorkRuns, reconcileWorkEnvironments, recomputeRoadmapStatus, renewWorkTaskRunLease, resolveProjectContext, saveWorkState, startWorkTaskRun, summarizeWorkLeases, updateProjectBinding, updateRoadmap, updateRoadmapSupervisor, updateWorkTask, updateWorkTasks, upsertAlert, upsertProjectBinding } from '../work-store.js'
import { normalizeProjectAlias } from '../work-store/validators.js'
import { applyPromotionDecision, createPromotionScorecard, getPromotionState, listPromotionDecisions, listPromotionScorecards } from '../work-store/promotions.js'
import type { EnvironmentRunRecord } from '../environments.js'

describe('work store', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-work-store-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

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

  it('creates durable inbox tasks directly in SQLite', () => {
    const task = createWorkTask({ title: 'Build durable scheduler', priority: 'HIGH', pipeline: ['implement', 'review', 'verify'] }, store)
    const state = loadWorkState(store)

    expect(state.tasks).toHaveLength(1)
    expect(state.roadmaps).toContainEqual(expect.objectContaining({ id: task.roadmapId, title: 'Task Inbox' }))
    expect(state.tasks[0]).toMatchObject({ title: 'Build durable scheduler', pipeline: ['implement', 'review', 'verify'], currentStage: 'implement' })
    expect('source' in state.tasks[0]!).toBe(false)
  })

  it('persists durable work state with private permissions', () => {
    createWorkTask({ title: 'Persist this', priority: 'HIGH' }, store)

    const loaded = loadWorkState(store)
    expect(loaded.tasks[0]!.title).toBe('Persist this')
    expect((fs.statSync(store).mode & 0o777).toString(8)).toBe('600')
  })

  it('persists hot task mutations without deleting and reinserting unchanged graph rows', () => {
    const first = createWorkTask({ title: 'First hot mutation task', priority: 'HIGH' }, store)
    const second = createWorkTask({ title: 'Second hot mutation task', priority: 'LOW' }, store)
    const db = new DatabaseSync(store)
    db.exec(`
      CREATE TABLE rewrite_audit(table_name TEXT NOT NULL, row_id TEXT NOT NULL);
      CREATE TRIGGER audit_task_delete BEFORE DELETE ON tasks
      BEGIN
        INSERT INTO rewrite_audit(table_name, row_id) VALUES ('tasks', OLD.id);
      END;
      CREATE TRIGGER audit_run_delete BEFORE DELETE ON runs
      BEGIN
        INSERT INTO rewrite_audit(table_name, row_id) VALUES ('runs', OLD.id);
      END;
    `)
    db.close()

    updateWorkTask(first.id, { note: 'touch one task only' }, store)

    const auditDb = new DatabaseSync(store)
    const deleted = auditDb.prepare('SELECT table_name, row_id FROM rewrite_audit ORDER BY table_name, row_id').all()
    auditDb.close()
    expect(deleted).toEqual([])
    expect(loadWorkState(store).tasks.find(task => task.id === second.id)).toMatchObject({ title: 'Second hot mutation task', status: 'pending' })
  })

  it('throttles the event row-cap probe and prune to once per interval across appends', () => {
    appendWorkEvent('test.prune.seed', 'subject', {}, store)

    const db = new DatabaseSync(store)
    // Push the table over the row cap directly so an unthrottled cap prune on
    // the next append would find a boundary and delete rows.
    db.exec('BEGIN')
    const insert = db.prepare("INSERT INTO events (type, subject_id, payload_json, created_at) VALUES ('test.prune.filler', NULL, '{}', ?)")
    const fillerCreatedAt = new Date().toISOString()
    for (let index = 0; index < MAX_WORK_EVENT_ROWS + 50; index++) insert.run(fillerCreatedAt)
    db.exec('COMMIT')
    db.exec(`
      CREATE TABLE event_prune_audit(row_id INTEGER NOT NULL);
      CREATE TRIGGER audit_event_delete BEFORE DELETE ON events
      BEGIN
        INSERT INTO event_prune_audit(row_id) VALUES (OLD.id);
      END;
    `)
    db.close()

    // Within the throttle interval of the seed append: neither the cap prune
    // nor the age prune may delete anything.
    appendWorkEvent('test.prune.throttled', 'subject', {}, store)
    const throttledDb = new DatabaseSync(store)
    expect(Number((throttledDb.prepare('SELECT COUNT(*) AS count FROM event_prune_audit').get() as any).count)).toBe(0)
    // Expire the throttle timestamp, as if the interval elapsed.
    throttledDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('eventsAgePrunedAt', ?)").run(new Date(Date.now() - 120_000).toISOString())
    throttledDb.close()

    appendWorkEvent('test.prune.after_interval', 'subject', {}, store)
    const prunedDb = new DatabaseSync(store)
    const pruned = Number((prunedDb.prepare('SELECT COUNT(*) AS count FROM event_prune_audit').get() as any).count)
    const throttleStamp = String((prunedDb.prepare("SELECT value FROM meta WHERE key = 'eventsAgePrunedAt'").get() as any).value)
    prunedDb.close()
    expect(pruned).toBeGreaterThan(0)
    // The throttle timestamp was refreshed by the prune that ran.
    expect(Date.parse(throttleStamp)).toBeGreaterThan(Date.now() - 60_000)
  })

  it('creates deterministic promotion scorecards and projects evaluated or blocked state', () => {
    const passed = createPromotionScorecard({
      subjectKind: 'profile',
      subjectName: 'implementer',
      sourceKind: 'eval',
      sourceId: 'suite.repo-write',
      sourceVersion: '1',
      metrics: [{ id: 'quality', score: 0.95, maxScore: 1, passed: true }],
      thresholds: [{ id: 'quality.min', metric: 'quality', minPercentage: 0.9 }],
      evidence: ['fixture passed'],
    }, store)
    const replayed = createPromotionScorecard({
      subjectKind: 'profile',
      subjectName: 'implementer',
      sourceKind: 'eval',
      sourceId: 'suite.repo-write',
      sourceVersion: '1',
      metrics: [{ id: 'quality', score: 0.95, maxScore: 1, passed: true }],
      thresholds: [{ id: 'quality.min', metric: 'quality', minPercentage: 0.9 }],
      evidence: ['fixture passed again'],
    }, store)

    expect(replayed.id).toBe(passed.id)
    expect(listPromotionScorecards({ subjectKind: 'profile', subjectName: 'implementer' })).toHaveLength(1)
    expect(getPromotionState('profile', 'implementer', store)).toMatchObject({ state: 'evaluated', scorecard: { recommendation: 'promote' } })
    expect(getConfig().profiles['implementer']!.promotionState).toBe('evaluated')

    const failed = createPromotionScorecard({
      subjectKind: 'team',
      subjectName: 'default',
      sourceKind: 'eval',
      sourceId: 'suite.default-team',
      metrics: [{ id: 'quality', score: 0.4, maxScore: 1, passed: false }],
      thresholds: [{ id: 'quality.min', metric: 'quality', minPercentage: 0.9 }],
      evidence: ['quality below threshold'],
    }, store)
    expect(failed).toMatchObject({ recommendation: 'block', status: 'blocked' })
    expect(getPromotionState('team', 'default', store).state).toBe('blocked')
  })

  it('requires human approval for promote, deprecate, rollback, and records rejected gates', () => {
    const scorecard = createPromotionScorecard({
      subjectKind: 'profile',
      subjectName: 'reviewer',
      sourceKind: 'eval',
      sourceId: 'suite.review',
      metrics: [{ id: 'quality', score: 1, maxScore: 1, passed: true }],
      thresholds: [{ id: 'quality.min', metric: 'quality', minPercentage: 1 }],
      evidence: ['review suite passed'],
    }, store)

    const pending = applyPromotionDecision({ subjectKind: 'profile', subjectName: 'reviewer', action: 'promote', scorecardId: scorecard.id, actor: 'operator' }, store)!
    expect(pending).toMatchObject({ status: 'pending', gateId: expect.any(String), toStatus: 'promoted' })
    expect(getConfig().profiles['reviewer']!.promotionState).toBe('evaluated')

    decideHumanGate(pending.gateId!, { decision: 'reject', actor: 'operator', note: 'needs more evidence' }, store)
    const rejected = applyPromotionDecision({ decisionId: pending.id, gateId: pending.gateId, actor: 'operator' }, store)!
    expect(rejected).toMatchObject({ status: 'rejected' })
    expect(getConfig().profiles['reviewer']!.promotionState).toBe('evaluated')

    const approved = applyPromotionDecision({ subjectKind: 'profile', subjectName: 'reviewer', action: 'promote', scorecardId: scorecard.id, actor: 'operator' }, store)!
    decideHumanGate(approved.gateId!, { decision: 'approve', actor: 'operator', note: 'trusted' }, store)
    const promoted = applyPromotionDecision({ decisionId: approved.id, gateId: approved.gateId, actor: 'operator' }, store)!
    expect(promoted).toMatchObject({ status: 'applied', toStatus: 'promoted' })
    expect(getPromotionState('profile', 'reviewer', store)).toMatchObject({ state: 'promoted', decision: { id: promoted.id } })
    expect(getConfig().profiles['reviewer']!.promotionState).toBe('promoted')

    const deprecate = applyPromotionDecision({ subjectKind: 'profile', subjectName: 'reviewer', action: 'deprecate', scorecardId: scorecard.id, actor: 'operator' }, store)!
    decideHumanGate(deprecate.gateId!, { decision: 'approve', actor: 'operator' }, store)
    expect(applyPromotionDecision({ decisionId: deprecate.id, gateId: deprecate.gateId, actor: 'operator' }, store)).toMatchObject({ toStatus: 'deprecated' })
    expect(getConfig().profiles['reviewer']!.promotionState).toBe('deprecated')

    const rollback = applyPromotionDecision({ subjectKind: 'profile', subjectName: 'reviewer', action: 'rollback', scorecardId: scorecard.id, actor: 'operator' }, store)!
    decideHumanGate(rollback.gateId!, { decision: 'approve', actor: 'operator' }, store)
    expect(applyPromotionDecision({ decisionId: rollback.id, gateId: rollback.gateId, actor: 'operator' }, store)).toMatchObject({ toStatus: 'promoted' })
    expect(listPromotionDecisions({ subjectKind: 'profile', subjectName: 'reviewer' }).map(decision => decision.action)).toEqual(expect.arrayContaining(['promote', 'deprecate', 'rollback']))
    expect(listWorkEvents(100, store).map(event => event.type)).toEqual(expect.arrayContaining(['promotion.scorecard.upserted', 'promotion.decision.applied', 'promotion.decision.rejected']))
  })

  it('marks durable work tasks done by text match', () => {
    createWorkTask({ title: 'Finish the dashboard', priority: 'HIGH' }, store)

    expect(markWorkTaskDone('dashboard', store)).toBe(true)
    expect(loadWorkState(store).tasks[0]!.status).toBe('done')
  })

  it('emits delegation completion progress when marking delegated tasks done by text', () => {
    const roadmap = createRoadmap({ title: 'Delegated CLI project' }, store)
    const receipt = createDelegatedWork({
      idempotencyKey: 'delegated-cli-done',
      targetType: 'issue',
      objective: 'Complete delegated CLI task.',
      parentSessionId: 'ses_parent',
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1' },
      issue: { title: 'Finish delegated dashboard', roadmapId: roadmap.id, priority: 'HIGH' },
    }, store)

    expect(markWorkTaskDone('delegated dashboard', store)).toBe(true)

    const completion = listWorkEvents(50, store).find(event => event.type === 'delegation.progress' && event.payload['progress'] === 'completed')
    expect(completion).toMatchObject({
      subjectId: 'delegated-cli-done',
      payload: {
        idempotencyKey: 'delegated-cli-done',
        parentSessionId: 'ses_parent',
        taskId: receipt.taskIds[0],
        progress: 'completed',
      },
    })
  })

  it('retains denied inbound security audits while pruning noisy events', () => {
    appendAuditEvent({
      actor: 'telegram',
      source: 'telegram:untrusted',
      operation: 'channel.inbound',
      target: 'telegram:untrusted',
      result: 'denied',
      details: { reason: 'denial_probe' },
    }, store)
    const progressEventId = appendWorkEvent('delegation.progress', 'delegate-retention', {
      idempotencyKey: 'delegate-retention',
      progress: 'dispatched',
      progressKey: 'delegate-retention:dispatched',
      taskId: 'task_retention',
    }, store)
    appendWorkEvent('delegation.progress.notified', 'delegate-retention', {
      idempotencyKey: 'delegate-retention',
      progress: 'dispatched',
      progressEventId,
      delivery: 'session',
      sessionId: 'ses_parent',
    }, store)
    const db = new DatabaseSync(store)
    try {
      db.exec('BEGIN IMMEDIATE')
      const stmt = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
      const now = new Date().toISOString()
      for (let index = 0; index < 10050; index += 1) stmt.run('noise.event', `noise-${index}`, JSON.stringify({ index }), now)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    } finally {
      db.close()
    }
    appendWorkEvent('noise.trigger', 'trigger', {}, store)

    expect(listWorkEventsByType('audit.security', 10, store)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ operation: 'channel.inbound', result: 'denied' }),
      }),
    ])
    expect(listWorkEventsByType('delegation.progress', 10, store)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ idempotencyKey: 'delegate-retention', progress: 'dispatched' }),
      }),
    ])
    expect(listWorkEventsByType('delegation.progress.notified', 10, store)).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ idempotencyKey: 'delegate-retention', progressEventId }),
      }),
    ])
  })

  it('creates roadmaps, tasks, and workflow events in SQLite', () => {
    const roadmap = createRoadmap({ title: 'Launch project', priority: 'HIGH' }, store)
    const task = createWorkTask({ title: 'Write launch plan', roadmapId: roadmap.id, priority: 'HIGH', pipeline: ['plan', 'review'] }, store)
    appendWorkEvent('test.event', task.id, { ok: true }, store)

    const state = loadWorkState(store)
    expect(state.roadmaps.find(r => r.id === roadmap.id)?.title).toBe('Launch project')
    expect(state.tasks.find(t => t.id === task.id)).toMatchObject({ roadmapId: roadmap.id, currentStage: 'plan' })
    expect(listWorkEvents(10, store).at(-1)).toMatchObject({ type: 'test.event', subjectId: task.id, payload: { ok: true } })
  })

  it('updates and transitions durable tasks deterministically', () => {
    const task = createWorkTask({ title: 'Initial title', priority: 'LOW' }, store)

    const updated = updateWorkTask(task.id, { title: 'Updated title', priority: 'HIGH', pipeline: ['plan', 'implement'] }, store)
    expect(updated).toMatchObject({ title: 'Updated title', priority: 'HIGH', pipeline: ['plan', 'implement'] })

    const paused = applyWorkTaskAction(task.id, 'pause', { note: 'waiting' }, store)
    expect(paused?.task).toMatchObject({ status: 'paused', note: 'waiting' })

    const resumed = applyWorkTaskAction(task.id, 'resume', { stage: 'plan' }, store)
    expect(resumed?.task).toMatchObject({ status: 'pending', currentStage: 'plan' })

    const cancelled = applyWorkTaskAction(task.id, 'cancel', {}, store)
    expect(cancelled?.task).toMatchObject({ status: 'cancelled', currentStage: undefined })
  })

  it('rejects invalid durable task and roadmap mutations', () => {
    const roadmap = createRoadmap({ title: 'Validation project' }, store)
    const task = createWorkTask({ title: 'Validate updates', roadmapId: roadmap.id, pipeline: ['plan', 'implement'] }, store)

    expect(() => createWorkTask({ title: 'Orphan task', roadmapId: 'roadmap_missing' }, store)).toThrow('roadmap not found')
    expect(() => createRoadmap({ title: '', priority: 'HIGH' }, store)).toThrow('title is required')
    expect(() => createRoadmap({ title: 'Bad priority', priority: 'URGENT' } as any, store)).toThrow('priority must be HIGH')
    expect(() => createWorkTask({ title: 'Bad pipeline', pipeline: ['plan', 42] as any }, store)).toThrow('pipeline stage at index 1 must be a string')
    expect(() => createWorkTask({ title: 'Bad agent', agent: 'bad agent' }, store)).toThrow('agent must be')
    expect(() => updateWorkTask(task.id, { status: 'running' }, store)).toThrow('running status is reserved')
    expect(() => updateWorkTask(task.id, { status: 'mystery' } as any, store)).toThrow('task status must be')
    expect(() => updateWorkTask(task.id, { priority: 'URGENT' } as any, store)).toThrow('priority must be HIGH')
    expect(() => updateWorkTask(task.id, { pipeline: ['plan'], currentStage: 'verify' }, store)).toThrow('currentStage must be in pipeline')
    expect(() => updateWorkTask(task.id, { currentStage: 'bad stage' }, store)).toThrow('currentStage must be')
    expect(() => applyWorkTaskAction(task.id, 'pause', { note: 123 } as any, store)).toThrow('text field must be a string')
    expect(() => applyWorkTaskAction(task.id, 'launch' as any, {}, store)).toThrow('task action must be')
    expect(() => applyWorkTaskAction(task.id, 'retry', { stage: 'verify' }, store)).toThrow('stage must be in pipeline')
    expect(startWorkTaskRun(task.id, 'verify', 'ses_invalid', 'verifier', store)).toBeUndefined()
    expect(() => updateRoadmap(roadmap.id, { status: 'archived' }, store)).toThrow('use roadmap_archive')
    expect(() => updateRoadmap(roadmap.id, { status: 'missing' } as any, store)).toThrow('roadmap status must be')

    const persisted = loadWorkState(store)
    expect(persisted.roadmaps.some(row => row.title === 'Bad priority')).toBe(false)
    expect(persisted.tasks.some(row => row.title === 'Bad pipeline')).toBe(false)
    expect(persisted.tasks.find(row => row.id === task.id)).toMatchObject({ status: 'pending', priority: 'MEDIUM', currentStage: 'plan' })

    const archived = createRoadmap({ title: 'Archived project' }, store)
    archiveRoadmap(archived.id, {}, store)
    expect(() => createWorkTask({ title: 'No archived children', roadmapId: archived.id }, store)).toThrow('roadmap is archived')
  })

  it('updates, recomputes, archives, and deletes roadmaps and tasks', () => {
    const roadmap = createRoadmap({ title: 'Cleanup project', priority: 'LOW' }, store)
    const renamed = updateRoadmap(roadmap.id, { title: 'Cleanup project v2', priority: 'HIGH' }, store)
    expect(renamed).toMatchObject({ title: 'Cleanup project v2', priority: 'HIGH' })

    const task = createWorkTask({ title: 'Archive me', roadmapId: roadmap.id }, store)
    updateWorkTask(task.id, { status: 'done' }, store)
    expect(recomputeRoadmapStatus(roadmap.id, store)).toMatchObject({ status: 'done' })

    const archive = archiveWorkTask(task.id, { note: 'not needed' }, store)
    expect(archive?.task).toMatchObject({ status: 'archived', note: 'not needed' })
    expect(loadWorkState(store).tasks[0]!.status).toBe('archived')

    const task2 = createWorkTask({ title: 'Delete me', roadmapId: roadmap.id }, store)
    const run = createRun(task2, 'implement', 'ses_delete', 'implementer')
    const state = loadWorkState(store)
    const persisted = state.tasks.find(row => row.id === task2.id)!
    persisted.status = 'running'
    persisted.currentRunId = run.id
    state.runs.push(run)
    saveWorkState(state, store)

    expect(deleteWorkTask(task2.id, store)).toMatchObject({ deleted: true, abortedSessionId: 'ses_delete' })
    expect(loadWorkState(store).tasks.some(row => row.id === task2.id)).toBe(false)

    const roadmapArchive = archiveRoadmap(roadmap.id, { note: 'archive all' }, store)
    expect(roadmapArchive?.roadmap.status).toBe('archived')
    expect(roadmapArchive?.tasks.every(row => row.status === 'archived')).toBe(true)

    const deleted = deleteRoadmap(roadmap.id, store)
    expect(deleted).toMatchObject({ deleted: true, roadmap: { id: roadmap.id } })
    expect(loadWorkState(store).roadmaps.some(row => row.id === roadmap.id)).toBe(false)
  })

  it('persists roadmap supervisors with deterministic default selection', () => {
    const roadmap = createRoadmap({ title: 'Supervised project' }, store)
    const first = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_first', cadence: { intervalMs: 3600000 }, eventTriggers: { enabled: true }, completionPolicy: { approval: 'required' }, notificationPolicyRef: 'policy-main' }, store)
    const watcher = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_watch', isDefault: false, note: 'watcher' }, store)

    expect(first).toMatchObject({ roadmapId: roadmap.id, sessionId: 'ses_first', profile: 'supervisor', status: 'active', isDefault: true })
    expect(watcher).toMatchObject({ isDefault: false })
    expect(getDefaultRoadmapSupervisor(roadmap.id, store)?.supervisorId).toBe(first.supervisorId)
    expect(loadWorkState(store).supervisors).toHaveLength(2)
    expect(getRoadmapSupervisor(first.supervisorId, store)).toMatchObject({ cadence: { intervalMs: 3600000 }, eventTriggers: { enabled: true }, completionPolicy: { approval: 'required' }, notificationPolicyRef: 'policy-main' })

    const promoted = updateRoadmapSupervisor(watcher.supervisorId, { isDefault: true, lastReviewedEventId: 42, lastReviewAt: '2026-06-13T12:00:00Z', nextReviewAt: '2026-06-13T13:00:00Z' }, store)!
    expect(promoted).toMatchObject({ isDefault: true, lastReviewedEventId: 42, lastReviewAt: '2026-06-13T12:00:00.000Z', nextReviewAt: '2026-06-13T13:00:00.000Z' })
    expect(getDefaultRoadmapSupervisor(roadmap.id, store)?.supervisorId).toBe(watcher.supervisorId)
    expect(getRoadmapSupervisor(first.supervisorId, store)?.isDefault).toBe(false)

    expect(listWorkEvents(10, store).map(event => event.type)).toEqual(expect.arrayContaining(['roadmap.supervisor.created', 'roadmap.supervisor.updated']))
  })

  it('validates supervisor roadmap and profile references', () => {
    const roadmap = createRoadmap({ title: 'Validation supervised project' }, store)

    expect(() => createRoadmapSupervisor({ roadmapId: 'roadmap_missing', sessionId: 'ses_missing' }, store)).toThrow('roadmap not found')
    expect(() => createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_bad_profile', profile: 'missing-profile' }, store)).toThrow('profile not found')
    expect(() => createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_bad_cadence', cadence: [] as any }, store)).toThrow('cadence must be an object')
    expect(() => createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_bad_cursor', lastReviewedEventId: -1 }, store)).toThrow('event cursor')

    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_valid' }, store)
    expect(() => updateRoadmapSupervisor(supervisor.supervisorId, { status: 'archived' } as any, store)).toThrow('use roadmap_supervisor_archive')

    archiveRoadmap(roadmap.id, {}, store)
    expect(() => createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_archived' }, store)).toThrow('roadmap is archived')
  })

  it('archives and deletes roadmap supervisors with their roadmaps', () => {
    const roadmap = createRoadmap({ title: 'Supervisor cascade project' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_cascade' }, store)

    const archived = archiveRoadmap(roadmap.id, { note: 'closed' }, store)!
    expect(archived.supervisors).toEqual([expect.objectContaining({ supervisorId: supervisor.supervisorId, status: 'archived', note: 'closed' })])
    expect(getRoadmapSupervisor(supervisor.supervisorId, store)).toMatchObject({ status: 'archived', isDefault: false })

    const otherRoadmap = createRoadmap({ title: 'Delete supervisor project' }, store)
    const other = createRoadmapSupervisor({ roadmapId: otherRoadmap.id, sessionId: 'ses_delete_supervisor' }, store)
    const binding = upsertProjectBinding({ alias: 'delete-supervisor-project', roadmapId: otherRoadmap.id, sessionId: other.sessionId, provider: 'telegram', chatId: 'delete-chat' }, store)
    expect(getChannelBinding('telegram', 'delete-chat', undefined, store)).toMatchObject({ roadmapId: otherRoadmap.id })
    expect(archiveRoadmapSupervisor(other.supervisorId, { note: 'watcher retired' }, store)).toMatchObject({ status: 'archived', note: 'watcher retired' })
    const deleted = deleteRoadmap(otherRoadmap.id, store)
    expect(deleted).toMatchObject({ deleted: true, supervisorIds: [other.supervisorId], projectBindingIds: [binding.id] })
    expect(loadWorkState(store).supervisors.some(row => row.supervisorId === other.supervisorId)).toBe(false)
    expect(getChannelBinding('telegram', 'delete-chat', undefined, store)).toBeUndefined()
  })

  it('acquires supervisor wakeups from matching events and advances cursors on completion', () => {
    const roadmap = createRoadmap({ title: 'Wake event project' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_wake' }, store)
    const task = createWorkTask({ title: 'Trigger done', roadmapId: roadmap.id }, store)
    applyWorkTaskAction(task.id, 'done', {}, store)

    const wakeups = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'test-owner', leaseMs: 60000 }, store)

    expect(wakeups).toHaveLength(1)
    expect(wakeups[0]).toMatchObject({ reason: 'event:allRoadmapTasksDone', wakeReason: 'issue_completed', wakeReasonDetail: 'allRoadmapTasksDone', leaseOwner: 'test-owner', idempotencyKey: expect.any(String), receiptId: expect.any(String) })
    expect(wakeups[0]!.triggerEvents.some(event => event.type === 'task.done')).toBe(true)
    expect(acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'other-owner', leaseMs: 60000 }, store)).toHaveLength(0)
    expect(listSupervisorWakeupReceipts({ supervisorId: supervisor.supervisorId }, store)).toEqual([
      expect.objectContaining({ id: wakeups[0]!.receiptId, status: 'leased', wakeReason: 'issue_completed', idempotencyKey: wakeups[0]!.idempotencyKey, triggerEventIds: expect.arrayContaining(wakeups[0]!.triggerEvents.map(event => event.id)) }),
    ])

    const completed = completeRoadmapSupervisorWakeup(supervisor.supervisorId, { leaseOwner: 'test-owner', cursorEventId: wakeups[0]!.cursorEventId, note: 'reviewed' }, store)
    expect(completed).toMatchObject({ wakeLeaseOwner: undefined, lastReviewedEventId: wakeups[0]!.cursorEventId, lastReviewAt: expect.any(String), note: 'reviewed' })
    expect(acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'after-cursor' }, store)).toHaveLength(0)
    expect(listWorkEvents(10, store).map(event => event.type)).toEqual(expect.arrayContaining(['roadmap.supervisor.wakeup_acquired', 'roadmap.supervisor.wakeup_completed']))
    expect(listSupervisorWakeupReceipts({ supervisorId: supervisor.supervisorId }, store)[0]).toMatchObject({ status: 'completed', summary: 'reviewed', completedAt: expect.any(String) })
  })

  it('honors supervisor trigger policy, disabled state, and cadence due dates', () => {
    const roadmap = createRoadmap({ title: 'Wake cadence project' }, store)
    const disabled = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_disabled', eventTriggers: { disabled: true } }, store)
    const cadence = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_cadence', cadence: { intervalMs: 60000 }, isDefault: true, lastReviewAt: '2026-06-13T00:00:00.000Z' }, store)
    updateRoadmapSupervisor(disabled.supervisorId, { isDefault: false }, store)
    const task = createWorkTask({ title: 'Blocked trigger', roadmapId: roadmap.id }, store)
    applyWorkTaskAction(task.id, 'block', {}, store)

    expect(acquireDueRoadmapSupervisorWakeups({ now: Date.parse('2026-06-13T00:00:30.000Z'), leaseOwner: 'early' }, store)).toMatchObject([{ reason: 'event:taskBlocked', wakeReason: 'blocked_work' }])
    completeRoadmapSupervisorWakeup(cadence.supervisorId, { leaseOwner: 'early', cursorEventId: listWorkEvents(100, store).at(-1)?.id }, store)

    const due = acquireDueRoadmapSupervisorWakeups({ now: Date.now() + 120000, leaseOwner: 'cadence' }, store)
    expect(due).toMatchObject([{ reason: 'cadence', wakeReason: 'schedule', windowKey: expect.any(String) }])
    expect(due[0]!.windowKey).toMatch(/^(nextReviewAt|cadence):/)
  })

  it('recovers stale supervisor wake leases without changing idempotency windows', () => {
    const roadmap = createRoadmap({ title: 'Wake stale lease project' }, store)
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_stale_wake', nextReviewAt: '2026-06-13T00:00:00.000Z' }, store)

    const first = acquireDueRoadmapSupervisorWakeups({ now: Date.parse('2026-06-13T00:01:00.000Z'), leaseOwner: 'owner-one', leaseMs: 60000 }, store)[0]
    expect(first).toMatchObject({ wakeReason: 'schedule', idempotencyKey: expect.any(String) })
    expect(acquireDueRoadmapSupervisorWakeups({ now: Date.parse('2026-06-13T00:01:30.000Z'), leaseOwner: 'owner-two', leaseMs: 60000 }, store)).toHaveLength(0)

    const recovered = acquireDueRoadmapSupervisorWakeups({ now: Date.parse('2026-06-13T00:02:01.000Z'), leaseOwner: 'owner-two', leaseMs: 60000 }, store)[0]
    expect(recovered).toMatchObject({ idempotencyKey: first!.idempotencyKey, receiptId: first!.receiptId, leaseOwner: 'owner-two' })
    expect(listSupervisorWakeupReceipts({ supervisorId: recovered!.supervisor.supervisorId }, store)).toEqual([
      expect.objectContaining({ id: first!.receiptId, status: 'leased', leaseOwner: 'owner-two', idempotencyKey: first!.idempotencyKey }),
    ])
  })

  it('maps manual, gate, alert, and delegation events onto unified wake reasons', () => {
    const roadmap = createRoadmap({ title: 'Wake reasons project' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_reasons' }, store)

    appendWorkEvent('roadmap.supervisor.review_requested', roadmap.id, { supervisorId: supervisor.supervisorId }, store)
    const manual = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'manual' }, store)[0]
    expect(manual).toMatchObject({ reason: 'event:manualPoke', wakeReason: 'manual_poke' })
    completeRoadmapSupervisorWakeup(supervisor.supervisorId, { leaseOwner: 'manual', cursorEventId: manual!.cursorEventId }, store)

    appendWorkEvent('human_gate.created', roadmap.id, { gateId: 'gate_1', roadmapId: roadmap.id }, store)
    const gate = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'gate' }, store)[0]
    expect(gate).toMatchObject({ reason: 'event:humanGatePending', wakeReason: 'gate_requested' })
    completeRoadmapSupervisorWakeup(supervisor.supervisorId, { leaseOwner: 'gate', cursorEventId: gate!.cursorEventId }, store)

    appendWorkEvent('alert.detected', roadmap.id, { severity: 'critical', roadmapId: roadmap.id }, store)
    const alert = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'alert' }, store)[0]
    expect(alert).toMatchObject({ reason: 'event:criticalAlertActive', wakeReason: 'failure_alert' })
    completeRoadmapSupervisorWakeup(supervisor.supervisorId, { leaseOwner: 'alert', cursorEventId: alert!.cursorEventId }, store)

    appendWorkEvent('delegation.progress', roadmap.id, { roadmapId: roadmap.id }, store)
    const delegated = acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'delegated' }, store)[0]
    expect(delegated).toMatchObject({ reason: 'event:delegatedProgress', wakeReason: 'delegated_progress' })
  })

  it('filters disabled event categories', () => {
    const roadmap = createRoadmap({ title: 'Wake filtered project' }, store)
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_filtered', eventTriggers: { taskBlocked: false } }, store)
    const task = createWorkTask({ title: 'Filtered block', roadmapId: roadmap.id }, store)
    applyWorkTaskAction(task.id, 'block', {}, store)

    expect(acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'filtered' }, store)).toHaveLength(0)

    const disabledRoadmap = createRoadmap({ title: 'Wake disabled project' }, store)
    createRoadmapSupervisor({ roadmapId: disabledRoadmap.id, sessionId: 'ses_disabled', eventTriggers: { disabled: true } }, store)
    const disabledTask = createWorkTask({ title: 'Disabled block', roadmapId: disabledRoadmap.id }, store)
    applyWorkTaskAction(disabledTask.id, 'block', {}, store)

    expect(acquireDueRoadmapSupervisorWakeups({ leaseOwner: 'disabled' }, store)).toHaveLength(0)
  })

  it('normalizes aliases and resolves project context by precedence', () => {
    const roadmap = createRoadmap({ title: 'Launch Site' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' }, store)
    const global = upsertProjectBinding({ alias: 'Launch Site!', roadmapId: roadmap.id, sessionId: supervisor.sessionId, title: 'Launch Site' }, store)
    const identitySessionRef: { sessionId?: string } = { sessionId: supervisor.sessionId }
    const identityChannelTarget = { provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' }

    expect(normalizeProjectAlias(' Launch_Site! ')).toBe('launch-site')
    expect(global).toMatchObject({ alias: 'launch-site', scope: 'global', roadmapId: roadmap.id })
    expect(resolveProjectContext({ alias: 'launch-site' }, store)).toMatchObject({ status: 'resolved', reason: 'explicit alias', roadmap: { id: roadmap.id }, supervisor: { supervisorId: supervisor.supervisorId } })

    const channel = upsertProjectBinding({ alias: 'launch-site-chat', roadmapId: roadmap.id, sessionId: 'ses_channel', ...identityChannelTarget }, store)
    expect(resolveProjectContext({ alias: 'launch-site', provider: 'telegram', chatId: 'chat-1', threadId: 'topic-1' }, store)).toMatchObject({ status: 'resolved', reason: 'bound chat/thread context', binding: { id: channel.id } })
    expect(resolveProjectContext(identitySessionRef, store)).toMatchObject({ status: 'resolved', reason: 'explicit session context', binding: { id: global.id } })
    expect(loadWorkState(store).projectBindings).toHaveLength(2)
  })

  it('uses canonical identity graph resolution without unsafe fallback', () => {
    const first = createRoadmap({ title: 'Session project' }, store)
    const second = createRoadmap({ title: 'Roadmap project' }, store)
    createRoadmapSupervisor({ roadmapId: first.id, sessionId: 'ses_first_supervisor' }, store)
    createRoadmapSupervisor({ roadmapId: second.id, sessionId: 'ses_second_supervisor' }, store)
    const sessionBinding = upsertProjectBinding({ alias: 'session-project', roadmapId: first.id, sessionId: 'ses_shared' }, store)
    const roadmapBinding = upsertProjectBinding({ alias: 'roadmap-project', roadmapId: second.id, sessionId: 'ses_other' }, store)

    expect(resolveProjectContext({ sessionId: 'ses_shared', roadmapId: second.id }, store)).toMatchObject({
      status: 'resolved',
      reason: 'explicit session context',
      binding: { id: sessionBinding.id },
      roadmap: { id: first.id },
    })
    expect(resolveProjectContext({ sessionId: 'ses_missing' }, store)).toMatchObject({
      status: 'not_found',
      reason: 'Project binding not found for session: ses_missing',
    })
    expect(resolveProjectContext({ sessionId: 'ses_missing', roadmapId: second.id }, store)).toMatchObject({
      status: 'not_found',
      reason: 'Project binding not found for session: ses_missing',
    })
    expect(resolveProjectContext({ roadmapId: second.id }, store)).toMatchObject({
      status: 'resolved',
      reason: 'explicit roadmap ID',
      binding: { id: roadmapBinding.id },
      roadmap: { id: second.id },
    })
  })

  it('falls back to the single active supervisor only when context is otherwise absent', () => {
    const roadmap = createRoadmap({ title: 'Only active supervisor project' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_only_supervisor' }, store)
    upsertProjectBinding({ alias: 'only-supervisor-project', roadmapId: roadmap.id, sessionId: supervisor.sessionId }, store)

    expect(resolveProjectContext({}, store)).toMatchObject({
      status: 'resolved',
      reason: 'single active supervisor session',
      roadmap: { id: roadmap.id },
      supervisor: { supervisorId: supervisor.supervisorId },
    })
    expect(resolveProjectContext({ sessionId: 'ses_missing' }, store)).toMatchObject({ status: 'not_found' })
  })

  it('detects project binding conflicts and supports explicit rebind', () => {
    const first = createRoadmap({ title: 'First project' }, store)
    const second = createRoadmap({ title: 'Second project' }, store)
    const binding = upsertProjectBinding({ alias: 'project', roadmapId: first.id, sessionId: 'ses_first' }, store)

    expect(() => upsertProjectBinding({ alias: 'project', roadmapId: second.id, sessionId: 'ses_second' }, store)).toThrow('project alias already bound')
    const rebound = upsertProjectBinding({ alias: 'project', roadmapId: second.id, sessionId: 'ses_second', allowRebind: true }, store)
    expect(rebound).toMatchObject({ id: binding.id, roadmapId: second.id, sessionId: 'ses_second' })

    upsertProjectBinding({ alias: 'chat-one', roadmapId: first.id, sessionId: 'ses_chat_one', provider: 'telegram', chatId: 'chat-1' }, store)
    expect(getChannelBinding('telegram', 'chat-1', undefined, store)).toMatchObject({ roadmapId: first.id })
    expect(() => upsertProjectBinding({ alias: 'chat-two', roadmapId: second.id, sessionId: 'ses_chat_two', provider: 'telegram', chatId: 'chat-1' }, store)).toThrow('project surface already bound')
    expect(upsertProjectBinding({ alias: 'chat-two', roadmapId: second.id, sessionId: 'ses_chat_two', provider: 'telegram', chatId: 'chat-1', allowRebind: true }, store)).toMatchObject({ alias: 'chat-two', roadmapId: second.id })
    expect(getChannelBinding('telegram', 'chat-1', undefined, store)).toMatchObject({ roadmapId: second.id })
  })

  it('updates and deletes project bindings deterministically', () => {
    const roadmap = createRoadmap({ title: 'Project binding update' }, store)
    const binding = upsertProjectBinding({ alias: 'old-name', roadmapId: roadmap.id, sessionId: 'ses_old', provider: 'telegram', chatId: 'old-chat' }, store)
    expect(getChannelBinding('telegram', 'old-chat', undefined, store)).toMatchObject({ roadmapId: roadmap.id })

    expect(updateProjectBinding(binding.id, { alias: 'new name', sessionId: 'ses_new', chatId: 'new-chat' }, store)).toMatchObject({ alias: 'new-name', sessionId: 'ses_new' })
    expect(getProjectBinding(binding.id, store)).toMatchObject({ alias: 'new-name' })
    expect(listProjectBindings({ alias: 'new-name' }, store)).toHaveLength(1)
    expect(getChannelBinding('telegram', 'old-chat', undefined, store)).toBeUndefined()
    expect(getChannelBinding('telegram', 'new-chat', undefined, store)).toMatchObject({ sessionId: 'ses_new' })

    expect(deleteProjectBinding(binding.id, store)).toBe(true)
    expect(getProjectBinding(binding.id, store)).toBeUndefined()
    expect(getChannelBinding('telegram', 'new-chat', undefined, store)).toBeUndefined()
    expect(listWorkEvents(10, store).map(event => event.type)).toEqual(expect.arrayContaining(['project.binding.upserted', 'project.binding.updated', 'project.binding.deleted']))
  })

  it('returns ambiguity instead of guessing aliases', () => {
    const first = createRoadmap({ title: 'Ambiguous first' }, store)
    const second = createRoadmap({ title: 'Ambiguous second' }, store)
    upsertProjectBinding({ alias: 'ambiguous', roadmapId: first.id, sessionId: 'ses_global' }, store)
    upsertProjectBinding({ alias: 'ambiguous', roadmapId: second.id, sessionId: 'ses_chat', provider: 'telegram', chatId: 'chat-2' }, store)

    const resolved = resolveProjectContext({ alias: 'ambiguous' }, store)
    expect(resolved).toMatchObject({ status: 'ambiguous' })
    expect(resolved.reason).toContain('specify')
  })

  it('stores roadmap quality metadata and approves completion proposals', () => {
    const roadmap = createRoadmap({
      title: 'Governed roadmap',
      qualitySpec: {
        objective: 'Ship the real outcome',
        acceptanceCriteria: ['All user-visible flows pass'],
        definitionOfDone: ['Docs and tests complete'],
        evidenceRequirements: ['npm run verify'],
        requiredArtifacts: ['docs/runbook.md'],
        residualRiskNotes: ['Monitor rollout'],
        completionPolicy: 'assistant_proposes_user_approves',
      },
    }, store)
    createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_supervisor' }, store)

    expect(loadWorkState(store).roadmaps[0]!.qualitySpec).toMatchObject({ completionPolicy: 'assistant_proposes_user_approves', definitionOfDone: ['Docs and tests complete'] })
    const proposed = proposeRoadmapCompletion({ roadmapId: roadmap.id, proposedBy: 'supervisor', sessionId: 'ses_supervisor', evidence: ['npm run verify', 'docs/runbook.md'], recommendation: 'approve completion' }, store)
    expect(proposed.proposal).toMatchObject({ status: 'pending', roadmapId: roadmap.id })
    expect(listRoadmapCompletionProposals({ status: 'open' }, store)).toHaveLength(1)

    const decided = decideRoadmapCompletionProposal(proposed.proposal.id, { decision: 'approve', actor: 'operator', source: 'test', note: 'accepted' }, store)
    expect(decided?.proposal).toMatchObject({ status: 'approved', decisionBy: 'operator', decisionNote: 'accepted' })
    expect(loadWorkState(store).roadmaps.find(row => row.id === roadmap.id)).toMatchObject({ status: 'done' })
    expect(listWorkEvents(10, store).map(event => event.type)).toEqual(expect.arrayContaining(['roadmap.completion.proposed', 'roadmap.completion.approved', 'audit.human_decision']))
  })

  it('blocks automatic completion when required evidence, gates, alerts, or blocked tasks exist', () => {
    const roadmap = createRoadmap({
      title: 'Auto governed roadmap',
      qualitySpec: {
        evidenceRequirements: ['npm run verify'],
        requiredArtifacts: ['release note'],
        acceptanceCriteria: [],
        definitionOfDone: [],
        residualRiskNotes: [],
        completionPolicy: 'auto_when_evidence_complete',
      },
    }, store)
    const task = createWorkTask({ title: 'Blocked task', roadmapId: roadmap.id, manualGate: 'approval_required' }, store)
    applyWorkTaskAction(task.id, 'block', { note: 'blocked' }, store)
    updateRoadmap(roadmap.id, { status: 'active' }, store)
    upsertAlert({ key: 'critical:auto-complete', severity: 'critical', source: 'test', summary: 'Critical alert', nextAction: 'Resolve it' }, {}, store)

    const result = proposeRoadmapCompletion({ roadmapId: roadmap.id, evidence: ['partial'], unresolvedRisks: ['rollout unknown'] }, store)

    expect(result.proposal.status).toBe('pending')
    expect(result.blockedReasons.join('\n')).toContain('blocked tasks')
    expect(result.blockedReasons.join('\n')).toContain('open required gates')
    expect(result.blockedReasons.join('\n')).toContain('active critical alerts')
    expect(result.blockedReasons.join('\n')).toContain('missing required evidence')
    expect(result.blockedReasons.join('\n')).toContain('unresolved risks')
    expect(loadWorkState(store).roadmaps.find(row => row.id === roadmap.id)?.status).not.toBe('done')
  })

  it('rejects completion proposals and schedules supervisor follow-up', () => {
    const roadmap = createRoadmap({ title: 'Rejected completion' }, store)
    const supervisor = createRoadmapSupervisor({ roadmapId: roadmap.id, sessionId: 'ses_followup' }, store)
    const proposal = proposeRoadmapCompletion({ roadmapId: roadmap.id, evidence: ['tests pass'] }, store).proposal

    const result = decideRoadmapCompletionProposal(proposal.id, { decision: 'reject', actor: 'operator', source: 'test', note: 'missing rollout proof' }, store)

    expect(result?.proposal).toMatchObject({ status: 'rejected', decisionNote: 'missing rollout proof' })
    expect(getRoadmapSupervisor(supervisor.supervisorId, store)).toMatchObject({ nextReviewAt: expect.any(String), note: 'missing rollout proof' })
    expect(loadWorkState(store).roadmaps.find(row => row.id === roadmap.id)?.status).toBe('active')
  })

  it('creates roadmaps with tasks and bulk mutates tasks atomically', () => {
    const result = createRoadmapWithTasks({
      title: 'Bulk project',
      priority: 'HIGH',
      tasks: [
        { title: 'First task', priority: 'HIGH', pipeline: ['plan', 'implement'] },
        { title: 'Second task', priority: 'LOW' },
      ],
    }, store)

    expect(result.roadmap).toMatchObject({ title: 'Bulk project', priority: 'HIGH' })
    expect(result.tasks).toHaveLength(2)
    expect(result.tasks.every(task => task.roadmapId === result.roadmap.id)).toBe(true)

    const more = createWorkTasks([{ title: 'Third task' }], result.roadmap.id, store)
    expect(more[0]).toMatchObject({ roadmapId: result.roadmap.id, title: 'Third task' })

    const updated = updateWorkTasks([
      { taskId: result.tasks[0]!.id, priority: 'LOW', currentStage: 'implement' },
      { taskId: result.tasks[1]!.id, status: 'done' },
    ], store)
    expect(updated.tasks[0]).toMatchObject({ priority: 'LOW', currentStage: 'implement' })
    expect(updated.tasks[1]).toMatchObject({ status: 'done', currentStage: undefined })

    expect(() => updateWorkTasks([
      { taskId: result.tasks[0]!.id, priority: 'HIGH' },
      { taskId: 'task_missing', priority: 'LOW' },
    ], store)).toThrow('task not found')
    expect(loadWorkState(store).tasks.find(task => task.id === result.tasks[0]!.id)?.priority).toBe('LOW')
  })

  function expireEventPruneThrottle(storePath: string): void {
    const db = new DatabaseSync(storePath)
    try {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('eventsAgePrunedAt', ?)").run(new Date(Date.now() - 120_000).toISOString())
    } finally {
      db.close()
    }
  }

  it('bounds retained workflow events', () => {
    const task = createWorkTask({ title: 'Event retention target' }, store)
    const db = new DatabaseSync(store)
    try {
      const insert = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
      const createdAt = new Date().toISOString()
      db.exec('BEGIN')
      for (let i = 0; i < 10010; i++) insert.run('retention.seed', task.id, JSON.stringify({ i }), createdAt)
      db.exec('COMMIT')
    } finally {
      db.close()
    }

    // Pruning is throttled housekeeping now; expire the throttle so this
    // append runs it.
    expireEventPruneThrottle(store)
    appendWorkEvent('retention.test', task.id, {}, store)

    const verifyDb = new DatabaseSync(store)
    try {
      const count = Number((verifyDb.prepare('SELECT COUNT(*) AS count FROM events').get() as any).count)
      expect(count).toBeLessThanOrEqual(10000)
    } finally {
      verifyDb.close()
    }
  })

  it('keeps notification dedupe proof events durable across cap-based pruning', () => {
    const task = createWorkTask({ title: 'Dedupe proof retention target' }, store)
    appendWorkEvent('opencode.request.notified', 'question:q_1', { kind: 'question', targetKey: 'telegram:target:abc' }, store)
    appendWorkEvent('project.notification.sent', 'roadmap:dedupe-key', {}, store)

    const db = new DatabaseSync(store)
    try {
      const insert = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
      const createdAt = new Date().toISOString()
      db.exec('BEGIN')
      for (let i = 0; i < 10010; i++) insert.run('retention.seed', task.id, JSON.stringify({ i }), createdAt)
      db.exec('COMMIT')
    } finally {
      db.close()
    }

    // Triggers pruneWorkEvents; the row cap must not evict durable dedupe proofs.
    expireEventPruneThrottle(store)
    appendWorkEvent('retention.test', task.id, {}, store)

    expect(listWorkEventsByType('opencode.request.notified', 10, store)).toEqual([
      expect.objectContaining({ subjectId: 'question:q_1', payload: expect.objectContaining({ targetKey: 'telegram:target:abc' }) }),
    ])
    expect(listWorkEventsByType('project.notification.sent', 10, store)).toHaveLength(1)
  })

  it('records durable security audit events', () => {
    appendAuditEvent({ actor: 'http', source: '127.0.0.1', operation: 'config.update', target: 'config', result: 'ok' }, store)

    const [event] = listWorkEvents(1, store)
    expect(event).toMatchObject({ type: 'audit.security', subjectId: 'config' })
    expect(event!.payload).toMatchObject({ actor: 'http', source: '127.0.0.1', operation: 'config.update', target: 'config', result: 'ok' })
  })

  it('persists dependencies and calculates deterministic readiness', () => {
    const prerequisite = createWorkTask({ title: 'Finish prerequisite' }, store)
    const dependent = createWorkTask({ title: 'Run after prerequisite', dependsOn: [prerequisite.id], manualGate: 'approval_required' }, store)

    expect(listWorkDependencies(dependent.id, store)).toEqual([expect.objectContaining({ taskId: dependent.id, dependsOnTaskId: prerequisite.id, type: 'blocks' })])
    expect(getWorkTaskReadiness(dependent.id, store)).toMatchObject({ status: 'waiting', reason: 'Waiting for operator approval' })

    updateWorkTask(dependent.id, { manualGate: '' }, store)
    expect(getWorkTaskReadiness(dependent.id, store)).toMatchObject({ status: 'blocked', blockers: [prerequisite.id] })

    updateWorkTask(prerequisite.id, { status: 'done' }, store)
    expect(getWorkTaskReadiness(dependent.id, store)).toMatchObject({ status: 'runnable' })
  })

  it('persists structured task quality specs', () => {
    const task = createWorkTask({ title: 'Quality task', qualitySpec: { acceptanceCriteria: ['works end to end'], verificationCommands: ['npm test'], evidenceRequirements: ['test output'], requiredArtifacts: ['src/app.ts'], rollbackPlan: 'revert commit' } as any }, store)

    expect(loadWorkState(store).tasks.find(row => row.id === task.id)?.qualitySpec).toMatchObject({
      acceptanceCriteria: ['works end to end'],
      verificationCommands: ['npm test'],
      evidenceRequirements: ['test output'],
      requiredArtifacts: ['src/app.ts'],
      rollbackPlan: 'revert commit',
    })
  })

  it('persists agent team bindings, task overrides, and run resolution metadata', () => {
    updateConfig({
      agentTeams: {
        analytics: {
          roles: { implement: 'implementer', verify: 'verifier' },
          capabilityRequirements: { implement: ['dbt'] },
          qualitySpecDefaults: {},
        },
      },
    } as any)
    const teamRevision = getConfig().agentTeams['analytics']!.revision
    const roadmap = createRoadmap({ title: 'Analytics project', agentTeam: 'analytics' }, store)
    const task = createWorkTask({ title: 'Build model', roadmapId: roadmap.id, agentTeam: 'analytics', stageProfiles: { verify: 'verifier' }, pipeline: ['implement', 'verify'] }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_team', 'implementer', store, { owner: 'owner-team' }, { agentTeam: 'analytics', agentTeamVersion: teamRevision, resolvedProfile: 'implementer', resolvedAgent: 'gateway-implementer' })!

    const state = loadWorkState(store)
    expect(state.roadmaps.find(row => row.id === roadmap.id)).toMatchObject({ agentTeam: 'analytics' })
    expect(state.tasks.find(row => row.id === task.id)).toMatchObject({ agentTeam: 'analytics', stageProfiles: { verify: 'verifier' } })
    expect(state.runs.find(row => row.id === started.run.id)).toMatchObject({ agentTeam: 'analytics', agentTeamVersion: teamRevision, resolvedProfile: 'implementer', resolvedAgent: 'gateway-implementer' })

    expect(() => createWorkTask({ title: 'Bad team', agentTeam: 'missing-team' }, store)).toThrow('agent team not found')
    expect(() => updateWorkTask(task.id, { stageProfiles: { verify: 'missing-profile' } }, store)).toThrow('profile not found')
  })

  it('persists execution environment selectors and run snapshots', () => {
    const roadmap = createRoadmap({ title: 'Environment roadmap', environment: 'remote-large' }, store)
    const task = createWorkTask({ title: 'Environment task', roadmapId: roadmap.id, environment: { name: 'local-node', backend: 'local-process', tools: ['node'] } as any }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_env', 'implementer', store, { owner: 'owner-env' }, {
      environment: {
        id: 'env_test',
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
      },
    })!

    const state = loadWorkState(store)

    expect(state.roadmaps.find(row => row.id === roadmap.id)).toMatchObject({ environment: 'remote-large' })
    expect(state.tasks.find(row => row.id === task.id)).toMatchObject({ environment: { name: 'local-node', backend: 'local-process', tools: ['node'] } })
    expect(state.runs.find(row => row.id === started.run.id)).toMatchObject({ environment: { id: 'env_test', name: 'local-node', backend: 'local-process', preflight: { ok: true } } })
  })

  it('lists, inspects, acts on, and reconciles environment snapshots without exposing secrets', () => {
    const task = createWorkTask({ title: 'Environment operator task' }, store)
    const cleanupError = `cleanup failed on ${path.join(os.homedir(), 'private-cleanup.log')} token=secret-token-value chat_id=5102309655 webhook=https://hooks.example.test/private`
    const started = startWorkTaskRun(task.id, 'implement', 'ses_environment', 'implementer', store, {}, { environment: envRun({ metadata: { apiKey: 'secret-key-value', slug: 'safe-slug', cleanupError }, artifacts: ['artifact://log'] }) })!

    const environments = listWorkEnvironments({}, loadWorkState(store))
    expect(environments).toEqual([expect.objectContaining({ id: 'env_operator', runId: started.run.id, status: 'prepared', artifacts: ['artifact://log'], metadata: expect.objectContaining({ apiKey: '<redacted>', slug: 'safe-slug' }) })])
    const metadataText = JSON.stringify(environments[0]!.metadata)
    expect(metadataText).toContain('cleanup failed')
    expect(metadataText).not.toContain(os.homedir())
    expect(metadataText).not.toContain('private-cleanup.log')
    expect(metadataText).not.toContain('secret-token-value')
    expect(metadataText).not.toContain('5102309655')
    expect(metadataText).not.toContain('hooks.example.test')
    expect(environments[0]!.lifecycleDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
      code: 'stale_active_environment',
      action: expect.stringContaining('environment_reconcile'),
    })]))
    expect(getWorkEnvironment('env_operator', loadWorkState(store))).toMatchObject({ taskTitle: 'Environment operator task', backend: 'local-process' })

    const retained = applyWorkEnvironmentAction('env_operator', 'retain', { actor: 'test', note: 'debug' }, store)
    expect(retained).toMatchObject({ eventType: 'environment.retained', environment: { status: 'retained', cleanup: { state: 'retained' } } })
    expect(listWorkEvents(10, store).at(-1)).toMatchObject({ type: 'environment.retained', payload: { actor: 'test', note: 'debug' } })

    const released = applyWorkEnvironmentAction(started.run.id, 'release', {}, store)
    expect(released).toMatchObject({ eventType: 'environment.released', environment: { status: 'released', cleanup: { state: 'released' } } })
    expect(reconcileWorkEnvironments(store)).toMatchObject({ checked: 0, cleanupFailed: 0 })
  })

  it('marks cleanup failures and returns active session ids for environment aborts', () => {
    const failedTask = createWorkTask({ title: 'Cleanup failure task' }, store)
    startWorkTaskRun(failedTask.id, 'implement', 'ses_cleanup', 'implementer', store, {}, { environment: envRun({ id: 'env_cleanup', backend: 'remote-crabbox', runtime: 'missing-crabbox-cli-for-test', leaseId: 'lease-cleanup' }) })!
    const cleaned = applyWorkEnvironmentAction('env_cleanup', 'cleanup', {}, store)
    expect(cleaned).toMatchObject({ eventType: 'environment.cleanup_failed', environment: { status: 'cleanup_failed', cleanup: { state: 'failed' } } })

    const abortTask = createWorkTask({ title: 'Abort env task' }, store)
    const started = startWorkTaskRun(abortTask.id, 'implement', 'ses_abort_env', 'implementer', store, {}, { environment: envRun({ id: 'env_abort' }) })!
    const aborted = applyWorkEnvironmentAction('env_abort', 'abort', {}, store)

    expect(aborted).toMatchObject({ eventType: 'environment.aborted', abortedSessionId: 'ses_abort_env', run: { status: 'errored' } })
    expect(loadWorkState(store).tasks.find(row => row.id === abortTask.id)).toMatchObject({ status: 'blocked', currentRunId: undefined })
    expect(loadWorkState(store).runs.find(row => row.id === started.run.id)).toMatchObject({ status: 'errored', result: { summary: 'environment.abort requested by Gateway' } })
  })

  it('rejects dependency cycles and scheduled tasks before start time', () => {
    const first = createWorkTask({ title: 'First dependency' }, store)
    const second = createWorkTask({ title: 'Second dependency', dependsOn: [first.id] }, store)

    expect(() => addWorkDependency({ taskId: first.id, dependsOnTaskId: second.id }, store)).toThrow('cycle')
    updateWorkTask(first.id, { earliestStartAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }, store)

    expect(getWorkTaskReadiness(first.id, store)).toMatchObject({ status: 'scheduled' })
  })

  it('records, renews, summarizes, and recovers durable run leases', () => {
    const task = createWorkTask({ title: 'Lease protected task' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_lease', 'implementer', store, { owner: 'owner-1', leaseMs: 1000, generation: 'gen-1' })!

    expect(started.run).toMatchObject({ leaseOwner: 'owner-1', schedulerGeneration: 'gen-1' })
    expect(summarizeWorkLeases(loadWorkState(store), Date.parse(started.run.leaseExpiresAt!) + 1)).toMatchObject({ running: 1, expired: 1 })

    expect(renewWorkTaskRunLease(started.run.id, { owner: 'owner-2', leaseMs: 120_000, generation: 'gen-2' }, store)).toBe(false)
    expect(loadWorkState(store).runs[0]).toMatchObject({ leaseOwner: 'owner-1', schedulerGeneration: 'gen-1' })
    expect(listWorkEvents(10, store)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'task.run.lease_renew_denied', payload: expect.objectContaining({ reason: 'lease_owner_mismatch' }) }),
    ]))
    expect(renewWorkTaskRunLease(started.run.id, { owner: 'owner-1', leaseMs: 120_000, generation: 'gen-1' }, store)).toBe(true)
    expect(loadWorkState(store).runs[0]).toMatchObject({ leaseOwner: 'owner-1', schedulerGeneration: 'gen-1' })
    const renewedLease = loadWorkState(store).runs[0]!.leaseExpiresAt
    expect(renewWorkTaskRunLease(started.run.id, { owner: 'owner-1', leaseMs: 120_000, generation: 'gen-1' }, store)).toBe(true)
    expect(loadWorkState(store).runs[0]!.leaseExpiresAt).toBe(renewedLease)
    const staleCompletion = completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'stale pass', artifacts: [], raw: 'stale pass' }, 2, store, {}, { owner: 'owner-2', generation: 'gen-1' })
    expect(staleCompletion).toMatchObject({ applied: false, reason: 'lease_owner_mismatch' })
    expect(loadWorkState(store).tasks.find(row => row.id === task.id)).toMatchObject({ status: 'running', currentRunId: started.run.id })

    const expiredAt = Date.parse(loadWorkState(store).runs[0]!.leaseExpiresAt!) + 120_001
    const recovered = recoverExpiredWorkLeases(2, store, expiredAt)
    expect(recovered).toMatchObject({ recovered: 0, blocked: 1, runIds: [started.run.id] })
    expect(loadWorkState(store).tasks[0]).toMatchObject({ status: 'blocked', currentStage: undefined, note: expect.stringContaining('old OpenCode session may still be running') })
  })

  it('recovers malformed running runs that have no lease expiration', () => {
    const task = createWorkTask({ title: 'Malformed running task' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_missing_lease', 'implementer', store)!
    const state = loadWorkState(store)
    state.runs[0]!.leaseExpiresAt = undefined
    saveWorkState(state, store)

    expect(summarizeWorkLeases(loadWorkState(store))).toMatchObject({ running: 1, expired: 1 })
    expect(recoverExpiredWorkLeases(2, store)).toMatchObject({ recovered: 0, blocked: 1, runIds: [started.run.id] })
  })

  it('recovers running runs whose OpenCode sessions are missing at startup', () => {
    const task = createWorkTask({ title: 'Orphaned session task' }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_missing', 'implementer', store)!

    expect(recoverOrphanedWorkRuns(new Set(['ses_other']), 2, store)).toMatchObject({ recovered: 1, blocked: 0, runIds: [started.run.id] })
    expect(loadWorkState(store).tasks[0]).toMatchObject({ status: 'pending', currentStage: 'implement' })
  })

  it('plans an initiative with tasks, dependency edges, and a supervisor in one atomic call', () => {
    const result = planInitiative({
      title: 'Ship payments',
      priority: 'HIGH',
      tasks: [
        { title: 'Design schema' },
        { title: 'Build API' },
        { title: 'Wire UI' },
      ],
      dependencies: [
        { taskRef: 1, dependsOnRef: 0 },
        { taskRef: 'Wire UI', dependsOnRef: 1 },
      ],
      supervisor: { sessionId: 'ses_plan_supervisor', isDefault: true },
    }, store)

    expect(result.roadmap.title).toBe('Ship payments')
    expect(result.tasks).toHaveLength(3)
    expect(result.dependencies).toHaveLength(2)
    expect(result.supervisor).toMatchObject({ roadmapId: result.roadmap.id, sessionId: 'ses_plan_supervisor', isDefault: true })

    const state = loadWorkState(store)
    expect(state.roadmaps.some(roadmap => roadmap.id === result.roadmap.id)).toBe(true)
    expect(state.tasks.filter(task => task.roadmapId === result.roadmap.id)).toHaveLength(3)
    // Edge 1: Build API (index 1) depends on Design schema (index 0).
    expect(listWorkDependencies(result.tasks[1]!.id, store)).toContainEqual(expect.objectContaining({ taskId: result.tasks[1]!.id, dependsOnTaskId: result.tasks[0]!.id }))
    // Edge 2: Wire UI (by title) depends on Build API (index 1).
    expect(listWorkDependencies(result.tasks[2]!.id, store)).toContainEqual(expect.objectContaining({ taskId: result.tasks[2]!.id, dependsOnTaskId: result.tasks[1]!.id }))
    expect(getDefaultRoadmapSupervisor(result.roadmap.id, store)?.supervisorId).toBe(result.supervisor!.supervisorId)
  })

  it('rolls the whole initiative back when any dependency reference is invalid', () => {
    const before = loadWorkState(store)
    expect(() => planInitiative({
      title: 'Broken initiative',
      tasks: [{ title: 'Only task' }],
      dependencies: [{ taskRef: 0, dependsOnRef: 5 }],
    }, store)).toThrow(/index out of range/)

    const after = loadWorkState(store)
    expect(after.roadmaps).toHaveLength(before.roadmaps.length)
    expect(after.tasks).toHaveLength(before.tasks.length)
    expect(after.tasks.some(task => task.title === 'Only task')).toBe(false)
  })

  it('rolls the whole initiative back when a dependency would form a cycle', () => {
    expect(() => planInitiative({
      title: 'Cyclic initiative',
      tasks: [{ title: 'A' }, { title: 'B' }],
      dependencies: [
        { taskRef: 0, dependsOnRef: 1 },
        { taskRef: 1, dependsOnRef: 0 },
      ],
    }, store)).toThrow(/cycle/i)

    expect(loadWorkState(store).tasks.some(task => task.title === 'A')).toBe(false)
  })

  it('plans an initiative without a supervisor when none is provided', () => {
    const result = planInitiative({ title: 'No supervisor', tasks: [{ title: 'Task' }] }, store)
    expect(result.supervisor).toBeUndefined()
    expect(listRoadmapSupervisors({ roadmapId: result.roadmap.id }, store)).toHaveLength(0)
  })

  it('rejects a supervisor object missing a sessionId and rolls the whole initiative back', () => {
    const before = loadWorkState(store)
    expect(() => planInitiative({
      title: 'Supervisor without session',
      tasks: [{ title: 'Task' }],
      supervisor: { isDefault: true } as any,
    }, store)).toThrow(/sessionId/)

    const after = loadWorkState(store)
    expect(after.roadmaps).toHaveLength(before.roadmaps.length)
    expect(after.tasks.some(task => task.title === 'Task')).toBe(false)
    expect(after.supervisors).toHaveLength(before.supervisors.length)
  })

  it('rolls the whole initiative back when the supervisor references an unknown profile', () => {
    const before = loadWorkState(store)
    expect(() => planInitiative({
      title: 'Supervisor with bad profile',
      tasks: [{ title: 'Task A' }, { title: 'Task B' }],
      dependencies: [{ taskRef: 1, dependsOnRef: 0 }],
      supervisor: { sessionId: 'ses_bad_profile', profile: 'does-not-exist' },
    }, store)).toThrow(/profile not found/)

    const after = loadWorkState(store)
    expect(after.roadmaps).toHaveLength(before.roadmaps.length)
    expect(after.tasks.some(task => task.title === 'Task A' || task.title === 'Task B')).toBe(false)
    expect(after.dependencies?.length || 0).toBe(before.dependencies?.length || 0)
    expect(after.supervisors).toHaveLength(before.supervisors.length)
  })

  it('rejects an ambiguous dependency title and rolls the whole initiative back', () => {
    const before = loadWorkState(store)
    expect(() => planInitiative({
      title: 'Ambiguous title initiative',
      tasks: [{ title: 'Dup' }, { title: 'Dup' }, { title: 'Consumer' }],
      dependencies: [{ taskRef: 'Consumer', dependsOnRef: 'Dup' }],
    }, store)).toThrow(/matches multiple new tasks by title/)

    const after = loadWorkState(store)
    expect(after.roadmaps).toHaveLength(before.roadmaps.length)
    expect(after.tasks.some(task => task.title === 'Consumer')).toBe(false)
  })

  it('dedups an identical dependency edge declared twice into a single durable edge', () => {
    const result = planInitiative({
      title: 'Duplicate edge initiative',
      tasks: [{ title: 'Upstream' }, { title: 'Downstream' }],
      dependencies: [
        { taskRef: 1, dependsOnRef: 0 },
        { taskRef: 1, dependsOnRef: 0 },
      ],
    }, store)

    // The duplicate resolves to the same edge record, so only one durable edge persists.
    expect(listWorkDependencies(result.tasks[1]!.id, store)).toHaveLength(1)
    expect(listWorkDependencies(result.tasks[1]!.id, store)).toContainEqual(
      expect.objectContaining({ taskId: result.tasks[1]!.id, dependsOnTaskId: result.tasks[0]!.id }),
    )
  })

})

function envRun(overrides: Partial<EnvironmentRunRecord> = {}): EnvironmentRunRecord {
  return {
    id: 'env_operator',
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
