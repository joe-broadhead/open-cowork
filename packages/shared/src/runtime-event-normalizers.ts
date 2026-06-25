import {
  asRecord,
  readRecordValue,
  readString,
} from './normalizer-utils.js'

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
    const payload = error && Object.keys(error).length > 0
      ? error
      : properties && Object.keys(properties).length > 0
        ? properties
        : null
    if (payload) {
      const serialized = JSON.stringify(payload)
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
    if (Object.keys(nested).length > 0) return nested
  }
  return null
}

export function normalizePermissionEvent(properties: Record<string, unknown> | null | undefined) {
  const permission = readNestedRecord(properties, ['permission', 'info', 'request'])
  const id = readFirstString(permission, ['id', 'requestID', 'requestId'])
    || readFirstString(properties, ['id', 'requestID', 'requestId'])
  const sessionId = readFirstString(permission, ['sessionID', 'sessionId'])
    || readFirstString(properties, ['sessionID', 'sessionId'])
  const permissionType = readFirstString(permission, ['type', 'permission'])
    || readFirstString(properties, ['type', 'permission'])
    || 'permission'
  const title = readFirstString(permission, ['title', 'tool', 'name'])
    || readFirstString(properties, ['title', 'tool', 'name'])
    || permissionType
  const metadata = asRecord(readRecordValue(permission, 'metadata'))
  const outerMetadata = asRecord(readRecordValue(properties, 'metadata'))
  const nestedInput = asRecord(readRecordValue(permission, 'input'))
  const outerInput = asRecord(readRecordValue(properties, 'input'))
  let input = outerInput
  if (Object.keys(nestedInput).length > 0) input = nestedInput
  if (Object.keys(outerMetadata).length > 0) input = outerMetadata
  if (Object.keys(metadata).length > 0) input = metadata

  return {
    id,
    sessionId,
    permissionType,
    title,
    input,
  }
}
