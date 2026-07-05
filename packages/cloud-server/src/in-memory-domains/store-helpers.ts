// Shared pure helpers for the in-memory control-plane store and its domain
// modules — ISO timestamps, list-limit clamping, stable JSON / NUL-joined keys,
// event-type classification, and the text/integer normalizers. No store state and
// no const/crypto deps; the single source these used to be copied from per file.

export function nowIso(now: Date | undefined) {
  return (now || new Date()).toISOString()
}

// Bounded retention prune over a Map of records carrying an ISO `createdAt`. Deletes up to `limit`
// of the oldest records created strictly before `cutoffIso` (lexicographic ISO compare == chronological)
// and returns the count removed — the in-memory analogue of the postgres `ORDER BY created_at LIMIT`
// ctid delete, so both stores drain in matching oldest-first batches.
export function pruneOldestByCreatedAt<K, V>(
  records: Map<K, V>,
  createdAtOf: (value: V) => string,
  cutoffIso: string,
  limit: number,
): number {
  const stale: Array<{ recordKey: K; createdAt: string }> = []
  for (const [recordKey, value] of records) {
    const createdAt = createdAtOf(value)
    if (createdAt < cutoffIso) stale.push({ recordKey, createdAt })
  }
  stale.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  let removed = 0
  for (const entry of stale) {
    if (removed >= limit) break
    records.delete(entry.recordKey)
    removed += 1
  }
  return removed
}

export function normalizeListLimit(value: number | null | undefined, fallback = 100, max = 500) {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value || fallback)))
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

export function key(...parts: string[]) {
  return parts.join('\0')
}

export function workspaceOperationFromType(type: string) {
  if (/\b(created|submitted|uploaded|started)\b/.test(type)) return 'create'
  if (/\b(deleted|removed|archived)\b/.test(type)) return 'delete'
  return 'update'
}

export function optionalTrimmedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// Shared event-replay slice for the in-memory store: events after `afterSequence`,
// deep-cloned, optionally capped at `limit`. Mirrors the postgres
// `WHERE sequence > $n ORDER BY sequence LIMIT $m` read used by the session/workspace
// event replay (and its *ForStream variants).
export function sliceEventsAfter<T extends { sequence: number }>(
  events: readonly T[],
  afterSequence: number,
  limit?: number,
): T[] {
  const matching = events
    .filter((event) => event.sequence > afterSequence)
    .map((event) => clone(event))
  return Number.isInteger(limit) && (limit as number) > 0 ? matching.slice(0, limit) : matching
}

export function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters.`)
  }
  return normalized
}

export function normalizeOptionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined) return undefined
  return normalizeText(value, maxLength, label)
}

export function normalizeNullableText(value: unknown, maxLength: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return normalizeText(value, maxLength, label)
}

export function normalizeNonNegativeInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0)
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer.`)
  return parsed
}

export function normalizePositiveInteger(value: unknown, label: string) {
  const parsed = Number(value ?? 0)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer.`)
  return parsed
}
