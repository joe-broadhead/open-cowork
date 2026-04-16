export type ProviderLike = {
  id?: string
  name?: string
  models?: Record<string, unknown>
}

// SDK v2 `provider.list` returns { all: Array<Provider>, default, connected } —
// see types.gen.d.ts:3600. We narrow the `all` array to ProviderLike so the
// caller does not have to care about unexpected fields.
export function normalizeProviderListResponse(raw: unknown): ProviderLike[] {
  if (!raw || typeof raw !== 'object') return []
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.all)) return []
  return value.all.filter(isProviderLike)
}

function isProviderLike(value: unknown): value is ProviderLike {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const hasName = typeof record.id === 'string' || typeof record.name === 'string'
  const hasModels = record.models === undefined || typeof record.models === 'object'
  return hasName && hasModels
}
