export type ProviderLike = {
  id?: string
  name?: string
  models?: Record<string, unknown>
}

export function normalizeProviderListResponse(raw: unknown): ProviderLike[] {
  if (Array.isArray(raw)) {
    return raw.filter(isProviderLike)
  }

  if (!raw || typeof raw !== 'object') {
    return []
  }

  const value = raw as Record<string, unknown>

  if (Array.isArray(value.all)) {
    return value.all.filter(isProviderLike)
  }

  if (Array.isArray(value.providers)) {
    return value.providers.filter(isProviderLike)
  }

  return Object.values(value).filter(isProviderLike)
}

function isProviderLike(value: unknown): value is ProviderLike {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const hasName = typeof record.id === 'string' || typeof record.name === 'string'
  const hasModels = record.models === undefined || typeof record.models === 'object'
  return hasName && hasModels
}
