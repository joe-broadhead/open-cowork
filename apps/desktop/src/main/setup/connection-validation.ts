import { getProviderDescriptor } from '@open-cowork/runtime-host/config'
import { listNativeProviders, type ProviderLike } from '@open-cowork/runtime-host/provider-utils'
import { getClient, getRuntimeHomeDir, writeRuntimeProviderApiAuth } from '@open-cowork/runtime-host/runtime'
import {
  isModelsDevAuthJsonBuiltin,
  toOpenCodeRuntimeProviderId,
} from '@open-cowork/runtime-host/runtime-config-builder'
import { getEffectiveSettings, getProviderCredentialValue } from '@open-cowork/runtime-host/settings'
import { connectNativeProviderApiKey, modelInfoKeys, unwrapNativeData } from '@open-cowork/runtime-host'
import { log } from '@open-cowork/shared/node'
import { deleteSessionThroughClassicGap } from '../ipc/session-action-handlers.ts'

type SetupConnectionValidationResult = {
  ok: true
  providerId: string
  modelId: string
}

export type SetupConnectionValidator = (
  providerId: string,
  modelId: string,
) => Promise<SetupConnectionValidationResult>

const CONNECTION_CHECK_TIMEOUT_MS = 30_000
const CONNECTION_CHECK_CLEANUP_TIMEOUT_MS = 5_000
const E2E_SETUP_VALIDATION_KEY_ENV = 'OPEN_COWORK_E2E_SETUP_VALIDATION_KEY'

class SafeSetupConnectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SafeSetupConnectionError'
  }
}

function runtimeModelId(providerId: string, modelId: string) {
  const prefix = `${providerId}/`
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
}

function findApiKeyCredential(providerId: string) {
  const descriptor = getProviderDescriptor(providerId)
  return descriptor?.credentials.find((credential) => {
    const runtimeKey = credential.runtimeKey || credential.key
    return runtimeKey === 'apiKey' || /api.*key/i.test(`${credential.key} ${credential.label}`)
  }) || null
}

function validateAgainstE2EFixture(providerId: string, expectedKey: string) {
  const credential = findApiKeyCredential(providerId)
  const settings = getEffectiveSettings()
  const actualKey = credential
    ? getProviderCredentialValue(settings, providerId, credential.key)
    : null
  if (!actualKey || actualKey !== expectedKey) {
    throw new SafeSetupConnectionError('The saved provider credential was rejected. Check it and test the connection again.')
  }
}

function isConnectionCheckTimeout(error: unknown) {
  return error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function connectionCheckOptions(timeoutMs = CONNECTION_CHECK_TIMEOUT_MS) {
  return {
    throwOnError: true as const,
    signal: AbortSignal.timeout(timeoutMs),
  }
}

export function resolveDevelopmentSetupConnectionValidator(options: {
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): SetupConnectionValidator | undefined {
  const env = options.env || process.env
  const expectedKey = env[E2E_SETUP_VALIDATION_KEY_ENV]?.trim()
  if (options.isPackaged || env.OPEN_COWORK_E2E !== '1' || !expectedKey) return undefined
  return async (providerId, modelId) => {
    // This seam is injected only by an unpackaged Electron process. Release
    // binaries always execute the real OpenCode model turn below.
    validateAgainstE2EFixture(providerId, expectedKey)
    return { ok: true, providerId, modelId }
  }
}

async function syncApiCredential(providerId: string) {
  const client = getClient()
  if (!client) throw new SafeSetupConnectionError('The model service is not ready yet. Try testing the connection again in a moment.')
  const credential = findApiKeyCredential(providerId)
  if (!credential) return false

  const settings = getEffectiveSettings()
  const key = getProviderCredentialValue(settings, providerId, credential.key)
  if (!key) return false

  const runtimeProviderId = toOpenCodeRuntimeProviderId(providerId)
  if (isModelsDevAuthJsonBuiltin(providerId)) {
    writeRuntimeProviderApiAuth(runtimeProviderId, key)
    return true
  }

  try {
    await connectNativeProviderApiKey(client, runtimeProviderId, key, connectionCheckOptions())
  } catch (error) {
    if (isConnectionCheckTimeout(error)) {
      throw new SafeSetupConnectionError('The model service timed out while applying the saved credential. Try the connection check again.')
    }
    // Some OpenCode providers do not expose a native key method even though
    // they accept managed auth.json credentials. Match runtime boot's fallback.
    writeRuntimeProviderApiAuth(runtimeProviderId, key)
    log('provider', `Connection-test native key sync unavailable for ${providerId}; used managed auth fallback.`)
  }
  return true
}

function providerMatches(provider: ProviderLike, runtimeProviderId: string) {
  return provider.id === runtimeProviderId || provider.name === runtimeProviderId
}

function providerHasModel(provider: ProviderLike, modelId: string) {
  const models = provider.models || {}
  const keys = Object.keys(models)
  if (keys.length === 0) return true
  const providerId = provider.id || provider.name
  const wanted = new Set(modelInfoKeys(providerId, modelId))
  return keys.some((key) => (
    wanted.has(key)
    || modelInfoKeys(providerId, key).some((candidate) => wanted.has(candidate))
  ))
}

function modelMatchesSelection(
  model: { providerID: string, id: string },
  runtimeProviderId: string,
  expectedRuntimeModelId: string,
) {
  return model.providerID === runtimeProviderId
    && runtimeModelId(runtimeProviderId, model.id) === expectedRuntimeModelId
}

function connectionFailure(providerId: string) {
  const providerName = getProviderDescriptor(providerId)?.name || providerId
  return new SafeSetupConnectionError(
    `${providerName} could not run the selected model. Check the model and credential, then test again.`,
  )
}

async function runDisposableModelTurn(
  providerId: string,
  modelId: string,
  runtimeProviderId: string,
) {
  const client = getClient()
  if (!client) throw new SafeSetupConnectionError('The model service is not ready yet. Try testing the connection again in a moment.')
  const directory = getRuntimeHomeDir()
  const selectedRuntimeModelId = runtimeModelId(providerId, modelId)
  let sessionId: string | null = null
  let connectionError: SafeSetupConnectionError | null = null
  let cleanupError: SafeSetupConnectionError | null = null

  try {
    const created = await client.v2.session.create({
      location: { directory },
      model: {
        id: selectedRuntimeModelId,
        providerID: runtimeProviderId,
      },
    }, connectionCheckOptions())
    sessionId = unwrapNativeData<{ id: string }>(created).id

    const prompted = await client.v2.session.prompt({
      sessionID: sessionId,
      prompt: { text: 'Reply with OK only. Do not use tools.' },
      delivery: 'queue',
      resume: true,
    }, connectionCheckOptions())
    const admitted = unwrapNativeData<{ sessionID: string }>(prompted)
    if (admitted.sessionID !== sessionId) {
      throw new SafeSetupConnectionError('The model service admitted the connection check to a different session. Test the selected connection again.')
    }

    await client.v2.session.wait({ sessionID: sessionId }, connectionCheckOptions())
    const response = await client.v2.session.messages({
      sessionID: sessionId,
      limit: 20,
      order: 'desc',
    }, connectionCheckOptions())
    const messages = unwrapNativeData<unknown[]>(response)
    const assistant = messages.find((message): message is {
      type: 'assistant'
      model: { providerID: string, id: string }
      error?: unknown
    } => {
      if (!message || typeof message !== 'object') return false
      const candidate = message as { type?: unknown, model?: { providerID?: unknown, id?: unknown } }
      return candidate.type === 'assistant'
        && typeof candidate.model?.providerID === 'string'
        && typeof candidate.model.id === 'string'
    })
    if (!assistant || assistant.error) throw connectionFailure(providerId)
    if (!modelMatchesSelection(assistant.model, runtimeProviderId, selectedRuntimeModelId)) {
      throw new SafeSetupConnectionError('The model service answered with a different provider or model. Test the selected connection again.')
    }
  } catch (error) {
    connectionError = error instanceof SafeSetupConnectionError
      ? error
      : new SafeSetupConnectionError('The model connection check failed. Check the credential and model, then try again.')
  }

  if (sessionId) {
    try {
      await deleteSessionThroughClassicGap(
        client,
        { sessionID: sessionId, directory },
        connectionCheckOptions(CONNECTION_CHECK_CLEANUP_TIMEOUT_MS),
      )
    } catch {
      cleanupError = new SafeSetupConnectionError('The connection check could not clean up its temporary session. Try again.')
    }
  }
  if (connectionError) {
    if (cleanupError) {
      log('provider', 'Temporary connection-check session cleanup also failed after the validation error.')
    }
    throw connectionError
  }
  if (cleanupError) throw cleanupError
}

export const validateRuntimeSetupConnection: SetupConnectionValidator = async (providerId, modelId) => {
  const client = getClient()
  if (!client) throw new SafeSetupConnectionError('The model service is not ready yet. Try testing the connection again in a moment.')
  const providerName = getProviderDescriptor(providerId)?.name || providerId
  const apiCredentialSynced = await syncApiCredential(providerId)
  const runtimeProviderId = toOpenCodeRuntimeProviderId(providerId)
  let providers: ProviderLike[]
  try {
    providers = await listNativeProviders(client, connectionCheckOptions())
  } catch (error) {
    if (isConnectionCheckTimeout(error)) {
      throw new SafeSetupConnectionError('The model service timed out while loading its provider catalog. Try the connection check again.')
    }
    throw new SafeSetupConnectionError('The model service could not load its provider catalog. Try the connection check again.')
  }
  const provider = providers.find((entry) => providerMatches(entry, runtimeProviderId))

  if (!provider) {
    throw new SafeSetupConnectionError(`${providerName} is not available in the model service. Choose another provider or update setup settings.`)
  }
  if (!apiCredentialSynced && provider.connected === false) {
    throw new SafeSetupConnectionError(`${providerName} is not signed in yet. Sign in or enter an API key, then test again.`)
  }
  if (!providerHasModel(provider, modelId)) {
    throw new SafeSetupConnectionError(`${modelId} is not available from ${providerName}. Choose a listed model, then test again.`)
  }

  await runDisposableModelTurn(providerId, modelId, runtimeProviderId)
  return { ok: true, providerId, modelId }
}
