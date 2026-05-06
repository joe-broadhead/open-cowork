import { basename, extname } from 'node:path'
import {
  getPublicAppConfig,
  resolveProviderDefaultModel,
} from '../config-loader.ts'
import type {
  ProviderAuthAuthorization,
  ProviderDescriptor,
  ProviderModelDescriptor,
  PublicAppConfig,
  RuntimeProviderDescriptor,
} from '@open-cowork/shared'

const MAX_PROVIDER_ID_LENGTH = 128
const MAX_PROVIDER_AUTH_METHOD_INDEX = 1_000
const MAX_PROVIDER_AUTH_INPUTS = 20
const MAX_PROVIDER_AUTH_INPUT_KEY_LENGTH = 128
const MAX_PROVIDER_AUTH_INPUT_VALUE_LENGTH = 8 * 1024
const MAX_PROVIDER_AUTH_CODE_LENGTH = 16 * 1024
const MAX_PROVIDER_AUTH_URL_LENGTH = 8 * 1024
const MAX_PROVIDER_AUTH_INSTRUCTIONS_LENGTH = 4 * 1024
const MAX_CREDENTIAL_SCOPE_ID_BYTES = 256

export const MAX_CLIPBOARD_TEXT_LENGTH = 2 * 1024 * 1024
export const MAX_SAVE_TEXT_BYTES = 2 * 1024 * 1024
export const MAX_SAVE_TEXT_FILENAME_BYTES = 512

const SENSITIVE_SAVE_TEXT_BASENAMES = new Set([
  '.bash_profile',
  '.bashrc',
  '.profile',
  '.ssh_config',
  '.zprofile',
  '.zshenv',
  '.zshrc',
  'authorized_keys',
  'config',
  'known_hosts',
])

const SENSITIVE_SAVE_TEXT_DIRS = new Set([
  '.aws',
  '.azure',
  '.config/gcloud',
  '.docker',
  '.gnupg',
  '.kube',
  '.ssh',
])

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function stringByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function normalizeBoundedString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  if (stringByteLength(value) > maxBytes) throw new Error(`${label} is too large.`)
  return value
}

export function normalizeCredentialScopeId(value: unknown, label: string): string {
  const normalized = normalizeBoundedString(value, `${label} id`, MAX_CREDENTIAL_SCOPE_ID_BYTES).trim()
  if (!normalized) throw new Error(`${label} id is invalid.`)
  return normalized
}

function pathContainsSensitiveDir(filePath: string) {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase()
  return Array.from(SENSITIVE_SAVE_TEXT_DIRS).some((dir) => normalized.includes(`/${dir}/`))
}

export function resolveSafeSaveTextPath(filePath: string) {
  const extension = extname(filePath)
  const targetPath = extension ? filePath : `${filePath}.json`
  if (extname(targetPath).toLowerCase() !== '.json') {
    throw new Error('Saved text exports must use a .json extension.')
  }
  const lowerBasename = basename(targetPath).toLowerCase()
  if (SENSITIVE_SAVE_TEXT_BASENAMES.has(lowerBasename) || pathContainsSensitiveDir(targetPath)) {
    throw new Error('Refusing to save exported text into a sensitive configuration path.')
  }
  return targetPath
}

export function resolveKnownProviderId(providerId: unknown): string {
  if (typeof providerId !== 'string') throw new Error('Invalid provider id.')
  const normalized = providerId.trim()
  if (!normalized || normalized.length > MAX_PROVIDER_ID_LENGTH) throw new Error('Invalid provider id.')
  if (!getPublicAppConfig().providers.available.some((provider) => provider.id === normalized)) {
    throw new Error(`Unknown provider: ${normalized}`)
  }
  return normalized
}

export function normalizeProviderAuthMethod(method: unknown): number {
  if (typeof method !== 'number' || !Number.isInteger(method) || method < 0 || method > MAX_PROVIDER_AUTH_METHOD_INDEX) {
    throw new Error('Invalid provider auth method.')
  }
  return method
}

export function normalizeProviderAuthInputs(inputs: unknown): Record<string, string> | undefined {
  if (inputs === undefined || inputs === null) return undefined
  const record = asRecord(inputs)
  if (!record || Array.isArray(inputs)) throw new Error('Invalid provider auth inputs.')
  const entries = Object.entries(record)
  if (entries.length > MAX_PROVIDER_AUTH_INPUTS) throw new Error('Too many provider auth inputs.')
  return Object.fromEntries(entries.map(([key, value]) => {
    if (!key || key.length > MAX_PROVIDER_AUTH_INPUT_KEY_LENGTH || typeof value !== 'string') {
      throw new Error('Invalid provider auth input.')
    }
    if (value.length > MAX_PROVIDER_AUTH_INPUT_VALUE_LENGTH) {
      throw new Error('Provider auth input is too large.')
    }
    return [key, value]
  }))
}

export function normalizeProviderAuthCode(code: unknown): string | undefined {
  if (code === undefined || code === null) return undefined
  if (typeof code !== 'string') throw new Error('Invalid provider auth code.')
  const normalized = code.trim()
  if (normalized.length > MAX_PROVIDER_AUTH_CODE_LENGTH) {
    throw new Error('Provider auth code is too large.')
  }
  return normalized
}

export function normalizeProviderAuthorization(raw: unknown): ProviderAuthAuthorization | null {
  const record = asRecord(raw)
  if (!record) return null
  const url = typeof record.url === 'string' ? record.url : ''
  if (!url) return null
  if (url.length > MAX_PROVIDER_AUTH_URL_LENGTH) throw new Error('Provider auth URL is too large.')
  const instructions = typeof record.instructions === 'string'
    ? record.instructions.slice(0, MAX_PROVIDER_AUTH_INSTRUCTIONS_LENGTH)
    : ''
  return {
    url,
    method: record.method === 'code' ? 'code' : 'auto',
    instructions,
  }
}

function runtimeModelToDescriptor(modelId: string, rawModel: unknown): ProviderModelDescriptor {
  const model = asRecord(rawModel)
  const limit = asRecord(model?.limit)
  const context = typeof limit?.context === 'number' && Number.isFinite(limit.context)
    ? limit.context
    : undefined
  return {
    id: modelId,
    name: typeof model?.name === 'string' && model.name.trim() ? model.name : modelId,
    ...(context ? { contextLength: context } : {}),
  }
}

function providerWithoutDefaultModel(provider: ProviderDescriptor): ProviderDescriptor {
  return {
    id: provider.id,
    name: provider.name,
    description: provider.description,
    credentials: provider.credentials,
    models: provider.models,
    ...(provider.connected !== undefined ? { connected: provider.connected } : {}),
  }
}

export function mergeRuntimeProviderModels(
  config: PublicAppConfig,
  runtimeProviders: RuntimeProviderDescriptor[],
): PublicAppConfig {
  if (runtimeProviders.length === 0) return config
  const runtimeById = new Map(
    runtimeProviders
      .filter((provider) => typeof provider.id === 'string' && provider.id)
      .map((provider) => [provider.id as string, provider]),
  )

  return {
    ...config,
    providers: {
      ...config.providers,
      available: config.providers.available.map((provider) => {
        const runtimeProvider = runtimeById.get(provider.id)
        if (!runtimeProvider) return provider
        const providerBase = providerWithoutDefaultModel(provider)
        const connected = typeof runtimeProvider.connected === 'boolean' ? runtimeProvider.connected : undefined
        if (!runtimeProvider.models) {
          const defaultModel = resolveProviderDefaultModel(provider.id, provider.models, runtimeProvider.defaultModel, {
            runtimeCatalogKnown: false,
          })
          return {
            ...providerBase,
            ...(defaultModel ? { defaultModel } : {}),
            ...(connected !== undefined ? { connected } : {}),
          }
        }
        const runtimeModels = Object.entries(runtimeProvider.models)
          .map(([modelId, rawModel]) => runtimeModelToDescriptor(modelId, rawModel))
          .sort((a, b) => a.name.localeCompare(b.name))
        if (runtimeModels.length === 0) {
          const defaultModel = resolveProviderDefaultModel(provider.id, provider.models, runtimeProvider.defaultModel)
          return {
            ...providerBase,
            ...(defaultModel ? { defaultModel } : {}),
            ...(connected !== undefined ? { connected } : {}),
          }
        }
        const configuredIds = new Set(provider.models.map((model) => model.id))
        const models = [
          ...provider.models,
          ...runtimeModels.filter((model) => !configuredIds.has(model.id)),
        ]
        const defaultModel = resolveProviderDefaultModel(provider.id, models, runtimeProvider.defaultModel)
        return {
          ...providerBase,
          ...(defaultModel ? { defaultModel } : {}),
          ...(connected !== undefined ? { connected } : {}),
          models,
        }
      }),
    },
  }
}

export async function ensureRuntimeAfterAuthLogin(input: {
  authenticated: boolean
  setupComplete: boolean
  hasActiveRuntime: boolean
  bootRuntime: () => Promise<void>
  rebootRuntime: () => Promise<void>
}) {
  if (!input.authenticated || !input.setupComplete) return
  if (input.hasActiveRuntime) {
    await input.rebootRuntime()
    return
  }
  await input.bootRuntime()
}
