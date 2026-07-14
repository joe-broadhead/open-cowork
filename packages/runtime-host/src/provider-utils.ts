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
    id: model.id,
    providerID: model.providerID,
    name: model.name,
    ...(model.family ? { family: model.family } : {}),
    capabilities: {
      tools: model.capabilities.tools,
      input: [...model.capabilities.input],
      output: [...model.capabilities.output],
    },
    time: { released: model.time.released },
    cost: baseCost
      ? {
          input: baseCost.input,
          output: baseCost.output,
          cache: {
            read: baseCost.cache.read,
            write: baseCost.cache.write,
          },
        }
      : {},
    status: model.status,
    enabled: model.enabled,
    limit: {
      context: model.limit.context,
      ...(model.limit.input === undefined ? {} : { input: model.limit.input }),
      output: model.limit.output,
    },
    // Renderer consumers need only stable identifiers and availability.
    // Native V2 variant headers/bodies are request transport and may contain
    // credentials, so never project them across the IPC boundary.
    variants: Object.fromEntries(model.variants.map((variant) => [
      variant.id,
      {
        id: variant.id,
        ...((variant as unknown as { disabled?: unknown }).disabled === true ? { disabled: true } : {}),
      },
    ])),
  }
}

export function combineNativeProviderCatalog(
  providers: ProviderV2Info[],
  models: ModelV2Info[],
): ProviderLike[] {
  const modelsByProvider = new Map<string, Map<string, unknown>>()
  for (const model of models) {
    const providerModels = modelsByProvider.get(model.providerID) || new Map<string, unknown>()
    providerModels.set(model.id, projectNativeModel(model))
    modelsByProvider.set(model.providerID, providerModels)
  }
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    models: Object.fromEntries(modelsByProvider.get(provider.id) || []),
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
