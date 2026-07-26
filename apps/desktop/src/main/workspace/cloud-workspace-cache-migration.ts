const MAX_SCAN_DEPTH = 24
const MAX_SCAN_NODES = 20_000

const SENSITIVE_FIELD_NAMES = new Set([
  'authorization',
  'apikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'cookie',
  'idtoken',
  'password',
  'privatekey',
  'secret',
  'sessioncookie',
  'sessiontoken',
  'token',
  'webhooksecret',
  'webhooksecretreveal',
])

type UnknownRecord = Record<string, unknown>

export type LegacyCacheRecordRewrite = {
  record: UnknownRecord
  removedSensitiveViews: boolean
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function addString(set: Set<string>, value: unknown) {
  if (typeof value === 'string' && value) set.add(value)
}

function collectRunSessionIds(value: unknown, sessionIds: Set<string>) {
  if (!Array.isArray(value)) return
  for (const candidate of value) {
    const run = asRecord(candidate)
    if (run) addString(sessionIds, run.sessionId)
  }
}

function workflowSessionIds(record: UnknownRecord) {
  const sessionIds = new Set<string>()
  if (Array.isArray(record.sessions)) {
    for (const candidate of record.sessions) {
      const session = asRecord(candidate)
      if (!session || typeof session.id !== 'string') continue
      if (
        session.kind === 'workflow_draft'
        || session.kind === 'workflow_run'
        || (typeof session.workflowId === 'string' && session.workflowId)
        || (typeof session.runId === 'string' && session.runId)
      ) {
        sessionIds.add(session.id)
      }
    }
  }

  const payload = asRecord(record.workflows)
  if (!payload) return sessionIds
  if (Array.isArray(payload.workflows)) {
    for (const candidate of payload.workflows) {
      const workflow = asRecord(candidate)
      if (!workflow) continue
      addString(sessionIds, workflow.draftSessionId)
      addString(sessionIds, workflow.latestRunSessionId)
      collectRunSessionIds(workflow.runs, sessionIds)
    }
  }
  collectRunSessionIds(payload.runs, sessionIds)
  return sessionIds
}

function normalizedFieldName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveFieldName(value: string) {
  const normalized = normalizedFieldName(value)
  return SENSITIVE_FIELD_NAMES.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('bearertoken')
    || normalized.endsWith('token')
    || normalized.endsWith('clientsecret')
    || normalized.endsWith('secret')
    || normalized.endsWith('credential')
    || normalized.startsWith('password')
    || normalized.endsWith('password')
    || normalized.includes('privatekey')
    || normalized.endsWith('sessiontoken')
    || normalized.endsWith('webhooksecret')
}

function isWorkflowCredentialToolName(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, '_')
  return normalized.includes('workflow')
    && (
      normalized.includes('create')
      || normalized.includes('preview')
      || normalized.includes('regenerate')
      || normalized.includes('webhook')
    )
}

function stringContainsCredentialShape(value: string) {
  return /webhook[_-]?secret(?:[_-]?reveal)?\s*["']?\s*[:=]/i.test(value)
    || /authorization\s*["']?\s*[:=]\s*["']?\s*bearer\s+\S+/i.test(value)
}

export function containsSensitiveCacheContent(
  value: unknown,
  state = { remaining: MAX_SCAN_NODES, seen: new WeakSet<object>() },
  depth = 0,
): boolean {
  state.remaining -= 1
  if (state.remaining < 0 || depth > MAX_SCAN_DEPTH) return true
  if (typeof value === 'string') return stringContainsCredentialShape(value)
  if (!value || typeof value !== 'object') return false
  if (state.seen.has(value)) return true
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.some((entry) => containsSensitiveCacheContent(entry, state, depth + 1))
    }
    for (const [key, entry] of Object.entries(value as UnknownRecord)) {
      const field = normalizedFieldName(key)
      if (isSensitiveFieldName(field) && entry !== null && entry !== undefined && entry !== '') {
        return true
      }
      if (
        (field === 'name' || field === 'tool' || field === 'toolname')
        && typeof entry === 'string'
        && isWorkflowCredentialToolName(entry)
      ) {
        return true
      }
      if (containsSensitiveCacheContent(entry, state, depth + 1)) return true
    }
    return false
  } finally {
    state.seen.delete(value)
  }
}

/**
 * V1 workflow results could contain webhook credentials in workflow records and
 * workflow setup/run transcripts. Remove those partitions while retaining
 * structurally unrelated transcript views and all normalized session metadata.
 */
export function rewriteLegacyCacheRecord(value: unknown): LegacyCacheRecordRewrite | null {
  const record = asRecord(value)
  if (!record) return null
  const unsafeSessionIds = workflowSessionIds(record)
  const views = asRecord(record.views)
  const safeViews: UnknownRecord = {}
  let removedSensitiveViews = false
  if (views) {
    for (const [sessionId, view] of Object.entries(views)) {
      const sensitive = unsafeSessionIds.has(sessionId)
        || containsSensitiveCacheContent(view)
      if (sensitive) {
        removedSensitiveViews = true
        continue
      }
      safeViews[sessionId] = view
    }
  }
  return {
    record: {
      ...record,
      views: safeViews,
      workflows: null,
    },
    removedSensitiveViews,
  }
}
