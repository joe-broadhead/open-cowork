import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearAutomationStoreCache, createDeliveryRecord } from '../apps/desktop/src/main/automation-store.ts'
import { clearChannelStoreCache, createChannelDefinition, createChannelDeliveryRecord } from '../apps/desktop/src/main/channel-store.ts'
import { clearConfigCaches } from '../apps/desktop/src/main/config-loader.ts'
import {
  appendCoworkTraceEvent,
  clearCrewStoreCache,
  createCrewApproval,
  createCrewDefinition,
  createCrewRun,
  createCrewRunNode,
  createCrewVersion,
  createOutcomeRubric,
  recordOutcomeEvaluation,
  recordPolicyDecision,
} from '../apps/desktop/src/main/crew-store.ts'
import { exportGovernanceAuditEvents } from '../apps/desktop/src/main/governance-audit-export.ts'
import { clearGovernanceAuditStoreCache, recordGovernanceAuditEvent } from '../apps/desktop/src/main/governance-audit-store.ts'
import { createCoworkTraceEvent } from '../packages/shared/src/crews.ts'

function uniqueUserDataDir(name: string) {
  return join(tmpdir(), `open-cowork-governance-export-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
}

function withAuditExportStores(name: string, fn: () => void) {
  const previousUserDataDir = process.env.OPEN_COWORK_USER_DATA_DIR
  const userDataDir = uniqueUserDataDir(name)
  try {
    process.env.OPEN_COWORK_USER_DATA_DIR = userDataDir
    clearConfigCaches()
    clearGovernanceAuditStoreCache()
    clearCrewStoreCache()
    clearChannelStoreCache()
    clearAutomationStoreCache()
    fn()
  } finally {
    clearGovernanceAuditStoreCache()
    clearCrewStoreCache()
    clearChannelStoreCache()
    clearAutomationStoreCache()
    clearConfigCaches()
    if (previousUserDataDir === undefined) delete process.env.OPEN_COWORK_USER_DATA_DIR
    else process.env.OPEN_COWORK_USER_DATA_DIR = previousUserDataDir
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

test('governance audit export covers incidents, traces, approvals, policy, deliveries, and evals', () => withAuditExportStores('records', () => {
  const crew = createCrewDefinition({ name: 'Research Crew', description: 'Research team.' })!
  const version = createCrewVersion({
    crewId: crew.id,
    members: [{
      schemaVersion: 1,
      id: 'lead',
      role: 'lead',
      agentName: 'lead-agent',
      displayName: 'Lead',
      description: 'Plans the work.',
      required: true,
    }],
  })!
  const run = createCrewRun({
    crewId: crew.id,
    crewVersionId: version.id,
    title: 'Investigate a launch plan',
  })!
  const node = createCrewRunNode({
    crewRunId: run.id,
    kind: 'delegate',
    title: 'Analyze launch data',
    agentName: 'lead-agent',
  })!
  const trace = appendCoworkTraceEvent(createCoworkTraceEvent({
    id: 'trace-tool-call',
    sequence: 1,
    runId: run.id,
    runKind: 'crew',
    source: 'opencode_event',
    sourceEventId: 'evt-tool-call',
    correlationId: null,
    causationId: null,
    sessionId: 'session-root',
    parentSessionId: null,
    actor: { kind: 'agent', id: 'lead-agent' },
    nodeId: node.id,
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: null,
    outputHash: null,
    payloadRef: null,
    payloadHash: null,
    redactionState: 'none',
    tokenUsage: null,
    costUsd: null,
    payload: { type: 'crew_run.tool_call', toolName: 'charts.create_line_chart' },
    createdAt: new Date().toISOString(),
  }))
  const approval = createCrewApproval({
    crewRunId: run.id,
    nodeId: node.id,
    title: 'Approve delivery',
    body: 'Review before external delivery.',
  })!
  const policy = recordPolicyDecision({
    runId: run.id,
    runKind: 'crew',
    nodeId: node.id,
    status: 'approval_required',
    reason: 'External delivery requires approval.',
    capabilityId: 'delivery:external',
  })!
  const rubric = createOutcomeRubric({
    name: 'Research quality',
    description: 'Minimum bar.',
    criteria: [{
      schemaVersion: 1,
      id: 'evidence',
      label: 'Evidence',
      description: 'Uses evidence.',
      weight: 1,
      passingScore: 80,
    }],
    passingScore: 80,
  })!
  const evaluation = recordOutcomeEvaluation({
    crewRunId: run.id,
    evaluatorAgentName: 'eval-agent',
    rubricId: rubric.id,
    status: 'passed',
    score: 91,
    evidenceTraceEventIds: [trace.id],
    recommendation: 'deliver',
  })!
  const channel = createChannelDefinition({
    provider: 'teams',
    name: 'Launch Teams',
    sourceKey: 'launch-teams',
    senderAllowlist: ['ops@example.com'],
    route: { activationMode: 'ask_user' },
  })
  const channelDelivery = createChannelDeliveryRecord({
    channelId: channel.id,
    provider: 'teams',
    target: 'launch-channel',
    status: 'draft',
    title: 'Launch update',
    body: 'Draft update.',
    runKind: 'crew',
    runId: run.id,
    policyDecisionIds: [policy.id],
    approvalIds: [approval.id],
  })
  const automationDelivery = createDeliveryRecord({
    automationId: 'automation:daily-brief',
    runId: 'automation-run-1',
    provider: 'in_app',
    target: 'pulse',
    status: 'delivered',
    title: 'Daily brief',
    body: 'Ready.',
  })!
  const incident = recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: `crew:${encodeURIComponent(crew.id)}`,
    action: 'pause_crew',
    beforeLifecycle: 'active',
    afterLifecycle: 'paused',
    reason: 'Operator pause.',
  })

  const exported = exportGovernanceAuditEvents({ format: 'ndjson' })
  const rows = exported.body.split('\n').map((line) => JSON.parse(line) as {
    recordType: string
    id: string
    subjectId: string | null
    runId: string | null
    payload: Record<string, unknown>
  })
  const byType = new Map(rows.map((row) => [row.recordType, row]))

  assert.equal(exported.eventCount, 7)
  assert.deepEqual([...byType.keys()].sort(), [
    'automation_delivery',
    'channel_delivery',
    'crew_approval',
    'crew_trace',
    'governance_incident',
    'outcome_evaluation',
    'policy_decision',
  ])
  assert.equal(byType.get('crew_trace')?.id, trace.id)
  assert.equal(byType.get('crew_trace')?.payload.payload && (byType.get('crew_trace')?.payload.payload as Record<string, unknown>).type, 'crew_run.tool_call')
  assert.equal(byType.get('crew_approval')?.id, approval.id)
  assert.equal(byType.get('policy_decision')?.id, policy.id)
  assert.equal(byType.get('outcome_evaluation')?.id, evaluation.id)
  assert.equal(byType.get('channel_delivery')?.id, channelDelivery.id)
  assert.equal(byType.get('channel_delivery')?.subjectId, `crew:${encodeURIComponent(crew.id)}`)
  assert.equal(byType.get('automation_delivery')?.id, automationDelivery.id)
  assert.equal(byType.get('governance_incident')?.id, incident.id)

  const otel = exportGovernanceAuditEvents({ format: 'otel-json' })
  const otelBody = JSON.parse(otel.body) as {
    resourceLogs?: Array<{ scopeLogs?: Array<{ logRecords?: Array<{ body?: { stringValue?: string } }> }> }>
  }
  const bodies = (otelBody.resourceLogs?.[0]?.scopeLogs?.[0]?.logRecords || [])
    .map((record) => record.body?.stringValue)
  assert.equal(otel.eventCount, 7)
  assert.ok(bodies.includes('open_cowork.audit.crew_trace'))
  assert.ok(bodies.includes('open_cowork.audit.policy_decision.approval_required'))
  assert.ok(bodies.includes('open_cowork.audit.channel_delivery.draft'))
}))

test('governance audit export rejects empty crew subject ids without broadening scope', () => withAuditExportStores('empty-crew-subject', () => {
  const crew = createCrewDefinition({ name: 'Scoped Crew', description: 'Scoped team.' })!
  const version = createCrewVersion({
    crewId: crew.id,
    members: [{
      schemaVersion: 1,
      id: 'lead',
      role: 'lead',
      agentName: 'lead-agent',
      displayName: 'Lead',
      description: 'Plans the work.',
      required: true,
    }],
  })!
  const run = createCrewRun({
    crewId: crew.id,
    crewVersionId: version.id,
    title: 'Scoped run',
  })!
  const node = createCrewRunNode({
    crewRunId: run.id,
    kind: 'delegate',
    title: 'Scoped task',
    agentName: 'lead-agent',
  })!
  appendCoworkTraceEvent(createCoworkTraceEvent({
    id: 'trace-scoped',
    sequence: 1,
    runId: run.id,
    runKind: 'crew',
    source: 'opencode_event',
    sourceEventId: 'evt-scoped',
    correlationId: null,
    causationId: null,
    sessionId: 'session-scoped',
    parentSessionId: null,
    actor: { kind: 'agent', id: 'lead-agent' },
    nodeId: node.id,
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: null,
    outputHash: null,
    payloadRef: null,
    payloadHash: null,
    redactionState: 'none',
    tokenUsage: null,
    costUsd: null,
    payload: { type: 'crew_run.tool_call', toolName: 'charts.create_line_chart' },
    createdAt: new Date().toISOString(),
  }))
  recordGovernanceAuditEvent({
    subjectKind: 'crew',
    subjectId: `crew:${encodeURIComponent(crew.id)}`,
    action: 'pause_crew',
    beforeLifecycle: 'active',
    afterLifecycle: 'paused',
    reason: 'Operator pause.',
  })

  const unfiltered = exportGovernanceAuditEvents({ format: 'ndjson' })
  assert.ok(unfiltered.eventCount > 0)

  const malformed = exportGovernanceAuditEvents({ format: 'ndjson', subjectKind: 'crew', subjectId: 'crew:' })
  assert.equal(malformed.eventCount, 0)
  assert.equal(malformed.body, '')
}))
