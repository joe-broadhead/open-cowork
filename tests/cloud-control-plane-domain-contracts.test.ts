import test from 'node:test'
import assert from 'node:assert/strict'

import type {
  ChannelControlPlaneStore,
  ProjectionControlPlaneStore,
  SessionControlPlaneStore,
} from '../apps/desktop/src/main/cloud/control-plane-store-domains.ts'
import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/in-memory-control-plane-store.ts'
import { CloudSessionEventBus, CloudWorkspaceEventBus } from '../apps/desktop/src/main/cloud/session-event-bus.ts'
import { CloudSessionProjectionService } from '../apps/desktop/src/main/cloud/session-projection-service.ts'
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
