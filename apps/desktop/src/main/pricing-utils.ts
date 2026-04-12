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

export function resolveMeaningfulCost(reportedCost: number | undefined, estimatedCost: number) {
  const safeReportedCost = typeof reportedCost === 'number' && Number.isFinite(reportedCost)
    ? Math.max(0, reportedCost)
    : 0
  const safeEstimatedCost = Number.isFinite(estimatedCost) ? Math.max(0, estimatedCost) : 0

  if (safeEstimatedCost <= 0) return safeReportedCost
  if (safeReportedCost <= 0) return safeEstimatedCost

  // Some custom-provider step-finish payloads report cost in a smaller unit than the
  // per-token pricing we use for display. Only override when the mismatch is extreme.
  if (safeReportedCost * 1000 < safeEstimatedCost) {
    return safeEstimatedCost
  }

  return safeReportedCost
}
