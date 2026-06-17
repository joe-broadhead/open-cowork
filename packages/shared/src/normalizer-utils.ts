export type JsonRecord = Record<string, unknown>

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readBoolean(value: unknown): boolean {
  return value === true
}

export function readRecordString(record: JsonRecord, keys: string[]): string | null {
  for (const key of keys) {
    const value = readString(record[key])
    if (value) return value
  }
  return null
}

export function readRecordNumber(record: JsonRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = readNumber(record[key])
    if (value !== null) return value
  }
  return null
}

export function readRecordArray(record: unknown, key: string): unknown[] {
  return asArray(asRecord(record)[key])
}

export function readRecordValue(record: unknown, key: string): unknown {
  return asRecord(record)[key]
}
