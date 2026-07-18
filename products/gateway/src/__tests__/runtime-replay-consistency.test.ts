import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest, updateConfig } from '../config.js'
import { buildEvidenceBundle } from '../evidence-export.js'
import { buildMissionControlDashboardSummary } from '../mission-control-view-model.js'
import { buildRuntimeReplayConsistencyReport } from '../runtime-replay-consistency.js'
import {
  appendWorkEvent,
  clearWorkStateForTest,
  createDelegatedWork,
  createWorkTask,
  listChannelBindings,
  listDelegationProgressRouteReceipts,
  listProjectBindings,
  listTaskDispatchReceipts,
  listWorkEvents,
  loadWorkState,
  startWorkTaskRun,
  summarizeWorkTasks,
  type WorkState,
} from '../work-store.js'

describe('runtime replay consistency harness', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-runtime-replay-test-'))
  const repoDir = path.join(testDir, 'repo')
  const stateDir = path.join(testDir, 'state')
  const store = path.join(stateDir, 'gateway.db')
  const generatedAt = '2026-07-14T10:00:00.000Z'

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(generatedAt))
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = stateDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = stateDir
    process.env['TELEGRAM_BOT_TOKEN'] = '123456:telegram-secret-token-value'
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(stateDir, { recursive: true })
    clearConfigCacheForTest()
    updateConfig({ channels: { telegram: { botToken: '123456:telegram-secret-token-value' } } } as any)
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['TELEGRAM_BOT_TOKEN']
    clearConfigCacheForTest()
  })

  it('rebuilds task, run, channel, delegation, dashboard, and evidence surfaces after a simulated restart', () => {
    const delegation = createDelegatedWork({
      idempotencyKey: 'delegation-world-class-fixture',
      targetType: 'project',
      objective: 'Ship a replay consistency harness',
      parentSessionId: 'ses_parent_private',
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'trusted-chat-42', threadId: 'topic-private-7' },
      project: {
        title: 'Runtime replay fixture',
        tasks: [
          { title: 'Implement replay harness', priority: 'HIGH', pipeline: ['implement', 'verify'] },
          { title: 'Write operator evidence', priority: 'MEDIUM', pipeline: ['document'] },
        ],
        supervisor: { roadmapId: 'overwritten-by-delegation', sessionId: 'ses_parent_private', profile: 'supervisor' },
        binding: {
          roadmapId: 'overwritten-by-delegation',
          alias: 'replay-fixture',
          scope: 'telegram',
          provider: 'telegram',
          chatId: 'trusted-chat-42',
          threadId: 'topic-private-7',
          sessionId: 'ses_parent_private',
          title: 'Replay Fixture',
        },
      },
    }, store)
    const taskId = delegation.taskIds[0]!
    const started = startWorkTaskRun(taskId, 'implement', 'ses_child_private', 'implementer', store, {
      owner: 'scheduler-main',
      leaseMs: 60 * 60 * 1000,
      generation: 'gen-1',
    })
    expect(started).toBeDefined()

    const createdProgress = listWorkEvents(100, store).find(event => event.type === 'delegation.progress')
    const progressKey = String(createdProgress?.payload['progressKey'] || 'progress-created-fixture')
    appendWorkEvent('delegation.progress.attempting', 'route-clean', {
      dedupeKey: 'route-clean',
      idempotencyKey: delegation.idempotencyKey,
      progress: 'created',
      progressKey,
      targetKey: 'target_hash_clean',
      provider: 'telegram',
      sessionId: 'ses_parent_private',
      delivery: 'immediate',
      progressEventId: createdProgress?.id,
    }, store)
    appendWorkEvent('delegation.progress.notified', 'route-clean', {
      dedupeKey: 'route-clean',
      idempotencyKey: delegation.idempotencyKey,
      progress: 'created',
      progressKey,
      targetKey: 'target_hash_clean',
      provider: 'telegram',
      sessionId: 'ses_parent_private',
      delivery: 'immediate',
      progressEventId: createdProgress?.id,
    }, store)

    const stateAfterRestart = loadWorkState(store)
    const activeSessionIds = new Set(['ses_parent_private', 'ses_child_private'])
    const dashboardSummary = dashboardForState(stateAfterRestart, activeSessionIds)
    const evidenceBundle = buildEvidenceBundle({
      target: { taskId },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now: new Date(generatedAt),
    })

    const report = buildRuntimeReplayConsistencyReport({
      state: stateAfterRestart,
      events: listWorkEvents(500, store),
      routeReceipts: listDelegationProgressRouteReceipts({}, store),
      channelBindings: listChannelBindings({}, store),
      projectBindings: listProjectBindings({}, store),
      taskDispatchReceipts: listTaskDispatchReceipts({}, store),
      dashboardSummary,
      evidenceManifest: evidenceBundle.manifest,
      activeSessionIds,
      generatedAt,
    })

    expect(report.status).toBe('pass')
    expect(report.findings).toEqual([])
    expect(report.counts).toMatchObject({
      tasks: 2,
      runs: 1,
      channelBindings: 1,
      projectBindings: 1,
      routeReceipts: 1,
      delegationReceipts: 1,
    })
    expect(report.surfaces.map(surface => surface.surface)).toEqual(expect.arrayContaining([
      'tasks',
      'runs',
      'delegation_receipts',
      'delegation_progress',
      'progress_route_receipts',
      'channel_bindings',
      'session_links',
      'dashboard_summary',
      'evidence_export',
    ]))
    expect(report.acceptance).toMatchObject({
      scannerOutputOwnerMapped: true,
      scannerOutputRedacted: true,
      replayCoversRuntimeSurfaces: true,
      unsafeRepairsRequireOperatorConfirmation: true,
      evidenceReferencesPresent: true,
      noReleaseClaimExpansion: true,
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('trusted-chat-42')
    expect(serialized).not.toContain('topic-private-7')
    expect(serialized).not.toContain('ses_parent_private')
    expect(serialized).not.toContain('telegram-secret-token-value')
  })

  it('fails closed with owner-mapped diagnostics for duplicate, missing, stale, orphaned, and unsafe repair cases', () => {
    const task = createWorkTask({ title: 'Corrupt replay fixture', priority: 'HIGH', pipeline: ['implement'] }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_orphan_private', 'implementer', store, {
      owner: 'scheduler-main',
      leaseMs: 60 * 1000,
      generation: 'gen-1',
    })
    expect(started).toBeDefined()
    const runId = started!.run.id

    const db = new DatabaseSync(store)
    db.prepare("DELETE FROM events WHERE type = 'task.created' AND subject_id = ?").run(task.id)
    db.prepare("UPDATE runs SET lease_expires_at = ? WHERE id = ?").run('not-a-date', runId)
    db.prepare(`INSERT INTO task_dispatch_receipts (
      id, task_id, stage, profile, idempotency_key, lease_owner, lease_expires_at, status,
      run_id, session_id, environment_json, prompt_submitted_at, failure_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
      .run('dispatch_mixed', task.id, 'implement', 'implementer', 'dispatch-mixed-key', 'scheduler-alt', '2026-07-14T11:00:00.000Z', 'starting', generatedAt, generatedAt)
    db.prepare(`INSERT INTO task_dispatch_receipts (
      id, task_id, stage, profile, idempotency_key, lease_owner, lease_expires_at, status,
      run_id, session_id, environment_json, prompt_submitted_at, failure_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
      .run('dispatch_bad_lease', task.id, 'implement', 'implementer', 'dispatch-bad-lease-key', 'scheduler-alt', 'not-a-date', 'starting', generatedAt, generatedAt)
    db.close()

    appendWorkEvent('delegation.accepted', 'ses_parent_private', {
      idempotencyKey: 'delegation-accepted-only',
      targetType: 'project',
      parentSessionId: 'ses_parent_private',
    }, store)
    appendWorkEvent('delegation.mapped', task.roadmapId, {
      idempotencyKey: 'delegation-mapped-only',
      targetType: 'project',
      taskIds: [task.id],
      roadmapId: task.roadmapId,
      parentSessionId: 'ses_parent_private',
    }, store)
    appendWorkEvent('delegation.progress', 'delegation-duplicate', {
      idempotencyKey: 'delegation-duplicate',
      progress: 'completed',
      progressKey: 'progress-duplicate-conflict',
      taskId: task.id,
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'trusted-chat-42' },
      summary: 'first terminal progress payload',
    }, store)
    appendWorkEvent('delegation.progress', 'delegation-duplicate', {
      idempotencyKey: 'delegation-duplicate',
      progress: 'completed',
      progressKey: 'progress-duplicate-conflict',
      taskId: task.id,
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'trusted-chat-42' },
      summary: 'conflicting terminal progress payload',
    }, store)
    appendWorkEvent('delegation.progress', 'delegation-parent', {
      idempotencyKey: 'delegation-parent',
      progress: 'completed',
      progressKey: 'progress-parent-terminal',
      taskId: task.id,
      parentSessionId: 'ses_parent_private',
      notificationTarget: { mode: 'parent_session' },
      summary: 'parent-session terminal progress without a route receipt',
    }, store)
    appendWorkEvent('delegation.progress.attempting', 'route-delayed', {
      dedupeKey: 'route-delayed',
      idempotencyKey: 'delegation-duplicate',
      progress: 'completed',
      progressKey: 'progress-delayed',
      targetKey: 'target_hash_delayed',
      provider: 'telegram',
      sessionId: 'ses_orphan_private',
      delivery: 'immediate',
    }, store)
    appendWorkEvent('delegation.progress.suppressed', 'route-orphaned', {
      dedupeKey: 'route-orphaned',
      idempotencyKey: 'delegation-duplicate',
      progress: 'created',
      progressKey: 'progress-orphaned',
      delivery: 'deferred',
      reason: 'missing parent session id',
    }, store)

    const reportNow = '2026-07-14T10:30:00.000Z'
    vi.setSystemTime(new Date(reportNow))
    const stateAfterRestart = loadWorkState(store)
    const activeSessionIds = new Set<string>()
    const dashboardSummary = dashboardForState(stateAfterRestart, activeSessionIds)
    const evidenceBundle = buildEvidenceBundle({
      target: { taskId: task.id },
      filePath: store,
      rootDir: repoDir,
      stateDir,
      now: new Date(reportNow),
    })

    const report = buildRuntimeReplayConsistencyReport({
      state: stateAfterRestart,
      events: listWorkEvents(500, store),
      routeReceipts: listDelegationProgressRouteReceipts({}, store),
      channelBindings: listChannelBindings({}, store),
      projectBindings: listProjectBindings({}, store),
      taskDispatchReceipts: listTaskDispatchReceipts({}, store),
      dashboardSummary,
      evidenceManifest: evidenceBundle.manifest,
      activeSessionIds,
      generatedAt: reportNow,
      staleRouteReceiptMs: 15 * 60 * 1000,
    })

    const codes = report.findings.map(finding => finding.code)
    expect(report.status).toBe('fail')
    expect(codes).toEqual(expect.arrayContaining([
      'runtime.task.missing_recent_created_event',
      'runtime.run.lease_expired',
      'runtime.run.orphaned_session',
      'runtime.dispatch.starting_lease_expired',
      'runtime.dispatch.mixed_active_ownership',
      'runtime.delegation.accepted_without_mapped',
      'runtime.delegation.mapped_without_accepted',
      'runtime.delegation_progress.duplicate_conflict',
      'runtime.delegation_progress.terminal_route_missing',
      'runtime.route_receipt.delayed_callback',
      'runtime.route_receipt.orphaned',
    ]))
    expect(codes.filter(code => code === 'runtime.delegation_progress.terminal_route_missing').length).toBeGreaterThanOrEqual(2)
    expect(report.findings.find(finding => finding.code === 'runtime.delegation_progress.duplicate_conflict')).toMatchObject({
      owner: 'delegation-progress',
      surface: 'delegation_progress',
      severity: 'critical',
      repairMode: 'operator_confirmed',
      redacted: true,
    })
    expect(report.findings.filter(finding => finding.severity === 'critical').every(finding => {
      return finding.repairMode === 'operator_confirmed' || finding.repairMode === 'blocked'
    })).toBe(true)
    expect(report.acceptance).toMatchObject({
      scannerOutputOwnerMapped: true,
      scannerOutputRedacted: true,
      duplicateMissingStaleOrphanedFailClosed: true,
      unsafeRepairsRequireOperatorConfirmation: true,
      noReleaseClaimExpansion: true,
    })
    const serialized = JSON.stringify(report)
    expect(serialized).not.toContain('trusted-chat-42')
    expect(serialized).not.toContain('ses_orphan_private')

    const incompleteEvidenceReport = buildRuntimeReplayConsistencyReport({
      state: stateAfterRestart,
      events: listWorkEvents(500, store),
      routeReceipts: listDelegationProgressRouteReceipts({}, store),
      channelBindings: listChannelBindings({}, store),
      projectBindings: listProjectBindings({}, store),
      taskDispatchReceipts: listTaskDispatchReceipts({}, store),
      dashboardSummary,
      evidenceManifest: {},
      activeSessionIds,
      generatedAt: reportNow,
    })
    expect(incompleteEvidenceReport.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'runtime.evidence_export.unsafe_or_incomplete',
        severity: 'critical',
        repairMode: 'blocked',
      }),
    ]))
  })
})

function dashboardForState(state: WorkState, activeSessionIds: Set<string>) {
  return buildMissionControlDashboardSummary({
    health: { status: 'ok', scheduler: { enabled: true, maxConcurrent: 2, defaultPipeline: ['implement', 'verify'] } },
    taskData: {
      counts: summarizeWorkTasks(state.tasks),
      tasks: state.tasks.map(task => ({
        id: task.id,
        status: task.status,
        priority: task.priority,
        title: task.title,
        agent: task.agent,
        currentStage: task.currentStage,
      })),
      roadmaps: state.roadmaps.map(roadmap => ({
        id: roadmap.id,
        status: roadmap.status,
        priority: roadmap.priority,
        title: roadmap.title,
      })),
      runs: state.runs.map(run => ({ id: run.id, status: run.status, sessionId: run.sessionId })),
    },
    sessions: {
      sessions: [...activeSessionIds].map(id => ({ id })),
      counts: { running: activeSessionIds.size, total: activeSessionIds.size },
    },
    questions: { questions: [] },
    permissions: { permissions: [] },
  })
}
