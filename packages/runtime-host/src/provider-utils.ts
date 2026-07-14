import type { ModelV2Info, OpencodeClient, ProviderV2Info } from '@opencode-ai/sdk/v2'

export type ProviderLike = {
  id?: string
  name?: string
  models?: Record<string, unknown>
  defaultModel?: string
  connected?: boolean
}

function projectNativeModel(model: ModelV2Info) {
  const baseCost = model.cost[0]
  return {
    ...model,
    cost: baseCost
      ? {
          input: baseCost.input,
          output: baseCost.output,
          cache: baseCost.cache,
        }
      : {},
    variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant])),
  }
}

export function combineNativeProviderCatalog(
  providers: ProviderV2Info[],
  models: ModelV2Info[],
): ProviderLike[] {
  const modelsByProvider = new Map<string, Record<string, unknown>>()
  for (const model of models) {
    const providerModels = modelsByProvider.get(model.providerID) || {}
    providerModels[model.id] = projectNativeModel(model)
    modelsByProvider.set(model.providerID, providerModels)
  }
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: modelsByProvider.get(provider.id) || {},
    // `/api/provider` returns only Catalog.provider.available(), so presence
    // in this response is the native V2 connected/available signal.
    connected: true,
  }))
}

export async function listNativeProviders(client: OpencodeClient): Promise<ProviderLike[]> {
  const [providerResponse, modelResponse] = await Promise.all([
    client.v2.provider.list(undefined, { throwOnError: true }),
    client.v2.model.list(undefined, { throwOnError: true }),
  ])
  return combineNativeProviderCatalog(providerResponse.data.data, modelResponse.data.data)
}
