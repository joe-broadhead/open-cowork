import { describe, expect, it } from 'vitest'
import { buildDelegationProgressRoutes } from '../delegation-progress.js'
import { createFakeDelegationProgressReadModel } from './helpers/fake-delegation-progress-read-model.js'
import type { WorkEventRecord, WorkState } from '../work-store.js'

describe('delegation progress read-model seam', () => {
  const now = Date.parse('2026-06-21T20:30:00.000Z')

  it('preserves production event-window ordering and pagination without a SQLite fixture', () => {
    const readModel = createFakeDelegationProgressReadModel({
      events: [
        progressEvent(1, 'created', 'delegation-a'),
        progressEvent(5, 'completed', 'delegation-c'),
        progressEvent(3, 'dispatched', 'delegation-b'),
        deliveryEvent(4, 'delegation.progress.notified', 'dedupe-old', '2026-06-21T20:00:00.000Z'),
      ],
    })

    expect(readModel.listProgressEvents({ limit: 2 }).map(event => event.id)).toEqual([3, 5])

    const routes = buildDelegationProgressRoutes(emptyState(), { now, readModel })
    expect(routes.map(route => route.event.id)).toEqual([1, 3, 5])
    expect(routes.map(route => route.event.payload['progress'])).toEqual(['created', 'dispatched', 'completed'])
  })

  it('simulates durable delivery dedupe against a progress key and target without work-store setup', () => {
    const readModel = createFakeDelegationProgressReadModel({ events: [progressEvent(1, 'created', 'delegation-dedupe')] })
    const [initial] = buildDelegationProgressRoutes(emptyState(), { now, readModel })

    readModel.append(deliveryEvent(2, 'delegation.progress.notified', initial!.dedupeKey, '2026-06-21T20:29:50.000Z', {
      progress: 'created',
      progressKey: initial!.event.payload['progressKey'],
    }))

    const [deduped] = buildDelegationProgressRoutes(emptyState(), { now, readModel })
    expect(deduped).toMatchObject({ delivery: 'deduped', reason: 'dedupe window active', dedupeKey: initial!.dedupeKey })
  })

  it('simulates timeout retry cooldowns before channel delivery is retried', () => {
    const readModel = createFakeDelegationProgressReadModel({ events: [progressEvent(1, 'created', 'delegation-timeout')] })
    const [initial] = buildDelegationProgressRoutes(emptyState(), { now, readModel })

    readModel.append(deliveryEvent(2, 'delegation.progress.failed', initial!.dedupeKey, '2026-06-21T20:29:55.000Z', {
      progress: 'created',
      progressKey: initial!.event.payload['progressKey'],
      error: 'telegram progress notification timed out after 5ms',
    }))

    const [cooldown] = buildDelegationProgressRoutes(emptyState(), { now, readModel, timeoutRetryDelayMs: 60_000 })
    expect(cooldown).toMatchObject({
      delivery: 'deferred',
      reason: 'recent timeout retry cooldown',
      deferredUntil: '2026-06-21T20:30:55.000Z',
    })
  })

  it('exposes current route receipt state and recovery actions without raw target context', () => {
    const readModel = createFakeDelegationProgressReadModel({
      events: [
        progressEvent(1, 'created', 'delegation-receipts'),
        deliveryEvent(2, 'delegation.progress.failed', 'dedupe-retried', '2026-06-21T20:28:00.000Z', {
          idempotencyKey: 'delegation-receipts',
          progressKey: 'progress:delegation-receipts:created',
          error: 'telegram progress notification timed out after 5ms',
        }),
        deliveryEvent(3, 'delegation.progress.notified', 'dedupe-retried', '2026-06-21T20:29:00.000Z', {
          idempotencyKey: 'delegation-receipts',
          progressKey: 'progress:delegation-receipts:created',
          provider: 'telegram',
          targetKey: 'target-hash-only',
        }),
        routeEvent(4, 'delegation.progress.suppressed', 'dedupe-stale-parent', '2026-06-21T20:29:10.000Z', {
          idempotencyKey: 'delegation-receipts',
          delivery: 'deferred',
          reason: 'session client unavailable',
          sessionId: 'ses_parent',
        }),
        routeEvent(5, 'delegation.progress.suppressed', 'dedupe-orphaned', '2026-06-21T20:29:20.000Z', {
          idempotencyKey: 'delegation-receipts',
          delivery: 'deferred',
          reason: 'missing parent session id',
        }),
      ],
    })

    const receipts = readModel.listRouteReceipts({ idempotencyKey: 'delegation-receipts', limit: 10 })

    expect(receipts.map(receipt => [receipt.dedupeKey, receipt.state])).toEqual([
      ['dedupe-orphaned', 'orphaned'],
      ['dedupe-stale-parent', 'stale_parent'],
      ['dedupe-retried', 'retried'],
    ])
    expect(receipts.find(receipt => receipt.dedupeKey === 'dedupe-retried')).toMatchObject({
      provider: 'telegram',
      targetKey: 'target-hash-only',
      nextAction: 'No action; delivery succeeded after a previous failed attempt.',
    })
    expect(receipts.find(receipt => receipt.dedupeKey === 'dedupe-stale-parent')?.nextAction).toContain('Reconnect the parent OpenCode session client')
    expect(JSON.stringify(receipts)).not.toContain('chat-1')
  })
})

function progressEvent(id: number, progress: string, key: string): WorkEventRecord {
  return {
    id,
    type: 'delegation.progress',
    subjectId: `task_${key}`,
    payload: {
      idempotencyKey: key,
      progress,
      progressKey: `progress:${key}:${progress}`,
      roadmapId: `roadmap_${key}`,
      taskId: `task_${key}`,
      notificationTarget: { mode: 'channel', provider: 'telegram', chatId: 'chat-1', notificationMode: 'immediate' },
    },
    createdAt: new Date(nowForId(id)).toISOString(),
  }
}

function deliveryEvent(id: number, type: 'delegation.progress.notified' | 'delegation.progress.failed', dedupeKey: string, createdAt: string, payload: Record<string, unknown> = {}): WorkEventRecord {
  return {
    id,
    type,
    subjectId: dedupeKey,
    payload: { dedupeKey, delivery: type.endsWith('.notified') ? 'immediate' : 'failed', ...payload },
    createdAt,
  }
}

function routeEvent(id: number, type: 'delegation.progress.notified' | 'delegation.progress.failed' | 'delegation.progress.suppressed', dedupeKey: string, createdAt: string, payload: Record<string, unknown> = {}): WorkEventRecord {
  return {
    id,
    type,
    subjectId: dedupeKey,
    payload: { dedupeKey, ...payload },
    createdAt,
  }
}

function emptyState(): WorkState {
  return {
    version: 1,
    savedAt: '2026-06-21T20:30:00.000Z',
    roadmaps: [],
    supervisors: [],
    projectBindings: [],
    completionProposals: [],
    tasks: [],
    runs: [],
    dependencies: [],
  }
}

function nowForId(id: number): number {
  return Date.parse('2026-06-21T20:00:00.000Z') + id * 1000
}
