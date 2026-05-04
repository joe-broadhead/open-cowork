import type { ExecutionBrief } from '@open-cowork/shared'
import {
  AUTOMATION_BRIEF_LIMITS,
  limitTextArray,
  limitTextValue,
  normalizeExecutionBriefForStorage,
} from './automation-brief-limits.ts'

const EXECUTION_BRIEF_TYPE = 'open_cowork.execution_brief'
const HEARTBEAT_DECISION_TYPE = 'open_cowork.heartbeat_decision'
const CONTRACT_VERSION = 1
const STRUCTURED_OUTPUT_RETRY_COUNT = 2

type JsonRecord = Record<string, unknown>
type JsonSchema = Record<string, unknown>
type StructuredOutputFormat = {
  type: 'json_schema'
  schema: JsonSchema
  retryCount: number
}

export type AutomationHeartbeatDecision = {
  summary: string
  action: 'noop' | 'request_user' | 'refresh_brief' | 'run_execution'
  reason: string
  userMessage: string | null
}

function readString(value: unknown, maxLength = AUTOMATION_BRIEF_LIMITS.text) {
  return typeof value === 'string' ? limitTextValue(value, maxLength) : ''
}

function readOptionalString(value: unknown, maxLength = AUTOMATION_BRIEF_LIMITS.text) {
  return typeof value === 'string' ? limitTextValue(value, maxLength) : null
}

function readStringArray(value: unknown, maxItems = AUTOMATION_BRIEF_LIMITS.arrayItems, maxLength = AUTOMATION_BRIEF_LIMITS.text) {
  return Array.isArray(value)
    ? limitTextArray(value.filter((entry): entry is string => typeof entry === 'string'), maxItems, maxLength)
    : []
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

function hasContractEnvelope(record: JsonRecord, type: string) {
  return record.type === type && record.version === CONTRACT_VERSION
}

const STRING_ARRAY_SCHEMA: JsonSchema = {
  type: 'array',
  maxItems: AUTOMATION_BRIEF_LIMITS.arrayItems,
  items: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.text },
}

const EXECUTION_BRIEF_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: EXECUTION_BRIEF_TYPE },
    version: { const: CONTRACT_VERSION },
    goal: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.text, description: 'The overall automation goal.' },
    deliverables: STRING_ARRAY_SCHEMA,
    assumptions: STRING_ARRAY_SCHEMA,
    missingContext: STRING_ARRAY_SCHEMA,
    successCriteria: STRING_ARRAY_SCHEMA,
    recommendedAgents: STRING_ARRAY_SCHEMA,
    approvalBoundary: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.text },
    workItems: {
      type: 'array',
      maxItems: AUTOMATION_BRIEF_LIMITS.workItems,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.workItemId },
          title: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.workItemTitle },
          description: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.workItemDescription },
          ownerAgent: { type: ['string', 'null'], maxLength: AUTOMATION_BRIEF_LIMITS.agentName },
          dependsOn: {
            type: 'array',
            maxItems: AUTOMATION_BRIEF_LIMITS.dependsOn,
            items: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.workItemId },
          },
        },
        required: ['id', 'title', 'description', 'ownerAgent', 'dependsOn'],
      },
    },
  },
  required: [
    'type',
    'version',
    'goal',
    'deliverables',
    'assumptions',
    'missingContext',
    'successCriteria',
    'recommendedAgents',
    'approvalBoundary',
    'workItems',
  ],
}

const HEARTBEAT_DECISION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { const: HEARTBEAT_DECISION_TYPE },
    version: { const: CONTRACT_VERSION },
    summary: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.heartbeatText },
    action: {
      type: 'string',
      enum: ['noop', 'request_user', 'refresh_brief', 'run_execution'],
    },
    reason: { type: 'string', maxLength: AUTOMATION_BRIEF_LIMITS.heartbeatText },
    userMessage: { type: ['string', 'null'], maxLength: AUTOMATION_BRIEF_LIMITS.heartbeatText },
  },
  required: ['type', 'version', 'summary', 'action', 'reason', 'userMessage'],
}

export function executionBriefOutputFormat(): StructuredOutputFormat {
  return {
    type: 'json_schema',
    schema: EXECUTION_BRIEF_SCHEMA,
    retryCount: STRUCTURED_OUTPUT_RETRY_COUNT,
  }
}

export function heartbeatDecisionOutputFormat(): StructuredOutputFormat {
  return {
    type: 'json_schema',
    schema: HEARTBEAT_DECISION_SCHEMA,
    retryCount: STRUCTURED_OUTPUT_RETRY_COUNT,
  }
}

function coerceExecutionBriefRecord(parsed: JsonRecord): ExecutionBrief | null {
  if (!hasContractEnvelope(parsed, EXECUTION_BRIEF_TYPE) && parsed.type !== undefined) {
    return null
  }

  const goal = readString(parsed.goal).trim()
  if (!goal) return null

  const missingContext = readStringArray(parsed.missingContext)
  const workItems = Array.isArray(parsed.workItems)
    ? parsed.workItems
      .slice(0, AUTOMATION_BRIEF_LIMITS.workItems)
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
        const record = entry as JsonRecord
        return {
          id: readString(record.id, AUTOMATION_BRIEF_LIMITS.workItemId).trim() || `work-item-${index + 1}`,
          title: readString(record.title, AUTOMATION_BRIEF_LIMITS.workItemTitle).trim() || `Work item ${index + 1}`,
          description: readString(record.description, AUTOMATION_BRIEF_LIMITS.workItemDescription),
          ownerAgent: readOptionalString(record.ownerAgent, AUTOMATION_BRIEF_LIMITS.agentName),
          dependsOn: readStringArray(record.dependsOn, AUTOMATION_BRIEF_LIMITS.dependsOn, AUTOMATION_BRIEF_LIMITS.workItemId),
        }
      })
      .filter((entry): entry is ExecutionBrief['workItems'][number] => Boolean(entry))
    : []

  return normalizeExecutionBriefForStorage({
    version: CONTRACT_VERSION,
    status: missingContext.length > 0 ? 'needs_user' : 'ready',
    goal,
    deliverables: readStringArray(parsed.deliverables),
    assumptions: readStringArray(parsed.assumptions),
    missingContext,
    successCriteria: readStringArray(parsed.successCriteria),
    recommendedAgents: readStringArray(parsed.recommendedAgents),
    approvalBoundary: readString(parsed.approvalBoundary).trim() || 'Approve the brief before execution.',
    workItems,
    generatedAt: new Date().toISOString(),
  })
}

function coerceHeartbeatDecisionRecord(parsed: JsonRecord): AutomationHeartbeatDecision | null {
  if (!hasContractEnvelope(parsed, HEARTBEAT_DECISION_TYPE) && parsed.type !== undefined) {
    return null
  }

  const action = readString(parsed.action)
  if (action !== 'noop' && action !== 'request_user' && action !== 'refresh_brief' && action !== 'run_execution') {
    return null
  }

  const summary = readString(parsed.summary, AUTOMATION_BRIEF_LIMITS.heartbeatText).trim() || readString(parsed.reason, AUTOMATION_BRIEF_LIMITS.heartbeatText).trim() || 'Heartbeat review completed.'
  const reason = readString(parsed.reason, AUTOMATION_BRIEF_LIMITS.heartbeatText).trim() || summary
  const userMessage = readOptionalString(parsed.userMessage, AUTOMATION_BRIEF_LIMITS.heartbeatText)?.trim() || null
  return {
    summary,
    action,
    reason,
    userMessage,
  }
}

export function executionBriefSchemaHint() {
  return [
    '{',
    `  "type": "${EXECUTION_BRIEF_TYPE}",`,
    `  "version": ${CONTRACT_VERSION},`,
    '  "goal": "string",',
    '  "deliverables": ["string"],',
    '  "assumptions": ["string"],',
    '  "missingContext": ["string"],',
    '  "successCriteria": ["string"],',
    '  "recommendedAgents": ["string"],',
    '  "approvalBoundary": "string",',
    '  "workItems": [',
    '    {',
    '      "id": "string",',
    '      "title": "string",',
    '      "description": "string",',
    '      "ownerAgent": "string|null",',
    '      "dependsOn": ["string"]',
    '    }',
    '  ]',
    '}',
  ].join('\n')
}

export function heartbeatDecisionSchemaHint() {
  return [
    '{',
    `  "type": "${HEARTBEAT_DECISION_TYPE}",`,
    `  "version": ${CONTRACT_VERSION},`,
    '  "summary": "string",',
    '  "action": "noop|request_user|refresh_brief|run_execution",',
    '  "reason": "string",',
    '  "userMessage": "string|null"',
    '}',
  ].join('\n')
}

export function extractExecutionBriefFromAssistantText(text: string): ExecutionBrief | null {
  const parsed = parseJsonRecord(text)
  if (!parsed) return null
  return coerceExecutionBriefRecord(parsed)
}

export function extractHeartbeatDecisionFromAssistantText(text: string): AutomationHeartbeatDecision | null {
  const parsed = parseJsonRecord(text)
  if (!parsed) return null
  return coerceHeartbeatDecisionRecord(parsed)
}

export function extractExecutionBriefFromStructured(value: unknown): ExecutionBrief | null {
  const parsed = value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
  if (!parsed) return null
  return coerceExecutionBriefRecord(parsed)
}

export function extractHeartbeatDecisionFromStructured(value: unknown): AutomationHeartbeatDecision | null {
  const parsed = value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
  if (!parsed) return null
  return coerceHeartbeatDecisionRecord(parsed)
}
