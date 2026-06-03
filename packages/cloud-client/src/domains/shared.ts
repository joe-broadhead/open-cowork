export type CloudDomainRequestInit = {
  method?: string
  body?: unknown
}

export type CloudDomainRequest = <T>(
  path: string,
  init?: CloudDomainRequestInit,
) => Promise<T>

export type CloudDomainClientContext = {
  request: CloudDomainRequest
}

export function encodePath(value: string) {
  return encodeURIComponent(value)
}

export function queryString(input: Record<string, unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry) params.append(key, entry)
      }
    } else if (typeof value === 'string' && value) {
      params.set(key, value)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      params.set(key, String(value))
    }
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

export function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

export function readNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
