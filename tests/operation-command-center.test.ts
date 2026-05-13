import test from 'node:test'
import assert from 'node:assert/strict'
import type { OperationalQueueItem, WorkLedgerEntry } from '@open-cowork/shared'
import {
  buildOperationsSummary,
  operationsQueueStatusForEntry,
} from '../apps/desktop/src/main/operation-command-center.ts'

function ledgerEntry(overrides: Partial<WorkLedgerEntry> = {}): WorkLedgerEntry {
  const sourceKind = overrides.sourceKind || 'thread'
  const sourceId = overrides.sourceId || 'session-1'
  return {
    schemaVersion: 1,
    id: overrides.id || `${sourceKind}:${sourceId}`,
    sourceKind,
    sourceId,
    title: overrides.title || 'Revenue thread',
    summary: overrides.summary ?? null,
    status: overrides.status || 'running',
    sourceLabel: overrides.sourceLabel || 'Revenue workspace',
    owner: overrides.owner ?? 'finance',
    agents: overrides.agents || ['analyst'],
    capabilities: overrides.capabilities || ['charts.create'],
    usage: overrides.usage || {
      cost: 0.1,
      tokens: { input: 10, output: 20, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
    },
    riskLabels: overrides.riskLabels || [],
    governanceLabels: overrides.governanceLabels || [],
    reviewState: overrides.reviewState || 'none',
    needsUserAttention: overrides.needsUserAttention ?? false,
    sourceRef: overrides.sourceRef || { kind: sourceKind, id: sourceId, sessionId: sourceId },
    route: overrides.route || { surface: 'thread', sessionId: sourceId },
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-02T00:00:00.000Z',
    startedAt: overrides.startedAt ?? null,
    finishedAt: overrides.finishedAt ?? null,
    indexedAt: overrides.indexedAt || '2026-01-02T00:00:00.000Z',
  }
}

function queueItem(overrides: Partial<OperationalQueueItem> = {}): OperationalQueueItem {
  return {
    schemaVersion: 1,
    id: overrides.id || 'queue-1',
    runKind: overrides.runKind || 'automation',
    runId: overrides.runId || 'run-1',
    title: overrides.title || 'Automation run',
    status: overrides.status || 'running',
    requestedAutonomy: overrides.requestedAutonomy || 'approve',
    effectiveAutonomy: overrides.effectiveAutonomy || 'approve',
    workspaceProfileId: overrides.workspaceProfileId || 'project',
    authority: overrides.authority || {
      schemaVersion: 1,
      filesystem: { mode: 'project', roots: ['/workspace'], writeAllowed: true },
      externalSystems: [],
      cleanup: { retentionDays: 30, deletesUnreferencedArtifacts: false },
      isolation: { projectBound: true, channelBound: false, highRiskIsolated: false },
    },
    queueKeys: overrides.queueKeys || ['automation:run-1'],
    caps: overrides.caps || { schemaVersion: 1, maxParallel: 1, maxRunDurationMinutes: 60, maxCostUsd: 10, maxRetries: 2 },
    costUsd: overrides.costUsd ?? 1.5,
    attempt: overrides.attempt || 1,
    createdAt: overrides.createdAt || '2026-01-01T00:00:00.000Z',
    updatedAt: overrides.updatedAt || '2026-01-03T00:00:00.000Z',
    startedAt: overrides.startedAt ?? '2026-01-03T00:00:00.000Z',
    finishedAt: overrides.finishedAt ?? null,
    error: overrides.error ?? null,
  }
}

test('operations command center normalizes ledger entries into queue lanes and safe actions', () => {
  const automationRun = ledgerEntry({
    id: 'automation_run:run-1',
    sourceKind: 'automation_run',
    sourceId: 'run-1',
    title: 'Weekly automation run',
    status: 'running',
    sourceRef: { kind: 'automation_run', id: 'run-1', automationId: 'automation-1', automationRunId: 'run-1', sessionId: 'session-1' },
    route: { surface: 'automations', automationId: 'automation-1', automationRunId: 'run-1', sessionId: 'session-1' },
  })
  const approval = ledgerEntry({
    id: 'approval:approval-1',
    sourceKind: 'approval',
    sourceId: 'automation_inbox:approval-1',
    title: 'Approve delivery',
    status: 'approval_required',
    reviewState: 'approval_requested',
    needsUserAttention: true,
    updatedAt: '2026-01-04T00:00:00.000Z',
    sourceRef: { kind: 'approval', id: 'approval-1', automationId: 'automation-1', approvalId: 'approval-1' },
    route: { surface: 'automations', automationId: 'automation-1' },
  })
  const delivered = ledgerEntry({
    id: 'delivery:delivery-1',
    sourceKind: 'delivery',
    sourceId: 'delivery-1',
    title: 'Published report',
    status: 'delivered',
    finishedAt: '2026-01-05T00:00:00.000Z',
  })

  const summary = buildOperationsSummary({
    ledgerEntries: [delivered, automationRun, approval],
    queueItems: [queueItem()],
    queueAlerts: [{
      schemaVersion: 1,
      queueItemId: 'queue-1',
      severity: 'warning',
      kind: 'stuck_run',
      message: 'Run has been active longer than expected.',
      createdAt: '2026-01-03T00:30:00.000Z',
    }],
    capabilityRisks: [{
      schemaVersion: 1,
      capabilityId: 'github.write',
      toolPattern: 'github:*',
      risk: 'high',
      writeCapable: true,
      approvalRequired: true,
      reason: 'Write-capable GitHub operation.',
    }],
    generatedAt: '2026-01-06T00:00:00.000Z',
  })

  assert.equal(summary.totalWorkItems, 3)
  assert.equal(summary.running, 1)
  assert.equal(summary.delivered, 1)
  assert.equal(summary.needsAttention, 1)
  assert.equal(summary.queue.find((lane) => lane.status === 'needs_review')?.count, 1)
  assert.equal(summary.items[0]!.id, 'approval:approval-1')
  assert.equal(summary.items[1]!.id, 'automation_run:run-1')
  assert.equal(summary.items[1]!.costUsd, 1.5)
  assert.equal(summary.items[1]!.tokenCount, 36)
  assert.equal(summary.items[1]!.actions.some((action) => action.kind === 'cancel_automation_run'), true)
  assert.equal(summary.healthSignals.some((signal) => signal.kind === 'capability_risk' && signal.severity === 'critical'), true)
  assert.equal(summary.healthSignals.some((signal) => signal.kind === 'stuck_run'), true)
})

test('operations queue status prioritizes operational queue blockers over passive ledger state', () => {
  const entry = ledgerEntry({
    sourceKind: 'automation_run',
    status: 'running',
    sourceRef: { kind: 'automation_run', id: 'run-1', automationId: 'automation-1', automationRunId: 'run-1' },
    route: { surface: 'automations', automationId: 'automation-1', automationRunId: 'run-1' },
  })
  assert.equal(operationsQueueStatusForEntry(entry, queueItem({ status: 'blocked' })), 'blocked')
  assert.equal(operationsQueueStatusForEntry(entry, queueItem({ status: 'failed' })), 'failed')
  assert.equal(operationsQueueStatusForEntry(entry), 'running')
})

test('operations command center preserves zero-cost queue projections', () => {
  const summary = buildOperationsSummary({
    ledgerEntries: [ledgerEntry({
      sourceKind: 'automation_run',
      sourceRef: { kind: 'automation_run', id: 'run-1', automationId: 'automation-1', automationRunId: 'run-1' },
      route: { surface: 'automations', automationId: 'automation-1', automationRunId: 'run-1' },
      usage: {
        cost: 42,
        tokens: { input: 10, output: 20, reasoning: 1, cacheRead: 2, cacheWrite: 3 },
      },
    })],
    queueItems: [queueItem({ costUsd: 0 })],
  })

  assert.equal(summary.items[0]?.costUsd, 0)
})

test('operations command center omits open-source actions for unsupported routes', () => {
  const summary = buildOperationsSummary({
    ledgerEntries: [
      ledgerEntry({
        id: 'channel_event:event-1',
        sourceKind: 'channel_event',
        sourceId: 'event-1',
        status: 'needs_user',
        sourceRef: { kind: 'channel_event', id: 'event-1', channelEventId: 'event-1' },
        route: { surface: 'channels', channelId: 'channel-1' },
      }),
      ledgerEntry({
        id: 'governance_incident:event-2',
        sourceKind: 'governance_incident',
        sourceId: 'event-2',
        status: 'denied',
        sourceRef: { kind: 'governance_incident', id: 'event-2', governanceAuditEventId: 'event-2' },
        route: { surface: 'operations', governanceAuditEventId: 'event-2' },
      }),
      ledgerEntry({
        id: 'thread:session-1',
        sourceKind: 'thread',
        sourceId: 'session-1',
        status: 'running',
        sourceRef: { kind: 'thread', id: 'session-1', sessionId: 'session-1' },
        route: { surface: 'thread', sessionId: 'session-1' },
      }),
    ],
  })

  const channel = summary.items.find((item) => item.id === 'channel_event:event-1')
  const governance = summary.items.find((item) => item.id === 'governance_incident:event-2')
  const thread = summary.items.find((item) => item.id === 'thread:session-1')
  assert.equal(channel?.actions.some((action) => action.kind === 'open_source'), false)
  assert.equal(governance?.actions.some((action) => action.kind === 'open_source'), false)
  assert.equal(thread?.actions.some((action) => action.kind === 'open_source'), true)
})
