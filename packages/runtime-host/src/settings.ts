import { getAppPathHost, getDesktopShellHost, getSafeStorageHost, writeFileAtomic } from '@open-cowork/shared/node'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SMALL_MODEL_USE_MAIN,
  type AgentColor,
  type AppSettings,
  type EffectiveAppSettings,
  type RuntimePermissionPolicy,
} from '@open-cowork/shared'
import type { CredentialField } from '@open-cowork/shared/providers'
import {
  getAppConfig,
  getAppDataDir,
  getConfiguredMcpsFromConfig,
  getProviderDescriptor,
  getPublicAppConfig,
  normalizeProviderModelId,
} from './config-loader-core.js'
import { log } from '@open-cowork/shared/node'
import {
  readSafeStorageBackendForPolicy,
  resolveSecretStorageMode,
  type SecretStorageMode,
} from './secure-storage-policy.js'


type SecretStorageAdapter = {
  mode: SecretStorageMode
  encryptString: (plaintext: string) => Buffer
  decryptString: (encrypted: Buffer) => string
}

export type CoworkSettings = AppSettings
export type { AgentColor }

let settingsCache: AppSettings | null = null
let settingsSecretStorageForTests: SecretStorageAdapter | null = null

export const SETTINGS_SCHEMA_VERSION = 10
export const DEFAULT_WINDOW_ZOOM_FACTOR = 1
export const MIN_WINDOW_ZOOM_FACTOR = 0.8
export const MAX_WINDOW_ZOOM_FACTOR = 1.5

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

class SettingsStoreLoadError extends Error {
  constructor(problem: string) {
    super(
      `Open Cowork cannot load the existing settings store: ${problem} `
      + `This pre-release build requires exact settings schema version ${SETTINGS_SCHEMA_VERSION} and does not migrate settings in place. `
      + 'Back up or export the settings file, then reset only settings.json/settings.enc and reconfigure the app. The existing file was left untouched.',
    )
    this.name = 'SettingsStoreLoadError'
  }
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
  const webPermission = appConfig.permissions.web
  const taskPermission = appConfig.permissions.task
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
    webPermission,
    webSearchEnabled: appConfig.permissions.webSearch,
    taskPermission,
    externalDirectoryPermission: 'allow',
    mcpPermission: 'allow',
    requireApprovalBeforeSending: true,
    notificationVoiceReplies: true,
    notificationSmartSuggestions: true,
    notificationDailyDigest: false,
    notificationSounds: true,
    privacyKeepConversationHistory: true,
    privacyShareAnonymizedUsage: false,
    runtimeConfigSource: 'app',
    runtimeToolingBridgeEnabled: true,
    windowZoomFactor: DEFAULT_WINDOW_ZOOM_FACTOR,
    workflowLaunchAtLogin: false,
    workflowRunInBackground: false,
    workflowDesktopNotifications: true,
    workflowQuietHoursStart: '22:00',
    workflowQuietHoursEnd: '07:00',
  }
}

function readSettingsSchemaVersion(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = (raw as { _schemaVersion?: unknown })._schemaVersion
  if (typeof value !== 'number') return null
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function assertCurrentSettingsSchemaVersion(raw: unknown) {
  const version = readSettingsSchemaVersion(raw)
  if (version !== SETTINGS_SCHEMA_VERSION) {
    throw new SettingsStoreLoadError(
      version === null
        ? 'the schema version is missing or invalid.'
        : `the file declares version ${version}.`,
    )
  }
}

function isSettingsStoreLoadError(error: unknown) {
  return error instanceof SettingsStoreLoadError
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

function roundWindowZoomFactor(value: number) {
  return Math.round(value * 100) / 100
}

export function normalizeWindowZoomFactor(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return roundWindowZoomFactor(Math.min(MAX_WINDOW_ZOOM_FACTOR, Math.max(MIN_WINDOW_ZOOM_FACTOR, value)))
}

function asSettingsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
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
  }
  const fileWritePermission = normalizeRuntimePermissionPolicy(settings.fileWritePermission, appPermissions.fileWrite)
  if (fileWritePermission) {
    update.fileWritePermission = fileWritePermission
  }
  const webPermission = normalizeRuntimePermissionPolicy(settings.webPermission, appPermissions.web)
  if (webPermission) update.webPermission = webPermission
  if (typeof settings.webSearchEnabled === 'boolean') update.webSearchEnabled = settings.webSearchEnabled && appPermissions.webSearch
  const taskPermission = normalizeRuntimePermissionPolicy(settings.taskPermission, appPermissions.task)
  if (taskPermission) update.taskPermission = taskPermission
  const externalDirectoryPermission = normalizeRuntimePermissionPolicy(settings.externalDirectoryPermission, 'allow')
  if (externalDirectoryPermission) update.externalDirectoryPermission = externalDirectoryPermission
  const mcpPermission = normalizeRuntimePermissionPolicy(settings.mcpPermission, 'allow')
  if (mcpPermission) update.mcpPermission = mcpPermission
  if (typeof settings.requireApprovalBeforeSending === 'boolean') update.requireApprovalBeforeSending = settings.requireApprovalBeforeSending
  if (typeof settings.notificationVoiceReplies === 'boolean') update.notificationVoiceReplies = settings.notificationVoiceReplies
  if (typeof settings.notificationSmartSuggestions === 'boolean') update.notificationSmartSuggestions = settings.notificationSmartSuggestions
  if (typeof settings.notificationDailyDigest === 'boolean') update.notificationDailyDigest = settings.notificationDailyDigest
  if (typeof settings.notificationSounds === 'boolean') update.notificationSounds = settings.notificationSounds
  if (typeof settings.privacyKeepConversationHistory === 'boolean') update.privacyKeepConversationHistory = settings.privacyKeepConversationHistory
  if (typeof settings.privacyShareAnonymizedUsage === 'boolean') update.privacyShareAnonymizedUsage = settings.privacyShareAnonymizedUsage
  if (typeof settings.runtimeToolingBridgeEnabled === 'boolean') update.runtimeToolingBridgeEnabled = settings.runtimeToolingBridgeEnabled
  const windowZoomFactor = normalizeWindowZoomFactor(settings.windowZoomFactor)
  if (windowZoomFactor !== undefined) update.windowZoomFactor = windowZoomFactor
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

function normalizeSettingsFromDisk(rawInput: unknown): AppSettings {
  assertCurrentSettingsSchemaVersion(rawInput)
  const raw = asSettingsRecord(rawInput)
  const defaults = createDefaults()
  const appPermissions = getAppConfig().permissions
  const bashPermission = normalizeRuntimePermissionPolicy(raw?.bashPermission, appPermissions.bash) || defaults.bashPermission
  const fileWritePermission = normalizeRuntimePermissionPolicy(raw?.fileWritePermission, appPermissions.fileWrite) || defaults.fileWritePermission
  const webPermission = normalizeRuntimePermissionPolicy(raw?.webPermission, appPermissions.web) || defaults.webPermission
  const taskPermission = normalizeRuntimePermissionPolicy(raw?.taskPermission, appPermissions.task) || defaults.taskPermission
  const externalDirectoryPermission = normalizeRuntimePermissionPolicy(raw?.externalDirectoryPermission, 'allow') || defaults.externalDirectoryPermission
  const mcpPermission = normalizeRuntimePermissionPolicy(raw?.mcpPermission, 'allow') || defaults.mcpPermission
  const next: AppSettings = {
    ...defaults,
    _schemaVersion: SETTINGS_SCHEMA_VERSION,
    selectedProviderId: typeof raw?.selectedProviderId === 'string'
      ? raw.selectedProviderId
      : defaults.selectedProviderId,
    selectedModelId: typeof raw?.selectedModelId === 'string'
      ? raw.selectedModelId
      : defaults.selectedModelId,
    selectedSmallModelId: typeof raw?.selectedSmallModelId === 'string'
      ? raw.selectedSmallModelId
      : null,
    providerCredentials: normalizeNestedStringMap(raw?.providerCredentials),
    integrationCredentials: normalizeNestedStringMap(raw?.integrationCredentials),
    integrationEnabled: normalizeBoolMap(raw?.integrationEnabled),
    bashPermission,
    fileWritePermission,
    webPermission,
    webSearchEnabled: typeof raw?.webSearchEnabled === 'boolean'
      ? raw.webSearchEnabled && appPermissions.webSearch
      : defaults.webSearchEnabled,
    taskPermission,
    externalDirectoryPermission,
    mcpPermission,
    requireApprovalBeforeSending: raw?.requireApprovalBeforeSending !== false,
    notificationVoiceReplies: raw?.notificationVoiceReplies !== false,
    notificationSmartSuggestions: raw?.notificationSmartSuggestions !== false,
    notificationDailyDigest: raw?.notificationDailyDigest === true,
    notificationSounds: raw?.notificationSounds !== false,
    privacyKeepConversationHistory: raw?.privacyKeepConversationHistory !== false,
    privacyShareAnonymizedUsage: raw?.privacyShareAnonymizedUsage === true,
    runtimeConfigSource: normalizeRuntimeConfigSource(raw?.runtimeConfigSource) || defaults.runtimeConfigSource,
    runtimeToolingBridgeEnabled: raw?.runtimeToolingBridgeEnabled !== false,
    windowZoomFactor: normalizeWindowZoomFactor(raw?.windowZoomFactor) ?? defaults.windowZoomFactor,
    workflowLaunchAtLogin: raw?.workflowLaunchAtLogin === true,
    workflowRunInBackground: raw?.workflowRunInBackground === true,
    workflowDesktopNotifications: raw?.workflowDesktopNotifications !== false,
    workflowQuietHoursStart: typeof raw?.workflowQuietHoursStart === 'string' && raw.workflowQuietHoursStart.trim()
      ? raw.workflowQuietHoursStart.trim()
      : defaults.workflowQuietHoursStart,
    workflowQuietHoursEnd: typeof raw?.workflowQuietHoursEnd === 'string' && raw.workflowQuietHoursEnd.trim()
      ? raw.workflowQuietHoursEnd.trim()
      : defaults.workflowQuietHoursEnd,
  }

  return next
}

function getSettingsPath() {
  return join(getAppDataDir(), 'settings.enc')
}

function getPlaintextSettingsPath() {
  return join(getAppDataDir(), 'settings.json')
}

function getSecretStorageMode() {
  if (settingsSecretStorageForTests) return settingsSecretStorageForTests.mode
  return resolveSecretStorageMode({
    isPackaged: Boolean(getAppPathHost()?.isPackaged),
    encryptionAvailable: Boolean(getSafeStorageHost()?.isEncryptionAvailable()),
    selectedStorageBackend: readSafeStorageBackendForPolicy(
      getSafeStorageHost()?.getSelectedStorageBackend,
    ),
  })
}

function applyWorkflowLaunchAtLogin(settings: AppSettings) {
  try {
    getDesktopShellHost()?.setLoginItemSettings({ openAtLogin: settings.workflowLaunchAtLogin })
  } catch (error) {
    log('error', `Failed to apply login item settings: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function applySettingsSideEffects(settings = loadSettings()) {
  applyWorkflowLaunchAtLogin(settings)
}

function requireSafeStorage() {
  if (settingsSecretStorageForTests) return settingsSecretStorageForTests
  const safeStorage = getSafeStorageHost()
  if (!safeStorage) {
    throw new Error('Electron safeStorage is unavailable')
  }
  return safeStorage
}

export function setSettingsSecretStorageForTests(adapter: SecretStorageAdapter | null) {
  settingsSecretStorageForTests = adapter
  settingsCache = null
}

// Sentinel rendered into masked credential fields returned by
// `settings:get`. Defense-in-depth: the same sentinel is stripped by
// `saveSettings()` before writing so a caller that accidentally echoes a
// masked value back can't overwrite the real key with the mask string.
export const CREDENTIAL_MASK = '••••••••'

function maskCredentialBag(
  value: Record<string, string>,
  fields: readonly CredentialField[] | undefined,
) {
  const fieldByKey = new Map((fields || []).map((field) => [field.key, field] as const))
  const masked: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    const field = fieldByKey.get(key)
    masked[key] = field && field.secret === false
      ? entry
      : entry && entry.length > 0 ? CREDENTIAL_MASK : ''
  }
  return masked
}

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
  const plaintextPath = getPlaintextSettingsPath()
  const encryptedExists = existsSync(encryptedPath)
  const plaintextExists = existsSync(plaintextPath)
  const storageMode = getSecretStorageMode()
  if (encryptedExists && plaintextExists) {
    throw new SettingsStoreLoadError('both encrypted and plaintext settings files exist, so the authoritative store is ambiguous.')
  }
  if (encryptedExists && storageMode !== 'encrypted') {
    throw new SettingsStoreLoadError('an encrypted settings file exists but OS-backed encrypted storage is not the active storage mode.')
  }
  if (plaintextExists && storageMode !== 'plaintext') {
    throw new SettingsStoreLoadError('a plaintext development settings file exists but plaintext storage is not the active storage mode.')
  }

  if (encryptedExists && storageMode === 'encrypted') {
    try {
      const safeStorage = requireSafeStorage()
      const raw = readFileSync(encryptedPath)
      const decrypted = safeStorage.decryptString(raw)
      const result = normalizeSettingsFromDisk(JSON.parse(decrypted))
      settingsCache = result
      return result
    } catch (err: unknown) {
      if (isSettingsStoreLoadError(err)) throw err
      throw new SettingsStoreLoadError('the encrypted file could not be decrypted or parsed.')
    }
  }

  if (storageMode === 'plaintext') {
    if (plaintextExists) {
      try {
        const raw = readFileSync(plaintextPath, 'utf-8')
        const result = normalizeSettingsFromDisk(JSON.parse(raw))
        settingsCache = result
        return result
      } catch (err: unknown) {
        if (isSettingsStoreLoadError(err)) throw err
        throw new SettingsStoreLoadError('the plaintext file could not be parsed.')
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
  // Strip mask sentinels so a caller that round-tripped masked credential
  // state can't accidentally overwrite real keys with the mask string.
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
    writeFileAtomic(getPlaintextSettingsPath(), json, { mode: 0o600 })
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
  return maskCredentialBag(credentials, getProviderDescriptor(providerId)?.credentials)
}

export function getIntegrationCredentials(integrationId: string) {
  const credentials = loadSettings().integrationCredentials[integrationId] || {}
  const configuredMcp = getConfiguredMcpsFromConfig().find((entry) => entry.name === integrationId)
  return maskCredentialBag(credentials, configuredMcp?.credentials)
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
  const bashPermission = clampRuntimePermissionPolicy(settings.bashPermission, appPermissions.bash)
  const fileWritePermission = clampRuntimePermissionPolicy(settings.fileWritePermission, appPermissions.fileWrite)
  const webPermission = clampRuntimePermissionPolicy(settings.webPermission, appPermissions.web)
  const taskPermission = clampRuntimePermissionPolicy(settings.taskPermission, appPermissions.task)
  const externalDirectoryPermission = clampRuntimePermissionPolicy(settings.externalDirectoryPermission, 'allow')
  const mcpPermission = clampRuntimePermissionPolicy(settings.mcpPermission, 'allow')

  return {
    ...settings,
    bashPermission,
    fileWritePermission,
    webPermission,
    webSearchEnabled: settings.webSearchEnabled && appPermissions.webSearch,
    taskPermission,
    externalDirectoryPermission,
    mcpPermission,
    effectiveProviderId: providerId,
    effectiveModel: selectedModelId,
    effectiveSmallModel,
  }
}
