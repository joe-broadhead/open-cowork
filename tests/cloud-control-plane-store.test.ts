import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryControlPlaneStore } from '../apps/desktop/src/main/cloud/control-plane-store.ts'

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

test('cloud control plane keeps tenant/user/session state isolated', () => {
  const store = seededStore()
  assert.equal(store.getSession('tenant-1', 'user-1', 'session-1')?.opencodeSessionId, 'oc-session-1')
  assert.throws(() => store.getSession('tenant-1', 'user-2', 'session-1'), /does not belong/)
  assert.throws(() => store.listSessions('tenant-2', 'user-1'), /Unknown tenant/)
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
  assert.deepEqual(store.listWorkspaceEvents('tenant-1', 'user-2', 0), [])
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
    new Date('2026-01-01T00:00:00.000Z'),
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
    new Date('2026-01-01T00:00:02.000Z'),
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
  assert.equal(store.findApiTokenByPlaintext(issued.plaintext)?.tokenId, issued.token.tokenId)

  const revoked = store.revokeApiToken({
    tokenId: issued.token.tokenId,
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
