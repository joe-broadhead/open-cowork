import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clearConfigCacheForTest } from '../config.js'
import { submitDelegation } from '../delegation.js'
import { appendWorkEvent, clearWorkStateForTest, createRoadmap, listWorkEvents, loadWorkState } from '../work-store.js'

describe('delegation entrypoint', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-delegation-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })
  const store = path.join(testDir, 'gateway.db')

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    clearWorkStateForTest(store)
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    clearConfigCacheForTest()
  })

  it('creates a durable issue from a DelegationRequest and records attribution', () => {
    const roadmap = createRoadmap({ title: 'Delegated project' }, store)
    const result = submitDelegation(baseRequest({
      idempotencyKey: 'issue-key',
      target: { type: 'issue', roadmapId: roadmap.id, title: 'Implement receipt' },
      desired: { profile: 'implementer', stageProfiles: { review: 'reviewer' } },
    }), store)

    expect(result).toMatchObject({ ok: true, receipt: { idempotencyStatus: 'created', roadmapId: roadmap.id, selectedProfile: 'implementer' } })
    const state = loadWorkState(store)
    expect(state.tasks).toHaveLength(1)
    expect(state.tasks[0]).toMatchObject({
      title: 'Implement receipt',
      roadmapId: roadmap.id,
      agent: 'implementer',
      stageProfiles: { review: 'reviewer' },
      qualitySpec: { acceptanceCriteria: ['AC1'], definitionOfDone: ['DOD1'] },
    })
    expect(state.tasks[0]!.note).toContain('Parent session: ses_parent')
    expect(listWorkEvents(20, store).map(event => event.type)).toEqual(expect.arrayContaining(['delegation.accepted', 'delegation.mapped', 'task.created']))
    expect(listWorkEvents(20, store).find(event => event.type === 'delegation.mapped')?.payload).toMatchObject({ idempotencyKey: 'issue-key', parentSessionId: 'ses_parent' })
  })

  it('creates a supervised project with child issues atomically', () => {
    const result = submitDelegation(baseRequest({
      idempotencyKey: 'project-key',
      target: {
        type: 'project',
        projectAlias: 'delegated-project',
        title: 'Delegated Project',
        tasks: [
          { title: 'Plan rollout', acceptanceCriteria: ['Plan accepted'], definitionOfDone: ['Plan linked'] },
          { title: 'Ship rollout', description: 'Do the implementation', acceptanceCriteria: ['Feature shipped'], definitionOfDone: ['Tests pass'] },
        ],
        createSupervisor: true,
      },
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'digest' },
      parentSession: { sessionId: 'ses_parent', channel: { provider: 'telegram', chatId: 'chat-1' } },
    }), store)

    expect(result).toMatchObject({ ok: true, receipt: { idempotencyStatus: 'created', projectBindingId: expect.any(String), supervisorId: expect.any(String) } })
    const state = loadWorkState(store)
    expect(state.roadmaps.find(row => row.title === 'Delegated Project')).toBeTruthy()
    expect(state.tasks.map(task => task.title).sort()).toEqual(['Plan rollout', 'Ship rollout'])
    expect(state.supervisors).toHaveLength(1)
    expect(state.projectBindings[0]).toMatchObject({ alias: 'delegated-project', provider: 'telegram', chatId: 'chat-1', notificationMode: 'digest' })
  })

  it('fails missing callback context before mutating durable state', () => {
    const result = submitDelegation(baseRequest({
      idempotencyKey: 'missing-context',
      parentSession: undefined,
      notificationTarget: { mode: 'parent_session' },
      target: { type: 'project', title: 'No callback', tasks: [], createSupervisor: false },
    }), store)

    expect(result).toMatchObject({ ok: false, failureMode: 'insufficient_scope' })
    expect(loadWorkState(store).tasks).toHaveLength(0)
    expect(listWorkEvents(20, store).filter(event => event.type.startsWith('delegation.'))).toHaveLength(0)
  })

  it('rejects invalid profile or team before mutation', () => {
    const roadmap = createRoadmap({ title: 'Profile validation' }, store)
    const result = submitDelegation(baseRequest({
      idempotencyKey: 'bad-profile',
      target: { type: 'issue', roadmapId: roadmap.id },
      desired: { profile: 'missing-profile' },
    }), store)

    expect(result).toMatchObject({ ok: false, failureMode: 'invalid_profile_or_team' })
    expect(loadWorkState(store).tasks).toHaveLength(0)
  })

  it('rejects unsafe, budget, and gate-required delegation without partial state', () => {
    const result = submitDelegation(baseRequest({
      idempotencyKey: 'unsafe-budget',
      target: { type: 'project', title: 'Unsafe project', tasks: [], createSupervisor: false },
      budget: { maxCostUsd: 50, requiresApprovalAbove: 10 },
    }), store)

    expect(result).toMatchObject({ ok: false, failureMode: 'budget_or_gate_required' })
    expect(loadWorkState(store).roadmaps.filter(row => row.title !== 'Task Inbox')).toHaveLength(0)
  })

  it('replays idempotent retries without creating duplicate tasks', () => {
    const roadmap = createRoadmap({ title: 'Retry project' }, store)
    const request = baseRequest({ idempotencyKey: 'retry-key', target: { type: 'issue', roadmapId: roadmap.id } })

    const first = submitDelegation(request, store)
    const second = submitDelegation(request, store)

    expect(first).toMatchObject({ ok: true, receipt: { idempotencyStatus: 'created' } })
    expect(second).toMatchObject({ ok: true, receipt: { idempotencyStatus: 'replayed', taskIds: first.receipt?.taskIds } })
    expect(loadWorkState(store).tasks).toHaveLength(1)
    expect(listWorkEvents(50, store).filter(event => event.type === 'delegation.mapped')).toHaveLength(1)
  })

  it('preserves delegation idempotency receipts across event pruning', () => {
    const roadmap = createRoadmap({ title: 'Pruned retry project' }, store)
    const request = baseRequest({ idempotencyKey: 'pruned-retry-key', target: { type: 'issue', roadmapId: roadmap.id } })
    const first = submitDelegation(request, store)
    floodEventsPastRetentionCap(store)
    deleteDelegationEvents(store)

    const second = submitDelegation(request, store)

    expect(first).toMatchObject({ ok: true, receipt: { idempotencyStatus: 'created' } })
    expect(second).toMatchObject({ ok: true, receipt: { idempotencyStatus: 'replayed', taskIds: first.receipt?.taskIds } })
    expect(loadWorkState(store).tasks).toHaveLength(1)
  })
})

function baseRequest(overrides: Record<string, any> = {}) {
  return {
    version: 1,
    idempotencyKey: 'base-key',
    target: { type: 'project', title: 'Base Project', tasks: [], createSupervisor: false },
    objective: 'Complete delegated work',
    context: {
      summary: 'Enough context to do the work.',
      references: ['docs/concepts/delegation-contract.md'],
      constraints: [],
      nonGoals: [],
    },
    acceptanceCriteria: ['AC1'],
    definitionOfDone: ['DOD1'],
    desired: {},
    environment: undefined,
    schedule: {},
    budget: {},
    evidence: [{ type: 'test', summary: 'Relevant tests pass' }],
    notificationTarget: { mode: 'parent_session' },
    parentSession: { sessionId: 'ses_parent' },
    completionPolicy: 'assistant_proposes_user_approves',
    ...overrides,
  }
}

function floodEventsPastRetentionCap(filePath: string): void {
  const db = new DatabaseSync(filePath)
  try {
    const now = new Date().toISOString()
    const insert = db.prepare('INSERT INTO events (type, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?)')
    db.exec('BEGIN IMMEDIATE')
    try {
      for (let i = 0; i < 10025; i++) insert.run('test.churn', `subject_${i}`, JSON.stringify({ i }), now)
      db.exec('COMMIT')
    } catch (err) {
      try { db.exec('ROLLBACK') } catch {}
      throw err
    }
  } finally {
    db.close()
  }
  appendWorkEvent('test.prune', 'subject_prune', {}, filePath)
}

function deleteDelegationEvents(filePath: string): void {
  const db = new DatabaseSync(filePath)
  try {
    db.prepare("DELETE FROM events WHERE type IN ('delegation.accepted', 'delegation.mapped')").run()
  } finally {
    db.close()
  }
}
