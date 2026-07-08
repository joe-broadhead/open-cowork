import test from 'node:test'
import assert from 'node:assert/strict'

import type {
  ChannelControlPlaneStore,
  ProjectionControlPlaneStore,
  SessionControlPlaneStore,
} from '@open-cowork/cloud-server/control-plane-store-domains'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { CloudSessionEventBus, CloudWorkspaceEventBus } from '@open-cowork/cloud-server/session-event-bus'
import { CloudSessionProjectionService } from '@open-cowork/cloud-server/session-projection-service'
import { createCloudProjectionFenceToken } from '../packages/shared/dist/cloud-session-projection.js'

test('control plane domain contracts expose narrow stores for cloud subservices', async () => {
  const store = new InMemoryControlPlaneStore()
  const projectionStore: ProjectionControlPlaneStore = store
  const sessionStore: SessionControlPlaneStore = store
  const channelStore: ChannelControlPlaneStore = store

  await store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  await store.ensureUser({
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.test',
    role: 'owner',
  })
  await sessionStore.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    opencodeSessionId: 'runtime-session-1',
    profileName: 'default',
    title: 'Domain contract',
  })

  const projections = new CloudSessionProjectionService(
    projectionStore,
    new CloudSessionEventBus(),
    new CloudWorkspaceEventBus(),
  )
  const event = await projections.appendProjectedEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    type: 'assistant.message',
    payload: { messageId: 'assistant-1', content: 'ok' },
  })
  const projection = await projectionStore.getSessionProjection('tenant-1', 'session-1')

  assert.equal(event.type, 'assistant.message')
  assert.equal(projection?.sequence, event.sequence)
  assert.equal(typeof channelStore.createHeadlessAgent, 'function')
})

test('cloud projection service waits for session-scoped fence checkpoints', async () => {
  const store = new InMemoryControlPlaneStore()
  await store.createTenant({ tenantId: 'tenant-1', name: 'Tenant 1' })
  await store.ensureUser({
    tenantId: 'tenant-1',
    userId: 'user-1',
    email: 'user@example.test',
    role: 'owner',
  })
  await store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    opencodeSessionId: 'runtime-session-1',
    profileName: 'default',
    title: 'Projection fence',
  })

  const projections = new CloudSessionProjectionService(
    store,
    new CloudSessionEventBus(),
    new CloudWorkspaceEventBus(),
  )
  const event = await projections.appendProjectedEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    type: 'assistant.message',
    payload: { messageId: 'assistant-1', content: 'ok' },
  })

  const observed = await projections.waitForProjectionFence({
    fence: createCloudProjectionFenceToken({
      scope: 'session',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sequence: event.sequence,
    }),
    timeoutMs: 0,
  })
  assert.equal(observed.ok, true)

  const timedOut = await projections.waitForProjectionFence({
    fence: createCloudProjectionFenceToken({
      scope: 'session',
      tenantId: 'tenant-1',
      sessionId: 'session-1',
      sequence: event.sequence + 1,
    }),
    timeoutMs: 0,
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, 'projection_fence_timeout')
})

test('projection append view-cache matches the re-normalize path over a long stream (#913)', async () => {
  const store = new InMemoryControlPlaneStore()
  await store.createTenant({ tenantId: 'tenant-1', name: 'T' })
  await store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'u@e.test', role: 'owner' })
  for (const sessionId of ['cached', 'fresh']) {
    await store.createSession({ tenantId: 'tenant-1', userId: 'user-1', sessionId, opencodeSessionId: `rt-${sessionId}`, profileName: 'default', title: 'T' })
  }
  const bus = new CloudSessionEventBus()
  const wbus = new CloudWorkspaceEventBus()
  const events = [
    { type: 'prompt.submitted' as const, payload: { messageId: 'u1', text: 'hi' } },
    ...Array.from({ length: 25 }, (_, index) => ({ type: 'assistant.message' as const, payload: { messageId: `a${index}`, content: `msg ${index}` } })),
  ]

  // Cached path: one persistent service keeps its per-session view cache warm across the stream.
  const cachedService = new CloudSessionProjectionService(store, bus, wbus)
  for (const event of events) await cachedService.appendProjectedEvent({ tenantId: 'tenant-1', sessionId: 'cached', ...event })
  // Re-normalize path: a fresh service per event has a cold cache, forcing a full re-normalize of
  // the stored view each time (the pre-#913 behavior). Both must yield an identical projection.
  for (const event of events) await new CloudSessionProjectionService(store, bus, wbus).appendProjectedEvent({ tenantId: 'tenant-1', sessionId: 'fresh', ...event })

  const messages = (view: unknown) => ((view as { messages?: Array<{ id: string, role: string, content: string }> }).messages || [])
    .map((message) => ({ id: message.id, role: message.role, content: message.content }))
  const cachedView = (await store.getSessionProjection('tenant-1', 'cached'))?.view
  const freshView = (await store.getSessionProjection('tenant-1', 'fresh'))?.view
  assert.deepEqual(messages(cachedView), messages(freshView))
  assert.equal(messages(cachedView).length, 26)
})
