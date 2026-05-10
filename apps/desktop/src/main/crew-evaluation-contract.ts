import type { OutcomeEvaluation, OutcomeEvaluationStatus } from '@open-cowork/shared'

const CREW_EVALUATION_TYPE = 'open_cowork.crew_outcome_evaluation'
const CONTRACT_VERSION = 1
const STRUCTURED_OUTPUT_RETRY_COUNT = 2
const MAX_EVALUATION_TEXT = 2_000
const MAX_EVALUATION_EVIDENCE_EVENTS = 100
const MAX_EVALUATION_TRACE_ID = 256

type JsonRecord = Record<string, unknown>
type JsonSchema = Record<string, unknown>

type StructuredOutputFormat = {
  type: 'json_schema'
  schema: JsonSchema
  retryCount: number
}

export type CrewOutcomeEvaluationResult = {
  status: OutcomeEvaluationStatus
  score: number
  recommendation: OutcomeEvaluation['recommendation']
  summary: string
  evidenceTraceEventIds: string[]
}

const EVIDENCE_TRACE_EVENT_SCHEMA: JsonSchema = {
  type: 'array',
  minItems: 1,
  maxItems: MAX_EVALUATION_EVIDENCE_EVENTS,
  items: { type: 'string', maxLength: MAX_EVALUATION_TRACE_ID },
}

const CREW_EVALUATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: CREW_EVALUATION_TYPE },
    version: { const: CONTRACT_VERSION },
    status: {
      type: 'string',
      enum: ['passed', 'failed', 'needs_revision', 'needs_human'],
    },
    score: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'Overall quality score on a 0-100 scale.',
    },
    recommendation: {
      type: 'string',
      enum: ['deliver', 'revise', 'escalate'],
    },
    summary: {
      type: 'string',
      maxLength: MAX_EVALUATION_TEXT,
      description: 'Short evaluator rationale safe to show in the operations UI.',
    },
    evidenceTraceEventIds: EVIDENCE_TRACE_EVENT_SCHEMA,
  },
  required: ['type', 'version', 'status', 'score', 'recommendation', 'summary', 'evidenceTraceEventIds'],
}

function extractJsonPayload(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  return fenced?.[1] || text
}

function parseJsonRecord(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(extractJsonPayload(text)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null
  } catch {
    return null
  }
}

function readString(value: unknown, maxLength = MAX_EVALUATION_TEXT) {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, maxLength)
}

function readEvidenceTraceEventIds(value: unknown) {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const item of value) {
    const id = readString(item, MAX_EVALUATION_TRACE_ID)
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_EVALUATION_EVIDENCE_EVENTS) break
  }
  return ids
}

function readStatus(value: unknown): OutcomeEvaluationStatus | null {
  if (value === 'passed' || value === 'failed' || value === 'needs_revision' || value === 'needs_human') return value
  return null
}

function readRecommendation(value: unknown): OutcomeEvaluation['recommendation'] | null {
  if (value === 'deliver' || value === 'revise' || value === 'escalate') return value
  return null
}

function coerceCrewOutcomeEvaluation(record: JsonRecord): CrewOutcomeEvaluationResult | null {
  if (record.type !== CREW_EVALUATION_TYPE || record.version !== CONTRACT_VERSION) return null
  const status = readStatus(record.status)
  const recommendation = readRecommendation(record.recommendation)
  const score = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : NaN
  const evidenceTraceEventIds = readEvidenceTraceEventIds(record.evidenceTraceEventIds)
  if (!status || !recommendation || !Number.isFinite(score) || score < 0 || score > 100 || evidenceTraceEventIds.length === 0) {
    return null
  }
  return {
    status,
    score,
    recommendation,
    summary: readString(record.summary) || `${status} with recommendation ${recommendation}.`,
    evidenceTraceEventIds,
  }
}

export function crewOutcomeEvaluationOutputFormat(): StructuredOutputFormat {
  return {
    type: 'json_schema',
    schema: CREW_EVALUATION_SCHEMA,
    retryCount: STRUCTURED_OUTPUT_RETRY_COUNT,
  }
}

export function crewOutcomeEvaluationSchemaHint() {
  return [
    '{',
    `  "type": "${CREW_EVALUATION_TYPE}",`,
    `  "version": ${CONTRACT_VERSION},`,
    '  "status": "passed|failed|needs_revision|needs_human",',
    '  "score": 0,',
    '  "recommendation": "deliver|revise|escalate",',
    '  "summary": "short evaluator rationale",',
    '  "evidenceTraceEventIds": ["crew trace event id"]',
    '}',
  ].join('\n')
}

export function extractCrewOutcomeEvaluationFromStructured(value: unknown): CrewOutcomeEvaluationResult | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
  return record ? coerceCrewOutcomeEvaluation(record) : null
}

export function extractCrewOutcomeEvaluationFromAssistantText(text: string): CrewOutcomeEvaluationResult | null {
  const record = parseJsonRecord(text)
  return record ? coerceCrewOutcomeEvaluation(record) : null
}
