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
import { resolveSecretStorageMode } from './secure-storage-policy.ts'

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
    integrationEnabled: {},
    enableBash: false,
    enableFileWrite: false,
    automationLaunchAtLogin: false,
    automationRunInBackground: false,
    automationDesktopNotifications: true,
    automationQuietHoursStart: '22:00',
    automationQuietHoursEnd: '07:00',
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'planning_only',
  }
}

function normalizeBoolMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const next: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'boolean') next[key] = raw
  }
  return next
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
    integrationEnabled: normalizeBoolMap(raw?.integrationEnabled),
    enableBash: raw?.enableBash === true,
    enableFileWrite: raw?.enableFileWrite === true,
    automationLaunchAtLogin: raw?.automationLaunchAtLogin === true,
    automationRunInBackground: raw?.automationRunInBackground === true,
    automationDesktopNotifications: raw?.automationDesktopNotifications !== false,
    automationQuietHoursStart: typeof raw?.automationQuietHoursStart === 'string' && raw.automationQuietHoursStart.trim()
      ? raw.automationQuietHoursStart.trim()
      : defaults.automationQuietHoursStart,
    automationQuietHoursEnd: typeof raw?.automationQuietHoursEnd === 'string' && raw.automationQuietHoursEnd.trim()
      ? raw.automationQuietHoursEnd.trim()
      : defaults.automationQuietHoursEnd,
    defaultAutomationAutonomyPolicy: raw?.defaultAutomationAutonomyPolicy === 'mostly-autonomous'
      ? 'mostly-autonomous'
      : defaults.defaultAutomationAutonomyPolicy,
    defaultAutomationExecutionMode: raw?.defaultAutomationExecutionMode === 'scoped_execution'
      ? 'scoped_execution'
      : defaults.defaultAutomationExecutionMode,
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

function getSecretStorageMode() {
  return resolveSecretStorageMode({
    isPackaged: Boolean(electronApp?.isPackaged),
    encryptionAvailable: Boolean(electronSafeStorage?.isEncryptionAvailable?.()),
  })
}

function applyAutomationLaunchAtLogin(settings: AppSettings) {
  try {
    electronApp?.setLoginItemSettings?.({ openAtLogin: settings.automationLaunchAtLogin })
  } catch (error) {
    log('error', `Failed to apply login item settings: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function applySettingsSideEffects(settings = loadSettings()) {
  applyAutomationLaunchAtLogin(settings)
}

function requireSafeStorage() {
  if (!electronSafeStorage) {
    throw new Error('Electron safeStorage is unavailable')
  }
  return electronSafeStorage
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
  if (existsSync(encryptedPath) && getSecretStorageMode() === 'encrypted') {
    try {
      const safeStorage = requireSafeStorage()
      const raw = readFileSync(encryptedPath)
      const decrypted = safeStorage.decryptString(raw)
      const result = migrateLegacySettings(JSON.parse(decrypted))
      settingsCache = result
      return result
    } catch (err: unknown) {
      log('error', `Settings load failed: ${err instanceof Error ? err.message : String(err)}`)
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
      } catch (err: unknown) {
        log('error', `Settings legacy load failed: ${err instanceof Error ? err.message : String(err)}`)
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
    integrationEnabled: { ...current.integrationEnabled, ...(settings.integrationEnabled || {}) },
  }

  const json = JSON.stringify(merged)
  const storageMode = getSecretStorageMode()

  if (storageMode === 'encrypted') {
    const safeStorage = requireSafeStorage()
    // Atomic + 0o600 so a crash mid-write can't leave settings.enc
    // truncated, wiping the user's provider keys on next launch.
    writeFileAtomic(getSettingsPath(), safeStorage.encryptString(json), { mode: 0o600 })
  } else if (storageMode === 'plaintext') {
    writeFileAtomic(getLegacySettingsPath(), json, { mode: 0o600 })
  } else {
    const message = 'Secure storage unavailable on this system. Open Cowork cannot persist settings in production without OS-backed secret storage.'
    log('error', message)
    throw new Error(message)
  }

  settingsCache = merged
  applyAutomationLaunchAtLogin(merged)
  return getEffectiveSettings(merged)
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
  const hasConfiguredModelList = Boolean(provider?.models?.length)
  const validDefaultModel = config.providers.defaultModel
    && provider?.models?.some((model) => model.id === config.providers.defaultModel)
      ? config.providers.defaultModel
      : null
  const validSelectedModel = settings.selectedModelId
    && (!hasConfiguredModelList || provider?.models?.some((model) => model.id === settings.selectedModelId))
      ? settings.selectedModelId
      : null
  const fallbackModel = validDefaultModel || provider?.models?.[0]?.id || (hasConfiguredModelList ? config.providers.defaultModel : '')
  const selectedModelId = validSelectedModel || fallbackModel

  return {
    ...settings,
    effectiveProviderId: providerId,
    effectiveModel: selectedModelId,
  }
}
