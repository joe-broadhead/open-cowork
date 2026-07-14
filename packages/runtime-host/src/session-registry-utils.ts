import type { SessionChangeSummary, SessionUsageSummary } from '@open-cowork/shared'

export interface StoredSessionRecord {
  id: string
  title?: string
  directory: string | null
  opencodeDirectory: string
  createdAt: string
  updatedAt: string
  kind: 'interactive' | 'workflow_draft' | 'workflow_run'
  workflowId: string | null
  runId: string | null
  providerId: string | null
  modelId: string | null
  composerAgentName: string | null
  composerModelId: string | null
  composerReasoningVariant: string | null
  summary: SessionUsageSummary | null
  parentSessionId: string | null
  changeSummary: SessionChangeSummary | null
  revertedMessageId: string | null
  managedByCowork: true
}

const STORED_SESSION_REQUIRED_KEYS = new Set([
  'id',
  'directory',
  'opencodeDirectory',
  'createdAt',
  'updatedAt',
  'kind',
  'workflowId',
  'runId',
  'providerId',
  'modelId',
  'composerAgentName',
  'composerModelId',
  'composerReasoningVariant',
  'summary',
  'parentSessionId',
  'changeSummary',
  'revertedMessageId',
  'managedByCowork',
])
const STORED_SESSION_ALLOWED_KEYS = new Set([...STORED_SESSION_REQUIRED_KEYS, 'title'])
const SESSION_TOKEN_KEYS = new Set(['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite'])
const SESSION_USAGE_KEYS = new Set([
  'messages',
  'userMessages',
  'assistantMessages',
  'toolCalls',
  'taskRuns',
  'cost',
  'tokens',
  'agentBreakdown',
])
const AGENT_USAGE_KEYS = new Set(['agent', 'taskRuns', 'cost', 'tokens'])
const CHANGE_SUMMARY_KEYS = new Set(['additions', 'deletions', 'files', 'source', 'synthetic'])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>) {
  return Object.keys(record).every((key) => allowed.has(key))
}

function hasRequiredKeys(record: Record<string, unknown>, required: ReadonlySet<string>) {
  return [...required].every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isCurrentSessionTokens(value: unknown) {
  const record = asRecord(value)
  return Boolean(
    record
    && Object.keys(record).length === SESSION_TOKEN_KEYS.size
    && hasOnlyKeys(record, SESSION_TOKEN_KEYS)
    && [...SESSION_TOKEN_KEYS].every((key) => isFiniteNumber(record[key])),
  )
}

function isCurrentAgentUsage(value: unknown) {
  const record = asRecord(value)
  return Boolean(
    record
    && Object.keys(record).length === AGENT_USAGE_KEYS.size
    && hasOnlyKeys(record, AGENT_USAGE_KEYS)
    && (record.agent === null || typeof record.agent === 'string')
    && isFiniteNumber(record.taskRuns)
    && isFiniteNumber(record.cost)
    && isCurrentSessionTokens(record.tokens),
  )
}

function isCurrentSessionUsageSummary(value: unknown): value is SessionUsageSummary {
  const record = asRecord(value)
  if (!record || !hasOnlyKeys(record, SESSION_USAGE_KEYS)) return false
  for (const key of ['messages', 'userMessages', 'assistantMessages', 'toolCalls', 'taskRuns', 'cost']) {
    if (!isFiniteNumber(record[key])) return false
  }
  if (!isCurrentSessionTokens(record.tokens)) return false
  return record.agentBreakdown === undefined
    || (Array.isArray(record.agentBreakdown) && record.agentBreakdown.every(isCurrentAgentUsage))
}

function isCurrentChangeSummary(value: unknown): value is SessionChangeSummary {
  const record = asRecord(value)
  if (!record || !hasOnlyKeys(record, CHANGE_SUMMARY_KEYS)) return false
  if (!isFiniteNumber(record.additions) || !isFiniteNumber(record.deletions) || !isFiniteNumber(record.files)) return false
  if (record.source !== undefined && record.source !== 'synthetic' && record.source !== 'mixed') return false
  return record.synthetic === undefined || typeof record.synthetic === 'boolean'
}

function isCurrentStoredSessionRecord(value: unknown): value is StoredSessionRecord {
  const record = asRecord(value)
  if (
    !record
    || !hasOnlyKeys(record, STORED_SESSION_ALLOWED_KEYS)
    || !hasRequiredKeys(record, STORED_SESSION_REQUIRED_KEYS)
  ) return false
  if (
    typeof record.id !== 'string'
    || !record.id
    || (record.title !== undefined && typeof record.title !== 'string')
    || !isNullableString(record.directory)
    || typeof record.opencodeDirectory !== 'string'
    || !record.opencodeDirectory
    || typeof record.createdAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(record.updatedAt))
    || (record.kind !== 'interactive' && record.kind !== 'workflow_draft' && record.kind !== 'workflow_run')
    || !isNullableString(record.workflowId)
    || !isNullableString(record.runId)
    || !isNullableString(record.providerId)
    || !isNullableString(record.modelId)
    || !isNullableString(record.composerAgentName)
    || !isNullableString(record.composerModelId)
    || !isNullableString(record.composerReasoningVariant)
    || !isNullableString(record.parentSessionId)
    || !isNullableString(record.revertedMessageId)
    || record.managedByCowork !== true
  ) return false
  if (record.summary !== null && !isCurrentSessionUsageSummary(record.summary)) return false
  return record.changeSummary === null || isCurrentChangeSummary(record.changeSummary)
}

function normalizeSessionTokens(tokens: SessionUsageSummary['tokens'] | undefined | null) {
  return {
    input: typeof tokens?.input === 'number' ? tokens.input : 0,
    output: typeof tokens?.output === 'number' ? tokens.output : 0,
    reasoning: typeof tokens?.reasoning === 'number' ? tokens.reasoning : 0,
    cacheRead: typeof tokens?.cacheRead === 'number' ? tokens.cacheRead : 0,
    cacheWrite: typeof tokens?.cacheWrite === 'number' ? tokens.cacheWrite : 0,
  }
}

function normalizeAgentBreakdown(value: unknown): SessionUsageSummary['agentBreakdown'] | undefined {
  if (!Array.isArray(value)) return undefined
  const entries = value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
      const record = entry as Partial<NonNullable<SessionUsageSummary['agentBreakdown']>[number]>
      return {
        agent: typeof record.agent === 'string' ? record.agent : null,
        taskRuns: typeof record.taskRuns === 'number' ? record.taskRuns : 0,
        cost: typeof record.cost === 'number' ? record.cost : 0,
        tokens: normalizeSessionTokens(record.tokens),
      }
    })
    .filter((entry): entry is NonNullable<SessionUsageSummary['agentBreakdown']>[number] => entry !== null)
  return entries.length > 0 ? entries : undefined
}

export function normalizeStoredSessionRecord(
  value: unknown,
  normalizeDirectory: (directory: string) => string,
  toDisplayDirectory: (opencodeDirectory: string) => string | null,
) {
  if (!isCurrentStoredSessionRecord(value)) return null
  const item = value

  const opencodeDirectory = normalizeDirectory(item.opencodeDirectory)

  return {
    id: item.id,
    title: item.title,
    directory: item.directory === null ? toDisplayDirectory(opencodeDirectory) : item.directory,
    opencodeDirectory,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    kind: item.kind,
    workflowId: item.workflowId,
    runId: item.runId,
    providerId: item.providerId,
    modelId: item.modelId,
    composerAgentName: item.composerAgentName,
    composerModelId: item.composerModelId,
    composerReasoningVariant: item.composerReasoningVariant,
    summary: item.summary && typeof item.summary === 'object'
      ? {
          messages: typeof item.summary.messages === 'number' ? item.summary.messages : 0,
          userMessages: typeof item.summary.userMessages === 'number' ? item.summary.userMessages : 0,
          assistantMessages: typeof item.summary.assistantMessages === 'number' ? item.summary.assistantMessages : 0,
          toolCalls: typeof item.summary.toolCalls === 'number' ? item.summary.toolCalls : 0,
          taskRuns: typeof item.summary.taskRuns === 'number' ? item.summary.taskRuns : 0,
          cost: typeof item.summary.cost === 'number' ? item.summary.cost : 0,
          tokens: normalizeSessionTokens(item.summary.tokens),
          agentBreakdown: normalizeAgentBreakdown(item.summary.agentBreakdown),
        }
      : null,
    parentSessionId: item.parentSessionId,
    changeSummary: item.changeSummary && typeof item.changeSummary === 'object'
      ? {
          additions: typeof item.changeSummary.additions === 'number' ? item.changeSummary.additions : 0,
          deletions: typeof item.changeSummary.deletions === 'number' ? item.changeSummary.deletions : 0,
          files: typeof item.changeSummary.files === 'number' ? item.changeSummary.files : 0,
          ...(item.changeSummary.source === 'synthetic' || item.changeSummary.source === 'mixed'
            ? { source: item.changeSummary.source, synthetic: true }
            : {}),
        }
      : null,
    revertedMessageId: item.revertedMessageId,
    managedByCowork: true as const,
  }
}
