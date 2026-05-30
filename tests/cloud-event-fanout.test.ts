import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CloudSessionEventBus,
  CloudWorkspaceEventBus,
  InMemoryCloudEventFanoutAdapter,
  type CloudSessionEventFilter,
  type CloudWorkspaceEventFilter,
} from '../apps/desktop/src/main/cloud/session-event-bus.ts'
import type { SessionEventRecord, WorkspaceEventRecord } from '../apps/desktop/src/main/cloud/control-plane-store.ts'

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
