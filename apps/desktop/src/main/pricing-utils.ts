export interface ModelPricingLike {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number
}

export function normalizeModelId(modelId: string) {
  return modelId.includes('/') ? modelId.split('/').pop() || modelId : modelId
}

export function getMeaningfulSdkPricing(
  pricing: Record<string, ModelPricingLike> | undefined,
  modelId: string,
  normalizedModelId = normalizeModelId(modelId),
) {
  if (!pricing) return null

  const candidate = pricing[modelId] || pricing[normalizedModelId]
  if (!candidate) return null

  const hasPositiveValue = candidate.inputPer1M > 0
    || candidate.outputPer1M > 0
    || (candidate.cachePer1M || 0) > 0

  return hasPositiveValue ? candidate : null
}
