import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { log } from './logger'

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

export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

export interface CustomAgent {
  name: string
  description: string
  instructions: string
  skillNames: string[]
  integrationIds: string[]
  enabled: boolean
  color: AgentColor
}

export interface CoworkSettings {
  provider: 'vertex' | 'databricks'
  defaultModel: string
  gcpProjectId: string | null
  gcpRegion: string
  databricksHost: string | null
  databricksToken: string | null
  githubToken: string | null
  perplexityApiKey: string | null
  customMcps: CustomMcp[]
  customSkills: CustomSkill[]
  customAgents: CustomAgent[]
  // Developer tools
  enableBash: boolean
  enableFileWrite: boolean
}

const DEFAULTS: CoworkSettings = {
  provider: 'databricks',
  defaultModel: 'databricks-claude-sonnet-4',
  gcpProjectId: null,
  gcpRegion: 'global',
  databricksHost: null,
  databricksToken: null,
  githubToken: null,
  perplexityApiKey: null,
  customMcps: [],
  customSkills: [],
  customAgents: [],
  enableBash: false,
  enableFileWrite: false,
}

export const PROVIDER_MODELS = {
  vertex: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
  ],
  databricks: [
    { id: 'databricks-claude-sonnet-4', name: 'Claude Sonnet 4' },
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
      const result = { ...DEFAULTS, ...JSON.parse(decrypted) }
      settingsCache = result
      return result
    } catch (e: any) { log('error', `Settings: ${e?.message}`) }
  }

  // Fall back to legacy plaintext (and migrate) — only in dev mode
  if (!app.isPackaged) {
    const legacyPath = getLegacySettingsPath()
    if (existsSync(legacyPath)) {
      try {
        const raw = readFileSync(legacyPath, 'utf-8')
        const result = { ...DEFAULTS, ...JSON.parse(raw) }
        settingsCache = result
        // Migrate to encrypted
        saveSettings(result)
        return result
      } catch (e: any) { log('error', `Settings: ${e?.message}`) }
    }
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
  } else if (!app.isPackaged) {
    // Dev only: write plaintext if encryption unavailable
    writeFileSync(getLegacySettingsPath(), json)
  } else {
    log('error', 'Cannot save settings: secure storage unavailable in production')
  }
  return merged
}

/**
 * Get effective settings. No external tool dependencies.
 * GCP project is only set if the user configured it in settings.
 */
export function getEffectiveSettings(): CoworkSettings & { effectiveModel: string } {
  const settings = loadSettings()
  const useDatabricks = settings.provider === 'databricks' && settings.databricksHost && settings.databricksToken
  let effectiveModel: string
  if (useDatabricks) {
    effectiveModel = settings.defaultModel
  } else {
    effectiveModel = settings.provider === 'vertex' ? settings.defaultModel : 'gemini-2.5-pro'
  }
  return { ...settings, effectiveModel }
}
