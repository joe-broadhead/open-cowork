export const CLOUD_WEB_RUNTIME_ENTITY_CLASSES = [
  'message',
  'taskRun',
  'toolCall',
  'pendingApproval',
  'resolvedApproval',
  'pendingQuestion',
  'resolvedQuestion',
  'artifact',
  'todo',
  'error',
  'usage',
  'context',
] as const

export type CloudWebRuntimeEntityClass = typeof CLOUD_WEB_RUNTIME_ENTITY_CLASSES[number]

export type CloudWebRuntimeCounts = Record<CloudWebRuntimeEntityClass, number>

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function numberValue(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function cloudWebRuntimeCounts(projection: unknown): CloudWebRuntimeCounts {
  const record = asRecord(projection)
  const tokens = asRecord(record.sessionTokens)
  return {
    message: list(record.messages).length,
    taskRun: list(record.taskRuns).length,
    toolCall: list(record.toolCalls).length,
    pendingApproval: list(record.pendingApprovals).length,
    resolvedApproval: list(record.resolvedApprovals).length,
    pendingQuestion: list(record.pendingQuestions).length,
    resolvedQuestion: list(record.resolvedQuestions).length,
    artifact: list(record.artifacts).length,
    todo: list(record.todos).length,
    error: list(record.errors).length + (typeof record.lastError === 'string' && record.lastError ? 1 : 0),
    usage: numberValue(record.sessionCost) > 0
      || numberValue(tokens.input) > 0
      || numberValue(tokens.output) > 0
      || numberValue(tokens.reasoning) > 0
      || numberValue(tokens.cacheRead) > 0
      || numberValue(tokens.cacheWrite) > 0
      ? 1
      : 0,
    context: (typeof record.contextState === 'string' && record.contextState && record.contextState !== 'idle')
      || numberValue(record.compactionCount) > 0
      || Boolean(record.lastCompactedAt)
      ? 1
      : 0,
  }
}

export type CloudWebErrorCategory = 'policy' | 'auth' | 'quota' | 'billing' | 'provider' | 'runtime'

export function cloudWebErrorCategory(message: unknown): CloudWebErrorCategory {
  const text = String(message || '').toLowerCase()
  if (text.includes('policy') || text.includes('disabled') || text.includes('not allowed')) return 'policy'
  if (text.includes('auth') || text.includes('token') || text.includes('forbidden') || text.includes('unauthorized')) return 'auth'
  if (text.includes('quota') || text.includes('rate limit') || text.includes('too many')) return 'quota'
  if (text.includes('billing') || text.includes('subscription') || text.includes('payment')) return 'billing'
  if (text.includes('provider') || text.includes('model') || text.includes('api key')) return 'provider'
  return 'runtime'
}

export function cloudWebRuntimeOrder(item: unknown, fallback: number) {
  const order = asRecord(item).order
  return typeof order === 'number' && Number.isFinite(order) ? order : fallback
}

export function cloudWebSafeArtifactMetadata(artifact: unknown): Record<string, unknown> {
  const record = asRecord(artifact)
  return Object.fromEntries(Object.entries(record).filter(([key]) => {
    const normalized = key.toLowerCase()
    return normalized !== 'database64'
      && normalized !== 'url'
      && normalized !== 'downloadurl'
      && normalized !== 'signedurl'
      && normalized !== 'presignedurl'
      && normalized !== 'key'
      && normalized !== 'objectkey'
      && normalized !== 'storagekey'
      && normalized !== 'bucket'
      && normalized !== 'container'
      && normalized !== 'authorization'
      && normalized !== 'token'
  }))
}
