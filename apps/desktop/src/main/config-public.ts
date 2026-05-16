import type {
  BrandingConfig,
  ProviderDescriptor,
  ProviderModelDescriptor,
  PublicAppConfig,
  ToolTraceRule,
} from '@open-cowork/shared'
import { brandingAssetUrl } from './branding-assets.ts'
import type {
  ConfiguredProviderDescriptor,
  ModelFallbackInfo,
  OpenCoworkConfig,
} from './config-types.ts'
import { modelInfoKeys } from './model-info-utils.ts'
import { getCachedProviderCatalog, scheduleBackgroundRefresh } from './provider-catalog.ts'

// Merge the descriptor's hardcoded `models[]` (marked featured) with the
// latest cached dynamic catalog. Hardcoded entries take priority on
// duplicate ids — the descriptor name wins, and the `featured` flag flags
// it for pinning in the picker. The fetch itself is kicked off in the
// background so subsequent reads eventually pick up fresh data.
function mergeDescriptorModels(
  providerId: string,
  descriptor: ConfiguredProviderDescriptor,
  invalidateCache: () => void,
): ProviderModelDescriptor[] {
  const featured: ProviderModelDescriptor[] = (descriptor.models || []).map((model) => ({
    ...model,
    featured: true,
  }))
  if (!descriptor.dynamicCatalog) return featured

  const dynamic = getCachedProviderCatalog(providerId)
  scheduleBackgroundRefresh(providerId, descriptor.dynamicCatalog, invalidateCache)

  const seen = new Set(featured.map((entry) => entry.id))
  const overlay = dynamic.filter((entry) => !seen.has(entry.id))
  return [...featured, ...overlay]
}

export function normalizeProviderModelId(providerId: string, modelId: string) {
  const trimmed = modelId.trim()
  const prefix = `${providerId}/`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

function resolveModelFromCurrentCatalog(
  providerId: string,
  models: ProviderModelDescriptor[],
  modelId: string | null | undefined,
) {
  if (!modelId?.trim()) return null
  const normalized = normalizeProviderModelId(providerId, modelId)
  if (models.length === 0) return normalized
  return models.find((model) => model.id === modelId || model.id === normalized)?.id || null
}

export function resolveProviderDefaultModel(
  config: OpenCoworkConfig,
  providerId: string,
  models: ProviderModelDescriptor[],
  runtimeDefaultModel?: string | null,
  options: { runtimeCatalogKnown?: boolean } = {},
) {
  const descriptorDefault = config.providers.descriptors?.[providerId]?.defaultModel
  const customDefault = config.providers.custom?.[providerId]?.defaultModel
  const globalDefault = providerId === config.providers.defaultProvider ? config.providers.defaultModel : null
  const descriptorResolved = resolveModelFromCurrentCatalog(providerId, models, descriptorDefault)
  if (descriptorResolved) return descriptorResolved
  const customResolved = resolveModelFromCurrentCatalog(providerId, models, customDefault)
  if (customResolved) return customResolved

  const runtimeModels = options.runtimeCatalogKnown === false ? [] : models
  const runtimeResolved = resolveModelFromCurrentCatalog(providerId, runtimeModels, runtimeDefaultModel)
  if (runtimeResolved) return runtimeResolved

  const globalResolved = resolveModelFromCurrentCatalog(providerId, models, globalDefault)
  if (globalResolved) return globalResolved
  return undefined
}

export function buildProviderDescriptors(
  config: OpenCoworkConfig,
  invalidateCache: () => void,
): ProviderDescriptor[] {
  return config.providers.available.map((providerId) => {
    const builtin = config.providers.descriptors?.[providerId]
    if (builtin) {
      const models = mergeDescriptorModels(providerId, builtin, invalidateCache)
      const defaultModel = resolveProviderDefaultModel(config, providerId, models)
      return {
        id: providerId,
        name: builtin.name,
        description: builtin.description,
        credentials: builtin.credentials || [],
        models,
        ...(defaultModel ? { defaultModel } : {}),
      }
    }

    const custom = config.providers.custom?.[providerId]
    if (!custom) {
      return {
        id: providerId,
        name: providerId,
        description: 'Custom provider',
        credentials: [],
        models: [],
      }
    }

    const models = Object.entries(custom.models || {}).map(([id, info]) => ({
      id,
      name: typeof info?.name === 'string' ? info.name : id,
    }))
    const defaultModel = resolveProviderDefaultModel(config, providerId, models)
    return {
      id: providerId,
      name: custom.name,
      description: custom.description || `${custom.name} custom provider`,
      credentials: custom.credentials || [],
      models,
      ...(defaultModel ? { defaultModel } : {}),
    }
  })
}

export function getProviderDynamicCatalogFromConfig(config: OpenCoworkConfig, providerId: string) {
  return config.providers.descriptors?.[providerId]?.dynamicCatalog || null
}

export function findProviderDescriptor(
  providers: ProviderDescriptor[],
  providerId: string | null | undefined,
) {
  if (!providerId) return null
  return providers.find((provider) => provider.id === providerId) || null
}

function resolvePublicBranding(branding: BrandingConfig): BrandingConfig {
  const top = branding.sidebar?.top
  if (!top?.logoAsset) return branding

  const logoUrl = brandingAssetUrl(top.logoAsset)
  const nextTop = {
    ...top,
    ...(logoUrl
      ? { logoUrl, logoDataUrl: undefined }
      : {}),
  }
  return {
    ...branding,
    sidebar: {
      ...branding.sidebar,
      top: nextTop,
    },
  }
}

export function buildPublicAppConfig(
  config: OpenCoworkConfig,
  providers: ProviderDescriptor[],
): PublicAppConfig {
  const toolTraceRules: ToolTraceRule[] = [
    ...(config.toolTrace?.additionalRules || []),
    ...(config.toolTrace?.rules || []),
  ]
  return {
    branding: resolvePublicBranding(config.branding),
    auth: {
      mode: config.auth.mode,
      enabled: config.auth.mode !== 'none',
    },
    providers: {
      available: providers,
      defaultProvider: config.providers.defaultProvider,
      defaultModel: config.providers.defaultModel,
    },
    permissions: {
      bash: config.permissions.bash,
      fileWrite: config.permissions.fileWrite,
    },
    agentStarterTemplates: config.agentStarterTemplates || [],
    toolTrace: {
      rules: toolTraceRules,
    },
    // Pass through the i18n overlay if present — renderer code reads
    // `config.i18n` via the public-config IPC. Absent block is treated
    // as "use inline English + host locale."
    ...(config.i18n ? { i18n: config.i18n } : {}),
  }
}

export function buildConfiguredModelFallbacks(config: OpenCoworkConfig): ModelFallbackInfo {
  const pricing: ModelFallbackInfo['pricing'] = {}
  const contextLimits: ModelFallbackInfo['contextLimits'] = {}

  const addModelInfo = (providerId: string | undefined, modelId: string, rawModel: unknown) => {
    const model = rawModel as Record<string, any>
    const cost = model?.cost
    if (cost && typeof cost === 'object') {
      const inputPer1M = typeof cost.input === 'number' ? cost.input : 0
      const outputPer1M = typeof cost.output === 'number' ? cost.output : 0
      const cachePer1M = typeof cost.cache_read === 'number' ? cost.cache_read : undefined
      const cacheWritePer1M = typeof cost.cache_write === 'number' ? cost.cache_write : undefined
      if (inputPer1M > 0 || outputPer1M > 0 || (cachePer1M || 0) > 0 || (cacheWritePer1M || 0) > 0) {
        const modelPricing = {
          inputPer1M,
          outputPer1M,
          ...(cachePer1M !== undefined ? { cachePer1M } : {}),
          ...(cacheWritePer1M !== undefined ? { cacheWritePer1M } : {}),
        }
        for (const key of modelInfoKeys(providerId, modelId)) {
          pricing[key] = modelPricing
        }
      }
    }

    const context = model?.limit?.context
    if (typeof context === 'number' && context > 0) {
      for (const key of modelInfoKeys(providerId, modelId)) {
        contextLimits[key] = context
      }
    }
  }

  for (const [providerId, descriptor] of Object.entries(config.providers.descriptors || {})) {
    for (const model of descriptor.models || []) {
      addModelInfo(providerId, model.id, model)
    }
  }

  for (const [providerId, provider] of Object.entries(config.providers.custom || {})) {
    for (const [modelId, rawModel] of Object.entries(provider.models || {})) {
      addModelInfo(providerId, modelId, rawModel)
    }
  }

  for (const [modelId, modelInfo] of Object.entries(config.providers.modelInfo || {})) {
    addModelInfo(undefined, modelId, modelInfo)
  }

  return { pricing, contextLimits }
}
