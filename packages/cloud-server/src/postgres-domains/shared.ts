export type QueryRow = Record<string, unknown>
export type QueryResult<Row extends QueryRow = QueryRow> = { rows: Row[] }

export function iso(value: unknown) {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return new Date(value).toISOString()
  throw new Error('Expected a timestamp column.')
}

export function numberValue(value: unknown) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error('Expected a numeric column.')
  return parsed
}

export function stringOrNull(value: unknown) {
  return typeof value === 'string' ? value : null
}

export function isoOrNull(value: unknown) {
  return value ? iso(value) : null
}

export function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function jsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}
