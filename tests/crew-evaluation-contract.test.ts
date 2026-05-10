import test from 'node:test'
import assert from 'node:assert/strict'
import {
  crewOutcomeEvaluationOutputFormat,
  extractCrewOutcomeEvaluationFromAssistantText,
  extractCrewOutcomeEvaluationFromStructured,
} from '../apps/desktop/src/main/crew-evaluation-contract.ts'

test('crew evaluation output format requests a bounded json schema payload', () => {
  const format = crewOutcomeEvaluationOutputFormat()

  assert.equal(format.type, 'json_schema')
  assert.equal(format.retryCount, 2)
  assert.equal((format.schema.properties as Record<string, unknown>).score instanceof Object, true)
  assert.deepEqual(format.schema.required, [
    'type',
    'version',
    'status',
    'score',
    'recommendation',
    'summary',
    'evidenceTraceEventIds',
  ])
})

test('extractCrewOutcomeEvaluationFromStructured parses a valid evaluator payload', () => {
  const evaluation = extractCrewOutcomeEvaluationFromStructured({
    type: 'open_cowork.crew_outcome_evaluation',
    version: 1,
    status: 'passed',
    score: 92,
    recommendation: 'deliver',
    summary: 'Evidence is sufficient.',
    evidenceTraceEventIds: ['trace-1', 'trace-2'],
  })

  assert.equal(evaluation?.status, 'passed')
  assert.equal(evaluation?.score, 92)
  assert.equal(evaluation?.recommendation, 'deliver')
  assert.deepEqual(evaluation?.evidenceTraceEventIds, ['trace-1', 'trace-2'])
})

test('extractCrewOutcomeEvaluationFromStructured rejects invalid scores and missing evidence', () => {
  assert.equal(extractCrewOutcomeEvaluationFromStructured({
    type: 'open_cowork.crew_outcome_evaluation',
    version: 1,
    status: 'passed',
    score: 101,
    recommendation: 'deliver',
    summary: 'Too high.',
    evidenceTraceEventIds: ['trace-1'],
  }), null)

  assert.equal(extractCrewOutcomeEvaluationFromStructured({
    type: 'open_cowork.crew_outcome_evaluation',
    version: 1,
    status: 'passed',
    score: 90,
    recommendation: 'deliver',
    summary: 'No evidence.',
    evidenceTraceEventIds: [],
  }), null)
})

test('extractCrewOutcomeEvaluationFromAssistantText accepts fenced json fallback', () => {
  const evaluation = extractCrewOutcomeEvaluationFromAssistantText([
    '```json',
    '{',
    '  "type": "open_cowork.crew_outcome_evaluation",',
    '  "version": 1,',
    '  "status": "needs_revision",',
    '  "score": 67,',
    '  "recommendation": "revise",',
    '  "summary": "Needs clearer artifact evidence.",',
    '  "evidenceTraceEventIds": ["trace-1"]',
    '}',
    '```',
  ].join('\n'))

  assert.equal(evaluation?.status, 'needs_revision')
  assert.equal(evaluation?.recommendation, 'revise')
})
