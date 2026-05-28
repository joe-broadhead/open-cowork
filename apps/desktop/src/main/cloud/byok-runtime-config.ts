import type { Config, ProviderConfig } from '@opencode-ai/sdk/v2'
import type { CredentialField } from '@open-cowork/shared'
import type { OpenCoworkConfig } from '../config-types.ts'
import { log } from '../logger.ts'
import { buildConfiguredDescriptorProviderRuntimeConfig } from '../runtime-config-builder.ts'
import type { ByokSecretStore } from './byok-secret-store.ts'
import type { CloudRuntimeExecutionContext } from './runtime-adapter.ts'

export class CloudByokRuntimeConfigError extends Error {
  readonly providerId: string
  readonly code: 'missing_required_byok' | 'kms_not_supported' | 'provider_not_allowed' | 'provider_not_entitled'

  constructor(providerId: string, code: CloudByokRuntimeConfigError['code'], message: string) {
    super(message)
    this.name = 'CloudByokRuntimeConfigError'
    this.providerId = providerId
    this.code = code
  }
}

export type CloudByokRuntimeConfigInput = {
  appConfig: OpenCoworkConfig
  byokSecrets: ByokSecretStore
  context: CloudRuntimeExecutionContext
  allowKmsRef?: boolean
  byokPolicy?: CloudByokRuntimeProviderPolicy | null
}

export type CloudByokRuntimeProviderPolicy = {
  allowedProviderIds?: readonly string[] | null
  checkEntitlement?: ((input: {
    orgId: string
    providerId: string
    context: CloudRuntimeExecutionContext
  }) => Promise<{ allowed: boolean, reason?: string | null }> | { allowed: boolean, reason?: string | null }) | null
}

function stripProviderPrefix(providerId: string, modelId: string | null | undefined) {
  const trimmed = modelId?.trim()
  if (!trimmed) return ''
  const prefix = `${providerId}/`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

function providerCredentialField(credentials: readonly CredentialField[] | undefined) {
  return credentials?.find((credential) => credential.secret)
    || credentials?.find((credential) => credential.required)
    || credentials?.[0]
    || null
}

function providerRequiresByok(input: {
  providerId: string
  defaultProviderId: string | null
  credentials: readonly CredentialField[] | undefined
}) {
  return input.providerId === input.defaultProviderId
    && Boolean(input.credentials?.some((credential) => credential.secret && credential.required))
}

function redactOptionShape(options: Record<string, unknown>) {
  return Object.entries(options).map(([key, value]) => {
    if (key === 'baseURL' && typeof value === 'string') return `${key}=${value}`
    if (typeof value === 'string') return `${key}=<len=${value.length} redacted>`
    return `${key}=<${typeof value}>`
  })
}

async function resolveProviderPolicy(input: {
  providerId: string
  orgId: string
  context: CloudRuntimeExecutionContext
  policy?: CloudByokRuntimeProviderPolicy | null
}): Promise<
  | { allowed: true, code: null, reason?: null }
  | { allowed: false, code: 'provider_not_allowed' | 'provider_not_entitled', reason?: string | null }
> {
  const allowedProviderIds = input.policy?.allowedProviderIds
    ? new Set(input.policy.allowedProviderIds.map((id) => id.trim().toLowerCase()).filter(Boolean))
    : null
  if (allowedProviderIds?.size && !allowedProviderIds.has(input.providerId.trim().toLowerCase())) {
    return { allowed: false, code: 'provider_not_allowed' as const }
  }
  const entitlement = await input.policy?.checkEntitlement?.({
    orgId: input.orgId,
    providerId: input.providerId,
    context: input.context,
  })
  if (entitlement && !entitlement.allowed) {
    return { allowed: false, code: 'provider_not_entitled' as const, reason: entitlement.reason || null }
  }
  return { allowed: true, code: null }
}

export async function buildCloudByokRuntimeConfig(input: CloudByokRuntimeConfigInput): Promise<Config> {
  const { appConfig, byokSecrets, context } = input
  const defaultProviderId = appConfig.providers.defaultProvider
  const providerEntries: Record<string, ProviderConfig> = {}
  const metadata = await byokSecrets.listMetadata(context.tenantId)
  const activeProviderIds = new Set(
    metadata
      .filter((secret) => secret.status === 'active')
      .map((secret) => secret.providerId),
  )

  for (const [providerId, descriptor] of Object.entries(appConfig.providers.descriptors || {})) {
    const policyVerdict = await resolveProviderPolicy({
      providerId,
      orgId: context.tenantId,
      context,
      policy: input.byokPolicy,
    })
    const shouldRequire = providerRequiresByok({
      providerId,
      defaultProviderId,
      credentials: descriptor.credentials,
    })
    const hasActiveSecret = activeProviderIds.has(providerId)
    if (!policyVerdict.allowed) {
      if (providerId === defaultProviderId || shouldRequire) {
        throw new CloudByokRuntimeConfigError(
          providerId,
          policyVerdict.code,
          policyVerdict.reason || `Provider "${providerId}" is not available for cloud BYOK execution.`,
        )
      }
      if (hasActiveSecret) {
        log(
          'runtime',
          `cloud-byok skipped provider=${providerId} tenant=${context.tenantId} session=${context.sessionId} reason=${policyVerdict.code}`,
        )
      }
      continue
    }
    if (!shouldRequire && !hasActiveSecret) continue

    const credential = providerCredentialField(descriptor.credentials)
    if (!credential) continue
    let plaintext: string
    try {
      plaintext = await byokSecrets.revealActiveSecret({
        orgId: context.tenantId,
        providerId,
        allowKmsRef: input.allowKmsRef,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const code = /kms/i.test(message) ? 'kms_not_supported' : 'missing_required_byok'
      throw new CloudByokRuntimeConfigError(
        providerId,
        code,
        `Provider "${providerId}" requires an active BYOK credential before cloud execution can start.`,
      )
    }

    const providerConfig = buildConfiguredDescriptorProviderRuntimeConfig(descriptor, {
      [credential.key]: plaintext,
    })
    if (!providerConfig) continue
    providerEntries[providerId] = providerConfig
    log(
      'runtime',
      `cloud-byok provider=${providerId} tenant=${context.tenantId} session=${context.sessionId} options {${redactOptionShape(providerConfig.options || {}).join(', ')}}`,
    )
  }

  const providerId = defaultProviderId || Object.keys(providerEntries)[0] || 'openrouter'
  const modelId = stripProviderPrefix(providerId, appConfig.providers.defaultModel)
  const model = modelId ? `${providerId}/${modelId}` : providerId
  return {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'manual',
    model,
    ...(Object.keys(providerEntries).length > 0 ? { provider: providerEntries } : {}),
  }
}
