import { getModelInfo } from '@open-cowork/runtime-host/runtime'
import { resolveDisplayCostForModel } from '@open-cowork/runtime-host/pricing-core'
import type { ModelPricing } from '@open-cowork/shared'
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
