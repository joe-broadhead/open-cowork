import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

export interface CustomMcp {
  name: string
  type: 'stdio' | 'http'
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http
  url?: string
  headers?: Record<string, string>
}

export interface CustomSkill {
  name: string
  content: string // full SKILL.md content
}

export interface CoworkSettings {
  // Provider selection
  provider: 'vertex' | 'databricks'
  defaultModel: string

  // Vertex AI
  gcpProjectId: string | null
  gcpRegion: string

  // Databricks
  databricksHost: string | null
  databricksToken: string | null

  // Custom MCPs and skills
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

// Available models per provider
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
let gcpProjectCache: string | null | undefined = undefined

function getSettingsPath() {
  const dir = join(app.getPath('userData'), 'cowork')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'settings.json')
}

export function loadSettings(): CoworkSettings {
  if (settingsCache) return settingsCache
  const path = getSettingsPath()
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8')
      settingsCache = { ...DEFAULTS, ...JSON.parse(raw) }
      return settingsCache
    } catch {
      return { ...DEFAULTS }
    }
  }
  return { ...DEFAULTS }
}

export function saveSettings(settings: Partial<CoworkSettings>) {
  const current = loadSettings()
  const merged = { ...current, ...settings }
  writeFileSync(getSettingsPath(), JSON.stringify(merged, null, 2))
  settingsCache = merged
  return merged
}

function detectGcpProject(): string | null {
  if (gcpProjectCache !== undefined) return gcpProjectCache
  try {
    const result = execFileSync('gcloud', ['config', 'get-value', 'project'], {
      timeout: 5_000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    gcpProjectCache = result && result !== '(unset)' ? result : null
  } catch {
    gcpProjectCache = null
  }
  return gcpProjectCache
}

export function getEffectiveSettings(): CoworkSettings {
  const saved = loadSettings()
  return {
    ...saved,
    gcpProjectId: saved.gcpProjectId || detectGcpProject(),
  }
}
