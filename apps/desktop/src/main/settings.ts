import electron from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  SMALL_MODEL_USE_MAIN,
  type AgentColor,
  type AppSettings,
  type EffectiveAppSettings,
  type RuntimePermissionPolicy,
} from '@open-cowork/shared'
import {
  getAppConfig,
  getAppDataDir,
  getProviderDescriptor,
  getPublicAppConfig,
  normalizeProviderModelId,
} from './config-loader.ts'
import { log } from './logger.ts'
import { writeFileAtomic } from './fs-atomic.ts'
import { resolveSecretStorageMode } from './secure-storage-policy.ts'

const electronApp = (electron as { app?: typeof import('electron').app }).app
const electronSafeStorage = (electron as { safeStorage?: typeof import('electron').safeStorage }).safeStorage
const electronSafeStorageBackend = electronSafeStorage as (typeof import('electron').safeStorage & {
  getSelectedStorageBackend?: () => string
}) | undefined

export type CoworkSettings = AppSettings
export type { AgentColor }

let settingsCache: AppSettings | null = null

export const SETTINGS_SCHEMA_VERSION = 8

type NativePermissionDefault = RuntimePermissionPolicy
const MAX_SETTINGS_MAP_ENTRIES = 64
const MAX_SETTINGS_KEY_BYTES = 256
const MAX_SETTINGS_VALUE_BYTES = 64 * 1024
const QUIET_HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const RUNTIME_CONFIG_SOURCES = new Set(['app', 'machine'])
const PERMISSION_POLICY_RANK: Record<RuntimePermissionPolicy, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

class UnsupportedSettingsSchemaVersionError extends Error {
  constructor(version: number) {
    super(`Settings schema version ${version} is newer than supported version ${SETTINGS_SCHEMA_VERSION}.`)
    this.name = 'UnsupportedSettingsSchemaVersionError'
  }
}

export function nativePermissionEnabledByDefault(policy: NativePermissionDefault) {
  return policy !== 'deny'
}

function isRuntimePermissionPolicy(value: unknown): value is RuntimePermissionPolicy {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function clampRuntimePermissionPolicy(
  requested: RuntimePermissionPolicy,
  maximum: RuntimePermissionPolicy,
): RuntimePermissionPolicy {
  return PERMISSION_POLICY_RANK[requested] <= PERMISSION_POLICY_RANK[maximum]
    ? requested
    : maximum
}

function defaultRuntimePermissionPolicy(maximum: RuntimePermissionPolicy): RuntimePermissionPolicy {
  // Keep fresh installs conservative even when a build allows users to opt
  // into no-prompt execution from Settings.
  return maximum === 'deny' ? 'deny' : 'ask'
}

function normalizeRuntimePermissionPolicy(
  requested: unknown,
  maximum: RuntimePermissionPolicy,
): RuntimePermissionPolicy | undefined {
  return isRuntimePermissionPolicy(requested)
    ? clampRuntimePermissionPolicy(requested, maximum)
    : undefined
}

function migrateRuntimePermissionPolicy(
  requested: unknown,
  legacyEnabled: unknown,
  maximum: RuntimePermissionPolicy,
  fallback: RuntimePermissionPolicy,
): RuntimePermissionPolicy {
  const normalized = normalizeRuntimePermissionPolicy(requested, maximum)
  if (normalized) return normalized
  if (legacyEnabled === false) return 'deny'
  if (legacyEnabled === true) return clampRuntimePermissionPolicy('ask', maximum)
  return fallback
}

function resolveProviderModelSelection(
  providerId: string | null,
  providerModels: Array<{ id: string }> | undefined,
  modelId: string | null | undefined,
) {
  const trimmed = modelId?.trim()
  if (!trimmed) return null
  if (!providerId) return trimmed

  const normalized = normalizeProviderModelId(providerId, trimmed)
  if (!providerModels?.length) {
    return !trimmed.includes('/') || trimmed.startsWith(`${providerId}/`) ? normalized : null
  }

  return providerModels.find((model) => model.id === trimmed || model.id === normalized)?.id || null
}

function createDefaults(): AppSettings {
  const config = getPublicAppConfig()
  const appConfig = getAppConfig()
  const defaultProvider = config.providers.defaultProvider
  const defaultProviderDescriptor = config.providers.available.find((provider) => provider.id === defaultProvider)
  const bashPermission = defaultRuntimePermissionPolicy(appConfig.permissions.bash)
  const fileWritePermission = defaultRuntimePermissionPolicy(appConfig.permissions.fileWrite)
  return {
    _schemaVersion: SETTINGS_SCHEMA_VERSION,
    selectedProviderId: defaultProvider,
    selectedModelId: defaultProviderDescriptor?.defaultModel || config.providers.defaultModel,
    selectedSmallModelId: null,
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission,
    fileWritePermission,
    enableBash: nativePermissionEnabledByDefault(bashPermission),
    enableFileWrite: nativePermissionEnabledByDefault(fileWritePermission),
    runtimeConfigSource: 'app',
    runtimeToolingBridgeEnabled: true,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: '22:00',
    workflowQuietHoursEnd: '07:00',
  }
}

function readSettingsSchemaVersion(raw: unknown) {
  if (!raw || typeof raw !== 'object') return 0
  const value = (raw as { _schemaVersion?: unknown })._schemaVersion
  if (typeof value !== 'number') return 0
  return Number.isInteger(value) && value >= 0 ? value : 0
}

function assertSupportedSettingsSchemaVersion(raw: unknown) {
  const version = readSettingsSchemaVersion(raw)
  if (version > SETTINGS_SCHEMA_VERSION) {
    throw new UnsupportedSettingsSchemaVersionError(version)
  }
}

function isUnsupportedSettingsSchemaVersionError(error: unknown) {
  return error instanceof UnsupportedSettingsSchemaVersionError
}

function normalizeBoolMap(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object') return {}
  const next: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(next).length >= MAX_SETTINGS_MAP_ENTRIES) break
    if (typeof raw === 'boolean' && Buffer.byteLength(key, 'utf8') <= MAX_SETTINGS_KEY_BYTES) {
      next[key] = raw
    }
  }
  return next
}

function normalizeStringMap(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  const next: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(next).length >= MAX_SETTINGS_MAP_ENTRIES) break
    if (
      typeof raw === 'string'
      && Buffer.byteLength(key, 'utf8') <= MAX_SETTINGS_KEY_BYTES
      && Buffer.byteLength(raw, 'utf8') <= MAX_SETTINGS_VALUE_BYTES
    ) {
      next[key] = raw
    }
  }
  return next
}

function normalizeNestedStringMap(value: unknown) {
  if (!value || typeof value !== 'object') return {}
  const next: Record<string, Record<string, string>> = {}
  for (const [outerKey, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(next).length >= MAX_SETTINGS_MAP_ENTRIES) break
    if (Buffer.byteLength(outerKey, 'utf8') <= MAX_SETTINGS_KEY_BYTES) {
      next[outerKey] = normalizeStringMap(raw)
    }
  }
  return next
}

function normalizeQuietHours(value: unknown) {
  if (value === null) return null
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return QUIET_HOURS_RE.test(trimmed) ? trimmed : undefined
}

function normalizeRuntimeConfigSource(value: unknown) {
  return RUNTIME_CONFIG_SOURCES.has(value as string) ? value as AppSettings['runtimeConfigSource'] : undefined
}

function normalizeSettingsUpdate(settings: Partial<AppSettings>) {
  const update: Partial<AppSettings> = {}
  const appPermissions = getAppConfig().permissions
  if (typeof settings.selectedProviderId === 'string' && Buffer.byteLength(settings.selectedProviderId, 'utf8') <= MAX_SETTINGS_KEY_BYTES) update.selectedProviderId = settings.selectedProviderId
  if (settings.selectedProviderId === null) update.selectedProviderId = null
  if (typeof settings.selectedModelId === 'string' && Buffer.byteLength(settings.selectedModelId, 'utf8') <= MAX_SETTINGS_KEY_BYTES) update.selectedModelId = settings.selectedModelId
  if (settings.selectedModelId === null) update.selectedModelId = null
  if (typeof settings.selectedSmallModelId === 'string' && Buffer.byteLength(settings.selectedSmallModelId, 'utf8') <= MAX_SETTINGS_KEY_BYTES) update.selectedSmallModelId = settings.selectedSmallModelId
  if (settings.selectedSmallModelId === null) update.selectedSmallModelId = null
  if (settings.providerCredentials !== undefined) update.providerCredentials = normalizeNestedStringMap(settings.providerCredentials)
  if (settings.integrationCredentials !== undefined) update.integrationCredentials = normalizeNestedStringMap(settings.integrationCredentials)
  if (settings.integrationEnabled !== undefined) update.integrationEnabled = normalizeBoolMap(settings.integrationEnabled)
  const bashPermission = normalizeRuntimePermissionPolicy(settings.bashPermission, appPermissions.bash)
  if (bashPermission) {
    update.bashPermission = bashPermission
    update.enableBash = bashPermission !== 'deny'
  } else if (typeof settings.enableBash === 'boolean') {
    update.enableBash = settings.enableBash
    update.bashPermission = settings.enableBash
      ? defaultRuntimePermissionPolicy(appPermissions.bash)
      : 'deny'
  }
  const fileWritePermission = normalizeRuntimePermissionPolicy(settings.fileWritePermission, appPermissions.fileWrite)
  if (fileWritePermission) {
    update.fileWritePermission = fileWritePermission
    update.enableFileWrite = fileWritePermission !== 'deny'
  } else if (typeof settings.enableFileWrite === 'boolean') {
    update.enableFileWrite = settings.enableFileWrite
    update.fileWritePermission = settings.enableFileWrite
      ? defaultRuntimePermissionPolicy(appPermissions.fileWrite)
      : 'deny'
  }
  if (typeof settings.runtimeToolingBridgeEnabled === 'boolean') update.runtimeToolingBridgeEnabled = settings.runtimeToolingBridgeEnabled
  const runtimeConfigSource = normalizeRuntimeConfigSource(settings.runtimeConfigSource)
  if (runtimeConfigSource) update.runtimeConfigSource = runtimeConfigSource
  if (typeof settings.workflowLaunchAtLogin === 'boolean') update.workflowLaunchAtLogin = settings.workflowLaunchAtLogin
  if (typeof settings.workflowRunInBackground === 'boolean') update.workflowRunInBackground = settings.workflowRunInBackground
  if (typeof settings.workflowDesktopNotifications === 'boolean') update.workflowDesktopNotifications = settings.workflowDesktopNotifications
  const quietHoursStart = normalizeQuietHours(settings.workflowQuietHoursStart)
  const quietHoursEnd = normalizeQuietHours(settings.workflowQuietHoursEnd)
  if (quietHoursStart !== undefined) update.workflowQuietHoursStart = quietHoursStart
  if (quietHoursEnd !== undefined) update.workflowQuietHoursEnd = quietHoursEnd
  return update
}

function migrateLegacySettings(raw: any): AppSettings {
  assertSupportedSettingsSchemaVersion(raw)
  const defaults = createDefaults()
  const appPermissions = getAppConfig().permissions
  const bashPermission = migrateRuntimePermissionPolicy(
    raw?.bashPermission,
    raw?.enableBash,
    appPermissions.bash,
    defaults.bashPermission,
  )
  const fileWritePermission = migrateRuntimePermissionPolicy(
    raw?.fileWritePermission,
    raw?.enableFileWrite,
    appPermissions.fileWrite,
    defaults.fileWritePermission,
  )
  const next: AppSettings = {
    ...defaults,
    _schemaVersion: SETTINGS_SCHEMA_VERSION,
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
    selectedSmallModelId: typeof raw?.selectedSmallModelId === 'string'
      ? raw.selectedSmallModelId
      : null,
    providerCredentials: normalizeNestedStringMap(raw?.providerCredentials),
    integrationCredentials: normalizeNestedStringMap(raw?.integrationCredentials),
    integrationEnabled: normalizeBoolMap(raw?.integrationEnabled),
    bashPermission,
    fileWritePermission,
    enableBash: bashPermission !== 'deny',
    enableFileWrite: fileWritePermission !== 'deny',
    runtimeConfigSource: normalizeRuntimeConfigSource(raw?.runtimeConfigSource) || defaults.runtimeConfigSource,
    runtimeToolingBridgeEnabled: raw?.runtimeToolingBridgeEnabled !== false,
    workflowLaunchAtLogin: raw?.workflowLaunchAtLogin === true || raw?.automationLaunchAtLogin === true,
    workflowRunInBackground: raw?.workflowRunInBackground === true || raw?.automationRunInBackground === true,
    workflowDesktopNotifications: raw?.workflowDesktopNotifications !== false && raw?.automationDesktopNotifications !== false,
    workflowQuietHoursStart: typeof raw?.workflowQuietHoursStart === 'string' && raw.workflowQuietHoursStart.trim()
      ? raw.workflowQuietHoursStart.trim()
      : typeof raw?.automationQuietHoursStart === 'string' && raw.automationQuietHoursStart.trim()
        ? raw.automationQuietHoursStart.trim()
        : defaults.workflowQuietHoursStart,
    workflowQuietHoursEnd: typeof raw?.workflowQuietHoursEnd === 'string' && raw.workflowQuietHoursEnd.trim()
      ? raw.workflowQuietHoursEnd.trim()
      : typeof raw?.automationQuietHoursEnd === 'string' && raw.automationQuietHoursEnd.trim()
        ? raw.automationQuietHoursEnd.trim()
        : defaults.workflowQuietHoursEnd,
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
    selectedStorageBackend: electronSafeStorageBackend?.getSelectedStorageBackend?.() || null,
  })
}

export function getSettingsSecretStorageMode() {
  return getSecretStorageMode()
}

function applyWorkflowLaunchAtLogin(settings: AppSettings) {
  try {
    electronApp?.setLoginItemSettings?.({ openAtLogin: settings.workflowLaunchAtLogin })
  } catch (error) {
    log('error', `Failed to apply login item settings: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function applySettingsSideEffects(settings = loadSettings()) {
  applyWorkflowLaunchAtLogin(settings)
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
      if (isUnsupportedSettingsSchemaVersionError(err)) throw err
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
        if (isUnsupportedSettingsSchemaVersionError(err)) throw err
        log('error', `Settings legacy load failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  settingsCache = createDefaults()
  return settingsCache
}

export function clearSettingsCache() {
  settingsCache = null
}

export function saveSettings(settings: Partial<AppSettings>) {
  const current = settingsCache || loadSettings()
  const updates = normalizeSettingsUpdate(settings)
  // Strip mask sentinels so a caller that round-tripped `settings:get`
  // (which returns masked credentials) can't accidentally overwrite
  // real keys with the mask string. Safe because the real value can
  // only have been preserved through the scoped credential IPCs.
  const merged: AppSettings = {
    ...current,
    ...updates,
    _schemaVersion: SETTINGS_SCHEMA_VERSION,
    providerCredentials: mergeNestedStringMaps(current.providerCredentials, stripMaskedValues(updates.providerCredentials)),
    integrationCredentials: mergeNestedStringMaps(current.integrationCredentials, stripMaskedValues(updates.integrationCredentials)),
    integrationEnabled: { ...current.integrationEnabled, ...(updates.integrationEnabled || {}) },
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
  applyWorkflowLaunchAtLogin(merged)
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

export function getProviderCredentials(providerId: string) {
  const credentials = loadSettings().providerCredentials[providerId] || {}
  return { ...credentials }
}

export function getIntegrationCredentials(integrationId: string) {
  const credentials = loadSettings().integrationCredentials[integrationId] || {}
  return { ...credentials }
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
  const appPermissions = getAppConfig().permissions
  const configuredDefaultProvider = config.providers.defaultProvider
  const selectedProvider = settings.selectedProviderId
    ? getProviderDescriptor(settings.selectedProviderId)
    : null
  const providerId = selectedProvider?.id || configuredDefaultProvider
  const provider = getProviderDescriptor(providerId)
  const providerDefaultModel = provider?.defaultModel || (
    providerId === configuredDefaultProvider ? config.providers.defaultModel : null
  )
  const validDefaultModel = resolveProviderModelSelection(providerId, provider?.models, providerDefaultModel)
  const validSelectedModel = resolveProviderModelSelection(providerId, provider?.models, settings.selectedModelId)
  const fallbackModel = validDefaultModel || provider?.models?.[0]?.id || ''
  const selectedModelId = validSelectedModel || fallbackModel
  const appConfig = getAppConfig()
  const configuredSmallModel = provider?.smallModel
    || appConfig.providers.descriptors?.[providerId || '']?.smallModel
    || appConfig.providers.custom?.[providerId || '']?.smallModel
  const validConfiguredSmallModel = resolveProviderModelSelection(providerId, provider?.models, configuredSmallModel)
  const validSelectedSmallModel = settings.selectedSmallModelId === SMALL_MODEL_USE_MAIN
    ? selectedModelId
    : resolveProviderModelSelection(providerId, provider?.models, settings.selectedSmallModelId)
  const effectiveSmallModel = validSelectedSmallModel || validConfiguredSmallModel || selectedModelId
  const bashPermission = clampRuntimePermissionPolicy(
    settings.enableBash === false ? 'deny' : settings.bashPermission,
    appPermissions.bash,
  )
  const fileWritePermission = clampRuntimePermissionPolicy(
    settings.enableFileWrite === false ? 'deny' : settings.fileWritePermission,
    appPermissions.fileWrite,
  )

  return {
    ...settings,
    bashPermission,
    fileWritePermission,
    enableBash: bashPermission !== 'deny',
    enableFileWrite: fileWritePermission !== 'deny',
    effectiveProviderId: providerId,
    effectiveModel: selectedModelId,
    effectiveSmallModel,
  }
}
