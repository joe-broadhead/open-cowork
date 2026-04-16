import type { RuntimeInputDiagnostics } from '@open-cowork/shared'
import { getAppConfig, getPublicAppConfig, getProviderDescriptor, resolveCustomProviderConfig } from './config-loader.ts'
import { getEffectiveSettings } from './settings.ts'
import { buildEffectiveProviderRuntimeConfig } from './runtime-config-builder.ts'
import { getBundledOpencodeVersion } from './runtime-opencode-cli.ts'

function isSensitiveOptionKey(key: string) {
  return /(token|secret|password|authorization|headers?|cookie|api[-_]?key|private[-_]?key)/i.test(key)
}

function sanitizeProviderOptions(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      if (isSensitiveOptionKey(key)) return []
      if (Array.isArray(entry)) {
        return [[key, entry]]
      }
      if (entry && typeof entry === 'object') {
        const nested = sanitizeProviderOptions(entry)
        return Object.keys(nested).length > 0 ? [[key, nested]] : []
      }
      return [[key, entry]]
    }),
  )
}

function getProviderSource(selectedProviderId: string | null, effectiveProviderId: string | null, defaultProviderId: string | null): RuntimeInputDiagnostics['providerSource'] {
  if (selectedProviderId && selectedProviderId === effectiveProviderId) return 'settings'
  if (!selectedProviderId && effectiveProviderId === defaultProviderId) return 'default'
  return 'fallback'
}

function getModelSource(selectedModelId: string | null, effectiveModelId: string | null, defaultModelId: string | null): RuntimeInputDiagnostics['modelSource'] {
  if (selectedModelId && selectedModelId === effectiveModelId) return 'settings'
  if (!selectedModelId && effectiveModelId === defaultModelId) return 'default'
  return 'fallback'
}

export function getRuntimeInputDiagnostics(): RuntimeInputDiagnostics {
  const publicConfig = getPublicAppConfig()
  const settings = getEffectiveSettings()
  const providerId = settings.effectiveProviderId
  const modelId = settings.effectiveModel
  const providerDescriptor = getProviderDescriptor(providerId)
  const isBuiltinProvider = Boolean(providerId && getAppConfig().providers.descriptors?.[providerId]?.runtime === 'builtin')
  const customProviderConfig = providerId ? resolveCustomProviderConfig(providerId) : null
  const effectiveProviderConfig = providerId
    ? buildEffectiveProviderRuntimeConfig(providerId, settings, providerId)
    : null
  const providerOptions = sanitizeProviderOptions(effectiveProviderConfig?.options)
  const credentialOverrideKeys = providerId
    ? Object.entries(settings.providerCredentials?.[providerId] || {})
      .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
      .map(([key]) => key)
      .sort()
    : []

  return {
    opencodeVersion: getBundledOpencodeVersion(),
    providerId,
    providerName: providerDescriptor?.name || null,
    providerPackage: isBuiltinProvider ? null : (customProviderConfig?.npm || null),
    modelId,
    runtimeModel: providerId && modelId ? `${providerId}/${modelId}` : (providerId || null),
    defaultProviderId: publicConfig.providers.defaultProvider,
    defaultModelId: publicConfig.providers.defaultModel,
    providerSource: getProviderSource(settings.selectedProviderId, providerId, publicConfig.providers.defaultProvider),
    modelSource: getModelSource(settings.selectedModelId, modelId, publicConfig.providers.defaultModel),
    providerOptions,
    credentialOverrideKeys,
  }
}
