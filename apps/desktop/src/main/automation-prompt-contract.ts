import type { ExecutionBrief } from '@open-cowork/shared'

const EXECUTION_BRIEF_TYPE = 'open_cowork.execution_brief'
const HEARTBEAT_DECISION_TYPE = 'open_cowork.heartbeat_decision'
const CONTRACT_VERSION = 1

type JsonRecord = Record<string, unknown>

export type AutomationHeartbeatDecision = {
  summary: string
  action: 'noop' | 'request_user' | 'refresh_brief' | 'run_execution'
  reason: string
  userMessage: string | null
}

function readString(value: unknown) {
  return typeof value === 'string' ? value : ''
}

function readOptionalString(value: unknown) {
  return typeof value === 'string' ? value : null
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
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

  // Legacy fallback keeps older sessions inspectable, but new prompts
  // always emit the explicit type/version contract above.
  if (!hasContractEnvelope(parsed, EXECUTION_BRIEF_TYPE) && parsed.type !== undefined) {
    return null
  }

  const goal = readString(parsed.goal).trim()
  if (!goal) return null

  const missingContext = readStringArray(parsed.missingContext)
  const workItems = Array.isArray(parsed.workItems)
    ? parsed.workItems
      .map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
        const record = entry as JsonRecord
        return {
          id: readString(record.id).trim() || `work-item-${index + 1}`,
          title: readString(record.title).trim() || `Work item ${index + 1}`,
          description: readString(record.description),
          ownerAgent: readOptionalString(record.ownerAgent),
          dependsOn: readStringArray(record.dependsOn),
        }
      })
      .filter((entry): entry is ExecutionBrief['workItems'][number] => Boolean(entry))
    : []

  return {
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
  }
}

export function extractHeartbeatDecisionFromAssistantText(text: string): AutomationHeartbeatDecision | null {
  const parsed = parseJsonRecord(text)
  if (!parsed) return null
  if (!hasContractEnvelope(parsed, HEARTBEAT_DECISION_TYPE) && parsed.type !== undefined) {
    return null
  }

  const action = readString(parsed.action)
  if (action !== 'noop' && action !== 'request_user' && action !== 'refresh_brief' && action !== 'run_execution') {
    return null
  }

  const summary = readString(parsed.summary).trim() || readString(parsed.reason).trim() || 'Heartbeat review completed.'
  const reason = readString(parsed.reason).trim() || summary
  const userMessage = readOptionalString(parsed.userMessage)?.trim() || null
  return {
    summary,
    action,
    reason,
    userMessage,
  }
}
