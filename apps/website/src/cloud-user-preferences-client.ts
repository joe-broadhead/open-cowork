import type { UiAccentPresetId } from '@open-cowork/shared'
import type { CloudWebClientBootstrap } from './client-contract.ts'
import {
  isCloudDensity,
  isCloudThemeAccentPreset,
  isCloudThemePreset,
  isCloudThemeScheme,
  type CloudDensity,
} from './cloud-theme.ts'

export const CLOUD_USER_PREFERENCES_SETTING_KEY = 'cloud-user-preferences'
export const CLOUD_USER_SETTING_STORAGE_PREFIX = 'open-cowork-cloud-'

export type CloudThemePreferenceValue = {
  presetId?: string
  scheme?: 'dark' | 'light'
  accentId?: UiAccentPresetId
  density?: CloudDensity
}

export type CloudUserPreferences = {
  theme?: CloudThemePreferenceValue
  notifications?: {
    voiceReplies?: boolean
    smartSuggestions?: boolean
    dailyDigest?: boolean
    sounds?: boolean
  }
  privacy?: {
    shareAnonymizedUsage?: boolean
  }
}

export const CLOUD_USER_SETTING_PATHS = {
  'cloud-setting-notification-voice': ['notifications', 'voiceReplies'],
  'cloud-setting-notification-suggestions': ['notifications', 'smartSuggestions'],
  'cloud-setting-notification-digest': ['notifications', 'dailyDigest'],
  'cloud-setting-notification-sound': ['notifications', 'sounds'],
  'cloud-setting-privacy-share': ['privacy', 'shareAnonymizedUsage'],
} as const

type CloudUserPreferenceState = {
  hydrationComplete: boolean
  lastSavedPreferences: CloudUserPreferences | null
  saveGeneration: number
}

const cloudUserPreferenceStates = new WeakMap<Document, CloudUserPreferenceState>()
const cloudUserPreferenceSaveQueues = new WeakMap<Document, Promise<void>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function boolFromRecord(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'boolean' ? value : undefined
}

function sanitizeCloudUserPreferences(value: unknown): CloudUserPreferences {
  const record = isRecord(value) ? value : {}
  const themeRecord = isRecord(record.theme) ? record.theme : {}
  const notificationsRecord = isRecord(record.notifications) ? record.notifications : {}
  const privacyRecord = isRecord(record.privacy) ? record.privacy : {}
  const theme: CloudThemePreferenceValue = {}
  if (isCloudThemePreset(String(themeRecord.presetId || ''))) theme.presetId = String(themeRecord.presetId)
  if (isCloudThemeScheme(String(themeRecord.scheme || ''))) theme.scheme = String(themeRecord.scheme) as 'dark' | 'light'
  if (isCloudThemeAccentPreset(String(themeRecord.accentId || ''))) theme.accentId = String(themeRecord.accentId) as UiAccentPresetId
  if (isCloudDensity(String(themeRecord.density || ''))) theme.density = String(themeRecord.density) as CloudDensity

  return {
    ...(Object.keys(theme).length > 0 ? { theme } : {}),
    notifications: {
      voiceReplies: boolFromRecord(notificationsRecord, 'voiceReplies'),
      smartSuggestions: boolFromRecord(notificationsRecord, 'smartSuggestions'),
      dailyDigest: boolFromRecord(notificationsRecord, 'dailyDigest'),
      sounds: boolFromRecord(notificationsRecord, 'sounds'),
    },
    privacy: {
      shareAnonymizedUsage: boolFromRecord(privacyRecord, 'shareAnonymizedUsage'),
    },
  }
}

function endpointPath(bootstrap: CloudWebClientBootstrap, id: string, fallback: string, params: Record<string, string> = {}) {
  const configured = bootstrap.api.find((endpoint) => endpoint.id === id)?.path
  if (!configured) return null
  let path = configured || fallback
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`:${key}`, encodeURIComponent(value))
  }
  return path
}

function readCookie(name: string) {
  const prefix = `${name}=`
  return document.cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length) || null
}

function cloudUserPreferencesPath(bootstrap: CloudWebClientBootstrap) {
  return endpointPath(bootstrap, 'setting', '/api/settings/:settingKey', {
    settingKey: CLOUD_USER_PREFERENCES_SETTING_KEY,
  })
}

export function hasDurableCloudUserPreferences(bootstrap: CloudWebClientBootstrap) {
  return bootstrap.features.settings !== false && Boolean(cloudUserPreferencesPath(bootstrap))
}

export async function loadCloudUserPreferences(bootstrap: CloudWebClientBootstrap): Promise<CloudUserPreferences | null> {
  if (bootstrap.features.settings === false) return null
  const path = cloudUserPreferencesPath(bootstrap)
  if (!path) return null
  try {
    const response = await fetch(path, { method: 'GET' })
    if (!response.ok) return null
    const body = await response.json() as { setting?: { value?: unknown } | null }
    return sanitizeCloudUserPreferences(body.setting?.value)
  } catch {
    return null
  }
}

export async function saveCloudUserPreferences(bootstrap: CloudWebClientBootstrap, value: CloudUserPreferences): Promise<boolean> {
  if (bootstrap.features.settings === false) return true
  const path = cloudUserPreferencesPath(bootstrap)
  if (!path) return true
  const csrfToken = readCookie('open_cowork_cloud_csrf')
  try {
    const response = await fetch(path, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
      },
      body: JSON.stringify({ value }),
    })
    return response.ok
  } catch {
    return false
  }
}

export function cloudUserPreferenceState(ownerDocument: Document) {
  let state = cloudUserPreferenceStates.get(ownerDocument)
  if (!state) {
    state = { hydrationComplete: false, lastSavedPreferences: null, saveGeneration: 0 }
    cloudUserPreferenceStates.set(ownerDocument, state)
  }
  return state
}

export function nextCloudUserPreferenceSaveGeneration(ownerDocument: Document) {
  const state = cloudUserPreferenceState(ownerDocument)
  state.saveGeneration += 1
  return state.saveGeneration
}

export function enqueueCloudUserPreferenceSave(ownerDocument: Document, task: () => Promise<boolean>) {
  const previous = cloudUserPreferenceSaveQueues.get(ownerDocument) || Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  cloudUserPreferenceSaveQueues.set(ownerDocument, next.then(() => undefined, () => undefined))
  return next
}
