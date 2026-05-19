import type { IpcHandlerContext } from './context.ts'
import {
  mergeRuntimeProviderModels,
  normalizeProviderAuthCode,
  normalizeProviderAuthorization,
  normalizeProviderAuthInputs,
  normalizeProviderAuthMethod,
  resolveKnownProviderId,
} from './app-handler-support.ts'
import { getProviderDynamicCatalog, getPublicAppConfig, invalidatePublicConfigCache } from '../config-loader.ts'
import { log } from '../logger.ts'
import { refreshProviderCatalog } from '../provider-catalog.ts'
import { normalizeProviderListResponse } from '../provider-utils.ts'
import { getClient } from '../runtime.ts'
import { sdkErrorMessage } from '../sdk-error.ts'

type ElectronShell = typeof import('electron').shell

async function listRuntimeProviders() {
  const client = getClient()
  if (!client) return []
  const result = await client.provider.list()
  return normalizeProviderListResponse(result.data)
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
      const result = await client.provider.auth()
      return result.data || {}
    } catch (err) {
      context.logHandlerError('provider:auth-methods', err)
      return {}
    }
  })

  context.ipcMain.handle('provider:oauth-authorize', async (_event, providerIdInput: unknown, methodInput: unknown, inputsInput?: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    const method = normalizeProviderAuthMethod(methodInput)
    const inputs = normalizeProviderAuthInputs(inputsInput)
    const client = getClient()
    if (!client) throw new Error('OpenCode runtime is not running. Save your provider settings first, then try provider login again.')
    try {
      const result = await client.provider.oauth.authorize({
        providerID: providerId,
        method,
        inputs,
      })
      const authorization = normalizeProviderAuthorization(result.data)
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
      const result = await client.provider.oauth.callback({
        providerID: providerId,
        method,
        code,
      })
      return Boolean(result.data)
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
      await client.auth.remove({ providerID: providerId }, { throwOnError: true })
      log('provider', `Removed OpenCode-native auth for ${providerId}`)
      return true
    } catch (err) {
      context.logHandlerError(`provider:auth-remove ${providerId}`, err)
      throw err
    }
  })
}
