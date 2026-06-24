import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CloudSessionEventBus,
  CloudWorkspaceEventBus,
  InMemoryCloudEventFanoutAdapter,
  type CloudSessionEventFilter,
  type CloudWorkspaceEventFilter,
} from '@open-cowork/cloud-server/session-event-bus'
import type { SessionEventRecord, WorkspaceEventRecord } from '@open-cowork/cloud-server/control-plane-store'

test('cloud event buses use injectable fanout adapters with sequence filtering', () => {
  const sessionFanout = new InMemoryCloudEventFanoutAdapter<SessionEventRecord, CloudSessionEventFilter>((filter, event) => (
    (!filter.tenantId || filter.tenantId === event.tenantId)
    && (!filter.sessionId || filter.sessionId === event.sessionId)
    && (filter.afterSequence === undefined || event.sequence > filter.afterSequence)
  ))
  const workspaceFanout = new InMemoryCloudEventFanoutAdapter<WorkspaceEventRecord, CloudWorkspaceEventFilter>((filter, event) => (
    (!filter.tenantId || filter.tenantId === event.tenantId)
    && (!filter.userId || filter.userId === event.userId)
    && (filter.afterSequence === undefined || event.sequence > filter.afterSequence)
  ))
  const sessionBus = new CloudSessionEventBus(sessionFanout)
  const workspaceBus = new CloudWorkspaceEventBus(workspaceFanout)
  const sessionEvents: string[] = []
  const workspaceEvents: string[] = []

  const unsubscribeSession = sessionBus.subscribe({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    afterSequence: 3,
  }, (event) => sessionEvents.push(event.eventId))
  const unsubscribeWorkspace = workspaceBus.subscribe({
    tenantId: 'tenant-1',
    userId: 'user-1',
    afterSequence: 5,
  }, (event) => workspaceEvents.push(event.eventId))

  sessionBus.publish({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    eventId: 'session-old',
    sequence: 3,
    type: 'assistant.message',
    payload: {},
    createdAt: '2026-05-30T10:00:00.000Z',
  })
  sessionBus.publish({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    eventId: 'session-new',
    sequence: 4,
    type: 'assistant.message',
    payload: {},
    createdAt: '2026-05-30T10:00:01.000Z',
  })
  workspaceBus.publish({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    eventId: 'workspace-old',
    sequence: 5,
    entityType: 'session',
    entityId: 'session-1',
    operation: 'update',
    projectionVersion: 5,
    type: 'assistant.message',
    payload: {},
    createdAt: '2026-05-30T10:00:00.000Z',
  })
  workspaceBus.publish({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    eventId: 'workspace-new',
    sequence: 6,
    entityType: 'session',
    entityId: 'session-1',
    operation: 'update',
    projectionVersion: 6,
    type: 'assistant.message',
    payload: {},
    createdAt: '2026-05-30T10:00:01.000Z',
  })

  assert.deepEqual(sessionEvents, ['session-new'])
  assert.deepEqual(workspaceEvents, ['workspace-new'])
  assert.equal(sessionBus.subscriberCount, 1)
  assert.equal(workspaceBus.subscriberCount, 1)
  unsubscribeSession()
  unsubscribeWorkspace()
  assert.equal(sessionBus.subscriberCount, 0)
  assert.equal(workspaceBus.subscriberCount, 0)
})

function sessionEvent(sessionId: string, sequence: number): SessionEventRecord {
  return {
    tenantId: 'tenant-1',
    sessionId,
    eventId: `${sessionId}-${sequence}`,
    sequence,
    type: 'assistant.message',
    payload: {},
    createdAt: '2026-05-30T10:00:00.000Z',
  }
}

test('default session bus routes by sessionId yet still delivers to unkeyed subscribers', () => {
  const bus = new CloudSessionEventBus()
  const one: string[] = []
  const two: string[] = []
  const all: string[] = []

  const unsubOne = bus.subscribe({ tenantId: 'tenant-1', sessionId: 'session-1' }, (event) => one.push(event.eventId))
  const unsubTwo = bus.subscribe({ tenantId: 'tenant-1', sessionId: 'session-2' }, (event) => two.push(event.eventId))
  // No sessionId on the filter: an unkeyed subscriber must see every session's events.
  const unsubAll = bus.subscribe({ tenantId: 'tenant-1' }, (event) => all.push(event.eventId))

  assert.equal(bus.subscriberCount, 3)
  bus.publish(sessionEvent('session-1', 1))
  bus.publish(sessionEvent('session-2', 1))

  // Keyed subscribers only receive their own session; the unkeyed one receives both.
  assert.deepEqual(one, ['session-1-1'])
  assert.deepEqual(two, ['session-2-1'])
  assert.deepEqual(all, ['session-1-1', 'session-2-1'])

  unsubOne()
  unsubTwo()
  unsubAll()
  assert.equal(bus.subscriberCount, 0)
  // After the last keyed unsubscribe, a further publish reaches nobody.
  bus.publish(sessionEvent('session-1', 2))
  assert.deepEqual(one, ['session-1-1'])
})
