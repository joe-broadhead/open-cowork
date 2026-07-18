import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  filterGatewayEvents,
  gatewayEventFromWorkEvent,
  gatewayEventsFromWorkEvents,
  validateGatewayEvent,
  validateGatewayEventName,
} from '../gateway-events.js'
import {
  appendWorkEvent,
  appendWorkEvents,
  clearWorkStateForTest,
  completeWorkTaskRun,
  createWorkTask,
  listWorkEvents,
  startWorkTaskRun,
  type WorkEventRecord,
} from '../work-store.js'
import { clearConfigCacheForTest } from '../config.js'
import { createSqliteDelegationProgressReadModel } from '../delegation-progress-read-model.js'

describe('Gateway event taxonomy', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-event-taxonomy-test-'))

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

  it('fails closed for invalid names, unmapped legacy types, and malformed envelopes', () => {
    expect(validateGatewayEventName('run.lifecycle.started')).toEqual({ ok: true, errors: [] })
    expect(validateGatewayEventName('Run Started')).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('dot notation')]) })
    expect(validateGatewayEventName('run.lifecycle.unknown')).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringContaining('not in the Gateway taxonomy')]) })

    expect(() => gatewayEventFromWorkEvent(workEvent(1, 'legacy.unknown'))).toThrow('unmapped Gateway work event type')

    const malformed = gatewayEventFromWorkEvent(workEvent(1, 'task.run.started', 'task_1', { runId: 'run_1' }))
    expect(validateGatewayEvent({ ...malformed, createdAt: 'not-a-date' })).toMatchObject({
      ok: false,
      errors: expect.arrayContaining(['createdAt must be an ISO timestamp']),
    })
  })

  it('filters canonical subscriptions by prefix, audience, subject, correlation, and order', () => {
    const gatewayEvents = gatewayEventsFromWorkEvents([
      workEvent(1, 'task.run.started', 'task_a', { runId: 'run_a', sessionId: 'ses_a' }),
      workEvent(2, 'delegation.progress', 'delegation_a', { idempotencyKey: 'delegation_a', progress: 'dispatched', taskId: 'task_a' }),
      workEvent(3, 'delegation.progress.notified', 'dedupe_a', { dedupeKey: 'dedupe_a', idempotencyKey: 'delegation_a', provider: 'telegram', targetKey: 'target_hash' }),
      workEvent(4, 'evidence.export.written', 'evidence_a', { exportId: 'export_a' }),
    ])

    expect(filterGatewayEvents(gatewayEvents, { prefixes: ['delegation.progress'], audience: ['channel'], order: 'asc' }).map(event => event.name)).toEqual([
      'delegation.progress.recorded',
      'delegation.progress.delivery_succeeded',
    ])
    expect(filterGatewayEvents(gatewayEvents, { subjects: ['dedupe_a'], correlation: { provider: 'telegram' } }).map(event => event.legacyType)).toEqual(['delegation.progress.notified'])
    expect(filterGatewayEvents(gatewayEvents, { prefixes: ['delegation.progress'], order: 'desc', limit: 1 }).map(event => event.correlation.eventId)).toEqual([3])
  })

  it('preserves scheduler run lifecycle behavior while exposing a canonical read model', () => {
    const task = createWorkTask({ title: 'Typed event run path', pipeline: ['implement'] }, store)
    const started = startWorkTaskRun(task.id, 'implement', 'ses_event_run', 'implementer', store)!
    completeWorkTaskRun(started.run.id, { status: 'pass', summary: 'done', feedback: 'done', artifacts: [], raw: 'done' }, 1, store)

    const canonical = gatewayEventsFromWorkEvents(listWorkEvents(20, store))
    const lifecycle = filterGatewayEvents(canonical, { prefixes: ['run.lifecycle'], correlation: { taskId: task.id }, order: 'asc' })

    expect(lifecycle.map(event => event.name)).toEqual(['run.lifecycle.started', 'run.lifecycle.completed'])
    expect(lifecycle[0]).toMatchObject({
      durable: true,
      destination: { kind: 'opencode_session', id: 'ses_event_run' },
      audience: expect.arrayContaining(['dashboard', 'channel', 'scheduler']),
    })
  })

  it('maps runtime capability grant evidence into the support and evidence surfaces', () => {
    const gatewayEvents = gatewayEventsFromWorkEvents([
      workEvent(1, 'runtime.capability_grant.validated', 'task_runtime', { stage: 'implement', status: 'granted', capabilityGrant: { id: 'grant_ok', status: 'granted' } }),
      workEvent(2, 'runtime.capability_grant.rejected', 'task_runtime', { stage: 'implement', status: 'denied', capabilityGrant: { id: 'grant_no', status: 'denied' } }),
    ])

    expect(gatewayEvents.map(event => event.name)).toEqual([
      'workflow.runtime_capability_grant.validated',
      'workflow.runtime_capability_grant.rejected',
    ])
    for (const event of gatewayEvents) {
      expect(event).toMatchObject({
        source: { kind: 'security', name: 'gateway.security' },
        visibility: 'support',
        subjectId: 'task_runtime',
        audience: expect.arrayContaining(['dashboard', 'support_bundle', 'evidence_ledger']),
      })
    }
  })

  it('uses the subscription contract for durable delegated channel progress reads', () => {
    const [progressId] = appendWorkEvents([
      {
        type: 'delegation.progress',
        subjectId: 'delegation_channel',
        payload: {
          idempotencyKey: 'delegation_channel',
          progress: 'dispatched',
          progressKey: 'progress:delegation_channel:dispatched',
          taskId: 'task_channel',
          roadmapId: 'roadmap_channel',
        },
      },
    ], store)
    appendWorkEvent('delegation.progress.notified', 'dedupe_channel', {
      dedupeKey: 'dedupe_channel',
      idempotencyKey: 'delegation_channel',
      progressKey: 'progress:delegation_channel:dispatched',
      progressEventId: progressId,
      provider: 'telegram',
      targetKey: 'target_hash_only',
      delivery: 'immediate',
    }, store)

    const readModel = createSqliteDelegationProgressReadModel({ filePath: store })

    expect(readModel.listProgressEvents({ limit: 5 }).map(event => event.type)).toEqual(['delegation.progress'])
    expect(readModel.listDeliveryEvents({
      type: 'delegation.progress.notified',
      dedupeKey: 'dedupe_channel',
      since: new Date('2000-01-01T00:00:00.000Z'),
      limit: 5,
    })).toEqual([
      expect.objectContaining({
        type: 'delegation.progress.notified',
        subjectId: 'dedupe_channel',
        payload: expect.objectContaining({ provider: 'telegram', targetKey: 'target_hash_only' }),
      }),
    ])
  })

})

function workEvent(id: number, type: string, subjectId = 'subject_1', payload: Record<string, unknown> = {}): WorkEventRecord {
  return {
    id,
    type,
    subjectId,
    payload,
    createdAt: new Date(Date.parse('2026-06-27T12:00:00.000Z') + id * 1000).toISOString(),
  }
}
