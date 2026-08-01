import {
  getEffectiveSettings,
  getSetupValidationFingerprint,
  invalidateSetupValidationProof,
  isSetupComplete,
  recordSuccessfulSetupValidation,
} from '@open-cowork/runtime-host/settings'
import { sdkErrorMessage } from '@open-cowork/runtime-host/sdk-error'
import { getClient } from '@open-cowork/runtime-host/runtime'
import { listNativeProviders } from '@open-cowork/runtime-host/provider-utils'
import { refreshProviderCatalog } from '@open-cowork/runtime-host'
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
import { getProviderDynamicCatalog, getPublicAppConfig, invalidatePublicConfigCache } from '@open-cowork/runtime-host/config'
import { log } from '@open-cowork/shared/node'
import { validateRuntimeSetupConnection } from '../setup/connection-validation.ts'
type ElectronShell = typeof import('electron').shell
const MAX_PROVIDER_MODEL_ID_LENGTH = 512
const DEFAULT_OAUTH_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000
const pendingOauthAttempts = new Map<string, {
  attemptID: string
  mode: 'auto' | 'code'
  client: OpencodeClient
  timeout: ReturnType<typeof setTimeout>
}>()

function oauthAttemptKey(providerId: string, method: number) {
  return `${providerId}\0${method}`
}

function invalidateNativeCredentialProof() {
  const setupWasComplete = isSetupComplete()
  invalidateSetupValidationProof()
  return setupWasComplete
}

async function suspendUnvalidatedRuntime(context: IpcHandlerContext) {
  const suspendRuntimeForSetup = context.suspendRuntimeForSetup || (async () => {
    const runtime = await import('../index.ts')
    await runtime.suspendRuntimeForSetup()
  })
  await suspendRuntimeForSetup()
}

async function restartRuntimeForSetupValidation(context: IpcHandlerContext) {
  const restartRuntime = context.restartRuntimeForSetupValidation || (async () => {
    const runtime = await import('../index.ts')
    await runtime.rebootRuntimeForSetupValidation()
  })
  await restartRuntime()
}

async function completeNativeOauthCredentialChange(
  context: IpcHandlerContext,
  attemptKey: string,
) {
  const pending = pendingOauthAttempts.get(attemptKey)
  if (pending) clearTimeout(pending.timeout)
  pendingOauthAttempts.delete(attemptKey)
  await suspendUnvalidatedRuntime(context)
}

async function cancelNativeOauthAttempt(
  context: IpcHandlerContext,
  attemptKey: string,
  expectedAttemptId?: string,
  suspend = true,
) {
  const pending = pendingOauthAttempts.get(attemptKey)
  if (!pending || (expectedAttemptId && pending.attemptID !== expectedAttemptId)) return false
  clearTimeout(pending.timeout)
  pendingOauthAttempts.delete(attemptKey)
  try {
    await pending.client.v2.integration.attempt.cancel({
      attemptID: pending.attemptID,
    }, { throwOnError: true })
  } catch (error) {
    // Expired/completed attempts may already be gone server-side. The local
    // ownership record and runtime suspension are still authoritative.
    context.logHandlerError('provider:oauth-cancel', error)
  } finally {
    if (suspend) await suspendUnvalidatedRuntime(context)
  }
  return true
}

function oauthAttemptDelay(expires: unknown, override?: number) {
  if (override !== undefined) return Math.max(1, override)
  if (typeof expires !== 'number' || !Number.isFinite(expires)) return DEFAULT_OAUTH_ATTEMPT_TIMEOUT_MS
  return Math.max(1, Math.min(expires - Date.now(), DEFAULT_OAUTH_ATTEMPT_TIMEOUT_MS))
}

function scheduleOauthAttemptExpiry(
  context: IpcHandlerContext,
  attemptKey: string,
  attemptId: string,
  expires: unknown,
) {
  const timeout = setTimeout(() => {
    void cancelNativeOauthAttempt(context, attemptKey, attemptId).catch((error) => {
      context.logHandlerError('provider:oauth-expire', error)
    })
  }, oauthAttemptDelay(expires, context.oauthAttemptTimeoutMs))
  timeout.unref?.()
  return timeout
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
    if (!client) throw new Error('Start the setup model service before loading provider sign-in options.')
    try {
      return await getNativeProviderAuthMethods(client)
    } catch (err) {
      context.logHandlerError('provider:auth-methods', err)
      throw new Error('Provider sign-in options could not be loaded from the model service.', { cause: err })
    }
  })

  context.ipcMain.handle('provider:test-connection', async (_event, providerIdInput: unknown, modelIdInput: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    const modelId = normalizeProviderModelId(modelIdInput)
    let validationStarted = false
    try {
      const settings = getEffectiveSettings()
      if (settings.effectiveProviderId !== providerId || settings.effectiveModel !== modelId) {
        throw new Error('Setup settings changed before the connection check. Save and test the selected connection again.')
      }
      const expectedFingerprint = getSetupValidationFingerprint()
      if (!expectedFingerprint) {
        throw new Error('Complete the required provider credentials before testing the connection.')
      }
      const setupWasComplete = invalidateNativeCredentialProof()
      if (setupWasComplete) await suspendUnvalidatedRuntime(context)
      if (!getClient() && (context.restartRuntimeForSetupValidation || !context.validateSetupConnection)) {
        await restartRuntimeForSetupValidation(context)
      }
      validationStarted = true
      const validateConnection = context.validateSetupConnection || validateRuntimeSetupConnection
      const result = await validateConnection(providerId, modelId)
      if (!result.ok || result.providerId !== providerId || result.modelId !== modelId) {
        throw new Error('The connection check did not validate the selected provider and model. Test it again.')
      }
      const validatedSettings = recordSuccessfulSetupValidation(expectedFingerprint)
      if (!validatedSettings.setupComplete) {
        throw new Error('The connection was tested, but setup validation could not be saved. Test it again.')
      }
      // Promote the deliberately limited setup candidate to the full runtime
      // only after the durable proof exists.
      if (context.restartRuntime) await context.restartRuntime()
      log('provider', `Tested provider connection for ${providerId}/${modelId}`)
      return result
    } catch (err) {
      if (validationStarted) {
        try {
          await suspendUnvalidatedRuntime(context)
        } catch (suspendError) {
          context.logHandlerError(`provider:test-connection suspend ${providerId}`, suspendError)
        }
      }
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
    const key = oauthAttemptKey(providerId, method)
    let invalidatedSetupWasComplete: boolean | null = null
    try {
      if (pendingOauthAttempts.has(key)) {
        throw new Error(`A provider login is already pending for ${providerId}. Finish it before starting another.`)
      }
      const integrationID = await resolveProviderIntegrationId(client, providerId)
      const integrationResponse = await client.v2.integration.get({ integrationID }, { throwOnError: true })
      const integration = unwrapNativeData<IntegrationInfo>(integrationResponse)
      const selected = integration.methods.filter((entry) => entry.type !== 'env')[method]
      if (!selected || selected.type !== 'oauth') {
        throw new Error(`Provider ${providerId} does not expose OAuth method ${method}.`)
      }
      // OAuth may replace credentials before the callback is observed (auto
      // mode). Persist the fail-closed state before the attempt can mutate
      // auth, while keeping the daemon alive until the pending attempt ends.
      const setupWasComplete = invalidateNativeCredentialProof()
      invalidatedSetupWasComplete = setupWasComplete
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
        time?: { expires?: number | string }
      }>(result)
      const authorization = normalizeProviderAuthorization({
        url: attempt.url,
        instructions: attempt.instructions,
        method: attempt.mode,
      })
      if (!authorization?.url) {
        throw new Error('Provider login did not return a valid authorization URL.')
      }
      try {
        const parsed = new URL(authorization.url)
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(`Unsupported auth URL protocol: ${parsed.protocol}`)
        }
        if (!electronShell) throw new Error('Electron shell API is unavailable')
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        log('security', `Blocked provider auth URL for ${providerId}: ${message}`)
        throw new Error('Provider auth URL was blocked because it was not a valid http(s) URL.', { cause: err })
      }
      pendingOauthAttempts.set(key, {
        attemptID: attempt.attemptID,
        mode: attempt.mode,
        client,
        timeout: scheduleOauthAttemptExpiry(context, key, attempt.attemptID, attempt.time?.expires),
      })
      await electronShell.openExternal(authorization.url)
      return authorization
    } catch (err) {
      if (invalidatedSetupWasComplete !== null) {
        try {
          if (!await cancelNativeOauthAttempt(context, key)) {
            await suspendUnvalidatedRuntime(context)
          }
        } catch (suspendError) {
          context.logHandlerError(`provider:oauth-authorize suspend ${providerId}`, suspendError)
        }
      }
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
        await completeNativeOauthCredentialChange(context, key)
        return true
      }
      if (status.status === 'failed') {
        await completeNativeOauthCredentialChange(context, key)
        throw new Error(status.message || `Provider login failed for ${providerId}.`)
      }
      if (status.status === 'expired') {
        await completeNativeOauthCredentialChange(context, key)
        throw new Error(`Provider login expired for ${providerId}. Start login again.`)
      }
      if (pending.mode === 'auto' && !code) return false
      try {
        await client.v2.integration.attempt.complete({
          attemptID: pending.attemptID,
          ...(code ? { code } : {}),
        }, { throwOnError: true })
      } finally {
        await completeNativeOauthCredentialChange(context, key)
      }
      return true
    } catch (err) {
      context.logHandlerError(`provider:oauth-callback ${providerId}`, err)
      throw err
    }
  })

  context.ipcMain.handle('provider:auth-remove', async (_event, providerIdInput: unknown) => {
    const providerId = resolveKnownProviderId(providerIdInput)
    invalidateNativeCredentialProof()
    try {
      const client = getClient()
      if (!client) throw new Error('OpenCode runtime is not running. Start the runtime, then try provider sign-out again.')
      const integrationID = await resolveProviderIntegrationId(client, providerId)
      const integrationResponse = await client.v2.integration.get({ integrationID }, { throwOnError: true })
      const integration = unwrapNativeData<IntegrationInfo>(integrationResponse)
      const credentialIds = integration.connections.flatMap((connection) => (
        connection.type === 'credential' ? [connection.id] : []
      ))
      // Persist the fail-closed state before mutating OpenCode auth. If either
      // storage or credential removal fails, a successful proof can never be
      // left behind for credentials that may already be gone.
      await Promise.all(credentialIds.map((credentialID) => (
        client.v2.credential.remove({ credentialID }, { throwOnError: true })
      )))
      for (const key of pendingOauthAttempts.keys()) {
        if (!key.startsWith(`${providerId}\0`)) continue
        await cancelNativeOauthAttempt(context, key, undefined, false)
      }
      log('provider', `Removed OpenCode-native auth for ${providerId}`)
      return true
    } catch (err) {
      context.logHandlerError(`provider:auth-remove ${providerId}`, err)
      throw err
    } finally {
      await suspendUnvalidatedRuntime(context)
    }
  })
}
