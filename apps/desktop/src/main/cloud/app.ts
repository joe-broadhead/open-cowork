import { resolve } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { PublicBrandingConfig } from '@open-cowork/shared'
import { DEFAULT_CONFIG, type CloudAbuseConfig, type CloudAuthConfig, type CloudBillingConfig, type OpenCoworkConfig } from '../config-types.ts'
import { CloudArtifactService } from './artifact-service.ts'
import { evaluateBillingEntitlement, type BillingAdapter } from './billing-adapter.ts'
import {
  resolveCloudRuntimePolicy,
  type CloudRuntimePolicy,
} from './cloud-config.ts'
import { type ControlPlaneStore, InMemoryControlPlaneStore } from './control-plane-store.ts'
import {
  createCloudHttpServer,
  CloudHttpError,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudDesktopAuthConfig,
  type CloudHttpServer,
} from './http-server.ts'
import {
  createCloudObservabilityFromEnv,
  type CloudObservabilityAdapter,
} from './observability.ts'
import { createObjectStoreForCloud, type ObjectStoreAdapter } from './object-store.ts'
import {
  createByokSecretStore,
  type ByokSecretStore,
  type ByokSecretStoreOptions,
} from './byok-secret-store.ts'
import {
  createOidcBrowserAuthProvider,
  createOidcCloudAuthResolver,
  type OidcCloudAuthResolverOptions,
} from './oidc-auth.ts'
import { createCloudPathProvider, createCloudSessionPathProvider, type PathProvider } from './path-provider.ts'
import { createPostgresControlPlaneStore } from './postgres-control-plane-store.ts'
import { createCloudProjectSourceService } from './project-source-service.ts'
import { createNodeOpencodeCloudRuntimeAdapter } from './opencode-runtime-adapter.ts'
import type { CloudRuntimeAdapter, CloudRuntimeEvent } from './runtime-adapter.ts'
import { createCloudSecretAdapterFromEnv, resolveCloudSecretRef, type SecretAdapter } from './secret-adapter.ts'
import { createCloudSessionCookieManager, type CloudSessionCookieManager } from './session-cookie-auth.ts'
import { CloudSessionService, type ByokManagementPolicy, type CloudPrincipal } from './session-service.ts'
import { CloudScheduler } from './scheduler.ts'
import { createStripeBillingAdapter } from './stripe-billing-adapter.ts'
import { createStubBillingAdapter } from './stub-billing-adapter.ts'
import { CloudWorker } from './worker.ts'
import { createWorkerScopedRuntimeAdapter } from './worker-scoped-runtime-adapter.ts'
import {
  createObjectWorkspaceCheckpointStore,
  defaultCloudSessionCheckpointRoots,
  type WorkspaceCheckpointStore,
} from './workspace-checkpoint-store.ts'
import type { WorkflowWebhookSecurityStore } from '../workflow/workflow-webhook-server.ts'

type Env = Record<string, string | undefined>

const ALLOW_INSECURE_CLOUD_AUTH_ENV = 'OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH'

export type CloudRoleRuntimeFactoryInput = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  execution: {
    tenantId: string
    sessionId: string
    profileName?: string | null
  }
  runtimeConfig: import('@opencode-ai/sdk/v2/server').ServerOptions['config']
}

export type CloudRuntimeFactory = (
  input: CloudRoleRuntimeFactoryInput,
) => Promise<CloudRuntimeAdapter> | CloudRuntimeAdapter

export type CloudControlPlaneStoreFactoryInput = {
  config: OpenCoworkConfig
  env: Env
}

export type CloudControlPlaneStoreFactory = (
  input: CloudControlPlaneStoreFactoryInput,
) => Promise<ControlPlaneStore> | ControlPlaneStore

export type CloudObjectStoreFactoryInput = {
  config: OpenCoworkConfig
  env: Env
  paths: PathProvider
}

export type CloudObjectStoreFactory = (
  input: CloudObjectStoreFactoryInput,
) => Promise<ObjectStoreAdapter> | ObjectStoreAdapter

export type CloudAppOptions = {
  config?: OpenCoworkConfig
  env?: Env
  store?: ControlPlaneStore
  storeFactory?: CloudControlPlaneStoreFactory
  objectStore?: ObjectStoreAdapter
  objectStoreFactory?: CloudObjectStoreFactory
  secretAdapter?: SecretAdapter
  byokSecretStoreOptions?: Pick<ByokSecretStoreOptions, 'kmsRefResolver' | 'validators'>
  byokPolicy?: ByokManagementPolicy
  billingAdapter?: BillingAdapter | null
  runtime?: CloudRuntimeAdapter
  runtimeFactory?: CloudRuntimeFactory
  paths?: PathProvider
  checkpointStore?: WorkspaceCheckpointStore | null
  checkpointsEnabled?: boolean
  sessionCookies?: CloudSessionCookieManager | null
  observability?: CloudObservabilityAdapter | null
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  hostname?: string
  port?: number
  workerPollMs?: number
  schedulerPollMs?: number
  corsOrigin?: string | null
  autoProcessCommands?: boolean
}

export type CloudApp = {
  policy: CloudRuntimePolicy
  store: ControlPlaneStore
  objectStore: ObjectStoreAdapter
  byokSecrets: ByokSecretStore
  checkpointStore: WorkspaceCheckpointStore | null
  paths: PathProvider
  runtime: CloudRuntimeAdapter
  service: CloudSessionService
  worker: CloudWorker | null
  scheduler: CloudScheduler | null
  server: CloudHttpServer | null
  observability: CloudObservabilityAdapter | null
  url: string | null
  close: () => Promise<void>
}

const DEFAULT_CLOUD_ROOT = '.open-cowork-cloud'

function envValue(env: Env, key: string) {
  const value = env[key]?.trim()
  return value || null
}

function parsePort(value: string | null | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid cloud port "${value}".`)
  }
  return parsed
}

function parsePositiveInt(value: string | null | undefined, fallback: number) {
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer "${value}".`)
  }
  return parsed
}

function parseOptionalPositiveInt(value: string | null | undefined, fallback: number | null) {
  if (!value) return fallback
  const parsed = Number(value)
  if (parsed === 0) return null
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid non-negative integer "${value}".`)
  }
  return parsed
}

function parseBoolean(value: string | null | undefined, fallback: boolean) {
  if (!value) return fallback
  if (/^(1|true|yes|on)$/i.test(value)) return true
  if (/^(0|false|no|off)$/i.test(value)) return false
  throw new Error(`Invalid boolean "${value}".`)
}

function resolveEnvRef(ref: string | undefined, env: Env) {
  if (!ref) return null
  const envName = ref.startsWith('env:') ? ref.slice('env:'.length) : ref
  return envValue(env, envName)
}

function parseCsv(value: string | null) {
  return value?.split(',').map((entry) => entry.trim()).filter(Boolean) || null
}

export function resolveCloudAuthConfig(config: OpenCoworkConfig, env: Env = process.env): CloudAuthConfig {
  const requestedMode = envValue(env, 'OPEN_COWORK_CLOUD_AUTH_MODE')
  const mode = requestedMode === 'oidc' || requestedMode === 'header' || requestedMode === 'none'
    ? requestedMode
    : config.cloud.auth.mode
  const requestedSelfService = envValue(env, 'OPEN_COWORK_CLOUD_ALLOW_SELF_SERVICE_SIGNUP')
  const envSwitchedToOidc = mode === 'oidc' && requestedMode === 'oidc' && config.cloud.auth.mode !== 'oidc'
  return {
    ...config.cloud.auth,
    mode,
    headerSecret: envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET')
      || resolveEnvRef(envValue(env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF') || undefined, env)
      || config.cloud.auth.headerSecret,
    issuerUrl: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_ISSUER_URL') || config.cloud.auth.issuerUrl,
    clientId: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_ID') || config.cloud.auth.clientId,
    clientSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF') || config.cloud.auth.clientSecretRef,
    callbackPath: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CALLBACK_PATH') || config.cloud.auth.callbackPath,
    cookieSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF') || config.cloud.auth.cookieSecretRef,
    allowedEmailDomains: parseCsv(envValue(env, 'OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS')) || config.cloud.auth.allowedEmailDomains,
    allowSelfServiceSignup: requestedSelfService
      ? parseBoolean(requestedSelfService, false)
      : envSwitchedToOidc
        ? false
        : config.cloud.auth.allowSelfServiceSignup ?? mode !== 'oidc',
  }
}

export function resolveCloudControlPlaneUrl(config: OpenCoworkConfig, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_CONTROL_PLANE_URL')
    || resolveEnvRef(config.cloud.storage.controlPlane.urlRef, env)
}

export function resolveCloudCookieSecret(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
    || resolveEnvRef(config.cloud.auth.cookieSecretRef, env)
    || envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
}

export function resolveCloudAbuseConfig(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env): CloudAbuseConfig {
  const defaults = config.cloud.abuse
  return {
    ...defaults,
    enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_ABUSE_ENABLED'), defaults.enabled),
    maxConcurrentSessionsPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_CONCURRENT_SESSIONS_PER_ORG'),
      defaults.maxConcurrentSessionsPerOrg,
    ),
    maxActiveWorkersPerOrg: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_ACTIVE_WORKERS_PER_ORG'),
      defaults.maxActiveWorkersPerOrg,
    ),
    maxPromptsPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_PROMPTS_PER_HOUR'),
      defaults.maxPromptsPerHour,
    ),
    maxGatewayDeliveriesPerHour: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_GATEWAY_DELIVERIES_PER_HOUR'),
      defaults.maxGatewayDeliveriesPerHour,
    ),
    maxArtifactBytesPerDay: parseOptionalPositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_ARTIFACT_BYTES_PER_DAY'),
      defaults.maxArtifactBytesPerDay,
    ),
    httpRateLimit: {
      ...defaults.httpRateLimit,
      enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_ENABLED'), defaults.httpRateLimit.enabled),
      windowMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_WINDOW_MS'), defaults.httpRateLimit.windowMs),
      maxRequests: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_HTTP_RATE_LIMIT_MAX_REQUESTS'), defaults.httpRateLimit.maxRequests),
    },
    authBackoff: {
      ...defaults.authBackoff,
      enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_ENABLED'), defaults.authBackoff.enabled),
      windowMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_WINDOW_MS'), defaults.authBackoff.windowMs),
      maxFailures: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_MAX_FAILURES'), defaults.authBackoff.maxFailures),
      backoffMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_AUTH_BACKOFF_MS'), defaults.authBackoff.backoffMs),
    },
  }
}

export function resolveCloudBillingConfig(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env): CloudBillingConfig {
  const defaults = config.cloud.billing
  const provider = envValue(env, 'OPEN_COWORK_CLOUD_BILLING_PROVIDER') || defaults.provider
  return {
    ...defaults,
    enabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_BILLING_ENABLED'), defaults.enabled),
    provider: provider === 'none' || provider === 'stub' || provider === 'stripe' ? provider : defaults.provider,
    defaultPlanKey: envValue(env, 'OPEN_COWORK_CLOUD_BILLING_DEFAULT_PLAN') || defaults.defaultPlanKey,
    stripe: {
      ...(defaults.stripe || {}),
      apiKeyRef: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_API_KEY_REF') || defaults.stripe?.apiKeyRef,
      webhookSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET_REF') || defaults.stripe?.webhookSecretRef,
      defaultPriceId: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_PRICE_ID') || defaults.stripe?.defaultPriceId,
      successUrl: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_SUCCESS_URL') || defaults.stripe?.successUrl,
      cancelUrl: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_CANCEL_URL') || defaults.stripe?.cancelUrl,
      portalReturnUrl: envValue(env, 'OPEN_COWORK_CLOUD_STRIPE_PORTAL_RETURN_URL') || defaults.stripe?.portalReturnUrl,
    },
  }
}

async function createBillingAdapterForCloud(input: {
  config: CloudBillingConfig
  env: Env
}): Promise<BillingAdapter | null> {
  if (!input.config.enabled || input.config.provider === 'none') return null
  if (input.config.provider === 'stub') return createStubBillingAdapter(input.config)
  if (input.config.provider === 'stripe') {
    const apiKey = envValue(input.env, 'OPEN_COWORK_CLOUD_STRIPE_API_KEY')
      || resolveEnvRef(input.config.stripe?.apiKeyRef, input.env)
    const webhookSecret = envValue(input.env, 'OPEN_COWORK_CLOUD_STRIPE_WEBHOOK_SECRET')
      || resolveEnvRef(input.config.stripe?.webhookSecretRef, input.env)
    return createStripeBillingAdapter({
      config: input.config,
      apiKey,
      webhookSecret,
    })
  }
  return null
}

export function resolveCloudOidcClientSecret(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET')
    || resolveEnvRef(config.cloud.auth.clientSecretRef, env)
}

export function resolveCloudInternalToken(env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_INTERNAL_TOKEN')
    || resolveEnvRef(envValue(env, 'OPEN_COWORK_CLOUD_INTERNAL_TOKEN_REF') || undefined, env)
}

export async function createControlPlaneStoreForCloud(
  input: CloudControlPlaneStoreFactoryInput,
): Promise<ControlPlaneStore> {
  const url = resolveCloudControlPlaneUrl(input.config, input.env)
  if (input.config.cloud.storage.controlPlane.kind === 'postgres' || url) {
    if (!url) {
      throw new Error('Cloud control plane is configured for Postgres but no connection URL is available.')
    }
    return createPostgresControlPlaneStore({ connectionString: url })
  }
  return new InMemoryControlPlaneStore()
}

export function shouldRunCloudWeb(role: CloudRuntimePolicy['role']) {
  return role === 'all-in-one' || role === 'web'
}

export function shouldRunCloudWorker(role: CloudRuntimePolicy['role']) {
  return role === 'all-in-one' || role === 'worker'
}

export function shouldRunCloudScheduler(role: CloudRuntimePolicy['role']) {
  return role === 'all-in-one' || role === 'scheduler'
}

export function resolveCloudBootstrapOptionsFromEnv(env: Env = process.env) {
  const workerPollMs = parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_POLL_MS'), 1000)
  return {
    root: resolve(envValue(env, 'OPEN_COWORK_CLOUD_ROOT') || DEFAULT_CLOUD_ROOT),
    hostname: envValue(env, 'HOST') || envValue(env, 'OPEN_COWORK_CLOUD_HOST') || '0.0.0.0',
    port: parsePort(envValue(env, 'PORT') || envValue(env, 'OPEN_COWORK_CLOUD_PORT'), 8787),
    workerPollMs,
    schedulerPollMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS'), workerPollMs),
    corsOrigin: envValue(env, 'OPEN_COWORK_CLOUD_CORS_ORIGIN'),
    autoProcessCommands: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS'), true),
    checkpointsEnabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED'), false),
    cookieSecure: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECURE'), true),
    publicUrl: envValue(env, 'OPEN_COWORK_CLOUD_PUBLIC_URL'),
    trustProxyHeaders: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS'), false),
  }
}

function parsePublicBrandingJson(env: Env) {
  const raw = envValue(env, 'OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON')
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<PublicBrandingConfig>
      : {}
  } catch (error) {
    throw new Error(`Invalid OPEN_COWORK_CLOUD_PUBLIC_BRANDING_JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function cleanBrandingObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => typeof entry === 'string' && entry.trim())
      .map(([key, entry]) => [key, String(entry).trim()]),
  )
}

function safePublicBrandingUrl(value: unknown, allowMailto = false) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol === 'https:') return url.toString()
    if (allowMailto && url.protocol === 'mailto:') return url.toString()
  } catch {
    return undefined
  }
  return undefined
}

function cleanPublicBrandingEntry(entry: Partial<PublicBrandingConfig>) {
  const cleaned = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null && value !== '')) as Partial<PublicBrandingConfig> & Record<string, unknown>
  const urls: Array<[keyof PublicBrandingConfig, boolean]> = [
    ['logoUrl', false],
    ['supportUrl', true],
    ['privacyUrl', false],
    ['securityUrl', false],
    ['legalUrl', false],
  ]
  for (const [key, allowMailto] of urls) {
    if (!(key in cleaned)) continue
    const safeUrl = safePublicBrandingUrl(cleaned[key], allowMailto)
    if (safeUrl) cleaned[key] = safeUrl
    else delete cleaned[key]
  }
  return cleaned
}

function mergePublicBranding(...entries: Array<Partial<PublicBrandingConfig> | undefined>): PublicBrandingConfig {
  const merged = entries.reduce<PublicBrandingConfig>((current, entry) => {
    if (!entry) return current
    const cleanEntry = cleanPublicBrandingEntry(entry)
    return {
      ...current,
      ...cleanEntry,
      theme: {
        ...(current.theme || {}),
        ...cleanBrandingObject(cleanEntry.theme),
      },
      dashboard: {
        ...(current.dashboard || {}),
        ...cleanBrandingObject(cleanEntry.dashboard),
      },
      managedOrgConnectionLabels: {
        ...(current.managedOrgConnectionLabels || {}),
        ...cleanBrandingObject(cleanEntry.managedOrgConnectionLabels),
      },
    }
  }, { ...DEFAULT_CONFIG.cloud.publicBranding })
  return {
    ...merged,
    productName: merged.productName?.trim() || DEFAULT_CONFIG.cloud.publicBranding.productName,
    shortName: merged.shortName?.trim() || DEFAULT_CONFIG.cloud.publicBranding.shortName,
  }
}

export function resolveCloudPublicBranding(config: OpenCoworkConfig, env: Env = process.env): PublicBrandingConfig {
  return mergePublicBranding(
    DEFAULT_CONFIG.cloud.publicBranding,
    config.cloud.publicBranding,
    parsePublicBrandingJson(env),
    {
      productName: envValue(env, 'OPEN_COWORK_CLOUD_BRAND_NAME') || undefined,
      shortName: envValue(env, 'OPEN_COWORK_CLOUD_BRAND_SHORT_NAME') || undefined,
      logoUrl: envValue(env, 'OPEN_COWORK_CLOUD_BRAND_LOGO_URL') || undefined,
      supportUrl: envValue(env, 'OPEN_COWORK_CLOUD_SUPPORT_URL') || undefined,
      privacyUrl: envValue(env, 'OPEN_COWORK_CLOUD_PRIVACY_URL') || undefined,
      securityUrl: envValue(env, 'OPEN_COWORK_CLOUD_SECURITY_URL') || undefined,
      legalUrl: envValue(env, 'OPEN_COWORK_CLOUD_LEGAL_URL') || undefined,
    },
  )
}

function createUnavailableRuntimeAdapter(): CloudRuntimeAdapter {
  const fail = () => {
    throw new Error('Cloud runtime is not available in this process role.')
  }
  return {
    createSession: fail,
    promptSession: fail,
    abortSession: fail,
    replyToQuestion: fail,
    rejectQuestion: fail,
    respondToPermission: fail,
  }
}

function defaultCloudRuntimeFactory(input: CloudRoleRuntimeFactoryInput) {
  return createNodeOpencodeCloudRuntimeAdapter({
    paths: input.paths,
    env: input.env as NodeJS.ProcessEnv,
    config: input.runtimeConfig,
    configDelivery: 'ephemeral-file',
    cwd: input.paths.resolveWorkspacePath(input.execution.tenantId, input.execution.sessionId),
  })
}

function listConfiguredByokProviderIds(config: OpenCoworkConfig) {
  const providerIds = (config.providers.available || [])
    .map((providerId) => providerId.trim().toLowerCase())
    .filter(Boolean)
  return providerIds.length > 0 ? Array.from(new Set(providerIds)) : null
}

function readHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

function constantTimeStringEqual(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) return false
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function createHeaderCloudAuthResolver(defaults: Partial<CloudPrincipal> = {}, options: {
  headerSecret?: string | null
} = {}): CloudAuthResolver {
  return (req) => {
    const expectedSecret = options.headerSecret?.trim()
    if (expectedSecret && !constantTimeStringEqual(readHeader(req, 'x-open-cowork-header-auth-secret'), expectedSecret)) {
      throw new CloudHttpError(401, 'Trusted header authentication secret is invalid.')
    }
    const tenantId = readHeader(req, 'x-open-cowork-tenant-id') || defaults.tenantId || 'default'
    const userId = readHeader(req, 'x-open-cowork-user-id') || defaults.userId || 'local-user'
    const email = readHeader(req, 'x-open-cowork-user-email') || defaults.email || 'local@example.test'
    return {
      tenantId,
      orgId: defaults.orgId || tenantId,
      tenantName: readHeader(req, 'x-open-cowork-tenant-name') || defaults.tenantName || tenantId,
      userId,
      accountId: defaults.accountId || userId,
      email,
      role: (readHeader(req, 'x-open-cowork-user-role') as CloudPrincipal['role']) || defaults.role || 'member',
      authSource: 'header',
    }
  }
}

export function createLocalCloudAuthResolver(defaults: Partial<CloudPrincipal> = {}): CloudAuthResolver {
  return () => ({
    tenantId: defaults.tenantId || 'default',
    orgId: defaults.orgId || defaults.tenantId || 'default',
    tenantName: defaults.tenantName || defaults.tenantId || 'Default',
    userId: defaults.userId || 'local-user',
    accountId: defaults.accountId || defaults.userId || 'local-user',
    email: defaults.email || 'local@example.test',
    role: defaults.role || 'owner',
    authSource: 'local',
  })
}

function readBearerToken(req: IncomingMessage) {
  const raw = readHeader(req, 'authorization') || ''
  return raw.toLowerCase().startsWith('bearer ') ? raw.slice('bearer '.length).trim() : ''
}

export function createApiTokenCloudAuthResolver(store: ControlPlaneStore): CloudAuthResolver {
  return async (req) => {
    const token = readBearerToken(req)
    if (!token) throw new CloudHttpError(401, 'Cloud API token authorization is required.')
    const record = await store.findApiTokenByPlaintext(token)
    if (!record) throw new CloudHttpError(401, 'Cloud API token is invalid or expired.')
    const membership = await store.resolvePrincipalMembership({
      tenantId: record.orgId,
      accountId: record.accountId,
    })
    if (!membership || membership.membership.status !== 'active') {
      throw new CloudHttpError(401, 'Cloud API token membership is not active.')
    }
    return {
      tenantId: membership.org.tenantId,
      orgId: membership.org.orgId,
      tenantName: membership.org.name,
      userId: membership.account.accountId,
      accountId: membership.account.accountId,
      email: membership.account.email,
      role: membership.membership.role,
      authSource: 'api_token',
      tokenId: record.tokenId,
      tokenScopes: record.scopes,
    }
  }
}

export function createCompositeCloudAuthResolver(...resolvers: CloudAuthResolver[]): CloudAuthResolver {
  return async (req) => {
    let lastError: unknown = null
    for (const resolver of resolvers) {
      try {
        return await resolver(req)
      } catch (error) {
        lastError = error
      }
    }
    if (lastError instanceof CloudHttpError) throw lastError
    throw new CloudHttpError(401, 'Cloud authentication failed.')
  }
}

export function createCloudAuthResolverForConfig(
  config: Pick<OpenCoworkConfig, 'cloud'>,
  options: OidcCloudAuthResolverOptions = {},
): CloudAuthResolver {
  if (config.cloud.auth.mode === 'oidc') {
    return createOidcCloudAuthResolver(config.cloud.auth, options)
  }
  if (config.cloud.auth.mode === 'header') {
    return createHeaderCloudAuthResolver({}, { headerSecret: config.cloud.auth.headerSecret })
  }
  return createLocalCloudAuthResolver()
}

export function createCloudDesktopAuthConfig(auth: CloudAuthConfig): CloudDesktopAuthConfig | null {
  if (auth.mode !== 'oidc' || !auth.issuerUrl?.trim() || !auth.clientId?.trim()) return null
  return {
    mode: 'oidc',
    issuerUrl: auth.issuerUrl.trim(),
    clientId: auth.clientId.trim(),
    scope: 'openid email profile offline_access',
  }
}

export function isLoopbackCloudHost(hostname: string | null | undefined) {
  const host = (hostname || '').trim().toLowerCase()
  if (!host) return false
  return host === 'localhost'
    || host === '::1'
    || host === '[::1]'
    || host === '::ffff:127.0.0.1'
    || host === '[::ffff:127.0.0.1]'
    || host === '127.0.0.1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

export function assertCloudAuthDeploymentSafe(input: {
  role: CloudRuntimePolicy['role']
  hostname: string
  auth: CloudAuthConfig
  publicUrl?: string | null
  env?: Env
}) {
  if (!shouldRunCloudWeb(input.role)) return
  if (parseBoolean(envValue(input.env || process.env, ALLOW_INSECURE_CLOUD_AUTH_ENV), false)) return
  if (input.auth.mode === 'none') {
    if (isLoopbackCloudHost(input.hostname)) return
    throw new Error(
      `Cloud auth mode "none" may only bind to loopback addresses. Set cloud.auth.mode to "oidc" for public browser/JWT auth, "header" for a trusted reverse proxy, or set ${ALLOW_INSECURE_CLOUD_AUTH_ENV}=true for an explicit local/demo override.`,
    )
  }
  if (input.auth.mode === 'header' && !input.auth.headerSecret?.trim() && !isLoopbackCloudHost(input.hostname)) {
    throw new Error(
      'Cloud auth mode "header" on a public bind requires OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET or OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF so caller-supplied identity headers cannot be spoofed.',
    )
  }
  if (input.auth.mode === 'oidc' && !input.publicUrl?.trim() && !isLoopbackCloudHost(input.hostname)) {
    throw new Error('Cloud OIDC public deployments require OPEN_COWORK_CLOUD_PUBLIC_URL so redirect URIs do not trust forwarded headers.')
  }
}

async function routeRuntimeEvent(
  store: ControlPlaneStore,
  worker: CloudWorker,
  event: CloudRuntimeEvent,
) {
  const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
  if (!sessionId) return
  const session = await store.findSession(sessionId)
  if (!session) return
  await worker.appendRuntimeEvent(session.tenantId, session.sessionId, event)
}

function loopErrorAttributes(error: unknown) {
  return {
    error_name: error instanceof Error ? error.name : 'Error',
    error_message: error instanceof Error ? error.message : String(error),
  }
}

async function recordLoopError(
  observability: CloudObservabilityAdapter | null,
  name: string,
  error: unknown,
  attributes: Record<string, string | number | boolean | null | undefined> = {},
) {
  await observability?.log({
    level: 'error',
    name,
    message: error instanceof Error ? error.message : String(error),
    attributes: {
      ...attributes,
      ...loopErrorAttributes(error),
    },
  })
}

function startWorkerLoop(worker: CloudWorker, pollMs: number, observability: CloudObservabilityAdapter | null) {
  let active = false
  const timer = setInterval(() => {
    if (active) return
    active = true
    void worker.processAllSessionCommands()
      .catch((error) => recordLoopError(observability, 'cloud.worker.loop.error', error))
      .finally(() => {
        active = false
      })
  }, pollMs)
  return () => clearInterval(timer)
}

function startSchedulerLoop(scheduler: CloudScheduler, pollMs: number, observability: CloudObservabilityAdapter | null) {
  let active = false
  const timer = setInterval(() => {
    if (active) return
    active = true
    void scheduler.processDueWorkflows()
      .catch((error) => recordLoopError(observability, 'cloud.scheduler.loop.error', error))
      .finally(() => {
        active = false
      })
  }, pollMs)
  return () => clearInterval(timer)
}

function isMissingCheckpointError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return /checkpoint manifest was not found/i.test(message)
}

export async function startCloudApp(options: CloudAppOptions = {}): Promise<CloudApp> {
  const env = options.env || process.env
  const envOptions = resolveCloudBootstrapOptionsFromEnv(env)
  const config = options.config || DEFAULT_CONFIG
  const policy = resolveCloudRuntimePolicy(config, env)
  const authConfig = resolveCloudAuthConfig(config, env)
  const abuseConfig = resolveCloudAbuseConfig(config, env)
  const billingConfig = resolveCloudBillingConfig(config, env)
  const listenHostname = options.hostname || envOptions.hostname
  assertCloudAuthDeploymentSafe({
    role: policy.role,
    hostname: listenHostname,
    auth: authConfig,
    publicUrl: envOptions.publicUrl,
    env,
  })
  const resolvedAuthConfig = {
    ...config,
    cloud: {
      ...config.cloud,
      auth: authConfig,
    },
  }
  const hasObservabilityOverride = Object.prototype.hasOwnProperty.call(options, 'observability')
  const observability = hasObservabilityOverride
    ? options.observability || null
    : createCloudObservabilityFromEnv(env)
  const paths = options.paths || createCloudPathProvider(envOptions.root)
  const store = options.store || await (options.storeFactory || createControlPlaneStoreForCloud)({ config, env })
  const objectStore = options.objectStore || await (options.objectStoreFactory || createObjectStoreForCloud)({ config, env, paths })
  const secretAdapter = options.secretAdapter || await createCloudSecretAdapterFromEnv(env)
  const billingAdapter = Object.prototype.hasOwnProperty.call(options, 'billingAdapter')
    ? options.billingAdapter || null
    : await createBillingAdapterForCloud({ config: billingConfig, env })
  const byokPolicy: ByokManagementPolicy = {
    allowedProviderIds: options.byokPolicy?.allowedProviderIds ?? listConfiguredByokProviderIds(config),
    checkEntitlement: options.byokPolicy?.checkEntitlement ?? null,
    checkRuntimeEntitlement: async (input) => {
      const subscription = await store.getBillingSubscription(input.orgId)
      if (billingConfig.enabled && billingConfig.provider !== 'none') {
        const billingVerdict = evaluateBillingEntitlement({
          config: billingConfig,
          subscription,
          action: 'byok.provider',
          providerId: input.providerId,
        })
        if (!billingVerdict.allowed) {
          return {
            allowed: false,
            reason: billingVerdict.reason || 'BYOK provider is not included in this billing entitlement.',
          }
        }
      }
      return options.byokPolicy?.checkRuntimeEntitlement?.(input) ?? { allowed: true }
    },
    kmsRefs: options.byokPolicy?.kmsRefs ?? null,
  }
  const byokSecrets = createByokSecretStore(store, secretAdapter, {
    ...options.byokSecretStoreOptions,
    kmsRefResolver: options.byokSecretStoreOptions?.kmsRefResolver
      || (({ kmsRef }) => resolveCloudSecretRef(kmsRef, { env })),
  })
  const checkpointsEnabled = options.checkpointsEnabled ?? envOptions.checkpointsEnabled
  const hasCheckpointStoreOverride = Object.prototype.hasOwnProperty.call(options, 'checkpointStore')
  const checkpointStore = shouldRunCloudWorker(policy.role)
    ? hasCheckpointStoreOverride
      ? options.checkpointStore || null
      : checkpointsEnabled
        ? createObjectWorkspaceCheckpointStore({
            objectStore,
            secretAdapter,
          })
        : null
    : null
  const runtime = options.runtime || (
    shouldRunCloudWorker(policy.role)
      ? createWorkerScopedRuntimeAdapter({
          paths,
          policy,
          env,
          config,
          byokSecrets,
          byokPolicy: {
            allowedProviderIds: byokPolicy.allowedProviderIds,
            checkEntitlement: byokPolicy.checkRuntimeEntitlement,
          },
          runtimeFactory: options.runtimeFactory || defaultCloudRuntimeFactory,
        })
      : createUnavailableRuntimeAdapter()
  )
  const projectSources = createCloudProjectSourceService({
    policy,
    objectStore,
    credentialResolver: (credentialRef) => resolveCloudSecretRef(credentialRef, { env }),
  })
  const service = new CloudSessionService(
    store,
    runtime,
    policy,
    undefined,
    undefined,
    undefined,
    byokSecrets,
    byokPolicy,
    abuseConfig,
    billingConfig,
    billingAdapter,
    { allowSelfServiceSignup: authConfig.allowSelfServiceSignup ?? authConfig.mode !== 'oidc' },
    projectSources,
  )
  const artifacts = new CloudArtifactService(service, objectStore)
  const hasSessionCookieOverride = Object.prototype.hasOwnProperty.call(options, 'sessionCookies')
  const cookieSecret = resolveCloudCookieSecret(resolvedAuthConfig, env)
  const sessionCookies = shouldRunCloudWeb(policy.role)
    ? hasSessionCookieOverride
      ? options.sessionCookies || null
      : cookieSecret
        ? createCloudSessionCookieManager({
            secret: cookieSecret,
            secure: envOptions.cookieSecure,
          })
        : null
    : null
  const hasBrowserAuthOverride = Object.prototype.hasOwnProperty.call(options, 'browserAuth')
  const browserAuth = shouldRunCloudWeb(policy.role)
    ? hasBrowserAuthOverride
      ? options.browserAuth || null
      : sessionCookies && cookieSecret && authConfig.mode === 'oidc'
        ? createOidcBrowserAuthProvider(authConfig, {
            clientSecret: resolveCloudOidcClientSecret(resolvedAuthConfig, env),
            publicUrl: envOptions.publicUrl,
            stateCookieSecret: cookieSecret,
            secureCookies: envOptions.cookieSecure,
          })
        : null
    : null
  const worker = shouldRunCloudWorker(policy.role)
    ? new CloudWorker(
        store,
        service,
        envValue(env, 'OPEN_COWORK_CLOUD_WORKER_ID') || `${policy.role}-worker`,
        30_000,
        {
          async restoreBeforeCommands(lease) {
            const leasePaths = createCloudSessionPathProvider(paths, lease.tenantId, lease.sessionId)
            await mkdir(leasePaths.resolveWorkspacePath(lease.tenantId, lease.sessionId), { recursive: true })
            let restoredCheckpointEntries = 0
            if (checkpointStore) {
              try {
                const restored = await checkpointStore.restoreSessionCheckpoint({
                  tenantId: lease.tenantId,
                  sessionId: lease.sessionId,
                  roots: defaultCloudSessionCheckpointRoots(leasePaths, lease.tenantId, lease.sessionId),
                })
                restoredCheckpointEntries = restored.restoredEntries
              } catch (error) {
                if (!isMissingCheckpointError(error)) throw error
              }
            }
            if (restoredCheckpointEntries === 0) {
              const source = await service.getSessionProjectSource(lease.tenantId, lease.sessionId)
              if (source) {
                await projectSources.restoreProjectSource({
                  tenantId: lease.tenantId,
                  sessionId: lease.sessionId,
                  source,
                  paths: leasePaths,
                })
              }
            }
          },
          async saveAfterCommand(lease) {
            if (!checkpointStore) return
            const leasePaths = createCloudSessionPathProvider(paths, lease.tenantId, lease.sessionId)
            await checkpointStore.saveSessionCheckpoint({
              tenantId: lease.tenantId,
              sessionId: lease.sessionId,
              checkpointVersion: lease.checkpointVersion,
              roots: defaultCloudSessionCheckpointRoots(leasePaths, lease.tenantId, lease.sessionId),
            })
          },
        },
        abuseConfig,
      )
    : null
  const scheduler = shouldRunCloudScheduler(policy.role)
    ? new CloudScheduler(store, service, envValue(env, 'OPEN_COWORK_CLOUD_SCHEDULER_ID') || `${policy.role}-scheduler`)
    : null

  const runtimeUnsubscribe = worker && runtime.subscribeEvents
    ? await runtime.subscribeEvents((event) => {
        void routeRuntimeEvent(store, worker, event).catch((error) => recordLoopError(
          observability,
          'cloud.worker.runtime_event.error',
          error,
          { event_type: event.type },
        ))
      })
    : null
  const stopWorkerLoop = worker
    ? startWorkerLoop(worker, options.workerPollMs || envOptions.workerPollMs, observability)
    : null
  const stopSchedulerLoop = scheduler
    ? startSchedulerLoop(scheduler, options.schedulerPollMs || envOptions.schedulerPollMs, observability)
    : null

  const webhookSecurity = isWorkflowWebhookSecurityStore(store) ? store : undefined
  const server = shouldRunCloudWeb(policy.role)
      ? createCloudHttpServer({
        service,
        artifacts,
        policy,
        publicBranding: resolveCloudPublicBranding(config, env),
        worker,
        sessionCookies,
        observability,
        browserAuth,
        desktopAuth: createCloudDesktopAuthConfig(authConfig),
        auth: options.auth || createCompositeCloudAuthResolver(
          createApiTokenCloudAuthResolver(store),
          createCloudAuthResolverForConfig(resolvedAuthConfig),
        ),
        internalToken: resolveCloudInternalToken(env),
        webhookSecurity,
        autoProcessCommands: options.autoProcessCommands ?? (policy.role === 'all-in-one' && envOptions.autoProcessCommands),
        corsOrigin: options.corsOrigin ?? envOptions.corsOrigin,
        trustProxyHeaders: envOptions.trustProxyHeaders,
      })
    : null
  const url = server
    ? await server.listen(options.port ?? envOptions.port, listenHostname)
    : null

  return {
    policy,
    store,
    objectStore,
    byokSecrets,
    checkpointStore,
    paths,
    runtime,
    service,
    worker,
    scheduler,
    server,
    observability,
    url,
    async close() {
      stopWorkerLoop?.()
      stopSchedulerLoop?.()
      runtimeUnsubscribe?.()
      await server?.close()
      await observability?.close?.()
      await runtime.close?.()
      await objectStore.close?.()
      await store.close?.()
    },
  }
}

function isWorkflowWebhookSecurityStore(store: ControlPlaneStore): store is ControlPlaneStore & WorkflowWebhookSecurityStore {
  const candidate = store as Partial<WorkflowWebhookSecurityStore>
  return typeof candidate.claimRequest === 'function'
    && typeof candidate.checkAuthBackoff === 'function'
    && typeof candidate.recordAuthFailure === 'function'
    && typeof candidate.claimSignature === 'function'
    && typeof candidate.clear === 'function'
}
