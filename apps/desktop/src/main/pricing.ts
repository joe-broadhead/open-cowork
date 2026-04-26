import { getModelInfo } from './runtime.ts'
import { calculateCostForModel, resolveDisplayCostForModel, type ModelPricing } from './pricing-core.ts'

export function calculateCost(
  modelId: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
): number {
  return calculateCostForModel(modelId, tokens, getModelInfo()?.pricing as Record<string, ModelPricing> | undefined)
}

export function resolveDisplayCost(
  modelId: string,
  reportedCost: number | undefined,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
): number {
  return resolveDisplayCostForModel(
    modelId,
    reportedCost,
    tokens,
    getModelInfo()?.pricing as Record<string, ModelPricing> | undefined,
  )
}
