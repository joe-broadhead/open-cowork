export type ProviderLike = {
  id?: string
  name?: string
  models?: Record<string, unknown>
  defaultModel?: string
  connected?: boolean
}

// SDK v2 `provider.list` returns { all: Array<Provider>, default, connected } —
// see types.gen.d.ts:3600. We narrow the `all` array to ProviderLike so the
// caller does not have to care about unexpected fields, while preserving the
// OpenCode-owned default model and auth/connected state.
export function normalizeProviderListResponse(raw: unknown): ProviderLike[] {
  if (!raw || typeof raw !== 'object') return []
  const value = raw as Record<string, unknown>
  if (!Array.isArray(value.all)) return []
  const defaults = value.default && typeof value.default === 'object'
    ? value.default as Record<string, unknown>
    : {}
  const connected = new Set(
    Array.isArray(value.connected)
      ? value.connected.filter((entry): entry is string => typeof entry === 'string')
      : [],
  )

  return value.all.filter(isProviderLike).map((provider) => {
    const id = provider.id || provider.name
    const defaultModel = id && typeof defaults[id] === 'string' ? defaults[id] : undefined
    return {
      ...provider,
      ...(defaultModel ? { defaultModel } : {}),
      ...(id ? { connected: connected.has(id) } : {}),
    }
  })
}

function isProviderLike(value: unknown): value is ProviderLike {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const hasName = typeof record.id === 'string' || typeof record.name === 'string'
  const hasModels = record.models === undefined || typeof record.models === 'object'
  return hasName && hasModels
}
