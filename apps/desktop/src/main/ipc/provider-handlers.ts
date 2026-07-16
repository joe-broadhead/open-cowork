import { getEffectiveSettings, getProviderCredentialValue } from '@open-cowork/runtime-host/settings'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { getClient, writeRuntimeProviderApiAuth } from '@open-cowork/runtime-host/runtime'
import { listNativeProviders, type ProviderLike } from '@open-cowork/runtime-host/provider-utils'
import { isModelsDevAuthJsonBuiltin } from '@open-cowork/runtime-host/runtime-config-builder'
import { connectNativeProviderApiKey, refreshProviderCatalog, modelInfoKeys } from '@open-cowork/runtime-host'
import { unwrapNativeData } from '@open-cowork/runtime-host'
import type { IntegrationInfo, IntegrationMethod, OpencodeClient, ProviderV2Info } from '@opencode-ai/sdk/v2'
import type { IpcHandlerContext } from './context.ts'
import {
  mergeRuntimeProviderModels,
  normalizeBoundedString,
  normalizeProviderAuthCode,
  normalizeProviderAuthorization,
  normalizeProviderAuthInputs,
  normalizeProviderAuthMethod,
  resolveKnownProviderId,
} from './app-handler-support.ts'
import { getProviderDescriptor, getProviderDynamicCatalog, getPublicAppConfig, invalidatePublicConfigCache } from '@open-cowork/runtime-host/config'
import { log } from '@open-cowork/shared/node'
type ElectronShell = typeof import('electron').shell
const MAX_PROVIDER_MODEL_ID_LENGTH = 512
const pendingOauthAttempts = new Map<string, { attemptID: string; mode: 'auto' | 'code' }>()

function oauthAttemptKey(providerId: string, method: number) {
  return `${providerId}\0${method}`
}

function projectIntegrationMethod(method: IntegrationMethod) {
  if (method.type === 'oauth') {
    return {
      type: 'oauth' as const,
      label: method.label,
      ...(method.prompts ? { prompts: method.prompts } : {}),
    }
  }
  if (method.type === 'key') {
    return { type: 'api' as const, label: method.label || 'API key' }
  }
  return null
}

type ProjectedIntegrationMethod = NonNullable<ReturnType<typeof projectIntegrationMethod>>

async function listNativeIntegrations(client: OpencodeClient) {
  const response = await client.v2.integration.list(undefined, { throwOnError: true })
  return unwrapNativeData<IntegrationInfo[]>(response)
}

async function resolveProviderIntegrationId(client: OpencodeClient, providerId: string) {
  const response = await client.v2.provider.get({ providerID: providerId }, { throwOnError: true })
  return unwrapNativeData<ProviderV2Info>(response).integrationID || providerId
}

export async function getNativeProviderAuthMethods(client: OpencodeClient) {
  const [providerResponse, integrations] = await Promise.all([
    client.v2.provider.list(undefined, { throwOnError: true }),
    listNativeIntegrations(client),
  ])
  const providers = unwrapNativeData<ProviderV2Info[]>(providerResponse)
  const byIntegration = new Map(integrations.map((integration) => [integration.id, integration]))
  return Object.fromEntries(providers.map((provider) => {
    const integration = byIntegration.get(provider.integrationID || provider.id)
    return [provider.id, (integration?.methods || [])
      .map(projectIntegrationMethod)
      .filter((method): method is ProjectedIntegrationMethod => Boolean(method))]
  }))
}

async function listRuntimeProviders() {
  const client = getClient()
  if (!client) return []
  return listNativeProviders(client)
}

function normalizeProviderModelId(value: unknown) {
  const modelId = normalizeBoundedString(value, 'Provider model id', MAX_PROVIDER_MODEL_ID_LENGTH).trim()
  if (!modelId) throw new Error('Provider model id is invalid.')
  return modelId
}

function findApiKeyCredential(providerId: string) {
  const descriptor = getProviderDescriptor(providerId)
  return descriptor?.credentials.find((credential) => {
    const runtimeKey = credential.runtimeKey || credential.key
    return runtimeKey === 'apiKey' || /api.*key/i.test(`${credential.key} ${credential.label}`)
  }) || null
}

async function syncApiCredentialForConnectionTest(providerId: string) {
  const client = getClient()
  if (!client) throw new Error('The model service is not ready yet. Try testing the connection again in a moment.')
  const credential = findApiKeyCredential(providerId)
  if (!credential) return false

  const settings = getEffectiveSettings()
  const key = getProviderCredentialValue(settings, providerId, credential.key)
  if (!key) return false

  // Match boot: OpenRouter uses auth.json (+ composed openai-compatible config),
  // not V2 integration.connect.key (which fails with "Key method not found").
  if (isModelsDevAuthJsonBuiltin(providerId)) {
    writeRuntimeProviderApiAuth(providerId, key)
    return true
  }

  try {
    await connectNativeProviderApiKey(client, providerId, key)
  } catch (err) {
    writeRuntimeProviderApiAuth(providerId, key)
    log('provider', `Connection-test auth.json fallback for ${providerId}: ${sdkErrorMessage(err)}`)
  }
  return true
}

function providerMatches(provider: ProviderLike, providerId: string) {
  return provider.id === providerId || provider.name === providerId
}

function providerHasModel(provider: ProviderLike, modelId: string) {
  const models = provider.models || {}
  const keys = Object.keys(models)
  if (keys.length === 0) return true
  const providerId = provider.id || provider.name
  const wanted = new Set(modelInfoKeys(providerId, modelId))
  return keys.some((key) => (
    wanted.has(key) ||
    modelInfoKeys(providerId, key).some((candidate) => candidate === modelId || wanted.has(candidate))
  ))
}

async function testRuntimeProviderConnection(providerId: string, modelId: string) {
  const client = getClient()
  if (!client) throw new Error('The model service is not ready yet. Try testing the connection again in a moment.')
  const providerName = getProviderDescriptor(providerId)?.name || providerId
  const apiCredentialSynced = await syncApiCredentialForConnectionTest(providerId)
  const providers = await listRuntimeProviders()
  const provider = providers.find((entry) => providerMatches(entry, providerId))

  if (!provider) {
    throw new Error(`${providerName} is not available in the model service. Choose another provider or update setup settings.`)
  }
  if (!apiCredentialSynced && provider.connected === false) {
    throw new Error(`${providerName} is not signed in yet. Sign in or enter an API key, then test again.`)
  }
  if (!providerHasModel(provider, modelId)) {
    throw new Error(`${modelId} is not available from ${providerName}. Choose a listed model, then test again.`)
  }

  return { ok: true, providerId, modelId }
}

export async function getPublicAppConfigWithRuntimeModels() {
  const config = getPublicAppConfig()
  try {
    return mergeRuntimeProviderModels(config, await listRuntimeProviders())
  } catch (err) {
    log('provider', `Could not merge runtime provider models: ${sdkErrorMessage(err)}`)
    return config
  }
}

export function registerProviderHandlers(context: IpcHandlerContext, electronShell: ElectronShell | undefined) {
  context.ipcMain.handle('app:refresh-provider-catalog', async (_event, providerId: string) => {
    const catalog = getProviderDynamicCatalog(providerId)
    if (!catalog) return []
    try {
      const models = await refreshProviderCatalog(providerId, catalog)
      invalidatePublicConfigCache()
      return models
    } catch (err) {
      context.logHandlerError(`app:refresh-provider-catalog ${providerId}`, err)
      return []
    }
  })

  context.ipcMain.handle('provider:list', async () => {
    try {
      const data = await listRuntimeProviders()
      log('provider', `Listed ${data.length} providers: ${data.map((provider) => `${provider.id || provider.name}(${Object.keys(provider.models || {}).length} models)`).join(', ')}`)
      return data
    } catch (err) {
      context.logHandlerError('provider:list', err)
      return []
    }
  })

  context.ipcMain.handle('provider:auth-methods', async () => {
    const client = getClient()
    if (!client) return {}
    try {
      return await getNativeProviderAuthMethods(client)
    } catch (err) {
      context.logHandlerError('provider:auth-methods', err)
      return {}
    }
  })

  context.ipcMain.handle('provider:test-connection', async (_event, providerIdInput: unknown, modelIdInput: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    const modelId = normalizeProviderModelId(modelIdInput)
    try {
      const result = await testRuntimeProviderConnection(providerId, modelId)
      log('provider', `Tested provider connection for ${providerId}/${modelId}`)
      return result
    } catch (err) {
      context.logHandlerError(`provider:test-connection ${providerId}`, err)
      throw err
    }
  })

  context.ipcMain.handle('provider:oauth-authorize', async (_event, providerIdInput: unknown, methodInput: unknown, inputsInput?: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    const method = normalizeProviderAuthMethod(methodInput)
    const inputs = normalizeProviderAuthInputs(inputsInput)
    const client = getClient()
    if (!client) throw new Error('OpenCode runtime is not running. Save your provider settings first, then try provider login again.')
    try {
      const integrationID = await resolveProviderIntegrationId(client, providerId)
      const integrationResponse = await client.v2.integration.get({ integrationID }, { throwOnError: true })
      const integration = unwrapNativeData<IntegrationInfo>(integrationResponse)
      const selected = integration.methods.filter((entry) => entry.type !== 'env')[method]
      if (!selected || selected.type !== 'oauth') {
        throw new Error(`Provider ${providerId} does not expose OAuth method ${method}.`)
      }
      const result = await client.v2.integration.connect.oauth({
        integrationID,
        methodID: selected.id,
        inputs,
        label: 'Open Cowork',
      }, { throwOnError: true })
      const attempt = unwrapNativeData<{
        attemptID: string
        url: string
        instructions: string
        mode: 'auto' | 'code'
      }>(result)
      pendingOauthAttempts.set(oauthAttemptKey(providerId, method), {
        attemptID: attempt.attemptID,
        mode: attempt.mode,
      })
      const authorization = normalizeProviderAuthorization({
        url: attempt.url,
        instructions: attempt.instructions,
        method: attempt.mode,
      })
      if (authorization?.url) {
        try {
          const parsed = new URL(authorization.url)
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error(`Unsupported auth URL protocol: ${parsed.protocol}`)
          }
          if (!electronShell) throw new Error('Electron shell API is unavailable')
          await electronShell.openExternal(authorization.url)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log('security', `Blocked provider auth URL for ${providerId}: ${message}`)
          throw new Error('Provider auth URL was blocked because it was not a valid http(s) URL.', { cause: err })
        }
      }
      return authorization
    } catch (err) {
      context.logHandlerError(`provider:oauth-authorize ${providerId}`, err)
      throw err
    }
  })

  context.ipcMain.handle('provider:oauth-callback', async (_event, providerIdInput: unknown, methodInput: unknown, codeInput?: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    const method = normalizeProviderAuthMethod(methodInput)
    const code = normalizeProviderAuthCode(codeInput)
    const client = getClient()
    if (!client) throw new Error('OpenCode runtime is not running. Save your provider settings first, then try provider login again.')
    try {
      const key = oauthAttemptKey(providerId, method)
      const pending = pendingOauthAttempts.get(key)
      if (!pending) throw new Error(`No pending OAuth attempt exists for ${providerId}. Start login again.`)
      const statusResponse = await client.v2.integration.attempt.status({
        attemptID: pending.attemptID,
      }, { throwOnError: true })
      const status = unwrapNativeData<{ status: 'pending' | 'complete' | 'failed' | 'expired'; message?: string }>(statusResponse)
      if (status.status === 'complete') {
        pendingOauthAttempts.delete(key)
        return true
      }
      if (status.status === 'failed') {
        pendingOauthAttempts.delete(key)
        throw new Error(status.message || `Provider login failed for ${providerId}.`)
      }
      if (status.status === 'expired') {
        pendingOauthAttempts.delete(key)
        throw new Error(`Provider login expired for ${providerId}. Start login again.`)
      }
      if (pending.mode === 'auto' && !code) return false
      await client.v2.integration.attempt.complete({
        attemptID: pending.attemptID,
        ...(code ? { code } : {}),
      }, { throwOnError: true })
      pendingOauthAttempts.delete(key)
      return true
    } catch (err) {
      context.logHandlerError(`provider:oauth-callback ${providerId}`, err)
      throw err
    }
  })

  context.ipcMain.handle('provider:auth-remove', async (_event, providerIdInput: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    const client = getClient()
    if (!client) throw new Error('OpenCode runtime is not running. Start the runtime, then try provider sign-out again.')
    try {
      const integrationID = await resolveProviderIntegrationId(client, providerId)
      const integrationResponse = await client.v2.integration.get({ integrationID }, { throwOnError: true })
      const integration = unwrapNativeData<IntegrationInfo>(integrationResponse)
      const credentialIds = integration.connections.flatMap((connection) => (
        connection.type === 'credential' ? [connection.id] : []
      ))
      await Promise.all(credentialIds.map((credentialID) => (
        client.v2.credential.remove({ credentialID }, { throwOnError: true })
      )))
      for (const key of pendingOauthAttempts.keys()) {
        if (key.startsWith(`${providerId}\0`)) pendingOauthAttempts.delete(key)
      }
      log('provider', `Removed OpenCode-native auth for ${providerId}`)
      return true
    } catch (err) {
      context.logHandlerError(`provider:auth-remove ${providerId}`, err)
      throw err
    }
  })
}
