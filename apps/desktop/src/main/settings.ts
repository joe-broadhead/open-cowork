import electron from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type {
  AgentColor,
  AppSettings,
  AutonomyLevel,
  EffectiveAppSettings,
  RuntimePermissionPolicy,
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

export type CoworkSettings = AppSettings
export type { AgentColor }

let settingsCache: AppSettings | null = null

export const SETTINGS_SCHEMA_VERSION = 5

type NativePermissionDefault = RuntimePermissionPolicy
const MAX_SETTINGS_MAP_ENTRIES = 64
const MAX_SETTINGS_KEY_BYTES = 256
const MAX_SETTINGS_VALUE_BYTES = 64 * 1024
const QUIET_HOURS_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const OPERATIONAL_AUTONOMY_LEVELS = new Set<AutonomyLevel>(['observe', 'draft', 'approve', 'supervised', 'bounded-auto'])
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
    providerCredentials: {},
    integrationCredentials: {},
    integrationEnabled: {},
    bashPermission,
    fileWritePermission,
    enableBash: nativePermissionEnabledByDefault(bashPermission),
    enableFileWrite: nativePermissionEnabledByDefault(fileWritePermission),
    runtimeToolingBridgeEnabled: true,
    automationLaunchAtLogin: false,
    automationRunInBackground: false,
    automationDesktopNotifications: true,
    automationQuietHoursStart: '22:00',
    automationQuietHoursEnd: '07:00',
    defaultAutomationAutonomyPolicy: 'review-first',
    defaultAutomationExecutionMode: 'planning_only',
    operationalMaxAutonomy: 'supervised',
    operationalWriteMaxParallel: 1,
    operationalMaxRunDurationMinutes: 120,
    operationalMaxCostUsd: null,
    operationalMaxRetries: 10,
    improvementProposalsEnabled: true,
    improvementProposalsDisabledAgents: {},
    improvementProposalsDisabledProjects: {},
    improvementProposalsDisabledCrews: {},
    dreamConsolidationScheduleEnabled: false,
    dreamConsolidationIntervalHours: 168,
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

function normalizeAutonomyLevel(value: unknown) {
  return OPERATIONAL_AUTONOMY_LEVELS.has(value as AutonomyLevel) ? value as AutonomyLevel : undefined
}

function normalizeInteger(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function normalizeNullableCostUsd(value: unknown) {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(10_000, Math.round(value * 100) / 100))
}

function normalizeSettingsUpdate(settings: Partial<AppSettings>) {
  const update: Partial<AppSettings> = {}
  const appPermissions = getAppConfig().permissions
  if (typeof settings.selectedProviderId === 'string' && Buffer.byteLength(settings.selectedProviderId, 'utf8') <= MAX_SETTINGS_KEY_BYTES) update.selectedProviderId = settings.selectedProviderId
  if (settings.selectedProviderId === null) update.selectedProviderId = null
  if (typeof settings.selectedModelId === 'string' && Buffer.byteLength(settings.selectedModelId, 'utf8') <= MAX_SETTINGS_KEY_BYTES) update.selectedModelId = settings.selectedModelId
  if (settings.selectedModelId === null) update.selectedModelId = null
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
  if (typeof settings.automationLaunchAtLogin === 'boolean') update.automationLaunchAtLogin = settings.automationLaunchAtLogin
  if (typeof settings.automationRunInBackground === 'boolean') update.automationRunInBackground = settings.automationRunInBackground
  if (typeof settings.automationDesktopNotifications === 'boolean') update.automationDesktopNotifications = settings.automationDesktopNotifications
  const quietHoursStart = normalizeQuietHours(settings.automationQuietHoursStart)
  const quietHoursEnd = normalizeQuietHours(settings.automationQuietHoursEnd)
  if (quietHoursStart !== undefined) update.automationQuietHoursStart = quietHoursStart
  if (quietHoursEnd !== undefined) update.automationQuietHoursEnd = quietHoursEnd
  if (settings.defaultAutomationAutonomyPolicy === 'review-first' || settings.defaultAutomationAutonomyPolicy === 'mostly-autonomous') {
    update.defaultAutomationAutonomyPolicy = settings.defaultAutomationAutonomyPolicy
  }
  if (settings.defaultAutomationExecutionMode === 'planning_only' || settings.defaultAutomationExecutionMode === 'scoped_execution') {
    update.defaultAutomationExecutionMode = settings.defaultAutomationExecutionMode
  }
  const operationalMaxAutonomy = normalizeAutonomyLevel(settings.operationalMaxAutonomy)
  if (operationalMaxAutonomy) update.operationalMaxAutonomy = operationalMaxAutonomy
  const operationalWriteMaxParallel = normalizeInteger(settings.operationalWriteMaxParallel, 1, 10)
  if (operationalWriteMaxParallel !== undefined) update.operationalWriteMaxParallel = operationalWriteMaxParallel
  const operationalMaxRunDurationMinutes = normalizeInteger(settings.operationalMaxRunDurationMinutes, 1, 24 * 60)
  if (operationalMaxRunDurationMinutes !== undefined) update.operationalMaxRunDurationMinutes = operationalMaxRunDurationMinutes
  const operationalMaxCostUsd = normalizeNullableCostUsd(settings.operationalMaxCostUsd)
  if (operationalMaxCostUsd !== undefined) update.operationalMaxCostUsd = operationalMaxCostUsd
  const operationalMaxRetries = normalizeInteger(settings.operationalMaxRetries, 0, 10)
  if (operationalMaxRetries !== undefined) update.operationalMaxRetries = operationalMaxRetries
  if (typeof settings.improvementProposalsEnabled === 'boolean') update.improvementProposalsEnabled = settings.improvementProposalsEnabled
  if (settings.improvementProposalsDisabledAgents !== undefined) update.improvementProposalsDisabledAgents = normalizeBoolMap(settings.improvementProposalsDisabledAgents)
  if (settings.improvementProposalsDisabledProjects !== undefined) update.improvementProposalsDisabledProjects = normalizeBoolMap(settings.improvementProposalsDisabledProjects)
  if (settings.improvementProposalsDisabledCrews !== undefined) update.improvementProposalsDisabledCrews = normalizeBoolMap(settings.improvementProposalsDisabledCrews)
  if (typeof settings.dreamConsolidationScheduleEnabled === 'boolean') update.dreamConsolidationScheduleEnabled = settings.dreamConsolidationScheduleEnabled
  const dreamConsolidationIntervalHours = normalizeInteger(settings.dreamConsolidationIntervalHours, 24, 720)
  if (dreamConsolidationIntervalHours !== undefined) update.dreamConsolidationIntervalHours = dreamConsolidationIntervalHours
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
    providerCredentials: normalizeNestedStringMap(raw?.providerCredentials),
    integrationCredentials: normalizeNestedStringMap(raw?.integrationCredentials),
    integrationEnabled: normalizeBoolMap(raw?.integrationEnabled),
    bashPermission,
    fileWritePermission,
    enableBash: bashPermission !== 'deny',
    enableFileWrite: fileWritePermission !== 'deny',
    runtimeToolingBridgeEnabled: raw?.runtimeToolingBridgeEnabled !== false,
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
    operationalMaxAutonomy: normalizeAutonomyLevel(raw?.operationalMaxAutonomy) || defaults.operationalMaxAutonomy,
    operationalWriteMaxParallel: normalizeInteger(raw?.operationalWriteMaxParallel, 1, 10) || defaults.operationalWriteMaxParallel,
    operationalMaxRunDurationMinutes: normalizeInteger(raw?.operationalMaxRunDurationMinutes, 1, 24 * 60) || defaults.operationalMaxRunDurationMinutes,
    operationalMaxCostUsd: normalizeNullableCostUsd(raw?.operationalMaxCostUsd) ?? defaults.operationalMaxCostUsd,
    operationalMaxRetries: normalizeInteger(raw?.operationalMaxRetries, 0, 10) ?? defaults.operationalMaxRetries,
    improvementProposalsEnabled: raw?.improvementProposalsEnabled !== false,
    improvementProposalsDisabledAgents: normalizeBoolMap(raw?.improvementProposalsDisabledAgents),
    improvementProposalsDisabledProjects: normalizeBoolMap(raw?.improvementProposalsDisabledProjects),
    improvementProposalsDisabledCrews: normalizeBoolMap(raw?.improvementProposalsDisabledCrews),
    dreamConsolidationScheduleEnabled: raw?.dreamConsolidationScheduleEnabled === true,
    dreamConsolidationIntervalHours: normalizeInteger(raw?.dreamConsolidationIntervalHours, 24, 720) || defaults.dreamConsolidationIntervalHours,
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

export function getSettingsSecretStorageMode() {
  return getSecretStorageMode()
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
  }
}
