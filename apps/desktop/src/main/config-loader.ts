import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve, dirname } from 'path'
import type { BrandingConfig, CredentialField, ProviderDescriptor, ProviderModelDescriptor, PublicAppConfig } from '@open-cowork/shared'

const electronApp = (electron as { app?: typeof import('electron').app }).app

export type BundleSkill = {
  name: string
  description: string
  badge: 'Skill'
  sourceName: string
}

export type BundleApp = {
  name: string
  description: string
  badge: 'App'
}

export type BundleAgentAccess = {
  readToolPatterns: string[]
  writeToolPatterns?: string[]
}

export type BundleCredential = CredentialField

export type BundleHeaderSetting = {
  header: string
  key: string
  prefix?: string
}

export type BundleEnvSetting = {
  env: string
  key: string
}

export type BundleMcp = {
  name: string
  type: 'local' | 'remote'
  description: string
  authMode: 'none' | 'oauth' | 'api_token'
  packageName?: string
  command?: string[]
  url?: string
  headers?: Record<string, string>
  headerSettings?: BundleHeaderSetting[]
  envSettings?: BundleEnvSetting[]
}

export type IntegrationBundle = {
  id: string
  name: string
  icon: string
  description: string
  longDescription?: string
  category: 'Analytics' | 'Productivity' | 'Communication' | 'Developer' | 'Custom'
  author: string
  version: string
  builtin: true
  enabledByDefault: boolean
  apps: BundleApp[]
  skills: BundleSkill[]
  credentials?: BundleCredential[]
  mcps: BundleMcp[]
  agentAccess?: BundleAgentAccess
  allowedTools: string[]
  deniedTools: string[]
}

export type CustomProviderRuntimeConfig = {
  npm: string
  name: string
  options?: Record<string, unknown>
  models: Record<string, Record<string, unknown>>
  credentials?: CredentialField[]
  description?: string
}

export type OpenCoworkConfig = {
  branding: BrandingConfig
  auth: {
    mode: 'none' | 'google-oauth'
    googleOAuth?: {
      clientId: string
      clientSecret?: string
      scopes?: string[]
    }
  }
  providers: {
    available: string[]
    defaultProvider: string | null
    defaultModel: string | null
    custom?: Record<string, CustomProviderRuntimeConfig>
  }
  integrations: IntegrationBundle[]
  agents: Array<Record<string, unknown>>
  permissions: {
    bash: 'allow' | 'ask' | 'deny'
    fileWrite: 'allow' | 'ask' | 'deny'
    task: 'allow' | 'ask' | 'deny'
    web: 'allow' | 'ask' | 'deny'
  }
}

export type ModelFallbackInfo = {
  pricing: Record<string, { inputPer1M: number; outputPer1M: number; cachePer1M?: number }>
  contextLimits: Record<string, number>
}

const DEFAULT_PROVIDER_DESCRIPTORS: Record<string, Omit<ProviderDescriptor, 'models'> & { models?: ProviderModelDescriptor[] }> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    description: 'Use Claude models through the built-in OpenCode Anthropic provider.',
    credentials: [
      {
        key: 'apiKey',
        label: 'Anthropic API Key',
        description: 'Required to use Anthropic models.',
        placeholder: 'sk-ant-...',
        secret: true,
        required: true,
        env: 'ANTHROPIC_API_KEY',
      },
    ],
    models: [
      { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4' },
      { id: 'claude-opus-4-20250514', name: 'Claude Opus 4' },
    ],
  },
  'google-vertex': {
    id: 'google-vertex',
    name: 'Google Vertex AI',
    description: 'Use Gemini models through Vertex AI. ADC can come from your environment or external auth flow.',
    credentials: [
      {
        key: 'projectId',
        label: 'GCP Project ID',
        description: 'Optional override for the active GCP project.',
        placeholder: 'my-gcp-project',
        required: false,
      },
      {
        key: 'location',
        label: 'Region',
        description: 'Optional Vertex location override.',
        placeholder: 'global',
        required: false,
      },
    ],
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    description: 'Use GPT models through the built-in OpenCode OpenAI provider.',
    credentials: [
      {
        key: 'apiKey',
        label: 'OpenAI API Key',
        description: 'Required to use OpenAI models.',
        placeholder: 'sk-...',
        secret: true,
        required: true,
        env: 'OPENAI_API_KEY',
      },
    ],
    models: [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
    ],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Use OpenRouter to access models through a single API key.',
    credentials: [
      {
        key: 'apiKey',
        label: 'OpenRouter API Key',
        description: 'Required to use OpenRouter models.',
        placeholder: 'sk-or-...',
        secret: true,
        required: true,
        env: 'OPENROUTER_API_KEY',
      },
    ],
    models: [
      { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4 via OpenRouter' },
      { id: 'openai/gpt-5-mini', name: 'GPT-5 Mini via OpenRouter' },
    ],
  },
}

const DEFAULT_CONFIG: OpenCoworkConfig = {
  branding: {
    name: 'Open Cowork',
    appId: 'com.opencowork.desktop',
    dataDirName: 'open-cowork',
    helpUrl: 'https://github.com/joe-broadhead/opencowork',
  },
  auth: {
    mode: 'none',
  },
  providers: {
    available: ['anthropic', 'google-vertex', 'openai', 'openrouter'],
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    custom: {},
  },
  integrations: [],
  agents: [],
  permissions: {
    bash: 'deny',
    fileWrite: 'deny',
    task: 'allow',
    web: 'allow',
  },
}

let configCache: OpenCoworkConfig | null = null
let publicConfigCache: PublicAppConfig | null = null
let dataDirCache: string | null = null

function deepMerge<T extends Record<string, any>>(base: T, override: Partial<T>): T {
  const next: Record<string, any> = { ...base }
  for (const [key, value] of Object.entries(override || {})) {
    if (Array.isArray(value)) {
      next[key] = value
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const current = next[key]
      next[key] = deepMerge(
        current && typeof current === 'object' && !Array.isArray(current) ? current : {},
        value as Record<string, unknown>,
      )
      continue
    }
    if (value !== undefined) next[key] = value
  }
  return next as T
}

function getBundledConfigPath() {
  const overridePath = process.env.OPEN_COWORK_CONFIG_PATH?.trim()
  if (overridePath) {
    return resolve(overridePath)
  }
  try {
    if (electronApp?.isPackaged) return join(process.resourcesPath, 'open-cowork.config.json')
    return resolve(electronApp?.getAppPath?.() || process.cwd(), '..', '..', 'open-cowork.config.json')
  } catch {
    return resolve(process.cwd(), 'open-cowork.config.json')
  }
}

function getUserConfigPath() {
  try {
    return join(electronApp?.getPath?.('home') || homedir(), '.config', 'open-cowork', 'config.json')
  } catch {
    return join(homedir(), '.config', 'open-cowork', 'config.json')
  }
}

function getUserDataRoot() {
  try {
    return electronApp?.getPath?.('userData') || join(process.cwd(), '.open-cowork-test')
  } catch {
    return join(process.cwd(), '.open-cowork-test')
  }
}

function readConfigFile(path: string): Partial<OpenCoworkConfig> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function normalizeConfig(raw: OpenCoworkConfig): OpenCoworkConfig {
  return {
    ...raw,
    branding: {
      ...DEFAULT_CONFIG.branding,
      ...(raw.branding || {}),
    },
    auth: {
      ...(raw.auth || {}),
      mode: raw.auth?.mode === 'google-oauth' ? 'google-oauth' : 'none',
    },
    providers: {
      ...DEFAULT_CONFIG.providers,
      ...(raw.providers || {}),
      available: Array.isArray(raw.providers?.available) && raw.providers?.available.length > 0
        ? raw.providers.available
        : DEFAULT_CONFIG.providers.available,
      custom: raw.providers?.custom || {},
    },
    integrations: Array.isArray(raw.integrations) ? raw.integrations : [],
    agents: Array.isArray(raw.agents) ? raw.agents : [],
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      ...(raw.permissions || {}),
    },
  }
}

export function getAppConfig(): OpenCoworkConfig {
  if (configCache) return configCache
  const bundled = readConfigFile(getBundledConfigPath())
  const user = readConfigFile(getUserConfigPath())
  configCache = normalizeConfig(deepMerge(deepMerge(DEFAULT_CONFIG, bundled), user))
  return configCache
}

export function getBranding() {
  return getAppConfig().branding
}

export function getDataDirName() {
  return getBranding().dataDirName
}

export function getAppDataDir() {
  if (dataDirCache) return dataDirCache

  const userDataRoot = getUserDataRoot()
  const preferredDir = join(userDataRoot, getDataDirName())
  const legacyDir = join(userDataRoot, 'cowork')

  if (!existsSync(preferredDir) && preferredDir !== legacyDir && existsSync(legacyDir)) {
    mkdirSync(dirname(preferredDir), { recursive: true })
    cpSync(legacyDir, preferredDir, { recursive: true })
  }

  mkdirSync(preferredDir, { recursive: true })
  dataDirCache = preferredDir
  return preferredDir
}

export function getProviderDescriptors(): ProviderDescriptor[] {
  const config = getAppConfig()
  return config.providers.available.map((providerId) => {
    const builtin = DEFAULT_PROVIDER_DESCRIPTORS[providerId]
    if (builtin) {
      return {
        id: builtin.id,
        name: builtin.name,
        description: builtin.description,
        credentials: builtin.credentials,
        models: builtin.models || [],
      }
    }

    const custom = config.providers.custom?.[providerId]
    if (!custom) {
      return {
        id: providerId,
        name: providerId,
        description: 'Custom provider',
        credentials: [],
        models: [],
      }
    }

    return {
      id: providerId,
      name: custom.name,
      description: custom.description || `${custom.name} custom provider`,
      credentials: custom.credentials || [],
      models: Object.entries(custom.models || {}).map(([id, info]) => ({
        id,
        name: typeof info?.name === 'string' ? info.name : id,
      })),
    }
  })
}

export function getProviderDescriptor(providerId: string | null | undefined) {
  if (!providerId) return null
  return getProviderDescriptors().find((provider) => provider.id === providerId) || null
}

export function getPublicAppConfig(): PublicAppConfig {
  if (publicConfigCache) return publicConfigCache
  const config = getAppConfig()
  publicConfigCache = {
    branding: config.branding,
    auth: {
      mode: config.auth.mode,
      enabled: config.auth.mode !== 'none',
    },
    providers: {
      available: getProviderDescriptors(),
      defaultProvider: config.providers.defaultProvider,
      defaultModel: config.providers.defaultModel,
    },
  }
  return publicConfigCache
}

export function getIntegrationBundlesFromConfig() {
  return getAppConfig().integrations
}

export function clearConfigCaches() {
  configCache = null
  publicConfigCache = null
  dataDirCache = null
}

export function resolveCustomProviderConfig(providerId: string) {
  return getAppConfig().providers.custom?.[providerId] || null
}

export function getConfiguredModelFallbacks(): ModelFallbackInfo {
  const pricing: ModelFallbackInfo['pricing'] = {}
  const contextLimits: ModelFallbackInfo['contextLimits'] = {}

  for (const provider of Object.values(getAppConfig().providers.custom || {})) {
    for (const [modelId, rawModel] of Object.entries(provider.models || {})) {
      const model = rawModel as Record<string, any>
      const cost = model?.cost
      if (cost && typeof cost === 'object') {
        const inputPer1M = typeof cost.input === 'number' ? cost.input * 1_000_000 : 0
        const outputPer1M = typeof cost.output === 'number' ? cost.output * 1_000_000 : 0
        const cachePer1M = typeof cost.cache_read === 'number' ? cost.cache_read * 1_000_000 : undefined
        if (inputPer1M > 0 || outputPer1M > 0 || (cachePer1M || 0) > 0) {
          pricing[modelId] = {
            inputPer1M,
            outputPer1M,
            ...(cachePer1M !== undefined ? { cachePer1M } : {}),
          }
        }
      }

      const context = model?.limit?.context
      if (typeof context === 'number' && context > 0) {
        contextLimits[modelId] = context
      }
    }
  }

  return { pricing, contextLimits }
}
