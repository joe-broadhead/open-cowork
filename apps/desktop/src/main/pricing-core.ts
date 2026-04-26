import { getMeaningfulSdkPricing, normalizeModelId, resolveMeaningfulCost } from './pricing-utils.ts'

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number
  cacheWritePer1M?: number
}

function resolvePricing(
  modelId: string,
  sdkPricingCatalog?: Record<string, ModelPricing> | null,
) {
  const normalizedModelId = normalizeModelId(modelId)
  return getMeaningfulSdkPricing(sdkPricingCatalog || undefined, modelId, normalizedModelId)
}

function estimateCostForModel(
  modelId: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  sdkPricingCatalog?: Record<string, ModelPricing> | null,
): number | null {
  const pricing = resolvePricing(modelId, sdkPricingCatalog)
  if (!pricing) return null

  const cacheTokens = tokens.cache?.read || 0
  const cacheWriteTokens = tokens.cache?.write || 0
  const inputTokens = Math.max(0, tokens.input - cacheTokens - cacheWriteTokens)
  const outputTokens = tokens.output + (tokens.reasoning || 0)

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M
  const cacheCost = (cacheTokens / 1_000_000) * (pricing.cachePer1M ?? pricing.inputPer1M)
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * (pricing.cacheWritePer1M ?? pricing.inputPer1M)
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M

  return Math.max(0, inputCost + cacheCost + cacheWriteCost + outputCost)
}

export function calculateCostForModel(
  modelId: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  sdkPricingCatalog?: Record<string, ModelPricing> | null,
): number {
  return estimateCostForModel(modelId, tokens, sdkPricingCatalog) ?? 0
}

export function resolveDisplayCostForModel(
  modelId: string,
  reportedCost: number | undefined,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  sdkPricingCatalog?: Record<string, ModelPricing> | null,
): number {
  const hasTokens = tokens.input > 0 || tokens.output > 0 || tokens.reasoning > 0 || (tokens.cache?.read || 0) > 0
  if (!hasTokens) {
    return typeof reportedCost === 'number' && Number.isFinite(reportedCost)
      ? Math.max(0, reportedCost)
      : 0
  }

  const estimatedCost = estimateCostForModel(modelId, tokens, sdkPricingCatalog)
  if (estimatedCost === null) {
    return typeof reportedCost === 'number' && Number.isFinite(reportedCost)
      ? Math.max(0, reportedCost)
      : 0
  }
  return resolveMeaningfulCost(reportedCost, estimatedCost)
}
