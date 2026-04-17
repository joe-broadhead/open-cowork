import type { ModelInfoSnapshot } from '@open-cowork/shared'
import { asRecord } from './opencode-adapter.ts'

// Merge normalized provider/model data from `client.provider.list()` with
// the configured fallbacks (pricing + context limits pulled from the local
// `open-cowork.config.json`). Kept as a pure function separate from
// `runtime.ts` so the fallback + merge logic is unit-testable without
// booting Electron + the SDK client.
//
// Contract:
// - When the live provider data is empty we return the fallbacks verbatim.
// - When it's non-empty we start from the fallbacks (so curated local
//   pricing for models the provider doesn't expose stays in place) and
//   overlay any per-model entries the provider returned.
// - We only overlay pricing for a model when at least one of its cost
//   fields (input, output, cache_read) is a positive number — zero /
//   missing costs don't replace a real configured fallback.

export function buildModelInfoSnapshot(
  providers: Array<{ models?: Record<string, unknown> | null }>,
  fallbacks: ModelInfoSnapshot,
): ModelInfoSnapshot {
  if (!providers.length) {
    return { pricing: { ...fallbacks.pricing }, contextLimits: { ...fallbacks.contextLimits } }
  }

  const pricing: ModelInfoSnapshot['pricing'] = { ...fallbacks.pricing }
  const contextLimits: ModelInfoSnapshot['contextLimits'] = { ...fallbacks.contextLimits }

  for (const provider of providers) {
    const models = provider.models || {}
    for (const [modelId, rawInfo] of Object.entries(models)) {
      const info = asRecord(rawInfo)
      const cost = asRecord(info.cost)
      const limit = asRecord(info.limit)
      if (Object.keys(cost).length > 0) {
        const inputPer1M = typeof cost.input === 'number' ? cost.input : 0
        const outputPer1M = typeof cost.output === 'number' ? cost.output : 0
        const cachePer1M = typeof cost.cache_read === 'number' ? cost.cache_read : undefined
        if (inputPer1M > 0 || outputPer1M > 0 || (cachePer1M || 0) > 0) {
          pricing[modelId] = {
            inputPer1M,
            outputPer1M,
            ...(cachePer1M ? { cachePer1M } : {}),
          }
        }
      }
      if (typeof limit.context === 'number') {
        contextLimits[modelId] = limit.context
      }
    }
  }

  return { pricing, contextLimits }
}
