import { getModelInfo } from './runtime.ts'
import { resolveDisplayCostForModel, type ModelPricing } from './pricing-core.ts'

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
