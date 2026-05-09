import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COWORK_CREW_SCHEMA_VERSION,
  COWORK_EVAL_SCHEMA_VERSION,
  COWORK_TRACE_EVENT_SCHEMA_VERSION,
  createCoworkTraceEvent,
  serializeCoworkTraceEvent,
  sortCoworkTraceEvents,
  toExportableCoworkTraceEvent,
  type CrewDefinition,
  type CrewRun,
  type CoworkTraceEventInput,
  type OutcomeEvaluation,
  type OutcomeRubric,
} from '../packages/shared/src/crews.ts'

function traceInput(overrides: Partial<CoworkTraceEventInput> = {}): CoworkTraceEventInput {
  return {
    id: 'trace-1',
    sequence: 1,
    runId: 'run-1',
    runKind: 'crew',
    source: 'opencode_event',
    sourceEventId: 'event-1',
    correlationId: 'corr-1',
    causationId: null,
    sessionId: 'session-1',
    parentSessionId: null,
    actor: { kind: 'agent', id: 'lead' },
    nodeId: 'node-1',
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: 'sha256:input',
    outputHash: 'sha256:output',
    payloadRef: null,
    payloadHash: 'sha256:payload',
    redactionState: 'none',
    tokenUsage: {
      input: 10,
      output: 20,
      reasoning: 3,
      cacheRead: 1,
      cacheWrite: 0,
    },
    costUsd: 0.04,
    payload: { text: 'visible evidence' },
    createdAt: '2026-05-10T00:00:00.000Z',
    ...overrides,
  }
}

test('crew durable primitives carry explicit schema versions', () => {
  const crew: CrewDefinition = {
    schemaVersion: COWORK_CREW_SCHEMA_VERSION,
    id: 'crew-1',
    name: 'Research Crew',
    description: 'Finds, checks, and summarizes evidence.',
    status: 'draft',
    activeVersionId: null,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  }
  const run: CrewRun = {
    schemaVersion: COWORK_CREW_SCHEMA_VERSION,
    id: 'run-1',
    crewId: crew.id,
    crewVersionId: 'crew-version-1',
    workItemId: 'work-item-1',
    status: 'queued',
    title: 'Weekly market research',
    summary: null,
    rootSessionId: null,
    createdAt: '2026-05-10T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
  }
  const rubric: OutcomeRubric = {
    schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
    id: 'rubric-1',
    name: 'Evidence quality',
    description: 'Checks whether output has enough cited evidence.',
    criteria: [{
      schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
      id: 'criterion-1',
      label: 'Evidence',
      description: 'Every major claim links to trace evidence.',
      weight: 1,
      passingScore: 0.8,
    }],
    passingScore: 0.8,
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  }
  const evaluation: OutcomeEvaluation = {
    schemaVersion: COWORK_EVAL_SCHEMA_VERSION,
    id: 'evaluation-1',
    crewRunId: run.id,
    evaluatorAgentName: 'evaluator',
    rubricId: rubric.id,
    status: 'passed',
    score: 0.91,
    evidenceTraceEventIds: ['trace-1'],
    recommendation: 'deliver',
    createdAt: '2026-05-10T00:01:00.000Z',
  }

  assert.equal(crew.schemaVersion, 1)
  assert.equal(run.schemaVersion, 1)
  assert.equal(rubric.criteria[0]?.schemaVersion, 1)
  assert.equal(evaluation.schemaVersion, 1)
})

test('trace event helper stamps the current trace schema version', () => {
  const event = createCoworkTraceEvent(traceInput())

  assert.equal(event.schemaVersion, COWORK_TRACE_EVENT_SCHEMA_VERSION)
  assert.equal(event.runKind, 'crew')
  assert.equal(event.source, 'opencode_event')
  assert.equal(event.actor.kind, 'agent')
})

test('trace event export redacts payloads for redacted and restricted events', () => {
  const event = createCoworkTraceEvent(traceInput({
    redactionState: 'restricted',
    payload: { secret: 'do-not-export' },
    payloadRef: 'artifact://secure-payload',
    payloadHash: 'sha256:restricted-payload',
  }))

  const exportable = toExportableCoworkTraceEvent(event)

  assert.equal(exportable.payload, null)
  assert.equal(exportable.payloadRef, 'artifact://secure-payload')
  assert.equal(exportable.payloadHash, 'sha256:restricted-payload')
  assert.deepEqual(exportable.actor, { kind: 'agent', id: 'lead' })
})

test('trace event sort is deterministic by sequence, timestamp, then id', () => {
  const unordered = [
    createCoworkTraceEvent(traceInput({ id: 'trace-c', sequence: 2, createdAt: '2026-05-10T00:00:01.000Z' })),
    createCoworkTraceEvent(traceInput({ id: 'trace-b', sequence: 1, createdAt: '2026-05-10T00:00:01.000Z' })),
    createCoworkTraceEvent(traceInput({ id: 'trace-a', sequence: 1, createdAt: '2026-05-10T00:00:00.000Z' })),
  ]

  assert.deepEqual(sortCoworkTraceEvents(unordered).map((event) => event.id), [
    'trace-a',
    'trace-b',
    'trace-c',
  ])
})

test('trace event serialization preserves a stable JSON field order for NDJSON export', () => {
  const event = createCoworkTraceEvent(traceInput({
    id: 'trace-serialize',
    sequence: 42,
  }))

  assert.equal(serializeCoworkTraceEvent(event), JSON.stringify({
    schemaVersion: 1,
    id: 'trace-serialize',
    sequence: 42,
    runId: 'run-1',
    runKind: 'crew',
    source: 'opencode_event',
    sourceEventId: 'event-1',
    correlationId: 'corr-1',
    causationId: null,
    sessionId: 'session-1',
    parentSessionId: null,
    actor: { kind: 'agent', id: 'lead' },
    nodeId: 'node-1',
    artifactId: null,
    approvalId: null,
    policyDecisionId: null,
    inputHash: 'sha256:input',
    outputHash: 'sha256:output',
    payloadRef: null,
    payloadHash: 'sha256:payload',
    redactionState: 'none',
    tokenUsage: {
      input: 10,
      output: 20,
      reasoning: 3,
      cacheRead: 1,
      cacheWrite: 0,
    },
    costUsd: 0.04,
    payload: { text: 'visible evidence' },
    createdAt: '2026-05-10T00:00:00.000Z',
  }))
})
