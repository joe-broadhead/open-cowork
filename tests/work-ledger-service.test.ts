import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  AutomationListPayload,
  ChannelListPayload,
  CrewListPayload,
  ThreadListItem,
} from '@open-cowork/shared'
import {
  buildWorkLedgerEntriesFromSnapshot,
  type WorkLedgerSnapshot,
  WorkLedgerService,
} from '../apps/desktop/src/main/work-ledger-service.ts'
import { WorkLedgerStore } from '../apps/desktop/src/main/work-ledger-store.ts'

function thread(overrides: Partial<ThreadListItem> = {}): ThreadListItem {
  return {
    sessionId: overrides.sessionId || 'session-1',
    title: overrides.title || 'Revenue thread',
    directory: overrides.directory ?? '/workspace/revenue',
    projectLabel: overrides.projectLabel ?? 'revenue',
    providerId: overrides.providerId ?? 'openrouter',
    modelId: overrides.modelId ?? 'openrouter/sonnet',
    status: overrides.status || 'idle',
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-02T00:00:00.000Z',
    parentSessionId: overrides.parentSessionId ?? null,
    automationId: overrides.automationId ?? null,
    runId: overrides.runId ?? null,
    revertedMessageId: overrides.revertedMessageId ?? null,
    tags: overrides.tags || [],
    actualAgents: overrides.actualAgents || [{ name: 'research', count: 1 }],
    actualTools: overrides.actualTools || [{ name: 'charts.create', mcpName: 'charts', count: 1 }],
    suggestions: overrides.suggestions || [],
    usage: overrides.usage || {
      messages: 3,
      toolCalls: 1,
      taskRuns: 1,
      cost: 0.2,
      tokens: { input: 1, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    },
    changeSummary: overrides.changeSummary ?? null,
  }
}

function automationState(): AutomationListPayload {
  return {
    automations: [{
      id: 'automation-1',
      title: 'Weekly report automation',
      goal: 'Produce the weekly report.',
      kind: 'recurring',
      status: 'needs_user',
      schedule: { type: 'weekly', timezone: 'UTC', dayOfWeek: 1, runAtHour: 9, runAtMinute: 0 },
      heartbeatMinutes: 60,
      retryPolicy: { maxRetries: 2, baseDelayMinutes: 5, maxDelayMinutes: 60 },
      runPolicy: { dailyRunCap: 2, maxRunDurationMinutes: 30 },
      executionMode: 'scoped_execution',
      autonomyPolicy: 'review-first',
      projectDirectory: '/workspace/revenue',
      preferredAgentNames: ['analyst'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      nextRunAt: null,
      lastRunAt: '2026-01-02T00:00:00.000Z',
      nextHeartbeatAt: null,
      lastHeartbeatAt: null,
      latestRunStatus: 'needs_user',
      latestRunId: 'run-1',
    }],
    inbox: [{
      id: 'inbox-approval',
      automationId: 'automation-1',
      runId: 'run-1',
      sessionId: 'session-1',
      questionId: null,
      type: 'approval',
      status: 'open',
      title: 'Approve delivery',
      body: 'Do not duplicate password=hunter2',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }, {
      id: 'inbox-question',
      automationId: 'automation-1',
      runId: 'run-1',
      sessionId: 'session-1',
      questionId: 'question-1',
      type: 'clarification',
      status: 'open',
      title: 'Need region',
      body: 'Which region?',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }],
    workItems: [{
      id: 'work-1',
      automationId: 'automation-1',
      runId: 'run-1',
      title: 'Draft charts',
      description: 'Create chart pack.',
      status: 'blocked',
      blockingReason: 'Approval required.',
      ownerAgent: 'analyst',
      dependsOn: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    }],
    runs: [{
      id: 'run-1',
      automationId: 'automation-1',
      sessionId: 'session-1',
      kind: 'execution',
      status: 'needs_user',
      title: 'Weekly report run',
      summary: 'Waiting for approval.',
      error: null,
      failureCode: null,
      attempt: 1,
      retryOfRunId: null,
      nextRetryAt: null,
      createdAt: '2026-01-02T00:00:00.000Z',
      startedAt: '2026-01-02T00:01:00.000Z',
      finishedAt: null,
    }],
    deliveries: [{
      id: 'delivery-1',
      automationId: 'automation-1',
      runId: 'run-1',
      provider: 'in_app',
      target: 'local',
      status: 'delivered',
      title: 'Weekly report delivered',
      body: 'Body is not indexed.',
      createdAt: '2026-01-04T00:00:00.000Z',
    }],
  }
}

function crewCatalog(): CrewListPayload {
  return {
    crews: [{
      definition: {
        schemaVersion: 1,
        id: 'crew-1',
        name: 'Research crew',
        description: 'Coordinates research specialists.',
        status: 'active',
        activeVersionId: 'crew-version-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      activeVersion: {
        schemaVersion: 1,
        id: 'crew-version-1',
        crewId: 'crew-1',
        version: 1,
        members: [{
          schemaVersion: 1,
          id: 'lead-research-1',
          role: 'lead',
          agentName: 'research',
          displayName: 'Research',
          description: 'Lead',
          required: true,
        }],
        workspaceProfileId: 'project-workspace',
        outcomeRubricId: null,
        evalSuiteId: null,
        certificationStatus: 'not_required',
        certifiedAt: null,
        budgetCapUsd: null,
        approvalPolicy: 'review-before-delivery',
        workflow: ['plan', 'delegate', 'join', 'evaluate', 'deliver'],
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'local-user',
      },
      latestRun: {
        schemaVersion: 1,
        id: 'crew-run-1',
        crewId: 'crew-1',
        crewVersionId: 'crew-version-1',
        workItemId: 'cowork-work-1',
        status: 'running',
        title: 'Market scan',
        summary: null,
        rootSessionId: 'session-crew',
        createdAt: '2026-01-04T00:00:00.000Z',
        startedAt: '2026-01-04T00:01:00.000Z',
        finishedAt: null,
      },
    }],
  }
}

function channels(): ChannelListPayload {
  return {
    channels: [{
      schemaVersion: 1,
      id: 'channel-1',
      provider: 'local_webhook',
      name: 'Support webhook',
      description: null,
      sourceKey: 'support',
      enabled: true,
      senderAllowlist: ['support@example.com'],
      allowedCapabilityIds: ['support.reply'],
      route: { schemaVersion: 1, activationMode: 'ask_user', targetSopId: null, targetCrewId: null },
      workspaceProfileId: 'channel-sandbox',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    inboundItems: [{
      schemaVersion: 1,
      id: 'inbound-1',
      channelId: 'channel-1',
      provider: 'local_webhook',
      source: { schemaVersion: 1, provider: 'local_webhook', sourceKey: 'support', externalMessageId: 'ext-1', replyTarget: null },
      sender: 'support@example.com',
      subject: 'Customer escalation',
      body: 'Do not index token=abc123secret',
      route: { schemaVersion: 1, activationMode: 'ask_user', targetSopId: null, targetCrewId: null },
      status: 'needs_user',
      auditState: 'user_review_required',
      allowedCapabilityIds: ['support.reply'],
      workspaceProfileId: 'channel-sandbox',
      queueItemId: null,
      deliveryRecordId: null,
      workItemId: null,
      runKind: null,
      runId: null,
      runStatus: null,
      approvedAt: null,
      approvedBy: null,
      reviewNote: null,
      receivedAt: '2026-01-05T00:00:00.000Z',
      updatedAt: '2026-01-05T00:00:00.000Z',
      error: null,
    }],
    deliveries: [],
  }
}

function snapshot(): WorkLedgerSnapshot {
  return {
    threads: [thread()],
    automations: automationState(),
    crews: {
      catalog: crewCatalog(),
      runs: [{
        schemaVersion: 1,
        id: 'crew-run-1',
        crewId: 'crew-1',
        crewVersionId: 'crew-version-1',
        workItemId: 'cowork-work-1',
        status: 'running',
        title: 'Market scan',
        summary: null,
        rootSessionId: 'session-crew',
        createdAt: '2026-01-04T00:00:00.000Z',
        startedAt: '2026-01-04T00:01:00.000Z',
        finishedAt: null,
      }],
      nodes: [{
        schemaVersion: 1,
        id: 'node-1',
        crewRunId: 'crew-run-1',
        sequence: 1,
        kind: 'delegate',
        status: 'running',
        agentName: 'research',
        sessionId: 'session-node',
        parentNodeId: null,
        title: 'Search market',
        startedAt: '2026-01-04T00:02:00.000Z',
        finishedAt: null,
      }],
      workItems: [{
        schemaVersion: 1,
        id: 'cowork-work-1',
        title: 'Market scan',
        description: 'Scan the market.',
        source: 'manual',
        status: 'running',
        createdAt: '2026-01-04T00:00:00.000Z',
        updatedAt: '2026-01-04T00:01:00.000Z',
      }],
      approvals: [{
        schemaVersion: 1,
        id: 'crew-approval-1',
        crewRunId: 'crew-run-1',
        nodeId: 'node-1',
        status: 'requested',
        title: 'Approve external write',
        body: 'Do not index secret=crewsecret',
        requestedAt: '2026-01-04T00:03:00.000Z',
        resolvedAt: null,
        resolvedBy: null,
      }],
      policyDecisions: [{
        schemaVersion: 1,
        id: 'policy-1',
        runId: 'crew-run-1',
        runKind: 'crew',
        nodeId: 'node-1',
        status: 'approval_required',
        reason: 'External write requires approval.',
        capabilityId: 'github.write',
        createdAt: '2026-01-04T00:04:00.000Z',
      }],
      artifacts: [{
        schemaVersion: 1,
        id: 'artifact-1',
        crewRunId: 'crew-run-1',
        nodeId: 'node-1',
        title: 'Market scan memo',
        mime: 'text/markdown',
        uri: 'private://artifact',
        hash: null,
        createdAt: '2026-01-04T00:05:00.000Z',
      }],
    },
    channels: channels(),
    governanceAuditEvents: [{
      schemaVersion: 1,
      id: 'audit-1',
      kind: 'incident_control',
      subjectKind: 'tool',
      subjectId: 'github.write',
      action: 'revoke_tool',
      outcome: 'succeeded',
      actor: { kind: 'user', id: 'local-user', displayName: 'Local user' },
      reason: 'Reduce blast radius.',
      beforeLifecycle: null,
      afterLifecycle: 'revoked',
      metadata: { secret: 'metadata is not indexed' },
      createdAt: '2026-01-06T00:00:00.000Z',
    }],
  }
}

function withService(name: string, run: (service: WorkLedgerService, store: WorkLedgerStore) => void) {
  const root = mkdtempSync(join(tmpdir(), `open-cowork-work-ledger-service-${name}-`))
  const store = new WorkLedgerStore(join(root, 'work-ledger.sqlite'))
  const service = new WorkLedgerService(store, { loadSnapshot: snapshot })
  try {
    run(service, store)
  } finally {
    store.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('work ledger snapshot builder indexes every durable work source without payload bodies', () => {
  const entries = buildWorkLedgerEntriesFromSnapshot(snapshot())
  const kinds = new Set(entries.map((entry) => entry.sourceKind))
  for (const kind of ['thread', 'automation', 'automation_run', 'delegated_task', 'approval', 'question', 'crew', 'crew_run', 'delivery', 'channel_event', 'governance_incident']) {
    assert.equal(kinds.has(kind as never), true, `${kind} should be indexed`)
  }
  const serialized = JSON.stringify(entries)
  assert.equal(serialized.includes('hunter2'), false)
  assert.equal(serialized.includes('abc123secret'), false)
  assert.equal(serialized.includes('crewsecret'), false)
  assert.equal(serialized.includes('metadata is not indexed'), false)
})

test('work ledger service backfills, searches, filters, and replaces stale entries', () => withService('query', (service, store) => {
  assert.equal(service.reindex(), true)

  const attention = service.search({ needsUserAttention: true, limit: 50 })
  assert.ok(attention.entries.some((entry) => entry.sourceKind === 'approval' && entry.reviewState === 'approval_requested'))
  assert.ok(attention.entries.some((entry) => entry.sourceKind === 'channel_event'))

  const github = service.search({ capabilities: ['github.write'] })
  assert.equal(github.entries.some((entry) => entry.sourceId === 'policy_decision:policy-1'), true)

  const facets = service.facets({})
  assert.ok(facets.sourceKinds.some((bucket) => bucket.value === 'automation_run'))
  assert.ok(facets.agents.some((bucket) => bucket.value === 'research'))

  store.upsertEntry({
    ...attention.entries[0]!,
    id: 'thread:stale',
    sourceKind: 'thread',
    sourceId: 'stale',
    title: 'Stale',
    sourceRef: { kind: 'thread', id: 'stale', sessionId: 'stale' },
    route: { surface: 'thread', sessionId: 'stale' },
  })
  assert.equal(store.searchEntries({ text: 'stale' }).entries.length, 1)
  service.reindex()
  assert.equal(store.searchEntries({ text: 'stale' }).entries.length, 0)
}))
