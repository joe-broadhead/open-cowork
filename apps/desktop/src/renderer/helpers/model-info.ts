import type { ModelInfoSnapshot } from '@open-cowork/shared'

export function modelInfoLookupKeys(providerId: string | null | undefined, modelId: string | null | undefined) {
  if (!modelId) return []
  const keys = new Set<string>([modelId])
  if (providerId && !modelId.startsWith(`${providerId}/`)) {
    keys.add(`${providerId}/${modelId}`)
  }
  if (modelId.includes('/')) {
    keys.add(modelId.split('/').pop() || modelId)
  }
  return Array.from(keys)
}

export function getModelContextLimit(
  info: Pick<ModelInfoSnapshot, 'contextLimits'> | null | undefined,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
) {
  if (!info?.contextLimits) return null
  for (const key of modelInfoLookupKeys(providerId, modelId)) {
    const limit = info.contextLimits[key]
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      return limit
    }
  }
  return null
}
