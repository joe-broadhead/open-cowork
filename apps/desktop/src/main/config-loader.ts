import electron from 'electron'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, resolve } from 'path'
import type { BrandingConfig, CredentialField, ProviderDescriptor, ProviderModelDescriptor, PublicAppConfig } from '@open-cowork/shared'

const electronApp = (electron as { app?: typeof import('electron').app }).app

export type ConfiguredSkill = {
  name: string
  description: string
  badge: 'Skill'
  sourceName: string
  toolIds?: string[]
}

export type ConfiguredTool = {
  id: string
  name: string
  icon?: string
  description: string
  kind: 'mcp' | 'built-in'
  namespace?: string
  patterns?: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
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

export type ConfiguredAgent = {
  name: string
  label?: string
  description: string
  instructions: string
  skillNames?: string[]
  toolIds?: string[]
  allowTools?: string[]
  askTools?: string[]
  color?: string
  hidden?: boolean
  mode?: 'primary' | 'subagent'
  toolScopes?: string[]
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
  tools: ConfiguredTool[]
  skills: ConfiguredSkill[]
  mcps: BundleMcp[]
  agents: ConfiguredAgent[]
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
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro' },
      { id: 'gemini-3.1-flash-preview', name: 'Gemini 3.1 Flash' },
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
    available: ['anthropic', 'vertex', 'openai', 'openrouter'],
    defaultProvider: 'vertex',
    defaultModel: 'gemini-3.1-flash-preview',
    custom: {},
  },
  tools: [],
  skills: [],
  mcps: [],
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
let configErrorCache: string | null = null

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

function formatConfigError(source: string, path: string, message: string) {
  return `Invalid Open Cowork config in ${source}${path ? ` at ${path}` : ''}: ${message}`
}

function ensureObject(value: unknown, source: string, path: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(formatConfigError(source, path, 'expected an object'))
  }
  return value as Record<string, unknown>
}

function ensureAllowedKeys(
  value: Record<string, unknown>,
  allowedKeys: string[],
  source: string,
  path: string,
) {
  const extras = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (extras.length > 0) {
    throw new Error(formatConfigError(source, path, `unexpected keys: ${extras.join(', ')}`))
  }
}

function readString(
  value: Record<string, unknown>,
  key: string,
  source: string,
  path: string,
  options?: { required?: boolean; nullable?: boolean },
) {
  const raw = value[key]
  if (raw === undefined) {
    if (options?.required) {
      throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'is required'))
    }
    return undefined
  }
  if (raw === null) {
    if (options?.nullable) return null
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'must be a string'))
  }
  if (typeof raw !== 'string') {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'must be a string'))
  }
  return raw
}

function readBoolean(value: Record<string, unknown>, key: string, source: string, path: string) {
  const raw = value[key]
  if (raw === undefined) return undefined
  if (typeof raw !== 'boolean') {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'must be a boolean'))
  }
  return raw
}

function readNumber(
  value: Record<string, unknown>,
  key: string,
  source: string,
  path: string,
  options?: { integer?: boolean; min?: number },
) {
  const raw = value[key]
  if (raw === undefined) return undefined
  if (typeof raw !== 'number' || Number.isNaN(raw)) {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'must be a number'))
  }
  if (options?.integer && !Number.isInteger(raw)) {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'must be an integer'))
  }
  if (options?.min !== undefined && raw < options.min) {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, `must be >= ${options.min}`))
  }
  return raw
}

function readStringArray(value: Record<string, unknown>, key: string, source: string, path: string) {
  const raw = value[key]
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, 'must be an array of strings'))
  }
  return raw as string[]
}

function readRecordOfStrings(value: Record<string, unknown>, key: string, source: string, path: string) {
  const raw = value[key]
  if (raw === undefined) return undefined
  const record = ensureObject(raw, source, path ? `${path}.${key}` : key)
  for (const [entryKey, entryValue] of Object.entries(record)) {
    if (typeof entryValue !== 'string') {
      throw new Error(formatConfigError(source, path ? `${path}.${key}.${entryKey}` : `${key}.${entryKey}`, 'must be a string'))
    }
  }
  return record as Record<string, string>
}

function readEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: T[],
  source: string,
  path: string,
  options?: { required?: boolean; nullable?: boolean },
) {
  const raw = readString(value, key, source, path, options)
  if (raw === undefined || raw === null) return raw
  if (!allowed.includes(raw as T)) {
    throw new Error(formatConfigError(source, path ? `${path}.${key}` : key, `must be one of: ${allowed.join(', ')}`))
  }
  return raw as T
}

function validateConfigFileInput(raw: unknown, source: string) {
  if (raw === undefined || raw === null) return
  const config = ensureObject(raw, source, '')
  ensureAllowedKeys(config, ['$schema', 'branding', 'auth', 'providers', 'tools', 'skills', 'mcps', 'agents', 'permissions'], source, '')

  if (config.branding !== undefined) {
    const branding = ensureObject(config.branding, source, 'branding')
    ensureAllowedKeys(branding, ['name', 'appId', 'dataDirName', 'helpUrl'], source, 'branding')
    readString(branding, 'name', source, 'branding', { required: true })
    readString(branding, 'appId', source, 'branding', { required: true })
    readString(branding, 'dataDirName', source, 'branding', { required: true })
    readString(branding, 'helpUrl', source, 'branding', { required: true })
  }

  if (config.auth !== undefined) {
    const auth = ensureObject(config.auth, source, 'auth')
    ensureAllowedKeys(auth, ['mode', 'googleOAuth'], source, 'auth')
    readEnum(auth, 'mode', ['none', 'google-oauth'], source, 'auth', { required: true })
    if (auth.googleOAuth !== undefined) {
      const googleOAuth = ensureObject(auth.googleOAuth, source, 'auth.googleOAuth')
      ensureAllowedKeys(googleOAuth, ['clientId', 'clientSecret', 'scopes'], source, 'auth.googleOAuth')
      readString(googleOAuth, 'clientId', source, 'auth.googleOAuth', { required: true })
      readString(googleOAuth, 'clientSecret', source, 'auth.googleOAuth')
      readStringArray(googleOAuth, 'scopes', source, 'auth.googleOAuth')
    }
  }

  if (config.providers !== undefined) {
    const providers = ensureObject(config.providers, source, 'providers')
    ensureAllowedKeys(providers, ['available', 'defaultProvider', 'defaultModel', 'custom'], source, 'providers')
    readStringArray(providers, 'available', source, 'providers')
    readString(providers, 'defaultProvider', source, 'providers', { nullable: true })
    readString(providers, 'defaultModel', source, 'providers', { nullable: true })
    if (providers.custom !== undefined) {
      const customProviders = ensureObject(providers.custom, source, 'providers.custom')
      for (const [providerId, rawProvider] of Object.entries(customProviders)) {
        const provider = ensureObject(rawProvider, source, `providers.custom.${providerId}`)
        ensureAllowedKeys(provider, ['npm', 'name', 'options', 'models', 'credentials', 'description'], source, `providers.custom.${providerId}`)
        readString(provider, 'npm', source, `providers.custom.${providerId}`, { required: true })
        readString(provider, 'name', source, `providers.custom.${providerId}`, { required: true })
        readString(provider, 'description', source, `providers.custom.${providerId}`)
        if (provider.options !== undefined) {
          ensureObject(provider.options, source, `providers.custom.${providerId}.options`)
        }
        const models = ensureObject(provider.models, source, `providers.custom.${providerId}.models`)
        for (const [modelId, modelValue] of Object.entries(models)) {
          const model = ensureObject(modelValue, source, `providers.custom.${providerId}.models.${modelId}`)
          ensureAllowedKeys(
            model,
            ['name', 'limit', 'cost', 'options'],
            source,
            `providers.custom.${providerId}.models.${modelId}`,
          )
          readString(model, 'name', source, `providers.custom.${providerId}.models.${modelId}`)

          if (model.limit !== undefined) {
            const limit = ensureObject(model.limit, source, `providers.custom.${providerId}.models.${modelId}.limit`)
            ensureAllowedKeys(limit, ['context', 'output'], source, `providers.custom.${providerId}.models.${modelId}.limit`)
            readNumber(limit, 'context', source, `providers.custom.${providerId}.models.${modelId}.limit`, { integer: true, min: 1 })
            readNumber(limit, 'output', source, `providers.custom.${providerId}.models.${modelId}.limit`, { integer: true, min: 1 })
          }

          if (model.cost !== undefined) {
            const cost = ensureObject(model.cost, source, `providers.custom.${providerId}.models.${modelId}.cost`)
            ensureAllowedKeys(cost, ['input', 'output', 'cache_read'], source, `providers.custom.${providerId}.models.${modelId}.cost`)
            readNumber(cost, 'input', source, `providers.custom.${providerId}.models.${modelId}.cost`, { min: 0 })
            readNumber(cost, 'output', source, `providers.custom.${providerId}.models.${modelId}.cost`, { min: 0 })
            readNumber(cost, 'cache_read', source, `providers.custom.${providerId}.models.${modelId}.cost`, { min: 0 })
          }

          if (model.options !== undefined) {
            const modelOptions = ensureObject(model.options, source, `providers.custom.${providerId}.models.${modelId}.options`)
            readNumber(modelOptions, 'maxOutputTokens', source, `providers.custom.${providerId}.models.${modelId}.options`, { integer: true, min: 1 })
          }
        }
        if (provider.credentials !== undefined) {
          if (!Array.isArray(provider.credentials)) {
            throw new Error(formatConfigError(source, `providers.custom.${providerId}.credentials`, 'must be an array'))
          }
          for (const [index, rawCredential] of provider.credentials.entries()) {
            const credential = ensureObject(rawCredential, source, `providers.custom.${providerId}.credentials[${index}]`)
            ensureAllowedKeys(credential, ['key', 'label', 'description', 'placeholder', 'secret', 'required', 'env'], source, `providers.custom.${providerId}.credentials[${index}]`)
            readString(credential, 'key', source, `providers.custom.${providerId}.credentials[${index}]`, { required: true })
            readString(credential, 'label', source, `providers.custom.${providerId}.credentials[${index}]`, { required: true })
            readString(credential, 'description', source, `providers.custom.${providerId}.credentials[${index}]`, { required: true })
            readString(credential, 'placeholder', source, `providers.custom.${providerId}.credentials[${index}]`)
            readBoolean(credential, 'secret', source, `providers.custom.${providerId}.credentials[${index}]`)
            readBoolean(credential, 'required', source, `providers.custom.${providerId}.credentials[${index}]`)
            readString(credential, 'env', source, `providers.custom.${providerId}.credentials[${index}]`)
          }
        }
      }
    }
  }

  if (config.tools !== undefined) {
    if (!Array.isArray(config.tools)) {
      throw new Error(formatConfigError(source, 'tools', 'must be an array'))
    }
    for (const [index, rawTool] of config.tools.entries()) {
      const tool = ensureObject(rawTool, source, `tools[${index}]`)
      ensureAllowedKeys(tool, ['id', 'name', 'icon', 'description', 'kind', 'namespace', 'patterns', 'allowPatterns', 'askPatterns'], source, `tools[${index}]`)
      readString(tool, 'id', source, `tools[${index}]`, { required: true })
      readString(tool, 'name', source, `tools[${index}]`, { required: true })
      readString(tool, 'icon', source, `tools[${index}]`)
      readString(tool, 'description', source, `tools[${index}]`, { required: true })
      readEnum(tool, 'kind', ['mcp', 'built-in'], source, `tools[${index}]`, { required: true })
      readString(tool, 'namespace', source, `tools[${index}]`)
      readStringArray(tool, 'patterns', source, `tools[${index}]`)
      readStringArray(tool, 'allowPatterns', source, `tools[${index}]`)
      readStringArray(tool, 'askPatterns', source, `tools[${index}]`)
    }
  }

  if (config.skills !== undefined) {
    if (!Array.isArray(config.skills)) {
      throw new Error(formatConfigError(source, 'skills', 'must be an array'))
    }
    for (const [index, rawSkill] of config.skills.entries()) {
      const skill = ensureObject(rawSkill, source, `skills[${index}]`)
      ensureAllowedKeys(skill, ['name', 'description', 'badge', 'sourceName', 'toolIds'], source, `skills[${index}]`)
      readString(skill, 'name', source, `skills[${index}]`, { required: true })
      readString(skill, 'description', source, `skills[${index}]`, { required: true })
      readEnum(skill, 'badge', ['Skill'], source, `skills[${index}]`, { required: true })
      readString(skill, 'sourceName', source, `skills[${index}]`, { required: true })
      readStringArray(skill, 'toolIds', source, `skills[${index}]`)
    }
  }

  if (config.mcps !== undefined) {
    if (!Array.isArray(config.mcps)) {
      throw new Error(formatConfigError(source, 'mcps', 'must be an array'))
    }
    for (const [index, rawMcp] of config.mcps.entries()) {
      const mcp = ensureObject(rawMcp, source, `mcps[${index}]`)
      ensureAllowedKeys(mcp, ['name', 'type', 'description', 'authMode', 'packageName', 'command', 'url', 'headers', 'headerSettings', 'envSettings'], source, `mcps[${index}]`)
      const type = readEnum(mcp, 'type', ['local', 'remote'], source, `mcps[${index}]`, { required: true })
      readString(mcp, 'name', source, `mcps[${index}]`, { required: true })
      readString(mcp, 'description', source, `mcps[${index}]`, { required: true })
      readEnum(mcp, 'authMode', ['none', 'oauth', 'api_token'], source, `mcps[${index}]`, { required: true })
      readString(mcp, 'packageName', source, `mcps[${index}]`)
      readStringArray(mcp, 'command', source, `mcps[${index}]`)
      readString(mcp, 'url', source, `mcps[${index}]`)
      readRecordOfStrings(mcp, 'headers', source, `mcps[${index}]`)
      if (mcp.headerSettings !== undefined) {
        if (!Array.isArray(mcp.headerSettings)) {
          throw new Error(formatConfigError(source, `mcps[${index}].headerSettings`, 'must be an array'))
        }
        for (const [headerIndex, rawHeader] of mcp.headerSettings.entries()) {
          const headerSetting = ensureObject(rawHeader, source, `mcps[${index}].headerSettings[${headerIndex}]`)
          ensureAllowedKeys(headerSetting, ['header', 'key', 'prefix'], source, `mcps[${index}].headerSettings[${headerIndex}]`)
          readString(headerSetting, 'header', source, `mcps[${index}].headerSettings[${headerIndex}]`, { required: true })
          readString(headerSetting, 'key', source, `mcps[${index}].headerSettings[${headerIndex}]`, { required: true })
          readString(headerSetting, 'prefix', source, `mcps[${index}].headerSettings[${headerIndex}]`)
        }
      }
      if (mcp.envSettings !== undefined) {
        if (!Array.isArray(mcp.envSettings)) {
          throw new Error(formatConfigError(source, `mcps[${index}].envSettings`, 'must be an array'))
        }
        for (const [envIndex, rawEnv] of mcp.envSettings.entries()) {
          const envSetting = ensureObject(rawEnv, source, `mcps[${index}].envSettings[${envIndex}]`)
          ensureAllowedKeys(envSetting, ['env', 'key'], source, `mcps[${index}].envSettings[${envIndex}]`)
          readString(envSetting, 'env', source, `mcps[${index}].envSettings[${envIndex}]`, { required: true })
          readString(envSetting, 'key', source, `mcps[${index}].envSettings[${envIndex}]`, { required: true })
        }
      }
      if (type === 'local' && !(Array.isArray(mcp.command) || typeof mcp.packageName === 'string')) {
        throw new Error(formatConfigError(source, `mcps[${index}]`, 'local MCPs require either packageName or command'))
      }
      if (type === 'remote' && typeof mcp.url !== 'string') {
        throw new Error(formatConfigError(source, `mcps[${index}]`, 'remote MCPs require a url'))
      }
    }
  }

  if (config.agents !== undefined) {
    if (!Array.isArray(config.agents)) {
      throw new Error(formatConfigError(source, 'agents', 'must be an array'))
    }
    for (const [index, rawAgent] of config.agents.entries()) {
      const agent = ensureObject(rawAgent, source, `agents[${index}]`)
      ensureAllowedKeys(agent, ['name', 'label', 'description', 'instructions', 'skillNames', 'toolIds', 'allowTools', 'askTools', 'color', 'hidden', 'mode', 'toolScopes'], source, `agents[${index}]`)
      readString(agent, 'name', source, `agents[${index}]`, { required: true })
      readString(agent, 'label', source, `agents[${index}]`)
      readString(agent, 'description', source, `agents[${index}]`, { required: true })
      readString(agent, 'instructions', source, `agents[${index}]`, { required: true })
      readStringArray(agent, 'skillNames', source, `agents[${index}]`)
      readStringArray(agent, 'toolIds', source, `agents[${index}]`)
      readStringArray(agent, 'allowTools', source, `agents[${index}]`)
      readStringArray(agent, 'askTools', source, `agents[${index}]`)
      readString(agent, 'color', source, `agents[${index}]`)
      readBoolean(agent, 'hidden', source, `agents[${index}]`)
      readEnum(agent, 'mode', ['primary', 'subagent'], source, `agents[${index}]`)
      readStringArray(agent, 'toolScopes', source, `agents[${index}]`)
    }
  }

  if (config.permissions !== undefined) {
    const permissions = ensureObject(config.permissions, source, 'permissions')
    ensureAllowedKeys(permissions, ['bash', 'fileWrite', 'task', 'web'], source, 'permissions')
    readEnum(permissions, 'bash', ['allow', 'ask', 'deny'], source, 'permissions')
    readEnum(permissions, 'fileWrite', ['allow', 'ask', 'deny'], source, 'permissions')
    readEnum(permissions, 'task', ['allow', 'ask', 'deny'], source, 'permissions')
    readEnum(permissions, 'web', ['allow', 'ask', 'deny'], source, 'permissions')
  }
}

export function resolveConfigEnvPlaceholders<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => process.env[envName] || '') as T
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveConfigEnvPlaceholders(entry)) as T
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveConfigEnvPlaceholders(entry)]),
    ) as T
  }

  return value
}

function getBundledConfigPath() {
  const overridePath = process.env.OPEN_COWORK_CONFIG_PATH?.trim()
  if (overridePath) {
    return resolve(overridePath)
  }
  try {
    if (electronApp?.isPackaged) return join(process.resourcesPath, 'open-cowork.config.json')
    if (electronApp?.getAppPath) {
      return resolve(electronApp.getAppPath(), '..', '..', 'open-cowork.config.json')
    }
    return resolve(process.cwd(), 'open-cowork.config.json')
  } catch {
    return resolve(process.cwd(), 'open-cowork.config.json')
  }
}

function getUserConfigPath() {
  const bundled = normalizeConfig(deepMerge(DEFAULT_CONFIG, readConfigFile(getBundledConfigPath(), 'bundled config')))
  const dataDirName = bundled.branding?.dataDirName || DEFAULT_CONFIG.branding.dataDirName
  try {
    return join(electronApp?.getPath?.('home') || homedir(), '.config', dataDirName, 'config.json')
  } catch {
    return join(homedir(), '.config', dataDirName, 'config.json')
  }
}

function getUserDataRoot() {
  try {
    return electronApp?.getPath?.('userData') || join(process.cwd(), '.open-cowork-test')
  } catch {
    return join(process.cwd(), '.open-cowork-test')
  }
}

function readConfigFile(path: string, source: string): Partial<OpenCoworkConfig> {
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    validateConfigFileInput(parsed, source)
    return parsed
  } catch (err) {
    if (err instanceof Error) throw err
    throw new Error(formatConfigError(source, '', 'could not be parsed'))
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
    tools: Array.isArray((raw as any).tools) ? (raw as any).tools : [],
    skills: Array.isArray((raw as any).skills) ? (raw as any).skills : [],
    mcps: Array.isArray((raw as any).mcps) ? (raw as any).mcps : [],
    agents: Array.isArray(raw.agents) ? raw.agents : [],
    permissions: {
      ...DEFAULT_CONFIG.permissions,
      ...(raw.permissions || {}),
    },
  }
}

export function getAppConfig(): OpenCoworkConfig {
  if (configCache) return configCache
  try {
    const bundled = readConfigFile(getBundledConfigPath(), 'bundled config')
    const user = readConfigFile(getUserConfigPath(), 'user config')
    const merged = normalizeConfig(deepMerge(deepMerge(DEFAULT_CONFIG, bundled), user))
    validateConfigFileInput(merged, 'resolved config')
    configCache = merged
    configErrorCache = null
  } catch (err) {
    configCache = normalizeConfig(DEFAULT_CONFIG)
    configErrorCache = err instanceof Error
      ? err.message
      : 'Invalid Open Cowork config'
  }
  return configCache
}

export function getConfigError() {
  void getAppConfig()
  return configErrorCache
}

export function assertConfigValid() {
  void getAppConfig()
  if (configErrorCache) {
    throw new Error(configErrorCache)
  }
}

export function getBranding() {
  return getAppConfig().branding
}

export function getDataDirName() {
  return getBranding().dataDirName
}

export function getLogFilePrefix() {
  return getDataDirName()
}

export function getAppDataDir() {
  if (dataDirCache) return dataDirCache

  const userDataRoot = getUserDataRoot()
  const preferredDir = userDataRoot
  const legacyDirs = Array.from(new Set([
    join(userDataRoot, getDataDirName()),
    join(userDataRoot, 'cowork'),
  ])).filter((path) => path !== preferredDir)

  mkdirSync(preferredDir, { recursive: true })

  for (const legacyDir of legacyDirs) {
    if (!existsSync(legacyDir)) continue
    try {
      cpSync(legacyDir, preferredDir, { recursive: true, force: false })
    } catch {
      // Best-effort migration only. Existing root data wins over legacy copies.
    }
  }

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
  const config = resolveConfigEnvPlaceholders(getAppConfig())
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

export function getConfiguredToolsFromConfig() {
  return getAppConfig().tools || []
}

export function getConfiguredToolById(toolId: string) {
  return getConfiguredToolsFromConfig().find((tool) => tool.id === toolId) || null
}

export function getConfiguredToolAllowPatterns(tool: ConfiguredTool) {
  if (tool.allowPatterns?.length) return [...tool.allowPatterns]
  if (tool.patterns?.length) return [...tool.patterns]
  if (tool.namespace) return [`mcp__${tool.namespace}__*`]
  return []
}

export function getConfiguredToolAskPatterns(tool: ConfiguredTool) {
  return [...(tool.askPatterns || [])]
}

export function getConfiguredToolPatterns(tool: ConfiguredTool) {
  return Array.from(new Set([
    ...getConfiguredToolAllowPatterns(tool),
    ...getConfiguredToolAskPatterns(tool),
    ...(tool.patterns || []),
  ]))
}

export function getConfiguredSkillsFromConfig() {
  return getAppConfig().skills || []
}

export function getConfiguredMcpsFromConfig() {
  return getAppConfig().mcps || []
}

export function getConfiguredAgentsFromConfig() {
  return getAppConfig().agents || []
}

export function clearConfigCaches() {
  configCache = null
  publicConfigCache = null
  dataDirCache = null
  configErrorCache = null
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
