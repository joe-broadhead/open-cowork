import { getModelInfo } from './runtime'

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number
}

// Fallback pricing — used only when SDK doesn't provide model cost data
const FALLBACK_PRICING: Record<string, ModelPricing> = {
  'databricks-claude-sonnet-4': { inputPer1M: 3.0, outputPer1M: 15.0, cachePer1M: 0.3 },
  'databricks-claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0, cachePer1M: 1.5 },
  'databricks-claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0, cachePer1M: 0.3 },
  'databricks-gpt-oss-120b': { inputPer1M: 1.0, outputPer1M: 3.0 },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0, cachePer1M: 0.315 },
  'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.6, cachePer1M: 0.0375 },
  '_default': { inputPer1M: 3.0, outputPer1M: 15.0 },
}

export function calculateCost(
  modelId: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
): number {
  // Try SDK pricing first, fall back to hardcoded
  const sdkPricing = getModelInfo()?.pricing[modelId]
  const pricing = sdkPricing || FALLBACK_PRICING[modelId] || FALLBACK_PRICING['_default']

  const inputTokens = tokens.input - (tokens.cache?.read || 0)
  const cacheTokens = tokens.cache?.read || 0
  const outputTokens = tokens.output + (tokens.reasoning || 0)

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M
  const cacheCost = (cacheTokens / 1_000_000) * (pricing.cachePer1M || pricing.inputPer1M * 0.1)
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M

  return Math.max(0, inputCost + cacheCost + outputCost)
}
