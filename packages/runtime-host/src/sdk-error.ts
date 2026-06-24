import { asRecord, readString } from '@open-cowork/shared'
function stringifyBody(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  if (!value || typeof value !== 'object') return null
  try {
    const text = JSON.stringify(value)
    return text && text !== '{}' ? text : null
  } catch {
    return null
  }
}

export function sdkErrorMessage(error: unknown, fallback = 'OpenCode SDK request failed') {
  const record = asRecord(error)
  const cause = asRecord(record.cause)
  return readString(cause.message)
    || stringifyBody(cause.body)
    || readString(record.message)
    || stringifyBody(error)
    || fallback
}
