import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

export interface CustomMcp {
  name: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface CustomSkill {
  name: string
  content: string
}

export interface CoworkSettings {
  provider: 'vertex' | 'databricks'
  defaultModel: string
  gcpProjectId: string | null
  gcpRegion: string
  databricksHost: string | null
  databricksToken: string | null
  customMcps: CustomMcp[]
  customSkills: CustomSkill[]
}

const DEFAULTS: CoworkSettings = {
  provider: 'databricks',
  defaultModel: 'databricks-claude-opus-4-6',
  gcpProjectId: null,
  gcpRegion: 'global',
  databricksHost: null,
  databricksToken: null,
  customMcps: [],
  customSkills: [],
}

export const PROVIDER_MODELS = {
  vertex: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  ],
  databricks: [
    { id: 'databricks-claude-opus-4-6', name: 'Claude Opus 4.6' },
    { id: 'databricks-claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
    { id: 'databricks-gpt-oss-120b', name: 'GPT OSS 120B' },
  ],
}

let settingsCache: CoworkSettings | null = null

function getSettingsPath() {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.enc')
}

// Legacy plaintext path for migration
function getLegacySettingsPath() {
  return join(app.getPath('userData'), 'cowork', 'settings.json')
}

export function loadSettings(): CoworkSettings {
  if (settingsCache) return settingsCache

  // Try encrypted settings first
  const encPath = getSettingsPath()
  if (existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
    try {
      const raw = readFileSync(encPath)
      const decrypted = safeStorage.decryptString(raw)
      settingsCache = { ...DEFAULTS, ...JSON.parse(decrypted) }
      return settingsCache
    } catch {}
  }

  // Fall back to legacy plaintext (and migrate)
  const legacyPath = getLegacySettingsPath()
  if (existsSync(legacyPath)) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8')
      const parsed = { ...DEFAULTS, ...JSON.parse(raw) }
      settingsCache = parsed
      // Migrate to encrypted
      saveSettings(parsed)
      return settingsCache
    } catch {}
  }

  return { ...DEFAULTS }
}

export function saveSettings(settings: Partial<CoworkSettings>) {
  const current = settingsCache || loadSettings()
  const merged = { ...current, ...settings }
  settingsCache = merged

  const json = JSON.stringify(merged)
  if (safeStorage.isEncryptionAvailable()) {
    writeFileSync(getSettingsPath(), safeStorage.encryptString(json))
  } else {
    // Fallback: write plaintext if encryption unavailable
    writeFileSync(getLegacySettingsPath(), json)
  }
  return merged
}

/**
 * Get effective settings. No external tool dependencies.
 * GCP project is only set if the user configured it in settings.
 */
export function getEffectiveSettings(): CoworkSettings {
  return loadSettings()
}
