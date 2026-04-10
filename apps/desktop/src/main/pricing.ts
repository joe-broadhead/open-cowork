/**
 * Token pricing per model (cost per 1M tokens).
 * Prices approximate Databricks model serving rates.
 * These can be overridden in settings.
 */

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number // cache read discount
}

// Default pricing (USD per 1M tokens)
// Based on typical Databricks serving endpoint costs
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Databricks served models
  'databricks-claude-sonnet-4': { inputPer1M: 3.0, outputPer1M: 15.0, cachePer1M: 0.3 },
  'databricks-claude-opus-4-6': { inputPer1M: 15.0, outputPer1M: 75.0, cachePer1M: 1.5 },
  'databricks-claude-sonnet-4-6': { inputPer1M: 3.0, outputPer1M: 15.0, cachePer1M: 0.3 },
  'databricks-gpt-oss-120b': { inputPer1M: 1.0, outputPer1M: 3.0 },

  // Vertex AI / Google models
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10.0, cachePer1M: 0.315 },
  'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.6, cachePer1M: 0.0375 },
  'gemini-3-pro-preview': { inputPer1M: 1.25, outputPer1M: 10.0 },

  // Fallback for unknown models
  '_default': { inputPer1M: 3.0, outputPer1M: 15.0 },
}

export function calculateCost(
  modelId: string,
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
  customPricing?: Record<string, ModelPricing>,
): number {
  const pricing = customPricing?.[modelId] || DEFAULT_PRICING[modelId] || DEFAULT_PRICING['_default']

  const inputTokens = tokens.input - (tokens.cache?.read || 0) // Non-cached input
  const cacheTokens = tokens.cache?.read || 0
  const outputTokens = tokens.output + (tokens.reasoning || 0) // Reasoning counts as output

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPer1M
  const cacheCost = (cacheTokens / 1_000_000) * (pricing.cachePer1M || pricing.inputPer1M * 0.1)
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPer1M

  return Math.max(0, inputCost + cacheCost + outputCost)
}
