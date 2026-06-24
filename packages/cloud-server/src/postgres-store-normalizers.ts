import { jsonRecord } from './postgres-domains/shared.ts'
import { stableJson } from './postgres-store-id-helpers.ts'
// redactOperationalText now lives in its own single-source module; re-exported here so the
// store's existing import surface (postgres-store-normalizers) is unchanged.
export { redactOperationalText } from './operational-text-redaction.ts'

// Pure input normalizers/validators for the Postgres control-plane store,
// extracted from postgres-control-plane-store.ts: trimming/length-bounding text,
// the operational-text secret redactor, tag-colour/id-list/thread-query/metadata
// record normalization, integer bounds, the rate-limit window math, and the BYOK
// provider-id validator. No store state — depends only on the shared JSON-record
// coercion and the stable-JSON serializer.

const THREAD_DEFAULT_TAG_COLOR = '#64748b'
const SMART_FILTER_QUERY_MAX_BYTES = 16_384
const CHANNEL_METADATA_MAX_BYTES = 16_384
const BYOK_PROVIDER_ID_MAX_LENGTH = 64

export function optionalTrimmedText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function normalizeText(value: unknown, maxLength: number, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters.`)
  return normalized
}


export function normalizeOptionalText(value: unknown, maxLength: number, label: string) {
  if (value === undefined) return undefined
  return normalizeText(value, maxLength, label)
}

export function normalizeTagColor(value: unknown) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim())
    ? value.trim()
    : THREAD_DEFAULT_TAG_COLOR
}

export function normalizeIdList(values: readonly unknown[], label: string, maxLength: number) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array.`)
  if (values.length > maxLength) throw new Error(`${label} exceeds ${maxLength} entries.`)
  return [...new Set(values.map((value) => normalizeText(value, 256, label)))]
}

export function normalizeThreadQuery(value: unknown) {
  const query = jsonRecord(value)
  const serialized = stableJson(query)
  if (Buffer.byteLength(serialized, 'utf8') > SMART_FILTER_QUERY_MAX_BYTES) {
    throw new Error(`Smart filter query exceeds ${SMART_FILTER_QUERY_MAX_BYTES} bytes.`)
  }
  return query
}

export function normalizeRecord(value: unknown, label: string, maxBytes = CHANNEL_METADATA_MAX_BYTES): Record<string, unknown> {
  const record = jsonRecord(value)
  const serialized = stableJson(record)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes.`)
  }
  return record
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

export function windowStart(nowMs: number, windowMs: number) {
  return Math.floor(nowMs / windowMs) * windowMs
}

export function retryAfterMs(nowMs: number, windowStartedAtMs: number, windowMs: number) {
  return Math.max(1, windowStartedAtMs + windowMs - nowMs)
}

export function normalizeByokProviderId(value: unknown) {
  const providerId = normalizeText(value, BYOK_PROVIDER_ID_MAX_LENGTH, 'BYOK provider id').toLowerCase()
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) throw new Error(`Unsupported BYOK provider id ${providerId}.`)
  return providerId
}
