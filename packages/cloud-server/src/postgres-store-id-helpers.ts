import { createHash, randomBytes } from 'node:crypto'

// Pure id / stable-JSON / hash / event-classification helpers for the Postgres
// control-plane store, extracted from postgres-control-plane-store.ts: an ISO
// timestamp, a deterministic key-sorted JSON serialization, a content-hashed
// stable id, a work-claim token, and a coarse workspace-operation classifier.
// No store state; depends only on node:crypto.

export function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, entry]) => `${JSON.stringify(field)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function stableId(prefix: string, ...parts: string[]) {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

export function createWorkClaimToken(tenantId: string, workId: string, claimedBy: string) {
  return stableId('claim', tenantId, workId, claimedBy, randomBytes(16).toString('base64url'))
}

export function workspaceOperationFromType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}
