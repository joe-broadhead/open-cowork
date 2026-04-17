import electron from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  AgentColor,
  AppSettings,
  EffectiveAppSettings,
} from '@open-cowork/shared'
import { getAppDataDir, getProviderDescriptor, getPublicAppConfig } from './config-loader.ts'
import { log } from './logger.ts'
import { writeFileAtomic } from './fs-atomic.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const electronSafeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage

export type CoworkSettings = AppSettings
export type { AgentColor }

let settingsCache: AppSettings | null = null

function createDefaults(): AppSettings {
  const config = getPublicAppConfig()
  return {
    selectedProviderId: config.providers.defaultProvider,
    selectedModelId: config.providers.defaultModel,
    providerCredentials: {},
    integrationCredentials: {},
    enableBash: false,
    enableFileWrite: false,
  }
}

function normalizeStringMap(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  const next: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') next[key] = raw
  }
  return next
}

function normalizeNestedStringMap(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  const next: Record<string, Record<string, string>> = {}
  for (const [outerKey, raw] of Object.entries(value as Record<string, unknown>)) {
    next[outerKey] = normalizeStringMap(raw)
  }
  return next
}

function migrateLegacySettings(raw: any): AppSettings {
  const defaults = createDefaults()
  const next: AppSettings = {
    ...defaults,
    selectedProviderId: typeof raw?.selectedProviderId === 'string'
      ? raw.selectedProviderId
      : typeof raw?.provider === 'string'
        ? (raw.provider === 'google-vertex' ? 'vertex' : raw.provider)
        : defaults.selectedProviderId,
    selectedModelId: typeof raw?.selectedModelId === 'string'
      ? raw.selectedModelId
      : typeof raw?.defaultModel === 'string'
        ? raw.defaultModel
        : defaults.selectedModelId,
    providerCredentials: normalizeNestedStringMap(raw?.providerCredentials),
    integrationCredentials: normalizeNestedStringMap(raw?.integrationCredentials),
    enableBash: raw?.enableBash === true,
    enableFileWrite: raw?.enableFileWrite === true,
  }

  const legacyProviderCredentials = next.providerCredentials['google-vertex']
  if (legacyProviderCredentials) {
    next.providerCredentials.vertex = {
      ...(legacyProviderCredentials || {}),
      ...(next.providerCredentials.vertex || {}),
    }
    delete next.providerCredentials['google-vertex']
  }

  const legacyVertex = {
    projectId: typeof raw?.gcpProjectId === 'string' ? raw.gcpProjectId : '',
    location: typeof raw?.gcpRegion === 'string' ? raw.gcpRegion : '',
  }
  if (legacyVertex.projectId || legacyVertex.location) {
    next.providerCredentials.vertex = {
      ...(next.providerCredentials.vertex || {}),
      ...(legacyVertex.projectId ? { projectId: legacyVertex.projectId } : {}),
      ...(legacyVertex.location ? { location: legacyVertex.location } : {}),
    }
  }

  const legacyDatabricks = {
    host: typeof raw?.databricksHost === 'string' ? raw.databricksHost : '',
    token: typeof raw?.databricksToken === 'string' ? raw.databricksToken : '',
  }
  if (legacyDatabricks.host || legacyDatabricks.token) {
    next.providerCredentials.databricks = {
      ...(next.providerCredentials.databricks || {}),
      ...(legacyDatabricks.host ? { host: legacyDatabricks.host } : {}),
      ...(legacyDatabricks.token ? { token: legacyDatabricks.token } : {}),
    }
  }

  if (typeof raw?.githubToken === 'string' && raw.githubToken.trim()) {
    next.integrationCredentials.github = {
      ...(next.integrationCredentials.github || {}),
      token: raw.githubToken.trim(),
    }
  }

  if (typeof raw?.perplexityApiKey === 'string' && raw.perplexityApiKey.trim()) {
    next.integrationCredentials.perplexity = {
      ...(next.integrationCredentials.perplexity || {}),
      apiKey: raw.perplexityApiKey.trim(),
    }
  }

  return next
}

function getSettingsPath() {
  return join(getAppDataDir(), 'settings.enc')
}

function getLegacySettingsPath() {
  return join(getAppDataDir(), 'settings.json')
}

// Sentinel rendered into masked credential fields returned by
// `settings:get`. Defense-in-depth: the same sentinel is stripped by
// `saveSettings()` before writing so a caller that accidentally echoes a
// masked value back can't overwrite the real key with the mask string.
export const CREDENTIAL_MASK = '••••••••'

function maskNestedStringMap(value: Record<string, Record<string, string>>) {
  const masked: Record<string, Record<string, string>> = {}
  for (const [outer, inner] of Object.entries(value)) {
    const innerMasked: Record<string, string> = {}
    for (const [key, v] of Object.entries(inner)) {
      innerMasked[key] = v && v.length > 0 ? CREDENTIAL_MASK : ''
    }
    masked[outer] = innerMasked
  }
  return masked
}

function stripMaskedValues(value: Record<string, Record<string, string>> | undefined) {
  if (!value) return value
  const clean: Record<string, Record<string, string>> = {}
  for (const [outer, inner] of Object.entries(value)) {
    const cleanInner: Record<string, string> = {}
    for (const [key, v] of Object.entries(inner)) {
      if (v === CREDENTIAL_MASK) continue
      cleanInner[key] = v
    }
    clean[outer] = cleanInner
  }
  return clean
}

export function maskEffectiveSettingsCredentials(settings: EffectiveAppSettings): EffectiveAppSettings {
  return {
    ...settings,
    providerCredentials: maskNestedStringMap(settings.providerCredentials),
    integrationCredentials: maskNestedStringMap(settings.integrationCredentials),
  }
}

function mergeNestedStringMaps(
  current: Record<string, Record<string, string>>,
  updates: Record<string, Record<string, string>> | undefined,
) {
  if (!updates) return current
  const next: Record<string, Record<string, string>> = { ...current }
  for (const [outerKey, values] of Object.entries(updates)) {
    next[outerKey] = {
      ...(current[outerKey] || {}),
      ...normalizeStringMap(values),
    }
  }
  return next
}

export function loadSettings(): AppSettings {
  if (settingsCache) return settingsCache

  const encryptedPath = getSettingsPath()
  if (existsSync(encryptedPath) && electronSafeStorage?.isEncryptionAvailable?.()) {
    try {
      const raw = readFileSync(encryptedPath)
      const decrypted = electronSafeStorage.decryptString(raw)
      const result = migrateLegacySettings(JSON.parse(decrypted))
      settingsCache = result
      return result
    } catch (err: any) {
      log('error', `Settings load failed: ${err?.message}`)
    }
  }

  if (!electronApp?.isPackaged) {
    const legacyPath = getLegacySettingsPath()
    if (existsSync(legacyPath)) {
      try {
        const raw = readFileSync(legacyPath, 'utf-8')
        const result = migrateLegacySettings(JSON.parse(raw))
        settingsCache = result
        saveSettings(result)
        return result
      } catch (err: any) {
        log('error', `Settings legacy load failed: ${err?.message}`)
      }
    }
  }

  settingsCache = createDefaults()
  return settingsCache
}

export function saveSettings(settings: Partial<AppSettings>) {
  const current = settingsCache || loadSettings()
  // Strip mask sentinels so a caller that round-tripped `settings:get`
  // (which returns masked credentials) can't accidentally overwrite
  // real keys with the mask string. Safe because the real value can
  // only have been preserved through `settings:get-with-credentials`.
  const merged: AppSettings = {
    ...current,
    ...settings,
    providerCredentials: mergeNestedStringMaps(current.providerCredentials, stripMaskedValues(settings.providerCredentials)),
    integrationCredentials: mergeNestedStringMaps(current.integrationCredentials, stripMaskedValues(settings.integrationCredentials)),
  }

  settingsCache = merged
  const json = JSON.stringify(merged)

  if (electronSafeStorage?.isEncryptionAvailable?.()) {
    // Atomic + 0o600 so a crash mid-write can't leave settings.enc
    // truncated, wiping the user's provider keys on next launch.
    writeFileAtomic(getSettingsPath(), electronSafeStorage.encryptString(json), { mode: 0o600 })
  } else if (!electronApp?.isPackaged) {
    writeFileAtomic(getLegacySettingsPath(), json, { mode: 0o600 })
  } else {
    log('error', 'Cannot save settings: secure storage unavailable in production')
  }

  return getEffectiveSettings()
}

export function getProviderCredentialValue(settings: AppSettings, providerId: string | null | undefined, key: string) {
  if (!providerId) return null
  const value = settings.providerCredentials?.[providerId]?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getIntegrationCredentialValue(settings: AppSettings, integrationId: string, key: string) {
  const value = settings.integrationCredentials?.[integrationId]?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function isSetupComplete(settings = loadSettings()) {
  const effective = getEffectiveSettings(settings)
  if (!effective.effectiveProviderId || !effective.effectiveModel) return false

  const provider = getProviderDescriptor(effective.effectiveProviderId)
  if (!provider) return false

  for (const credential of provider.credentials) {
    if (credential.required === false) continue
    const value = getProviderCredentialValue(settings, effective.effectiveProviderId, credential.key)
    if (!value) return false
  }

  return true
}

export function getEffectiveSettings(settings = loadSettings()): EffectiveAppSettings {
  const config = getPublicAppConfig()
  const configuredDefaultProvider = config.providers.defaultProvider
  const selectedProvider = settings.selectedProviderId
    ? getProviderDescriptor(settings.selectedProviderId)
    : null
  const providerId = selectedProvider?.id || configuredDefaultProvider
  const provider = getProviderDescriptor(providerId)
  const validDefaultModel = config.providers.defaultModel
    && provider?.models?.some((model) => model.id === config.providers.defaultModel)
      ? config.providers.defaultModel
      : null
  const validSelectedModel = settings.selectedModelId
    && provider?.models?.some((model) => model.id === settings.selectedModelId)
      ? settings.selectedModelId
      : null
  const fallbackModel = validDefaultModel || provider?.models?.[0]?.id || config.providers.defaultModel
  const selectedModelId = validSelectedModel || fallbackModel

  return {
    ...settings,
    effectiveProviderId: providerId,
    effectiveModel: selectedModelId,
  }
}
