import {
  asRecord,
  readRecordValue,
  readString,
} from './normalizer-utils.js'
import {
  RUNTIME_EVENT_MAX_COLLECTION_ENTRIES,
  sanitizeRuntimeEventValue,
} from './runtime-event-sanitizer.js'

function hasEnumerableOwnProperty(value: Record<string, unknown>) {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return true
  }
  return false
}

function boundedRecord(value: unknown) {
  const source = asRecord(value)
  const output: Record<string, unknown> = {}
  let count = 0
  for (const key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    if (count >= RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) break
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    output[key] = source[key]
    count += 1
  }
  return output
}

function readFirstString(record: Record<string, unknown> | null | undefined, keys: string[]) {
  for (const key of keys) {
    const value = readString(readRecordValue(record, key))
    if (value) return value
  }
  return null
}

export function readRuntimeSessionId(properties: Record<string, unknown> | null | undefined) {
  return readFirstString(properties, ['sessionID', 'sessionId'])
}

export type RuntimeToolStatus = 'complete' | 'error' | 'running'

// Single source of truth for tool-part status across the live runtime paths (cloud + desktop)
// and history replay. Error takes precedence; otherwise a part with output (or an explicit
// completed/complete status) is complete, and a part with neither is still running. The history
// replay paths previously defaulted the no-output/no-error case to 'complete', so an interrupted
// tool rendered as a live spinner that flipped to "complete" on reload.
export function deriveToolStatus(input: { hasOutput: boolean, hasError: boolean, statusHint?: string }): RuntimeToolStatus {
  if (input.hasError) return 'error'
  if (input.hasOutput || input.statusHint === 'completed' || input.statusHint === 'complete') return 'complete'
  return 'running'
}

export function extractRuntimeErrorMessage(
  properties: Record<string, unknown> | null | undefined,
  error: Record<string, unknown> | null | undefined,
) {
  const nestedError = asRecord(readRecordValue(error, 'error'))
  const data = asRecord(readRecordValue(error, 'data'))
  const nestedData = asRecord(readRecordValue(nestedError, 'data'))
  const response = asRecord(readRecordValue(error, 'response'))
  const responseBody = asRecord(readRecordValue(response, 'body'))

  const resolved = readFirstString(error, ['message'])
    || readFirstString(nestedError, ['message'])
    || readFirstString(data, ['message', 'error'])
    || readFirstString(nestedData, ['message', 'error'])
    || readFirstString(responseBody, ['message', 'error'])
    || readFirstString(properties, ['message'])
    || readFirstString(error, ['name', 'type', 'code'])
    || readFirstString(nestedError, ['name', 'type', 'status', 'code'])
  if (resolved) return resolved

  // Fall back to stringifying the payload so a runtime-surfaced error with
  // an unfamiliar shape still reaches the user with actionable detail.
  // "An error occurred" on its own is not useful when debugging which of
  // 300+ OpenRouter models failed.
  try {
    const payload = error && hasEnumerableOwnProperty(error)
      ? error
      : properties && hasEnumerableOwnProperty(properties)
        ? properties
        : null
    if (payload) {
      const serialized = JSON.stringify(sanitizeRuntimeEventValue(payload))
      if (serialized && serialized !== '{}') return serialized
    }
  } catch {
    // ignore serialization errors
  }
  return 'An error occurred'
}

function readNestedRecord(
  record: Record<string, unknown> | null | undefined,
  keys: string[],
) {
  for (const key of keys) {
    const nested = asRecord(readRecordValue(record, key))
    if (hasEnumerableOwnProperty(nested)) return nested
  }
  return null
}

export function normalizePermissionEvent(properties: Record<string, unknown> | null | undefined) {
  const permission = readNestedRecord(properties, ['permission', 'info', 'request'])
  const id = readFirstString(permission, ['id', 'requestID', 'requestId'])
    || readFirstString(properties, ['id', 'requestID', 'requestId'])
  const sessionId = readFirstString(permission, ['sessionID', 'sessionId'])
    || readFirstString(properties, ['sessionID', 'sessionId'])
  const permissionType = readFirstString(permission, ['action', 'type', 'permission'])
    || readFirstString(properties, ['action', 'type', 'permission'])
    || 'permission'
  const title = readFirstString(permission, ['title', 'tool', 'name', 'action'])
    || readFirstString(properties, ['title', 'tool', 'name', 'action'])
    || permissionType
  const metadata = asRecord(readRecordValue(permission, 'metadata'))
  const outerMetadata = asRecord(readRecordValue(properties, 'metadata'))
  const nestedInput = asRecord(readRecordValue(permission, 'input'))
  const outerInput = asRecord(readRecordValue(properties, 'input'))
  let input = boundedRecord(outerInput)
  if (hasEnumerableOwnProperty(nestedInput)) input = boundedRecord(nestedInput)
  if (hasEnumerableOwnProperty(outerMetadata)) input = boundedRecord(outerMetadata)
  if (hasEnumerableOwnProperty(metadata)) input = boundedRecord(metadata)

  const resources = readRecordValue(permission, 'resources') || readRecordValue(properties, 'resources')
  const save = readRecordValue(permission, 'save') || readRecordValue(properties, 'save')
  const source = boundedRecord(readRecordValue(permission, 'source') || readRecordValue(properties, 'source'))
  if (Array.isArray(resources)) {
    input.resources = resources.slice(0, RUNTIME_EVENT_MAX_COLLECTION_ENTRIES)
  }
  if (Array.isArray(save)) {
    input.save = save.slice(0, RUNTIME_EVENT_MAX_COLLECTION_ENTRIES)
  }
  if (hasEnumerableOwnProperty(source)) {
    input.source = source
  }

  return {
    id,
    sessionId,
    permissionType,
    title,
    input,
  }
}
