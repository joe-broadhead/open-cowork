import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ControlPlaneQuotaExceededError,
} from '@open-cowork/cloud-server/control-plane-store'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'

function seededStore() {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@example.com', role: 'owner' })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    opencodeSessionId: 'oc-session-1',
    profileName: 'full',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  return store
}

function createManualWorkflow(store: InMemoryControlPlaneStore, workflowId: string) {
  return store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId,
    draft: {
      title: workflowId,
      instructions: 'Run bounded recovery work.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
}

test('cloud control plane keeps tenant/user/session state isolated', () => {
  const store = seededStore()
  assert.equal(store.getSession('tenant-1', 'user-1', 'session-1')?.opencodeSessionId, 'oc-session-1')
  assert.throws(() => store.getSession('tenant-1', 'user-2', 'session-1'), /does not belong/)
  assert.throws(() => store.listSessions('tenant-2', 'user-1'), /Unknown tenant/)
})

test('cloud control plane paginates and filters user session lists', () => {
  const store = seededStore()
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-2',
    opencodeSessionId: 'oc-session-2',
    profileName: 'data-analyst',
    title: 'Revenue model',
    createdAt: new Date('2026-01-01T00:02:00.000Z'),
  })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-3',
    opencodeSessionId: 'oc-session-3',
    profileName: 'full',
    title: 'Hiring plan',
    createdAt: new Date('2026-01-01T00:01:00.000Z'),
  })
  store.updateSessionStatus({
    tenantId: 'tenant-1',
    sessionId: 'session-3',
    status: 'closed',
    updatedAt: new Date('2026-01-01T00:03:00.000Z'),
  })

  const first = store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', limit: 2 })
  assert.deepEqual(first.items.map((session) => session.sessionId), ['session-3', 'session-2'])
  assert.ok(first.nextCursor)
  const second = store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', limit: 2, cursor: first.nextCursor })
  assert.deepEqual(second.items.map((session) => session.sessionId), ['session-1'])
  assert.equal(second.nextCursor, null)
  assert.throws(
    () => store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', limit: 2, status: 'closed', cursor: first.nextCursor }),
    /cursor/i,
  )
  assert.throws(
    () => store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', limit: 2, cursor: 'not-a-valid-cursor' }),
    /cursor/i,
  )

  assert.deepEqual(
    store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', status: 'closed' }).items.map((session) => session.sessionId),
    ['session-3'],
  )
  assert.deepEqual(
    store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', profileName: 'data-analyst' }).items.map((session) => session.sessionId),
    ['session-2'],
  )
  assert.deepEqual(
    store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1', query: 'revenue' }).items.map((session) => session.sessionId),
    ['session-2'],
  )
})

test('cloud control plane exposes safe project-source summaries on session lists', () => {
  const store = seededStore()
  store.writeSessionProjection({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 1,
    view: {
      projectSource: {
        kind: 'git',
        repositoryUrl: 'https://github.com/example/repo.git?token=secret#fragment',
        ref: 'feature/sidebar',
        subdirectory: 'apps/web',
        credentialRef: 'secret-token-ref',
      },
    },
  })

  const expectedSummary = {
    kind: 'git',
    repositoryUrl: 'https://github.com/example/repo.git',
    ref: 'feature/sidebar',
    subdirectory: 'apps/web',
  }
  assert.deepEqual(store.listSessions('tenant-1', 'user-1')[0]?.projectSource, expectedSummary)
  assert.deepEqual(store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1' }).items[0]?.projectSource, expectedSummary)
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      store.listSessionsPage({ tenantId: 'tenant-1', userId: 'user-1' }).items[0]?.projectSource || {},
      'credentialRef',
    ),
    false,
  )
  assert.equal(JSON.stringify(store.listSessions('tenant-1', 'user-1')[0]?.projectSource).includes('secret'), false)
})

test('cloud control plane keeps product domains isolated by tenant and org', () => {
  const store = seededStore()
  const org1 = store.ensureOrgForTenant({ tenantId: 'tenant-1', orgId: 'tenant-1', name: 'Acme' })
  store.createTenant({ tenantId: 'tenant-2', name: 'Other' })
  store.ensureUser({ tenantId: 'tenant-2', userId: 'user-2', email: 'b@example.com', role: 'owner' })
  const org2 = store.ensureOrgForTenant({ tenantId: 'tenant-2', orgId: 'tenant-2', name: 'Other' })

  assert.equal(store.getSessionForTenant('tenant-2', 'session-1'), null)
  assert.equal(store.getSession('tenant-2', 'user-2', 'session-1'), null)

  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-1',
    draft: {
      title: 'Daily revenue',
      instructions: 'Summarize revenue.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  assert.equal(store.getWorkflow('tenant-2', 'user-2', 'workflow-1'), null)
  assert.throws(() => store.listWorkflowRuns('tenant-2', 'workflow-1'), /Unknown workflow/)

  const agent = store.createHeadlessAgent({
    agentId: 'agent-1',
    orgId: org1.orgId,
    tenantId: 'tenant-1',
    profileName: 'full',
    name: 'Agent',
  })
  const channelBinding = store.createChannelBinding({
    bindingId: 'telegram-binding',
    orgId: org1.orgId,
    agentId: agent.agentId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    displayName: 'Telegram',
  })
  const identity = store.upsertChannelIdentity({
    identityId: 'identity-1',
    orgId: org1.orgId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalUserId: 'alice',
    role: 'member',
    status: 'active',
  })
  const sessionBinding = store.bindChannelSession({
    bindingId: 'channel-session-1',
    orgId: org1.orgId,
    agentId: agent.agentId,
    channelBindingId: channelBinding.bindingId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
    sessionId: 'session-1',
  })
  assert.equal(store.getChannelBinding(org2.orgId, channelBinding.bindingId), null)
  assert.equal(store.getChannelIdentity(org2.orgId, identity.identityId), null)
  assert.equal(store.getChannelSessionBinding(org2.orgId, sessionBinding.bindingId), null)
  assert.equal(store.findChannelSessionBindingByThread({
    orgId: org2.orgId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
  }), null)

  store.createByokSecret({
    secretId: 'secret-1',
    orgId: org1.orgId,
    providerId: 'anthropic',
    ciphertext: 'ciphertext',
    last4: '1234',
    keyFingerprint: 'fingerprint',
  })
  assert.equal(store.getActiveByokSecret(org2.orgId, 'anthropic'), null)
  assert.deepEqual(store.listByokSecrets(org2.orgId), [])

  store.upsertBillingSubscription({
    orgId: org1.orgId,
    providerId: 'stub',
    providerCustomerId: 'cus_1',
    providerSubscriptionId: 'sub_1',
    planKey: 'pro',
    status: 'active',
  })
  assert.equal(store.getBillingSubscription(org2.orgId), null)

  store.recordUsageEvent({
    orgId: org1.orgId,
    eventType: 'prompt.submitted',
    metadata: { sessionId: 'session-1' },
  })
  assert.deepEqual(store.listUsageEvents(org2.orgId), [])
  assert.equal(store.consumeUsageQuota({
    orgId: org1.orgId,
    quotaKey: 'prompts:hour',
    limit: 1,
    windowMs: 60_000,
    now: new Date('2026-01-01T00:00:00.000Z'),
  }).allowed, true)
  assert.equal(store.consumeUsageQuota({
    orgId: org2.orgId,
    quotaKey: 'prompts:hour',
    limit: 1,
    windowMs: 60_000,
    now: new Date('2026-01-01T00:00:00.000Z'),
  }).allowed, true)
})

test('cloud control plane appends ordered idempotent session events', () => {
  const store = seededStore()
  const first = store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    eventId: 'event-1',
    type: 'message.created',
    payload: { messageId: 'm1' },
  })
  const replay = store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    eventId: 'event-1',
    type: 'message.created',
    payload: { messageId: 'm1' },
  })

  assert.equal(first.sequence, 1)
  assert.deepEqual(replay, first)
  assert.throws(() => store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    eventId: 'event-1',
    type: 'message.updated',
    payload: { messageId: 'm1' },
  }), /reused/)
})

test('cloud control plane appends user-scoped workspace events across sessions', () => {
  const store = seededStore()
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-2',
    opencodeSessionId: 'oc-session-2',
    profileName: 'full',
  })
  store.ensureUser({ tenantId: 'tenant-1', userId: 'user-2', email: 'b@example.com' })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-2',
    sessionId: 'session-other',
    opencodeSessionId: 'oc-session-other',
    profileName: 'full',
  })

  const first = store.appendWorkspaceEvent({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    eventId: 'session-1:event-1',
    type: 'assistant.message',
    payload: { content: 'first' },
  })
  const second = store.appendWorkspaceEvent({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-2',
    eventId: 'session-2:event-1',
    type: 'assistant.message',
    payload: { content: 'second' },
  })
  const replay = store.appendWorkspaceEvent({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    eventId: 'session-1:event-1',
    type: 'assistant.message',
    payload: { content: 'first' },
  })

  assert.equal(first.sequence, 1)
  assert.equal(first.entityType, 'session')
  assert.equal(first.entityId, 'session-1')
  assert.equal(first.operation, 'update')
  assert.equal(first.projectionVersion, 1)
  assert.equal(second.sequence, 2)
  assert.deepEqual(replay, first)
  assert.deepEqual(
    store.listWorkspaceEvents('tenant-1', 'user-1', 1).map((event) => [event.sequence, event.sessionId]),
    [[2, 'session-2']],
  )
  assert.deepEqual(store.getWorkspaceEventCursor('tenant-1', 'user-1'), {
    earliestSequence: 1,
    latestSequence: 2,
  })
  assert.deepEqual(store.listWorkspaceEvents('tenant-1', 'user-2', 0), [])
  assert.deepEqual(store.getWorkspaceEventCursor('tenant-1', 'user-2'), {
    earliestSequence: null,
    latestSequence: 0,
  })
  assert.throws(() => store.appendWorkspaceEvent({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-other',
    eventId: 'bad-owner',
    type: 'assistant.message',
  }), /does not belong/)
})

test('cloud control plane fences projection writes by worker lease token', () => {
  const store = seededStore()
  const firstLease = store.claimSessionLease(
    'tenant-1',
    'session-1',
    'worker-a',
    new Date('2030-01-01T00:00:00.000Z'),
    1000,
  )
  assert.ok(firstLease)
  assert.equal(store.writeSessionProjection({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 1,
    view: { messages: 1 },
    leaseToken: firstLease.leaseToken,
  }).sequence, 1)

  const secondLease = store.claimSessionLease(
    'tenant-1',
    'session-1',
    'worker-b',
    new Date('2030-01-01T00:00:02.000Z'),
    1000,
  )
  assert.ok(secondLease)
  assert.throws(() => store.writeSessionProjection({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 2,
    view: { messages: 2 },
    leaseToken: firstLease.leaseToken,
  }), /stale/)
  assert.equal(store.writeSessionProjection({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    sequence: 2,
    view: { messages: 2 },
    leaseToken: secondLease.leaseToken,
  }).sequence, 2)
})

test('cloud control plane commands are idempotent and owned by the current lease', () => {
  const store = seededStore()
  const lease = store.claimSessionLease('tenant-1', 'session-1', 'worker-a')
  assert.ok(lease)

  const command = store.enqueueSessionCommand({
    commandId: 'cmd-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'hello' },
  })
  assert.equal(command.status, 'pending')
  assert.deepEqual(store.enqueueSessionCommand({
    commandId: 'cmd-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'hello' },
  }), command)

  const claimed = store.claimNextSessionCommand(lease)
  assert.equal(claimed?.status, 'running')
  assert.equal(claimed?.claimedLeaseToken, lease.leaseToken)
  assert.equal(store.ackSessionCommand(lease, 'cmd-1').status, 'acked')

  store.enqueueSessionCommand({
    commandId: 'cmd-2',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'abort',
  })
  assert.equal(store.claimNextSessionCommand(lease)?.commandId, 'cmd-2')

  const takeoverLease = store.claimSessionLease(
    'tenant-1',
    'session-1',
    'worker-b',
    new Date(Date.now() + 31_000),
  )
  assert.ok(takeoverLease)
  assert.throws(() => store.ackSessionCommand(lease, 'cmd-2'), /stale/)

  const reclaimed = store.claimNextSessionCommand(takeoverLease)
  assert.equal(reclaimed?.commandId, 'cmd-2')
  assert.equal(reclaimed?.claimedLeaseToken, takeoverLease.leaseToken)
  assert.equal(store.ackSessionCommand(takeoverLease, 'cmd-2').status, 'acked')
})

test('cloud control plane truncates redacted command failure summaries', () => {
  const store = seededStore()
  const lease = store.claimSessionLease('tenant-1', 'session-1', 'worker-a')
  assert.ok(lease)
  store.enqueueSessionCommand({
    commandId: 'cmd-long-error',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'hello' },
  })
  assert.equal(store.claimNextSessionCommand(lease)?.commandId, 'cmd-long-error')

  const failed = store.failSessionCommand(
    lease,
    'cmd-long-error',
    `provider failed apiKey=${'a'.repeat(80)} ${'details '.repeat(200)}`,
  )

  assert.equal(failed.status, 'failed')
  assert.ok(failed.lastErrorSummary)
  assert.equal(failed.lastErrorSummary!.length, 512)
  assert.equal(failed.lastErrorSummary!.includes('apiKey=aaaaaaaa'), false)
  assert.equal(failed.lastErrorSummary!.endsWith('...'), true)
})

test('cloud control plane fences status, runtime binding, and event writes by worker lease token', () => {
  const store = seededStore()
  const firstLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-a', new Date(), 1)
  assert.ok(firstLease)
  const secondLease = store.claimSessionLease(
    'tenant-1',
    'session-1',
    'worker-b',
    new Date(Date.now() + 2),
    30_000,
  )
  assert.ok(secondLease)

  assert.throws(() => store.updateSessionStatus({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    status: 'running',
    leaseToken: firstLease.leaseToken,
  }), /stale/)
  assert.throws(() => store.bindSessionRuntime({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    opencodeSessionId: 'oc-stale',
    leaseToken: firstLease.leaseToken,
  }), /stale/)
  assert.throws(() => store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    type: 'assistant.message',
    payload: { messageId: 'm-stale', content: 'stale' },
    leaseToken: firstLease.leaseToken,
  }), /stale/)

  assert.equal(store.updateSessionStatus({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    status: 'running',
    leaseToken: secondLease.leaseToken,
  }).status, 'running')
  assert.equal(store.bindSessionRuntime({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    opencodeSessionId: 'oc-current',
    leaseToken: secondLease.leaseToken,
  }).opencodeSessionId, 'oc-current')
  assert.equal(store.appendSessionEvent({
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    type: 'assistant.message',
    payload: { messageId: 'm-current', content: 'current' },
    leaseToken: secondLease.leaseToken,
  }).sequence, 1)
})

test('cloud control plane reaps expired session leases with bounded retries', async () => {
  const store = seededStore()
  const firstLeaseStart = new Date('2030-01-01T00:00:00.000Z')
  const firstLeaseExpired = new Date('2030-01-01T00:00:02.000Z')
  const secondLeaseStart = new Date('2030-01-01T00:00:03.000Z')
  const secondLeaseExpired = new Date('2030-01-01T00:00:05.000Z')

  store.enqueueSessionCommand({
    commandId: 'cmd-retry',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'retry me' },
  })

  const firstLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-a', firstLeaseStart, 1_000)
  assert.ok(firstLease)
  assert.equal(store.claimNextSessionCommand(firstLease, firstLeaseStart)?.attemptCount, 1)

  const retried = store.reapExpiredSessionLeases({ maxCommandAttempts: 2, now: firstLeaseExpired })
  assert.equal(retried.length, 1)
  assert.equal(retried[0]?.action, 'retried')
  assert.deepEqual(retried[0]?.retriedCommandIds, ['cmd-retry'])

  const secondLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-b', secondLeaseStart, 1_000)
  assert.ok(secondLease)
  assert.equal(store.claimNextSessionCommand(secondLease, secondLeaseStart)?.attemptCount, 2)

  const failed = store.reapExpiredSessionLeases({ maxCommandAttempts: 2, now: secondLeaseExpired })
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.action, 'failed')
  assert.deepEqual(failed[0]?.failedCommandIds, ['cmd-retry'])
  assert.equal(store.getSessionForTenant('tenant-1', 'session-1')?.status, 'errored')
})

test('cloud control plane limits expired session lease reaping to oldest leases', () => {
  const store = seededStore()
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-2',
    opencodeSessionId: 'oc-session-2',
    profileName: 'full',
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
  })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-3',
    opencodeSessionId: 'oc-session-3',
    profileName: 'full',
    createdAt: new Date('2030-01-01T00:00:00.000Z'),
  })

  assert.ok(store.claimSessionLease('tenant-1', 'session-1', 'worker-a', new Date('2030-01-01T00:00:00.000Z'), 1_000))
  assert.ok(store.claimSessionLease('tenant-1', 'session-2', 'worker-a', new Date('2030-01-01T00:00:01.000Z'), 1_000))
  assert.ok(store.claimSessionLease('tenant-1', 'session-3', 'worker-a', new Date('2030-01-01T00:00:02.000Z'), 1_000))

  const first = store.reapExpiredSessionLeases({
    limit: 2,
    now: new Date('2030-01-01T00:00:05.000Z'),
  })
  assert.deepEqual(first.map((record) => record.sessionId), ['session-1', 'session-2'])
  assert.equal(store.getSessionForTenant('tenant-1', 'session-3')?.status, 'running')

  const second = store.reapExpiredSessionLeases({
    limit: 2,
    now: new Date('2030-01-01T00:00:05.000Z'),
  })
  assert.deepEqual(second.map((record) => record.sessionId), ['session-3'])
})

test('cloud control plane records worker heartbeats, settings metadata, and migrations', () => {
  const store = seededStore()

  store.recordWorkerHeartbeat({
    workerId: 'worker-a',
    role: 'worker',
    activeSessionIds: ['session-1', 'session-1'],
    now: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.deepEqual(store.listWorkerHeartbeats()[0]?.activeSessionIds, ['session-1'])

  store.setSettingMetadata({
    tenantId: 'tenant-1',
    userId: 'user-1',
    key: 'provider.openai',
    value: { secretRef: 'secret/openai' },
  })
  assert.deepEqual(
    store.getSettingMetadata('tenant-1', 'provider.openai', 'user-1')?.value,
    { secretRef: 'secret/openai' },
  )
  assert.equal(store.listSettingMetadata('tenant-1', 'user-1')[0]?.key, 'provider.openai')

  assert.equal(store.recordSchemaMigration('001_initial').id, '001_initial')
  assert.equal(store.recordSchemaMigration('001_initial').id, '001_initial')
  assert.equal(store.listSchemaMigrations().length, 1)
})

test('cloud control plane records usage and enforces windowed quotas', () => {
  const store = seededStore()
  const orgId = 'tenant-1'

  const first = store.consumeUsageQuota({
    orgId,
    quotaKey: 'prompts:hour',
    limit: 2,
    quantity: 1,
    windowMs: 60_000,
    now: new Date('2026-01-01T00:00:00.000Z'),
    policyCode: 'quota.prompts_per_hour_exceeded',
  })
  const second = store.consumeUsageQuota({
    orgId,
    quotaKey: 'prompts:hour',
    limit: 2,
    quantity: 1,
    windowMs: 60_000,
    now: new Date('2026-01-01T00:00:01.000Z'),
    policyCode: 'quota.prompts_per_hour_exceeded',
  })
  const denied = store.consumeUsageQuota({
    orgId,
    quotaKey: 'prompts:hour',
    limit: 2,
    quantity: 1,
    windowMs: 60_000,
    now: new Date('2026-01-01T00:00:02.000Z'),
    policyCode: 'quota.prompts_per_hour_exceeded',
  })

  assert.equal(first.allowed, true)
  assert.equal(second.remaining, 0)
  assert.equal(denied.allowed, false)
  assert.equal(denied.policyCode, 'quota.prompts_per_hour_exceeded')
  assert.equal(denied.retryAfterMs > 0, true)

  store.recordUsageEvent({
    orgId,
    accountId: 'user-1',
    eventType: 'prompt.enqueued',
    quantity: 1,
    unit: 'count',
    metadata: { token: 'secret-token', safe: 'yes' },
    createdAt: new Date('2026-01-01T00:00:03.000Z'),
  })
  const usage = store.listUsageEvents(orgId)
  assert.equal(usage.length, 1)
  assert.equal(usage[0]?.eventType, 'prompt.enqueued')
  assert.equal(usage[0]?.metadata.token, '[redacted]')
  assert.equal(usage[0]?.metadata.safe, 'yes')
})

test('cloud control plane stores billing subscriptions by org and provider ids', () => {
  const store = seededStore()
  const orgId = 'tenant-1'

  const active = store.upsertBillingSubscription({
    orgId,
    planKey: 'pro',
    providerId: 'stripe',
    providerCustomerId: 'cus_123',
    providerSubscriptionId: 'sub_123',
    status: 'active',
    seats: 2,
    entitlements: { allowPrompts: true, maxPromptsPerHour: 10 },
    currentPeriodEnd: new Date('2026-02-01T00:00:00.000Z'),
    metadata: { source: 'test', apiKey: 'secret-value' },
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(active.status, 'active')
  assert.equal(active.seats, 2)
  assert.equal(active.metadata.apiKey, '[redacted]')
  assert.equal(store.getBillingSubscription(orgId)?.providerSubscriptionId, 'sub_123')
  assert.equal(store.findBillingSubscriptionByProvider({
    providerId: 'stripe',
    providerSubscriptionId: 'sub_123',
  })?.orgId, orgId)
  assert.equal(store.findBillingSubscriptionByProvider({
    providerId: 'stripe',
    providerCustomerId: 'cus_123',
  })?.orgId, orgId)

  const canceled = store.upsertBillingSubscription({
    orgId,
    planKey: 'pro',
    providerId: 'stripe',
    providerCustomerId: 'cus_123',
    providerSubscriptionId: 'sub_123',
    status: 'canceled',
    entitlements: { allowPrompts: false },
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  })
  assert.equal(canceled.status, 'canceled')
  assert.equal(store.getBillingSubscription(orgId)?.status, 'canceled')
  assert.equal(store.listAuditEvents(orgId).some((event) => event.eventType === 'billing.subscription.updated'), true)
})

test('cloud control plane caps concurrent sessions and active workers', () => {
  const store = seededStore()
  assert.throws(() => store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-over-limit',
    opencodeSessionId: 'oc-session-over-limit',
    profileName: 'full',
    quota: {
      orgId: 'tenant-1',
      maxConcurrentSessionsPerOrg: 1,
      policyCode: 'quota.concurrent_sessions_exceeded',
    },
  }), (error) => (
    error instanceof ControlPlaneQuotaExceededError
    && error.policyCode === 'quota.concurrent_sessions_exceeded'
  ))

  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-2',
    opencodeSessionId: 'oc-session-2',
    profileName: 'full',
  })
  const firstLease = store.claimSessionLease('tenant-1', 'session-1', 'worker-a', new Date('2026-01-01T00:00:00.000Z'), 30_000, {
    orgId: 'tenant-1',
    maxActiveWorkersPerOrg: 1,
    policyCode: 'quota.active_workers_exceeded',
  })
  const secondLease = store.claimSessionLease('tenant-1', 'session-2', 'worker-b', new Date('2026-01-01T00:00:00.000Z'), 30_000, {
    orgId: 'tenant-1',
    maxActiveWorkersPerOrg: 1,
    policyCode: 'quota.active_workers_exceeded',
  })
  assert.ok(firstLease)
  assert.equal(secondLease, null)
})

test('cloud control plane caps managed command queues and workflow starts', () => {
  const store = seededStore()

  store.enqueueSessionCommand({
    commandId: 'queued-command-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'first prompt' },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    quota: {
      orgId: 'tenant-1',
      maxQueuedCommandsPerOrg: 1,
      policyCode: 'quota.queued_commands_exceeded',
    },
  })
  assert.throws(() => store.enqueueSessionCommand({
    commandId: 'queued-command-2',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'second prompt' },
    createdAt: new Date('2026-01-01T00:00:01.000Z'),
    quota: {
      orgId: 'tenant-1',
      maxQueuedCommandsPerOrg: 1,
      policyCode: 'quota.queued_commands_exceeded',
    },
  }), (error) => (
    error instanceof ControlPlaneQuotaExceededError
    && error.policyCode === 'quota.queued_commands_exceeded'
  ))
  assert.throws(() => store.enqueueSessionCommand({
    commandId: 'queued-command-3',
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    kind: 'prompt',
    payload: { text: 'third prompt' },
    createdAt: new Date('2026-01-01T00:00:02.000Z'),
    quota: {
      orgId: 'tenant-1',
      maxQueuedCommandsPerOrg: 10,
      maxQueueAgeMs: 1,
      queueAgePolicyCode: 'quota.queue_age_exceeded',
    },
  }), (error) => (
    error instanceof ControlPlaneQuotaExceededError
    && error.policyCode === 'quota.queue_age_exceeded'
  ))

  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-quota',
    draft: {
      title: 'Workflow quota',
      instructions: 'Respect workflow quotas.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-quota',
    runId: 'workflow-run-1',
    triggerType: 'manual',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    quota: {
      orgId: 'tenant-1',
      maxConcurrentWorkflowRunsPerOrg: 1,
      maxWorkflowRunsPerHour: 10,
    },
  })
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-quota-concurrent',
    draft: {
      title: 'Workflow concurrent quota',
      instructions: 'Respect concurrent workflow quotas.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  assert.throws(() => store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-quota-concurrent',
    runId: 'workflow-run-2',
    triggerType: 'manual',
    createdAt: new Date('2026-01-01T00:00:01.000Z'),
    quota: {
      orgId: 'tenant-1',
      maxConcurrentWorkflowRunsPerOrg: 1,
      maxWorkflowRunsPerHour: 10,
    },
  }), (error) => (
    error instanceof ControlPlaneQuotaExceededError
    && error.policyCode === 'quota.concurrent_workflow_runs_exceeded'
  ))
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-quota-hourly',
    draft: {
      title: 'Workflow hourly quota',
      instructions: 'Respect hourly workflow quotas.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  assert.throws(() => store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-quota-hourly',
    runId: 'workflow-run-3',
    triggerType: 'manual',
    createdAt: new Date('2026-01-01T00:00:02.000Z'),
    quota: {
      orgId: 'tenant-1',
      maxConcurrentWorkflowRunsPerOrg: 10,
      maxWorkflowRunsPerHour: 1,
    },
  }), (error) => (
    error instanceof ControlPlaneQuotaExceededError
    && error.policyCode === 'quota.workflow_runs_per_hour_exceeded'
  ))
})

test('cloud control plane resolves org accounts memberships, tokens, and audit events', () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Acme' })
  const account = store.createAccount({
    accountId: 'account-1',
    idpSubject: 'issuer:user-1',
    email: 'Owner@Example.test',
    displayName: 'Owner',
  })
  const membership = store.upsertMembership({
    orgId: org.orgId,
    accountId: account.accountId,
    role: 'owner',
    status: 'active',
    actor: { actorType: 'system', actorId: 'test' },
  })

  assert.equal(org.tenantId, 'tenant-1')
  assert.equal(account.email, 'owner@example.test')
  assert.equal(store.findAccountBySubject('issuer:user-1')?.accountId, 'account-1')
  assert.equal(store.findAccountByEmail('owner@example.test')?.accountId, 'account-1')
  assert.equal(membership.role, 'owner')
  assert.equal(store.listMembershipsForAccount('account-1')[0]?.orgId, org.orgId)
  assert.equal(store.resolvePrincipalMembership({
    tenantId: 'tenant-1',
    accountId: 'account-1',
  })?.membership.status, 'active')

  const issued = store.issueApiToken({
    orgId: org.orgId,
    accountId: account.accountId,
    name: 'Desktop token',
    scopes: ['desktop', 'gateway', 'desktop'],
    secret: 'deterministic-secret',
    actor: { actorType: 'user', actorId: account.accountId },
  })
  assert.match(issued.plaintext, /^occ_/)
  assert.notEqual(issued.token.tokenHash, issued.plaintext)
  assert.deepEqual(issued.token.scopes, ['desktop', 'gateway'])
  assert.equal(store.listApiTokens(org.orgId)[0]?.tokenId, issued.token.tokenId)
  assert.equal(store.findApiTokenByPlaintext(issued.plaintext)?.tokenId, issued.token.tokenId)

  const revoked = store.revokeApiToken({
    tokenId: issued.token.tokenId,
    orgId: org.orgId,
    actor: { actorType: 'user', actorId: account.accountId },
  })
  assert.equal(revoked?.revokedAt !== null, true)
  assert.equal(store.findApiTokenByPlaintext(issued.plaintext), null)

  const audit = store.recordAuditEvent({
    orgId: org.orgId,
    actorType: 'user',
    actorId: account.accountId,
    eventType: 'sensitive.changed',
    metadata: {
      token: issued.plaintext,
      secretValue: 'do-not-store',
      note: 'ok',
    },
  })
  assert.equal(audit.metadata.token, '[redacted]')
  assert.equal(audit.metadata.secretValue, '[redacted]')
  assert.equal(store.listAuditEvents(org.orgId).some((event) => event.eventType === 'api_token.created'), true)
})

test('cloud control plane manages worker lifecycle credentials and heartbeats', () => {
  const store = seededStore()
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', orgId: 'org-1', name: 'Acme' })

  assert.throws(
    () => store.createManagedWorkerPool({
      orgId: org.orgId,
      name: 'External pool',
      mode: 'customer_hosted',
    }),
    /not supported in v1/,
  )

  const pool = store.createManagedWorkerPool({
    poolId: 'pool-1',
    orgId: org.orgId,
    name: 'Internal pool',
    mode: 'self_hosted',
    maxWorkers: 3,
    maxConcurrentWork: 6,
    actor: { actorType: 'user', actorId: 'user-1', accountId: 'user-1' },
  })
  assert.equal(pool.status, 'active')
  assert.equal(store.listManagedWorkerPools(org.orgId)[0]?.poolId, 'pool-1')

  const worker = store.registerManagedWorker({
    workerId: 'worker-1',
    orgId: org.orgId,
    poolId: pool.poolId,
    displayName: 'Worker one',
  })
  assert.equal(worker.status, 'pending')
  assert.throws(
    () => store.updateManagedWorkerStatus({ orgId: org.orgId, workerId: worker.workerId, status: 'draining' }),
    /Invalid managed worker transition/,
  )
  assert.equal(store.updateManagedWorkerStatus({ orgId: org.orgId, workerId: worker.workerId, status: 'active' })?.status, 'active')
  assert.equal(store.updateManagedWorkerStatus({ orgId: org.orgId, workerId: worker.workerId, status: 'paused' })?.status, 'paused')
  assert.equal(store.updateManagedWorkerStatus({ orgId: org.orgId, workerId: worker.workerId, status: 'active' })?.status, 'active')

  assert.throws(
    () => store.issueManagedWorkerCredential({
      orgId: org.orgId,
      workerId: worker.workerId,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    }),
    /expiration must be in the future/,
  )

  const issued = store.issueManagedWorkerCredential({
    orgId: org.orgId,
    workerId: worker.workerId,
    secret: 'managed-worker-secret',
  })
  assert.match(issued.plaintext, /^ocw_/)
  assert.equal(store.listManagedWorkerCredentials(org.orgId, worker.workerId)[0]?.tokenHash.includes(issued.plaintext), false)
  assert.equal(store.findManagedWorkerCredentialByPlaintext(issued.plaintext)?.worker.workerId, worker.workerId)

  const heartbeat = store.recordManagedWorkerHeartbeat({
    orgId: org.orgId,
    workerId: worker.workerId,
    credentialId: issued.credential.credentialId,
    version: '1.0.0',
    currentLoad: 2,
    activeWorkIds: ['run-1', 'run-1'],
    lastErrorSummary: 'token=secret should redact',
    heartbeatSequence: 7,
  })
  assert.deepEqual(heartbeat.activeWorkIds, ['run-1'])
  assert.equal(heartbeat.currentLoad, 2)
  assert.equal(JSON.stringify(heartbeat).includes('secret'), false)

  const revokedCredential = store.revokeManagedWorkerCredential({
    orgId: org.orgId,
    workerId: worker.workerId,
    credentialId: issued.credential.credentialId,
  })
  assert.equal(revokedCredential?.revokedAt !== null, true)
  assert.equal(store.findManagedWorkerCredentialByPlaintext(issued.plaintext), null)
  const heartbeatRejectionAudit = store.listAuditEvents(org.orgId, 20)
  assert.equal(heartbeatRejectionAudit.some((event) => (
    event.eventType === 'managed_worker_heartbeat.rejected'
    && event.metadata.reason === 'credential_revoked'
  )), true)
  assert.equal(JSON.stringify(heartbeatRejectionAudit).includes(issued.plaintext), false)
  assert.throws(
    () => store.recordManagedWorkerHeartbeat({
      orgId: org.orgId,
      workerId: worker.workerId,
      credentialId: issued.credential.credentialId,
    }),
    /revoked/,
  )

  assert.equal(store.updateManagedWorkerStatus({ orgId: org.orgId, workerId: worker.workerId, status: 'revoked' })?.status, 'revoked')
  assert.equal(store.listAuditEvents(org.orgId).some((event) => event.eventType === 'managed_worker.revoked'), true)
})

test('cloud control plane stores headless channel bindings, interactions, cursors, and deliveries', () => {
  const store = seededStore()
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Acme' })

  const agent = store.createHeadlessAgent({
    agentId: 'agent-1',
    orgId: org.orgId,
    tenantId: 'tenant-1',
    profileName: 'data-analyst',
    name: 'Data analyst',
    createdByAccountId: 'user-1',
  })
  const channelBinding = store.createChannelBinding({
    bindingId: 'telegram-binding',
    orgId: org.orgId,
    agentId: agent.agentId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    displayName: 'Telegram',
    credentialRef: 'secret/telegram',
    settings: { parseMode: 'markdown' },
  })
  const identity = store.upsertChannelIdentity({
    orgId: org.orgId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalUserId: 'tg-user-1',
    accountId: 'user-1',
    role: 'member',
    status: 'active',
    metadata: { username: 'alice' },
  })

  assert.equal(agent.status, 'active')
  assert.equal(channelBinding.credentialRef, 'secret/telegram')
  assert.equal(store.findChannelIdentity({
    orgId: org.orgId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalUserId: 'tg-user-1',
  })?.identityId, identity.identityId)

  const sessionBinding = store.bindChannelSession({
    bindingId: 'session-binding-1',
    orgId: org.orgId,
    agentId: agent.agentId,
    channelBindingId: channelBinding.bindingId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
    sessionId: 'session-1',
  })
  assert.equal(sessionBinding.sessionId, 'session-1')
  assert.equal(sessionBinding.externalWorkspaceId, 'bot-1')
  assert.equal(store.findChannelSessionBindingByThread({
    orgId: org.orgId,
    provider: 'telegram',
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
  })?.bindingId, sessionBinding.bindingId)

  const cursor = store.updateChannelCursor({
    orgId: org.orgId,
    bindingId: sessionBinding.bindingId,
    lastEventSequence: 7,
    lastWorkspaceSequence: 3,
    lastChatMessageId: 'message-7',
  })
  assert.equal(cursor.ok, true)
  if (!cursor.ok) assert.fail(`Expected cursor update to succeed, got ${cursor.reason}`)
  assert.equal(cursor.binding.lastEventSequence, 7)
  const staleCursor = store.updateChannelCursor({
    orgId: org.orgId,
    bindingId: sessionBinding.bindingId,
    lastEventSequence: 6,
    lastWorkspaceSequence: 3,
  })
  assert.equal(staleCursor.ok, false)
  if (staleCursor.ok) assert.fail('Expected stale cursor update to be rejected.')
  assert.equal(staleCursor.reason, 'stale')
  assert.equal(staleCursor.binding.lastEventSequence, 7)
  assert.deepEqual(store.updateChannelCursor({
    orgId: org.orgId,
    bindingId: 'missing-session-binding',
    lastEventSequence: 1,
    lastWorkspaceSequence: 1,
  }), { ok: false, reason: 'not_found' })

  const issued = store.createChannelInteraction({
    interactionId: 'interaction-1',
    orgId: org.orgId,
    agentId: agent.agentId,
    sessionId: 'session-1',
    provider: 'telegram',
    externalInteractionId: 'button-1',
    kind: 'permission',
    targetId: 'permission-1',
    createdByIdentityId: identity.identityId,
    expiresAt: new Date('2026-01-01T01:00:00.000Z'),
    tokenSecret: 'test-secret',
  })
  assert.match(issued.plaintextToken, /^occi_interaction-1_/)
  assert.notEqual(issued.interaction.tokenHash, issued.plaintextToken)
  assert.throws(() => store.createChannelInteraction({
    interactionId: 'interaction-1',
    orgId: org.orgId,
    agentId: agent.agentId,
    sessionId: 'session-1',
    provider: 'telegram',
    kind: 'permission',
    targetId: 'permission-1',
    expiresAt: new Date('2026-01-01T01:00:00.000Z'),
  }), /already exists/)
  assert.equal(store.resolveChannelInteraction({
    orgId: org.orgId,
    token: issued.plaintextToken,
    identityId: identity.identityId,
    usedAt: new Date('2026-01-01T00:01:00.000Z'),
  })?.status, 'used')
  assert.equal(store.resolveChannelInteraction({
    orgId: org.orgId,
    token: issued.plaintextToken,
    identityId: identity.identityId,
    usedAt: new Date('2026-01-01T00:02:00.000Z'),
  }), null)

  const delivery = store.createChannelDelivery({
    deliveryId: 'delivery-1',
    orgId: org.orgId,
    agentId: agent.agentId,
    channelBindingId: channelBinding.bindingId,
    sessionBindingId: sessionBinding.bindingId,
    provider: 'telegram',
    target: { externalChatId: 'chat-1' },
    eventType: 'workflow.completed',
    payload: { runId: 'run-1' },
    nextAttemptAt: new Date('2026-01-01T00:00:10.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(delivery.status, 'pending')
  assert.equal(store.claimNextChannelDelivery({
    orgId: org.orgId,
    claimedBy: 'gateway-early',
    now: new Date('2026-01-01T00:00:01.000Z'),
  }), null)
  assert.equal(store.claimNextChannelDelivery({
    orgId: org.orgId,
    claimedBy: 'gateway-wrong-binding',
    channelBindingIds: ['other-binding'],
    now: new Date('2026-01-01T00:00:10.000Z'),
  }), null)
  const claimed = store.claimNextChannelDelivery({
    orgId: org.orgId,
    claimedBy: 'gateway-instance-1',
    lastClaimedBy: 'gateway-token-1',
    now: new Date('2026-01-01T00:00:10.000Z'),
    ttlMs: 30_000,
  })
  assert.equal(claimed?.deliveryId, delivery.deliveryId)
  assert.equal(claimed?.claimedBy, 'gateway-instance-1')
  assert.equal(claimed?.lastClaimedBy, 'gateway-token-1')
  assert.equal(store.listChannelDeliveries({
    orgId: org.orgId,
    lastClaimedBy: 'gateway-token-1',
  })[0]?.deliveryId, delivery.deliveryId)
  assert.equal(store.listChannelDeliveries({
    orgId: org.orgId,
    lastClaimedBy: 'gateway-token-2',
  }).length, 0)
  assert.equal(store.claimNextChannelDelivery({
    orgId: org.orgId,
    claimedBy: 'gateway-2',
    now: new Date('2026-01-01T00:00:02.000Z'),
  }), null)
  assert.equal(store.ackChannelDelivery({
    orgId: org.orgId,
    deliveryId: delivery.deliveryId,
    claimedBy: 'wrong-gateway',
    status: 'sent',
    updatedAt: new Date('2026-01-01T00:00:03.000Z'),
  }), null)
  assert.equal(store.ackChannelDelivery({
    orgId: org.orgId,
    deliveryId: delivery.deliveryId,
    lastClaimedBy: 'gateway-token-2',
    status: 'dead',
    updatedAt: new Date('2026-01-01T00:00:03.000Z'),
  }), null)
  const legacyDeliveryRecord = (store as unknown as {
    channelDeliveriesDomain: {
      deliveries: Map<string, { lastClaimedBy: string | null }>
    }
  }).channelDeliveriesDomain.deliveries.get(delivery.deliveryId)
  assert.ok(legacyDeliveryRecord)
  legacyDeliveryRecord.lastClaimedBy = null
  const legacyAck = store.ackChannelDelivery({
    orgId: org.orgId,
    deliveryId: delivery.deliveryId,
    claimedBy: 'gateway-instance-1',
    lastClaimedBy: 'gateway-token-1',
    status: 'sent',
    updatedAt: new Date('2026-01-01T00:00:03.000Z'),
  })
  assert.equal(legacyAck?.status, 'sent')
  assert.equal(legacyAck?.lastClaimedBy, 'gateway-token-1')

  const firstProviderEvent = store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-1',
    eventType: 'message',
    claimedBy: 'gateway-1',
    ttlMs: 30_000,
    now: new Date('2026-01-01T00:00:00.000Z'),
    metadata: { providerMessageId: 'message-1', attachmentCount: 0 },
  })
  assert.equal(firstProviderEvent.claimed, true)
  assert.equal(firstProviderEvent.duplicate, false)
  assert.equal(firstProviderEvent.event.status, 'processing')
  assert.equal(firstProviderEvent.event.attemptCount, 1)
  assert.equal(store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-1',
    eventType: 'message',
    claimedBy: 'gateway-2',
    now: new Date('2026-01-01T00:00:01.000Z'),
  }).claimed, false)
  assert.equal(store.completeChannelProviderEvent({
    orgId: org.orgId,
    eventId: firstProviderEvent.event.eventId,
    claimedBy: 'gateway-1',
    status: 'processed',
    updatedAt: new Date('2026-01-01T00:00:02.000Z'),
  })?.status, 'processed')
  assert.equal(store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-1',
    eventType: 'message',
    claimedBy: 'gateway-2',
    now: new Date('2026-01-01T00:00:03.000Z'),
  }).duplicate, true)

  const expired = store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-expired',
    eventType: 'message',
    claimedBy: 'gateway-1',
    ttlMs: 1_000,
    now: new Date('2026-01-01T00:00:00.000Z'),
  })
  const reclaimed = store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-expired',
    eventType: 'message',
    claimedBy: 'gateway-2',
    now: new Date('2026-01-01T00:00:02.000Z'),
  })
  assert.equal(reclaimed.claimed, true)
  assert.equal(reclaimed.event.eventId, expired.event.eventId)
  assert.equal(reclaimed.event.attemptCount, 2)

  const failed = store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-failed',
    eventType: 'command',
    claimedBy: 'gateway-1',
    now: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(store.completeChannelProviderEvent({
    orgId: org.orgId,
    eventId: failed.event.eventId,
    claimedBy: 'gateway-1',
    status: 'failed',
    retryable: true,
    lastError: 'temporary outage token=secret',
    updatedAt: new Date('2026-01-01T00:00:01.000Z'),
  })?.retryable, true)
  assert.equal(store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-failed',
    eventType: 'command',
    claimedBy: 'gateway-2',
    now: new Date('2026-01-01T00:00:02.000Z'),
  }).claimed, true)
  assert.equal(store.completeChannelProviderEvent({
    orgId: org.orgId,
    eventId: failed.event.eventId,
    claimedBy: 'gateway-2',
    status: 'failed',
    retryable: false,
    lastError: 'forbidden',
    updatedAt: new Date('2026-01-01T00:00:03.000Z'),
  })?.retryable, false)
  assert.equal(store.claimChannelProviderEvent({
    orgId: org.orgId,
    provider: 'telegram',
    providerInstanceId: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    providerEventId: 'event-failed',
    eventType: 'command',
    claimedBy: 'gateway-3',
    now: new Date('2026-01-01T00:00:04.000Z'),
  }).claimed, false)

  const secondInteraction = store.createChannelInteraction({
    interactionId: 'interaction-2',
    orgId: org.orgId,
    agentId: agent.agentId,
    sessionId: 'session-1',
    provider: 'telegram',
    kind: 'question',
    targetId: 'question-1',
    expiresAt: new Date('2027-01-01T01:00:00.000Z'),
  })
  assert.throws(() => store.resolveChannelInteractionWithCommand({
    orgId: org.orgId,
    token: secondInteraction.plaintextToken,
    identityId: identity.identityId,
    command: {
      commandId: 'bad-command',
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'missing-session',
      kind: 'question.reply',
      payload: { requestId: 'question-1', answers: [] },
    },
  }), /does not match/)
  assert.equal(store.findChannelInteraction({
    orgId: org.orgId,
    token: secondInteraction.plaintextToken,
  })?.status, 'pending')
  const resolvedWithCommand = store.resolveChannelInteractionWithCommand({
    orgId: org.orgId,
    token: secondInteraction.plaintextToken,
    identityId: identity.identityId,
    command: {
      commandId: 'question-command',
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
      kind: 'question.reply',
      payload: { requestId: 'question-1', answers: ['ok'] },
    },
  })
  assert.equal(resolvedWithCommand?.interaction.status, 'used')
  assert.equal(resolvedWithCommand?.command.kind, 'question.reply')
})

test('cloud control plane treats provider instance ids as routing namespaces', () => {
  const store = seededStore()
  const org = store.ensureOrgForTenant({ tenantId: 'tenant-1', name: 'Acme' })
  const agent = store.createHeadlessAgent({
    agentId: 'agent-1',
    orgId: org.orgId,
    tenantId: 'tenant-1',
    profileName: 'data-analyst',
    name: 'Data analyst',
    createdByAccountId: 'user-1',
  })
  const prod = store.createChannelBinding({
    bindingId: 'telegram-prod-binding',
    orgId: org.orgId,
    agentId: agent.agentId,
    provider: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    displayName: 'Telegram prod',
  })
  const support = store.createChannelBinding({
    bindingId: 'telegram-support-binding',
    orgId: org.orgId,
    agentId: agent.agentId,
    provider: 'telegram-support',
    externalWorkspaceId: 'bot-1',
    displayName: 'Telegram support',
  })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-prod',
    opencodeSessionId: 'oc-session-prod',
    profileName: 'data-analyst',
  })
  store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-support',
    opencodeSessionId: 'oc-session-support',
    profileName: 'data-analyst',
  })

  const prodSession = store.bindChannelSession({
    bindingId: 'telegram-prod-session',
    orgId: org.orgId,
    agentId: agent.agentId,
    channelBindingId: prod.bindingId,
    provider: prod.provider,
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
    sessionId: 'session-prod',
  })
  const supportSession = store.bindChannelSession({
    bindingId: 'telegram-support-session',
    orgId: org.orgId,
    agentId: agent.agentId,
    channelBindingId: support.bindingId,
    provider: support.provider,
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
    sessionId: 'session-support',
  })

  assert.notEqual(prodSession.bindingId, supportSession.bindingId)
  assert.equal(store.findChannelSessionBindingByThread({
    orgId: org.orgId,
    provider: 'telegram-prod',
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
  })?.sessionId, 'session-prod')
  assert.equal(store.findChannelSessionBindingByThread({
    orgId: org.orgId,
    provider: 'telegram-support',
    externalWorkspaceId: 'bot-1',
    externalChatId: 'chat-1',
    externalThreadId: 'thread-1',
  })?.sessionId, 'session-support')
})

test('cloud control plane persists tenant-scoped thread tags and session links', () => {
  const store = seededStore()
  const tag = store.createThreadTag({
    tenantId: 'tenant-1',
    tagId: 'tag-1',
    name: 'Revenue',
    color: '#22c55e',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(tag.name, 'Revenue')
  assert.equal(store.listThreadTags('tenant-1').length, 1)
  assert.throws(() => store.createThreadTag({
    tenantId: 'tenant-1',
    tagId: 'tag-2',
    name: 'revenue',
  }), /already exists/)

  store.applyThreadTags({
    tenantId: 'tenant-1',
    sessionIds: ['session-1'],
    tagIds: ['tag-1'],
  })
  assert.deepEqual(
    store.listThreadMetadata({ tenantId: 'tenant-1', userId: 'user-1' })[0]?.tags.map((entry) => entry.name),
    ['Revenue'],
  )
  assert.equal(
    store.listThreadMetadata({ tenantId: 'tenant-1', userId: 'user-1', tagIds: ['tag-1'] }).length,
    1,
  )

  assert.equal(store.updateThreadTag({
    tenantId: 'tenant-1',
    tagId: 'tag-1',
    name: 'Finance',
    color: '#2563eb',
  })?.color, '#2563eb')
  store.removeThreadTags({
    tenantId: 'tenant-1',
    sessionIds: ['session-1'],
    tagIds: ['tag-1'],
  })
  assert.deepEqual(
    store.listThreadMetadata({ tenantId: 'tenant-1', userId: 'user-1' })[0]?.tags,
    [],
  )
  assert.equal(store.deleteThreadTag('tenant-1', 'tag-1'), true)
  assert.equal(store.listThreadTags('tenant-1').length, 0)
})

test('cloud control plane persists tenant-scoped smart filters', () => {
  const store = seededStore()
  const filter = store.createThreadSmartFilter({
    tenantId: 'tenant-1',
    filterId: 'filter-1',
    name: 'Reports',
    query: { text: 'report', tagIds: ['tag-1'] },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.deepEqual(filter.query, { text: 'report', tagIds: ['tag-1'] })
  assert.equal(store.listThreadSmartFilters('tenant-1').length, 1)
  assert.deepEqual(store.updateThreadSmartFilter({
    tenantId: 'tenant-1',
    filterId: 'filter-1',
    query: { statuses: ['idle'] },
  })?.query, { statuses: ['idle'] })
  assert.equal(store.deleteThreadSmartFilter('tenant-1', 'filter-1'), true)
  assert.equal(store.listThreadSmartFilters('tenant-1').length, 0)
})

test('cloud control plane persists workflow runs and finalizes workflow state durably', () => {
  const store = seededStore()
  const workflow = store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-1',
    draft: {
      title: 'Daily revenue',
      instructions: 'Summarize revenue.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: ['charts'],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.equal(workflow.status, 'active')

  const run = store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    triggerType: 'manual',
    createdAt: new Date('2026-01-01T00:01:00.000Z'),
  })
  assert.equal(run.status, 'queued')
  assert.equal(store.getWorkflow('tenant-1', 'user-1', 'workflow-1')?.status, 'running')

  store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    sessionId: 'session-1',
    startedAt: new Date('2026-01-01T00:02:00.000Z'),
  })
  assert.equal(store.getWorkflowRunBySession('tenant-1', 'session-1')?.status, 'running')

  const completed = store.completeWorkflowRun({
    tenantId: 'tenant-1',
    workflowId: 'workflow-1',
    runId: 'run-1',
    summary: 'Revenue is up.',
    nextStatus: 'active',
    nextRunAt: null,
    finishedAt: new Date('2026-01-01T00:03:00.000Z'),
  })
  assert.equal(completed?.status, 'completed')
  const detail = store.getWorkflow('tenant-1', 'user-1', 'workflow-1')
  assert.equal(detail?.status, 'active')
  assert.equal(detail?.latestRunStatus, 'completed')
  assert.equal(detail?.latestRunSummary, 'Revenue is up.')
  assert.equal(store.listWorkflowRuns('tenant-1', 'workflow-1')[0]?.id, 'run-1')
})

test('cloud control plane fences workflow finalization by active worker lease', () => {
  const store = seededStore()
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-fenced-finalize',
    draft: {
      title: 'Fenced workflow',
      instructions: 'Finalize once.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-fenced-finalize',
    runId: 'run-fenced-finalize',
    triggerType: 'manual',
  })
  store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-fenced-finalize',
    runId: 'run-fenced-finalize',
    sessionId: 'session-1',
  })
  const staleLease = store.claimSessionLease(
    'tenant-1',
    'session-1',
    'worker-stale',
    new Date('2030-01-01T09:00:00.000Z'),
    1,
  )
  assert.ok(staleLease)
  const currentLease = store.claimSessionLease(
    'tenant-1',
    'session-1',
    'worker-current',
    new Date('2030-01-01T09:00:00.002Z'),
    30_000,
  )
  assert.ok(currentLease)

  assert.throws(() => store.completeWorkflowRun({
    tenantId: 'tenant-1',
    workflowId: 'workflow-fenced-finalize',
    runId: 'run-fenced-finalize',
    summary: 'stale result',
    nextStatus: 'active',
    nextRunAt: null,
    leaseToken: staleLease.leaseToken,
  }), /stale/)
  assert.equal(store.getWorkflowRun('tenant-1', 'run-fenced-finalize')?.status, 'running')

  const completed = store.completeWorkflowRun({
    tenantId: 'tenant-1',
    workflowId: 'workflow-fenced-finalize',
    runId: 'run-fenced-finalize',
    summary: 'current result',
    nextStatus: 'active',
    nextRunAt: null,
    leaseToken: currentLease.leaseToken,
  })
  assert.equal(completed?.status, 'completed')
  assert.equal(completed?.summary, 'current result')
})

test('cloud control plane atomically claims a due scheduled workflow run once', () => {
  const store = seededStore()
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-1',
    draft: {
      title: 'Scheduled revenue',
      instructions: 'Run on schedule.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{
        id: 'schedule-1',
        type: 'schedule',
        enabled: true,
        schedule: {
          type: 'daily',
          timezone: 'UTC',
          runAtHour: 9,
          runAtMinute: 0,
        },
      }],
    },
    nextRunAt: '2026-01-01T09:00:00.000Z',
  })

  const first = store.claimDueWorkflowRun({
    runId: 'run-1',
    now: new Date('2026-01-01T09:00:00.000Z'),
  })
  assert.equal(first?.run.triggerType, 'schedule')
  assert.equal(first?.workflow.status, 'running')
  assert.deepEqual(first?.run.triggerPayload, {
    source: 'schedule',
    scheduledFor: '2026-01-01T09:00:00.000Z',
  })

  const second = store.claimDueWorkflowRun({
    runId: 'run-2',
    now: new Date('2026-01-01T09:00:00.000Z'),
  })
  assert.equal(second, null)
})

test('cloud control plane reaps and retries expired scheduled workflow claims', () => {
  const store = seededStore()
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-retry',
    draft: {
      title: 'Retry workflow',
      instructions: 'Run retry work.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{
        id: 'schedule-1',
        type: 'schedule',
        enabled: true,
        schedule: {
          type: 'daily',
          timezone: 'UTC',
          runAtHour: 9,
          runAtMinute: 0,
        },
      }],
    },
    nextRunAt: '2030-01-01T09:00:00.000Z',
  })

  const first = store.claimDueWorkflowRun({
    runId: 'workflow-run-retry',
    claimedBy: 'scheduler-a',
    leaseTtlMs: 1,
    now: new Date('2030-01-01T09:00:00.000Z'),
  })
  assert.ok(first?.run.claimToken)
  const firstToken = first.run.claimToken

  const retried = store.reapExpiredWorkflowClaims({
    maxAttempts: 2,
    now: new Date('2030-01-01T09:00:00.002Z'),
  })
  assert.equal(retried.length, 1)
  assert.equal(retried[0]?.action, 'retried')

  const second = store.claimDueWorkflowRun({
    runId: 'unused-new-run',
    claimedBy: 'scheduler-b',
    leaseTtlMs: 1,
    now: new Date('2030-01-01T09:00:00.003Z'),
  })
  assert.equal(second?.run.id, 'workflow-run-retry')
  assert.equal(second?.run.attemptCount, 2)
  assert.notEqual(second?.run.claimToken, firstToken)
  assert.throws(() => store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-retry',
    runId: 'workflow-run-retry',
    sessionId: 'session-1',
    claimToken: firstToken,
  }), /stale/)

  const failed = store.reapExpiredWorkflowClaims({
    maxAttempts: 2,
    now: new Date('2030-01-01T09:00:00.005Z'),
  })
  assert.equal(failed.length, 1)
  assert.equal(failed[0]?.action, 'failed')
  assert.equal(store.getWorkflowForTenant('tenant-1', 'workflow-retry')?.status, 'failed')
  assert.equal(store.getWorkflowRun('tenant-1', 'workflow-run-retry')?.status, 'failed')
})

test('cloud control plane limits expired workflow claim reaping to oldest claims', () => {
  const store = seededStore()
  for (const index of [1, 2, 3]) {
    const workflowId = `workflow-claim-limit-${index}`
    createManualWorkflow(store, workflowId)
    const run = store.createWorkflowRun({
      tenantId: 'tenant-1',
      userId: 'user-1',
      workflowId,
      runId: `workflow-run-claim-limit-${index}`,
      triggerType: 'manual',
      claimedBy: `scheduler-${index}`,
      leaseTtlMs: 1,
      createdAt: new Date(`2030-01-01T09:00:0${index}.000Z`),
    })
    assert.ok(run.claimToken)
  }

  const first = store.reapExpiredWorkflowClaims({
    limit: 2,
    now: new Date('2030-01-01T09:00:10.000Z'),
  })
  assert.deepEqual(first.map((record) => record.runId), [
    'workflow-run-claim-limit-1',
    'workflow-run-claim-limit-2',
  ])
  assert.notEqual(store.getWorkflowRun('tenant-1', 'workflow-run-claim-limit-3')?.claimToken, null)

  const second = store.reapExpiredWorkflowClaims({
    limit: 2,
    now: new Date('2030-01-01T09:00:10.000Z'),
  })
  assert.deepEqual(second.map((record) => record.runId), ['workflow-run-claim-limit-3'])
})

test('cloud control plane recovers expired webhook workflow start claims', () => {
  const store = seededStore()
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-webhook-retry',
    draft: {
      title: 'Webhook workflow',
      instructions: 'Run from webhook.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{
        id: 'webhook-1',
        type: 'webhook',
        enabled: true,
        webhookSecret: 'secret',
      }],
    },
  })

  const first = store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-webhook-retry',
    runId: 'webhook-run-retry',
    triggerType: 'webhook',
    triggerPayload: { source: 'test' },
    claimedBy: 'workflow-webhook:workflow-webhook-retry',
    leaseTtlMs: 1,
    createdAt: new Date('2030-01-01T09:00:00.000Z'),
  })
  assert.equal(first.triggerType, 'webhook')
  assert.ok(first.claimToken)

  const retried = store.reapExpiredWorkflowClaims({
    maxAttempts: 2,
    now: new Date('2030-01-01T09:00:00.002Z'),
  })
  assert.equal(retried.length, 1)
  assert.equal(retried[0]?.action, 'retried')

  const second = store.claimDueWorkflowRun({
    runId: 'unused-webhook-run',
    claimedBy: 'scheduler-recovery',
    now: new Date('2030-01-01T09:00:00.003Z'),
  })
  assert.equal(second?.run.id, 'webhook-run-retry')
  assert.equal(second?.run.triggerType, 'webhook')
  assert.equal(second?.run.attemptCount, 2)
  assert.notEqual(second?.run.claimToken, first.claimToken)
})

test('cloud control plane rejects stale workflow attaches after expired claims are cleared', () => {
  const store = seededStore()
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-stale-attach',
    draft: {
      title: 'Stale attach workflow',
      instructions: 'Do not attach stale starters.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  const first = store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-stale-attach',
    runId: 'stale-attach-run',
    triggerType: 'manual',
    claimedBy: 'workflow-api:user-1',
    leaseTtlMs: 1,
    createdAt: new Date('2030-01-01T09:00:00.000Z'),
  })
  assert.ok(first.claimToken)
  assert.equal(store.reapExpiredWorkflowClaims({
    maxAttempts: 2,
    now: new Date('2030-01-01T09:00:00.002Z'),
  })[0]?.action, 'retried')
  assert.equal(store.getWorkflowRun('tenant-1', 'stale-attach-run')?.claimToken, null)
  assert.throws(() => store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-stale-attach',
    runId: 'stale-attach-run',
    sessionId: 'session-1',
    claimToken: first.claimToken,
  }), /stale/)

  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-terminal-stale-attach',
    draft: {
      title: 'Terminal stale attach workflow',
      instructions: 'Do not attach failed runs.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })
  const terminal = store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-terminal-stale-attach',
    runId: 'terminal-stale-attach-run',
    triggerType: 'manual',
    claimedBy: 'workflow-api:user-1',
    leaseTtlMs: 1,
    createdAt: new Date('2030-01-01T09:00:00.000Z'),
  })
  assert.ok(terminal.claimToken)
  assert.equal(store.reapExpiredWorkflowClaims({
    maxAttempts: 1,
    now: new Date('2030-01-01T09:00:00.002Z'),
  }).find((record) => record.runId === 'terminal-stale-attach-run')?.action, 'failed')
  assert.equal(store.getWorkflowRun('tenant-1', 'terminal-stale-attach-run')?.status, 'failed')
  assert.throws(() => store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-terminal-stale-attach',
    runId: 'terminal-stale-attach-run',
    sessionId: 'session-1',
    claimToken: terminal.claimToken,
  }), /not attachable/)
  assert.throws(() => store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-terminal-stale-attach',
    runId: 'terminal-stale-attach-run',
    sessionId: 'session-1',
  }), /not attachable/)
})

test('cloud control plane recovers workflow starts stranded after session attachment', () => {
  const store = seededStore()
  store.createWorkflow({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-attached-retry',
    draft: {
      title: 'Attached retry workflow',
      instructions: 'Recover command enqueue.',
      agentName: 'data-analyst',
      skillNames: [],
      toolIds: [],
      projectDirectory: null,
      draftSessionId: null,
      triggers: [{ id: 'manual-1', type: 'manual', enabled: true }],
    },
  })

  const first = store.createWorkflowRun({
    tenantId: 'tenant-1',
    userId: 'user-1',
    workflowId: 'workflow-attached-retry',
    runId: 'attached-run-retry',
    triggerType: 'manual',
    triggerPayload: { source: 'test' },
    claimedBy: 'workflow-api:user-1',
    leaseTtlMs: 30_000,
    createdAt: new Date('2030-01-01T09:00:00.000Z'),
  })
  assert.ok(first.claimToken)

  store.attachWorkflowRunSession({
    tenantId: 'tenant-1',
    workflowId: 'workflow-attached-retry',
    runId: 'attached-run-retry',
    sessionId: 'session-1',
    claimToken: first.claimToken,
    startedAt: new Date('2030-01-01T09:00:00.001Z'),
  })
  assert.equal(store.getWorkflowRun('tenant-1', 'attached-run-retry')?.claimToken, null)

  const claimed = store.claimDueWorkflowRun({
    runId: 'unused-attached-run',
    claimedBy: 'scheduler-recovery',
    leaseTtlMs: 1,
    now: new Date('2030-01-01T09:00:00.002Z'),
  })
  assert.equal(claimed?.run.id, 'attached-run-retry')
  assert.equal(claimed?.run.status, 'running')
  assert.equal(claimed?.run.sessionId, 'session-1')
  assert.equal(claimed?.run.attemptCount, 2)
  assert.ok(claimed?.run.claimToken)

  const retried = store.reapExpiredWorkflowClaims({
    maxAttempts: 3,
    now: new Date('2030-01-01T09:00:00.004Z'),
  })
  assert.equal(retried.length, 1)
  assert.equal(retried[0]?.action, 'retried')
  assert.equal(store.getWorkflowRun('tenant-1', 'attached-run-retry')?.claimToken, null)
  assert.equal(store.getWorkflowForTenant('tenant-1', 'workflow-attached-retry')?.latestRunStatus, 'running')
})

test('getMaxProjectionLag only counts sessions active within the last hour (#911)', () => {
  const store = new InMemoryControlPlaneStore()
  store.createTenant({ tenantId: 'tenant-1', name: 'Acme' })
  store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'a@example.com', role: 'owner' })
  const recentAt = new Date()
  const oldAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
  store.createSession({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'recent', opencodeSessionId: 'oc-recent', profileName: 'default', createdAt: recentAt })
  store.createSession({ tenantId: 'tenant-1', userId: 'user-1', sessionId: 'old', opencodeSessionId: 'oc-old', profileName: 'default', createdAt: oldAt })
  // Advance events (creating projection lag) on both sessions without projecting them. Appending
  // an event stamps the session's updated_at with the event time, so the old session's events are
  // dated three hours ago (its projection never caught up) while the recent session is live.
  for (let index = 0; index < 5; index += 1) store.appendSessionEvent({ tenantId: 'tenant-1', sessionId: 'recent', type: 'x', payload: {} })
  for (let index = 0; index < 9; index += 1) store.appendSessionEvent({ tenantId: 'tenant-1', sessionId: 'old', type: 'x', payload: {}, createdAt: oldAt })

  // The old session's larger lag (8) is excluded by the one-hour window; only the recent lag (4) counts.
  assert.equal(store.getMaxProjectionLag(), 4)
})
