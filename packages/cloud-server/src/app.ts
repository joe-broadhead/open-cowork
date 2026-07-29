import { createPostgresKnowledgeStore } from '@open-cowork/runtime-host/knowledge/postgres-knowledge-store'
import type { WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  normalizeCloudProjectSource,
  splitTrustedProxyCidrs,
  type KnowledgeStore,
} from '@open-cowork/shared'
import { DEFAULT_CONFIG, type CloudAuthConfig, type OpenCoworkConfig } from '@open-cowork/shared'
import { CloudArtifactService } from './artifact-service.ts'
import { evaluateBillingEntitlement, type BillingAdapter } from './billing-adapter.ts'
import {
  parseCloudDeploymentTier,
  resolveCloudAbuseConfig,
  resolveCloudAuthConfig,
  resolveCloudBillingConfig,
  resolveCloudEntitlementsConfig,
  resolveCloudRuntimePolicy,
  type CloudDeploymentTier,
  type CloudRuntimePolicy,
} from './cloud-config.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import { InMemoryControlPlaneStore } from './in-memory-control-plane-store.ts'
import {
  createCloudHttpServer,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudHttpServer,
} from './http-server.ts'
import { compileCloudRuntimeCapabilityPolicy } from './cloud-runtime-capability-policy.ts'
import {
  createCloudStartupCleanupStack,
  settleCloudCleanups,
} from './cloud-app-cleanup.ts'
import { CloudSseReplayHub } from './sse-replay.ts'
import { CloudSsePgNotifyListener } from './sse-pg-notify.ts'
import {
  createCloudObservabilityFromEnv,
  recordCloudLog,
  recordCloudMetric,
  type CloudObservabilityAdapter,
} from './observability.ts'
import { createObjectStoreForCloud, instrumentObjectStore, resolveCloudObjectStoreConfig, type ObjectStoreAdapter } from './object-store.ts'
import {
  createByokSecretStore,
  type ByokSecretStore,
  type ByokSecretStoreOptions,
} from './byok-secret-store.ts'
import {
  createOidcBrowserAuthProvider,
} from './oidc-auth.ts'
import { createCloudPathProvider, createCloudSessionPathProvider, type PathProvider } from './path-provider.ts'
import { loadPgPool } from './postgres-control-plane-store.ts'
import { createCloudProjectSourceService } from './project-source-service.ts'
import { createCloudReadinessCheck } from './readiness.ts'
import type { CloudRuntimeAdapter, CloudRuntimeEvent } from './runtime-adapter.ts'
import {
  assertCloudSecretKeyMaterialStrong,
  createCloudSecretAdapterFromEnv,
  resolveCloudSecretRef,
  type SecretAdapter,
} from './secret-adapter.ts'
import { isManagedCloudSecretRef } from './secret-ref-policy.ts'
import { createCloudSessionCookieManager, type CloudSessionCookieManager } from './session-cookie-auth.ts'
import { CloudSessionService, type ByokManagementPolicy, type CloudEmailSender } from './session-service.ts'
import { CloudScheduler, type CloudRetentionOptions } from './scheduler.ts'
import {
  DEFAULT_RUNTIME_DELTA_FLUSH_MS,
  createRuntimeDeltaCoalescer,
  type RuntimeDeltaCoalescer,
} from './runtime-delta-coalescer.ts'
import { resolveEntitlementResolver } from './entitlements/entitlement-provider.ts'
import { CloudWorker } from './worker.ts'
import { createWorkerScopedRuntimeAdapter } from './worker-scoped-runtime-adapter.ts'
import { createUnavailableRuntimeAdapter } from './unavailable-runtime-adapter.ts'
import {
  assertCloudExecutionIsolationCapability,
  CloudExecutionIsolationError,
  createDevelopmentProcessIsolationProvider,
  developmentProcessIsolationCapability,
  resolveCloudExecutionIsolationPolicy,
  resolveCloudSandboxResourceLimits,
  resolveCloudExecutionWorkerId,
  type CloudExecutionIsolationCapability,
  type CloudExecutionIsolationPolicy,
  type CloudExecutionIsolationProvider,
  type CloudExecutionProvisionInput,
} from './execution-isolation.ts'
import { createSandboxCloudExecutionIsolationProvider } from './sandbox-execution-isolation-provider.ts'
import { isLoopbackCloudHost, isNonPublicCloudHost } from './cloud-host-policy.ts'
import {
  createObjectWorkspaceCheckpointStore,
  defaultCloudSessionCheckpointRoots,
  type WorkspaceCheckpointStore,
} from './workspace-checkpoint-store.ts'
import { type Env, envValue, parseBoolean, parsePort, parsePositiveInt, resolveEnvRef } from './cloud-config-parse.ts'
import { resolveCloudPublicBranding } from './cloud-branding-config.ts'
import {
  createDefaultCloudRuntimeFactory,
  prepareDefaultCloudRuntimeFactoryInput,
  resolveCloudKnowledgeAgentOrigin,
  resolveCloudKnowledgeRuntimeAssets,
  type CloudRuntimeFactory,
  type KnowledgeAgentSpawnOptions,
} from './cloud-runtime-composition.ts'
import {
  createApiTokenCloudAuthResolver,
  createCloudAuthResolverForConfig,
  createCloudDesktopAuthConfig,
  createCompositeCloudAuthResolver,
  createManagedWorkerCloudAuthResolver,
} from './cloud-auth-resolvers.ts'
import {
  createBillingAdapterForCloud,
  createControlPlaneStoreForCloud,
  resolveCloudAuthRuntimeSecrets,
  resolveCloudControlPlaneUrl,
  resolveCloudCookieSecretForRuntime,
  resolveCloudInternalToken,
  resolveCloudOidcClientSecretForRuntime,
  RUN_MIGRATIONS_ENV,
  SSE_PG_NOTIFY_ENV,
  type CloudControlPlaneStoreFactory,
  type CloudObjectStoreFactory,
} from './cloud-adapter-factories.ts'
import {
  createRetryingRuntimeEventRouter,
  createSessionSerializedRuntimeEventRouter,
  routeRuntimeEvent,
} from './cloud-runtime-event-router.ts'
import {
  createLoopHeartbeat,
  recordLoopError,
  startCloudLivenessServer,
  startSchedulerLoop,
  startWorkerLoop,
} from './cloud-role-loops.ts'
export { resolveCloudPublicBranding } from './cloud-branding-config.ts'
export {
  createApiTokenCloudAuthResolver,
  createCloudAuthResolverForConfig,
  createCloudDesktopAuthConfig,
  createCompositeCloudAuthResolver,
  createHeaderCloudAuthResolver,
  createLocalCloudAuthResolver,
  createManagedWorkerCloudAuthResolver,
  signHeaderCloudAuthRequest,
} from './cloud-auth-resolvers.ts'
export {
  cloudKnowledgeRuntimeEligible,
  createDefaultCloudRuntimeFactory,
  prepareDefaultCloudRuntimeFactoryInput,
  resolveCloudKnowledgeAgentOrigin,
  resolveCloudKnowledgeMcpScriptPath,
  resolveCloudKnowledgeRuntimeAssets,
} from './cloud-runtime-composition.ts'
export type {
  CloudRoleRuntimeFactoryInput,
  CloudRuntimeFactory,
  KnowledgeAgentSpawnOptions,
} from './cloud-runtime-composition.ts'
export {
  createControlPlaneStoreForCloud,
  resolveCloudControlPlaneUrl,
  resolveCloudCookieSecret,
  resolveCloudInternalToken,
  resolveCloudOidcClientSecret,
} from './cloud-adapter-factories.ts'
export type {
  CloudControlPlaneStoreFactory,
  CloudControlPlaneStoreFactoryInput,
  CloudObjectStoreFactory,
  CloudObjectStoreFactoryInput,
} from './cloud-adapter-factories.ts'
export {
  DEFAULT_RUNTIME_EVENT_ROUTE_ATTEMPTS,
  createRetryingRuntimeEventRouter,
  createSessionSerializedRuntimeEventRouter,
} from './cloud-runtime-event-router.ts'

const ALLOW_INSECURE_CLOUD_AUTH_ENV = 'OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH'
const ALLOW_EPHEMERAL_STORAGE_ENV = 'OPEN_COWORK_CLOUD_ALLOW_EPHEMERAL_STORAGE'
const CLOUD_PUBLISHED_ADDR_ENV = 'OPEN_COWORK_CLOUD_PUBLISHED_ADDR'

export type CloudAppOptions = {
  config?: OpenCoworkConfig
  env?: Env
  store?: ControlPlaneStore
  storeFactory?: CloudControlPlaneStoreFactory
  // Optional override for the cloud knowledge backend. Omitted ⇒ a Postgres
  // knowledge store is built when the control plane resolves to Postgres,
  // otherwise the HTTP server falls back to its SQLite store.
  knowledgeStore?: KnowledgeStore
  objectStore?: ObjectStoreAdapter
  objectStoreFactory?: CloudObjectStoreFactory
  secretAdapter?: SecretAdapter
  byokSecretStoreOptions?: Pick<ByokSecretStoreOptions, 'kmsRefResolver' | 'validators' | 'activateUnvalidatedProviders'>
  byokPolicy?: ByokManagementPolicy
  billingAdapter?: BillingAdapter | null
  runtime?: CloudRuntimeAdapter
  runtimeFactory?: CloudRuntimeFactory
  executionIsolationProvider?: CloudExecutionIsolationProvider
  paths?: PathProvider
  checkpointStore?: WorkspaceCheckpointStore | null
  checkpointsEnabled?: boolean
  sessionCookies?: CloudSessionCookieManager | null
  // Optional host-injected email sender so the cloud can deliver team-invite links. Null/omitted
  // ⇒ no email is sent; the admin still receives the invite token in the API response to share.
  emailSender?: CloudEmailSender | null
  observability?: CloudObservabilityAdapter | null
  auth?: CloudAuthResolver
  browserAuth?: CloudBrowserAuthProvider | null
  hostname?: string
  port?: number
  workerPollMs?: number
  schedulerPollMs?: number
  // SSE read-poll cadence (ms). Omitted ⇒ OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS (default 1000).
  ssePollMs?: number
  shutdownGraceMs?: number
  runtimeCacheMaxEntries?: number
  runtimeCacheIdleTtlMs?: number
  runtimeAdmissionQueueMaxEntries?: number
  runtimeAdmissionQueueTimeoutMs?: number
  runtimeProvisionTimeoutMs?: number
  runtimeTeardownTimeoutMs?: number
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
  executionIsolationPolicy: CloudExecutionIsolationPolicy
  executionIsolationCapability: CloudExecutionIsolationCapability
  url: string | null
  close: () => Promise<void>
}

const DEFAULT_CLOUD_ROOT = '.open-cowork-cloud'

export function shouldRunCloudWeb(role: CloudRuntimePolicy['role']) {
  return role === 'all-in-one' || role === 'web'
}

export function shouldRunCloudWorker(role: CloudRuntimePolicy['role']) {
  return role === 'all-in-one' || role === 'worker'
}

export function shouldRunCloudScheduler(role: CloudRuntimePolicy['role']) {
  return role === 'all-in-one' || role === 'scheduler'
}

function parseCloudOrgMode(value: string | null | undefined): 'multi-org' | 'single-org' {
  if (!value) return 'multi-org'
  if (value === 'multi-org' || value === 'single-org') return value
  throw new Error(`Invalid OPEN_COWORK_CLOUD_ORG_MODE "${value}". Expected multi-org or single-org.`)
}

export function resolveCloudBootstrapOptionsFromEnv(env: Env = process.env) {
  const workerPollMs = parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_POLL_MS'), 1000)
  return {
    // Deployment topology (RBAC #894): single-org self-host mode auto-bootstraps one
    // org and skips tenant switching; multi-org (default) preserves multi-tenancy.
    orgMode: parseCloudOrgMode(envValue(env, 'OPEN_COWORK_CLOUD_ORG_MODE')),
    singleOrgId: envValue(env, 'OPEN_COWORK_CLOUD_SINGLE_ORG_ID') || undefined,
    singleOrgName: envValue(env, 'OPEN_COWORK_CLOUD_SINGLE_ORG_NAME') || undefined,
    deploymentTier: parseCloudDeploymentTier(envValue(env, 'OPEN_COWORK_CLOUD_DEPLOYMENT_TIER')),
    root: resolve(envValue(env, 'OPEN_COWORK_CLOUD_ROOT') || DEFAULT_CLOUD_ROOT),
    hostname: envValue(env, 'HOST') || envValue(env, 'OPEN_COWORK_CLOUD_HOST') || '0.0.0.0',
    port: parsePort(envValue(env, 'PORT') || envValue(env, 'OPEN_COWORK_CLOUD_PORT'), 8787),
    workerPollMs,
    schedulerPollMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_SCHEDULER_POLL_MS'), workerPollMs),
    shutdownGraceMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_SHUTDOWN_GRACE_MS'), 30_000),
    runtimeCacheMaxEntries: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RUNTIME_CACHE_MAX_ENTRIES'), 100),
    runtimeCacheIdleTtlMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RUNTIME_CACHE_IDLE_TTL_MS'), 30 * 60 * 1000),
    runtimeAdmissionQueueMaxEntries: parsePositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_RUNTIME_ADMISSION_QUEUE_MAX_ENTRIES'),
      100,
    ),
    runtimeAdmissionQueueTimeoutMs: parsePositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_RUNTIME_ADMISSION_TIMEOUT_MS'),
      30_000,
    ),
    runtimeProvisionTimeoutMs: parsePositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_RUNTIME_PROVISION_TIMEOUT_MS'),
      120_000,
    ),
    runtimeTeardownTimeoutMs: parsePositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_RUNTIME_TEARDOWN_TIMEOUT_MS'),
      30_000,
    ),
    // HTTP connection caps resolved/validated here (instead of read from process.env
    // inside the HTTP server) so they travel through CloudHttpServerOptions like every
    // other knob. Defaults preserve the previous in-server behaviour (200 / 10000).
    maxSseConnectionsPerOrg: parsePositiveInt(
      envValue(env, 'OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG'),
      // Keep in sync with DEFAULT_MAX_SSE_CONNECTIONS_PER_ORG (http-routes/sse-limits).
      200,
    ),
    maxConnections: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_MAX_CONNECTIONS'), 10_000),
    // SSE read-poll cadence (ms). The replay loop polls Postgres at this interval for the
    // life of each connection; operators trade delivery latency against control-plane query
    // load. Default 1000 preserves the previous in-server behaviour.
    ssePollIntervalMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_SSE_POLL_INTERVAL_MS'), 1000),
    // Opt-in Postgres LISTEN/NOTIFY accelerator (default OFF). See SSE_PG_NOTIFY_ENV.
    ssePgNotifyEnabled: parseBoolean(envValue(env, SSE_PG_NOTIFY_ENV), false),
    // Steady-state poll cadence for NOTIFY-addressable SSE topics WHILE the LISTEN/NOTIFY
    // accelerator is active: NOTIFY drives low-latency wakes, so the interval poll only
    // backstops missed notifications (cutting per-topic query load ~15x at the default).
    // Ignored when the accelerator is off — topics then poll at ssePollIntervalMs as before.
    sseNotifyBackstopPollMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_SSE_NOTIFY_BACKSTOP_POLL_MS'), 15_000),
    corsOrigin: envValue(env, 'OPEN_COWORK_CLOUD_CORS_ORIGIN'),
    autoProcessCommands: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS'), true),
    checkpointsEnabled: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED'), false),
    cookieSecure: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECURE'), true),
    publicUrl: envValue(env, 'OPEN_COWORK_CLOUD_PUBLIC_URL'),
    publishedAddr: envValue(env, CLOUD_PUBLISHED_ADDR_ENV),
    trustProxyHeaders: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS'), false),
    trustedProxyCidrs: splitTrustedProxyCidrs(envValue(env, 'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS')),
  }
}

export function listConfiguredByokProviderIds(config: OpenCoworkConfig) {
  const configuredProviderIds = (config.providers.available || [])
    .map((providerId) => providerId.trim().toLowerCase())
    .filter(Boolean)
  const providerIds = configuredProviderIds
    .filter((providerId) => {
      const descriptor = config.providers.descriptors?.[providerId]
      const custom = config.providers.custom?.[providerId]
      const credentials = descriptor?.credentials || custom?.credentials || []
      return credentials.some((credential) => credential.secret)
    })
  if (providerIds.length > 0) return Array.from(new Set(providerIds))
  return configuredProviderIds.length > 0 ? [] : null
}

export { isLoopbackCloudHost, isNonPublicCloudHost } from './cloud-host-policy.ts'

function parseDeploymentOrigin(value: string | null | undefined, label: string) {
  const text = value?.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`${label} must be a valid URL origin.`)
  }
  if (url.username || url.password) throw new Error(`${label} must not include credentials.`)
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`${label} must be an origin without a path, query, or fragment.`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${label} must use HTTP or HTTPS.`)
  return url
}

function assertPublicHttpsOrigin(value: string | null | undefined, label: string) {
  const url = parseDeploymentOrigin(value, label)
  if (!url) return null
  if (url.protocol !== 'https:' || isNonPublicCloudHost(url.hostname)) {
    throw new Error(`${label} for public deployments must use HTTPS with a publicly routable host.`)
  }
  return url
}

function publicUrlEnablesStrictTransportSecurity(value: string | null | undefined) {
  try {
    const url = parseDeploymentOrigin(value, 'OPEN_COWORK_CLOUD_PUBLIC_URL')
    return Boolean(url && url.protocol === 'https:' && !isNonPublicCloudHost(url.hostname))
  } catch {
    return false
  }
}

function describeInsecureCloudAuthPublicExposure(input: {
  hostname: string
  publicUrl?: string | null
  publishedAddr?: string | null
  env?: Env
}) {
  const publicUrl = parseDeploymentOrigin(input.publicUrl, 'OPEN_COWORK_CLOUD_PUBLIC_URL')
  if (publicUrl && !isLoopbackCloudHost(publicUrl.hostname)) {
    return `OPEN_COWORK_CLOUD_PUBLIC_URL=${publicUrl.origin}`
  }

  const publishedAddr = input.publishedAddr ?? envValue(input.env || {}, CLOUD_PUBLISHED_ADDR_ENV)
  if (publishedAddr?.trim()) {
    if (!isLoopbackCloudHost(publishedAddr)) return `${CLOUD_PUBLISHED_ADDR_ENV}=${publishedAddr.trim()}`
    return null
  }

  if (!isLoopbackCloudHost(input.hostname)) {
    return `OPEN_COWORK_CLOUD_HOST/HOST=${input.hostname}`
  }
  return null
}

function assertInsecureCloudAuthNotPublic(input: {
  hostname: string
  publicUrl?: string | null
  publishedAddr?: string | null
  env?: Env
}) {
  const exposure = describeInsecureCloudAuthPublicExposure(input)
  if (!exposure) return
  throw new Error(
    `${ALLOW_INSECURE_CLOUD_AUTH_ENV}=true is local/demo-only and refuses public Cloud exposure via ${exposure}. Publish/bind the demo to 127.0.0.1 or localhost, or configure cloud.auth.mode=oidc/header before exposing it.`,
  )
}

export function assertCloudAuthDeploymentSafe(input: {
  role: CloudRuntimePolicy['role']
  hostname: string
  auth: CloudAuthConfig
  publicUrl?: string | null
  publishedAddr?: string | null
  corsOrigin?: string | null
  cookieSecure?: boolean
  env?: Env
}) {
  if (!shouldRunCloudWeb(input.role)) return
  if (parseBoolean(envValue(input.env || process.env, ALLOW_INSECURE_CLOUD_AUTH_ENV), false)) {
    assertInsecureCloudAuthNotPublic(input)
    return
  }
  if (!isLoopbackCloudHost(input.hostname) && input.cookieSecure === false) {
    throw new Error('Cloud browser session cookies must be Secure on public deployments. Remove OPEN_COWORK_CLOUD_COOKIE_SECURE=false or use the explicit local/demo override.')
  }
  if (input.corsOrigin?.trim()) {
    if (input.corsOrigin.trim() === '*') {
      throw new Error('OPEN_COWORK_CLOUD_CORS_ORIGIN cannot be "*" when credentials are enabled.')
    }
    if (isLoopbackCloudHost(input.hostname)) parseDeploymentOrigin(input.corsOrigin, 'OPEN_COWORK_CLOUD_CORS_ORIGIN')
    else assertPublicHttpsOrigin(input.corsOrigin, 'OPEN_COWORK_CLOUD_CORS_ORIGIN')
  }
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
  if (input.auth.mode === 'header' && input.auth.headerAllowUnsigned && !isLoopbackCloudHost(input.hostname)) {
    throw new Error('Cloud auth mode "header" on a public bind requires signed trusted headers. OPEN_COWORK_CLOUD_HEADER_AUTH_ALLOW_UNSIGNED is local/demo-only.')
  }
  if (input.auth.mode === 'oidc' && !input.publicUrl?.trim() && !isLoopbackCloudHost(input.hostname)) {
    throw new Error('Cloud OIDC public deployments require OPEN_COWORK_CLOUD_PUBLIC_URL so redirect URIs do not trust forwarded headers.')
  }
  if (input.auth.mode === 'oidc' && input.publicUrl?.trim() && !isLoopbackCloudHost(input.hostname)) {
    assertPublicHttpsOrigin(input.publicUrl, 'OPEN_COWORK_CLOUD_PUBLIC_URL')
  }
}

function secretRefIsManaged(ref: string | null | undefined) {
  return isManagedCloudSecretRef(ref)
}

function hasProductionSecretMaterial(env: Env, keyName: string, refName: string, configRef?: string | null) {
  const key = envValue(env, keyName)
  if (key) {
    assertCloudSecretKeyMaterialStrong(key, keyName)
    return true
  }
  const ref = envValue(env, refName) || configRef
  if (secretRefIsManaged(ref)) return true
  const envRefValue = resolveEnvRef(ref || undefined, env)
  if (!envRefValue) return false
  assertCloudSecretKeyMaterialStrong(envRefValue, refName)
  return true
}

export function assertCloudProductionDeploymentSafe(input: {
  tier: CloudDeploymentTier
  role: CloudRuntimePolicy['role']
  config: OpenCoworkConfig
  auth: CloudAuthConfig
  env: Env
  checkpointsEnabled: boolean
  autoProcessCommands: boolean
  publicUrl?: string | null
  cookieSecure?: boolean
}) {
  if (input.tier !== 'public_production') return

  if (parseBoolean(envValue(input.env, ALLOW_INSECURE_CLOUD_AUTH_ENV), false)) {
    throw new Error(`${ALLOW_INSECURE_CLOUD_AUTH_ENV}=true is local/demo-only and cannot be used with OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=public_production.`)
  }

  if (input.role === 'all-in-one') {
    throw new Error('OPEN_COWORK_CLOUD_DEPLOYMENT_TIER=public_production requires split cloud roles. Run separate web, worker, and scheduler deployments instead of all-in-one.')
  }

  const controlPlaneUrl = resolveCloudControlPlaneUrl(input.config, input.env)
  if (!controlPlaneUrl) {
    throw new Error('Public production cloud deployments require durable Postgres control-plane storage. Set OPEN_COWORK_CLOUD_CONTROL_PLANE_URL or an equivalent urlRef.')
  }

  const objectStore = resolveCloudObjectStoreConfig(input.config, input.env)
  if (objectStore.kind === 'filesystem' || objectStore.kind === 'unavailable' || !objectStore.bucket) {
    throw new Error('Public production cloud deployments require durable provider-backed object storage with a bucket/container. Filesystem object storage is local/self-host-beta only.')
  }

  if (parseBoolean(envValue(input.env, RUN_MIGRATIONS_ENV), true)) {
    throw new Error(`Public production cloud deployments require ${RUN_MIGRATIONS_ENV}=false. Apply migrations from the exact pinned image with a separately credentialed one-shot cloud:migrate:start job before starting long-running roles.`)
  }

  if (!hasProductionSecretMaterial(input.env, 'OPEN_COWORK_CLOUD_SECRET_KEY', 'OPEN_COWORK_CLOUD_SECRET_KEY_REF')) {
    throw new Error('Public production cloud deployments require OPEN_COWORK_CLOUD_SECRET_KEY with at least 32 characters or a managed OPEN_COWORK_CLOUD_SECRET_KEY_REF.')
  }

  if (shouldRunCloudWeb(input.role)) {
    if (!input.publicUrl?.trim()) {
      throw new Error('Public production cloud web deployments require OPEN_COWORK_CLOUD_PUBLIC_URL so redirects, cookies, and proxy handling use a stable HTTPS origin.')
    }
    assertPublicHttpsOrigin(input.publicUrl, 'OPEN_COWORK_CLOUD_PUBLIC_URL')
    if (!envValue(input.env, 'OPEN_COWORK_CLOUD_SIGNUP_MODE')) {
      throw new Error('Public production cloud web deployments require explicit OPEN_COWORK_CLOUD_SIGNUP_MODE so org auto-provisioning is intentional.')
    }
    if (input.cookieSecure === false) {
      throw new Error('Public production cloud web deployments require Secure browser cookies.')
    }
    if (!hasProductionSecretMaterial(input.env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET', 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF', input.config.cloud.auth.cookieSecretRef)) {
      throw new Error('Public production cloud web deployments require OPEN_COWORK_CLOUD_COOKIE_SECRET with at least 32 characters or a managed OPEN_COWORK_CLOUD_COOKIE_SECRET_REF.')
    }
    // Reject reusing the envelope encryption key as the cookie-signing key (audit P2-17).
    // The runtime resolver falls back to OPEN_COWORK_CLOUD_SECRET_KEY when no distinct cookie
    // secret is set; the material check above already blocks that omission, and this blocks a
    // copy-pasted identical value so the two keys cannot share one secret.
    const inlineCookieSecret = envValue(input.env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
    const inlineSecretKey = envValue(input.env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
    if (inlineCookieSecret && inlineSecretKey && inlineCookieSecret === inlineSecretKey) {
      throw new Error('Public production cloud web deployments require a cookie secret distinct from OPEN_COWORK_CLOUD_SECRET_KEY. Reusing the envelope encryption key to sign browser cookies is crypto key reuse — set a separate OPEN_COWORK_CLOUD_COOKIE_SECRET.')
    }
    if (input.autoProcessCommands) {
      throw new Error('Public production cloud web deployments must not process commands inline. Set OPEN_COWORK_CLOUD_AUTO_PROCESS_COMMANDS=false and run worker roles separately.')
    }
  }

  if (shouldRunCloudWorker(input.role) && !input.checkpointsEnabled) {
    throw new Error('Public production cloud worker deployments require OPEN_COWORK_CLOUD_CHECKPOINTS_ENABLED=true for runtime/workspace recovery.')
  }

  if (input.auth.mode === 'none') {
    throw new Error('Public production cloud deployments require authenticated access. Set OPEN_COWORK_CLOUD_AUTH_MODE=oidc or header.')
  }

  if (input.auth.mode === 'header') {
    let hasHeaderSecret = hasProductionSecretMaterial(input.env, 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET', 'OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF', input.config.cloud.auth.headerSecretRef)
    if (!hasHeaderSecret && input.auth.headerSecret?.trim()) {
      assertCloudSecretKeyMaterialStrong(input.auth.headerSecret, 'cloud.auth.headerSecret')
      hasHeaderSecret = true
    }
    if (!hasHeaderSecret) {
      throw new Error('Public production trusted-header deployments require a strong OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET or managed OPEN_COWORK_CLOUD_HEADER_AUTH_SECRET_REF.')
    }
  }
  if (input.auth.mode === 'header' && input.auth.headerAllowUnsigned) {
    throw new Error('Public production trusted-header deployments require signed identity headers.')
  }

  // JOE-835 / JOE-841: durable event tables grow without bound when retention
  // windows stay null. Public production must set explicit prune windows for the
  // high-volume session/workspace event logs (audit/usage remain operator-opt-in).
  const sessionEventRetentionMs = parsePositiveInt(envValue(input.env, 'OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS'), 0)
  const workspaceEventRetentionMs = parsePositiveInt(envValue(input.env, 'OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS'), 0)
  if (!sessionEventRetentionMs) {
    throw new Error(
      'Public production cloud deployments require OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS '
      + '(milliseconds) so cloud_session_events cannot grow without bound.',
    )
  }
  if (!workspaceEventRetentionMs) {
    throw new Error(
      'Public production cloud deployments require OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS '
      + '(milliseconds) so cloud_workspace_events cannot grow without bound.',
    )
  }
}

function assertCloudProductionCoreAdaptersSafe(input: {
  tier: CloudDeploymentTier
  store: ControlPlaneStore
  objectStore: ObjectStoreAdapter
  secretAdapter: SecretAdapter
}) {
  if (input.tier !== 'public_production') return
  if (input.store instanceof InMemoryControlPlaneStore) {
    throw new Error('Public production cloud deployments require the resolved control-plane store to be durable. In-memory control-plane stores are local/self-host-beta only.')
  }
  if (input.objectStore.kind === 'filesystem' || input.objectStore.kind === 'unavailable') {
    throw new Error('Public production cloud deployments require the resolved object store to be provider-backed. Filesystem or unavailable object stores are local/self-host-beta only.')
  }
  if (input.secretAdapter.mode !== 'envelope-v1') {
    throw new Error('Public production cloud deployments require envelope-encrypted secret storage.')
  }
}

function assertCloudWebhookSecurityStoreSafe(input: {
  tier: CloudDeploymentTier
  role: CloudRuntimePolicy['role']
  store: ControlPlaneStore
}) {
  if (!shouldRunCloudWeb(input.role)) return
  if (input.tier === 'local') return
  if (isWorkflowWebhookSecurityStore(input.store)) return
  throw new Error(
    'Cloud web deployments outside the local tier require a durable workflow webhook security store '
    + 'for cross-replica replay protection, request rate limiting, and auth backoff.',
  )
}

// Encrypt/decrypt boot canary (audit P2-17). A worker or scheduler whose envelope key
// cannot round-trip would only discover it when revealing a real BYOK secret mid-run —
// after it had already claimed work. Verify the adapter round-trips at boot so a wrong,
// corrupt, or mis-rotated key fails fast instead of corrupting in-flight execution.
export function assertSecretAdapterRoundTrips(secretAdapter: SecretAdapter) {
  if (secretAdapter.mode !== 'envelope-v1') return
  const probe = 'open-cowork-cloud-secret-boot-canary'
  let revealed: string
  try {
    revealed = secretAdapter.reveal(secretAdapter.protect(probe, 'boot-canary'), 'boot-canary')
  } catch {
    // Secret backends commonly include key references, vault endpoints, or
    // provider response details in their errors. Startup failures are logged,
    // so keep this boundary deliberately generic and do not retain the raw
    // adapter error as a cause.
    throw new Error(
      'Cloud secret adapter failed its encrypt/decrypt boot canary. '
      + 'The configured cloud secret key cannot round-trip — refusing to start '
      + 'a worker/scheduler that would fail to reveal stored secrets at runtime.',
    )
  }
  if (revealed !== probe) {
    throw new Error('Cloud secret adapter boot canary did not round-trip; refusing to start the worker/scheduler.')
  }
}

// Non-`local` tiers that resolve to in-memory control-plane or filesystem/unavailable
// object storage silently lose all state on restart. `public_production` is already
// hard-blocked above; the `self_host_beta`/`private_beta` tiers legitimately MAY run
// ephemeral (the production asserts call those backends "local/self-host-beta only"),
// so we warn loudly rather than throw — unless the operator has acknowledged the
// trade-off with OPEN_COWORK_CLOUD_ALLOW_EPHEMERAL_STORAGE=true. Returns the risk
// descriptor to log, or null when storage is durable / acknowledged / not applicable.
export function describeUnacknowledgedEphemeralStorage(input: {
  tier: CloudDeploymentTier
  store: ControlPlaneStore
  objectStore: ObjectStoreAdapter
  env: Env
}): { controlPlane: 'in-memory' | 'durable', objectStore: ObjectStoreAdapter['kind'] } | null {
  if (input.tier !== 'self_host_beta' && input.tier !== 'private_beta') return null
  const ephemeralControlPlane = input.store instanceof InMemoryControlPlaneStore
  const ephemeralObjectStore = input.objectStore.kind === 'filesystem' || input.objectStore.kind === 'unavailable'
  if (!ephemeralControlPlane && !ephemeralObjectStore) return null
  if (parseBoolean(envValue(input.env, ALLOW_EPHEMERAL_STORAGE_ENV), false)) return null
  return {
    controlPlane: ephemeralControlPlane ? 'in-memory' : 'durable',
    objectStore: input.objectStore.kind,
  }
}

function assertCloudProductionRoleRuntimeSafe(input: {
  tier: CloudDeploymentTier
  role: CloudRuntimePolicy['role']
  auth: CloudAuthConfig
  checkpointStore: WorkspaceCheckpointStore | null
  sessionCookies: CloudSessionCookieManager | null
  browserAuth: CloudBrowserAuthProvider | null
}) {
  if (input.tier !== 'public_production') return
  if (shouldRunCloudWorker(input.role) && !input.checkpointStore) {
    throw new Error('Public production cloud worker deployments require an object-store checkpoint adapter.')
  }
  if (shouldRunCloudWeb(input.role) && !input.sessionCookies) {
    throw new Error('Public production cloud web deployments require signed browser session cookies.')
  }
  if (shouldRunCloudWeb(input.role) && input.auth.mode === 'oidc' && !input.browserAuth) {
    throw new Error('Public production OIDC deployments require a configured browser auth provider.')
  }
  if (input.auth.mode === 'header' && !input.auth.headerSecret?.trim()) {
    throw new Error('Public production trusted-header deployments require a resolved header auth secret.')
  }
}

// JOE-870: delta coalescer lives in runtime-delta-coalescer.ts (out of bootstrap).
export {
  DEFAULT_RUNTIME_DELTA_FLUSH_MS,
  createRuntimeDeltaCoalescer,
  type RuntimeDeltaCoalescer,
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
  const authConfig = await resolveCloudAuthRuntimeSecrets(resolveCloudAuthConfig(config, env), env)
  const abuseConfig = resolveCloudAbuseConfig(config, env)
  const billingConfig = resolveCloudBillingConfig(config, env)
  const entitlementsConfig = resolveCloudEntitlementsConfig(config, env)
  const listenHostname = options.hostname || envOptions.hostname
  assertCloudAuthDeploymentSafe({
    role: policy.role,
    hostname: listenHostname,
    auth: authConfig,
    publicUrl: envOptions.publicUrl,
    publishedAddr: envOptions.publishedAddr,
    corsOrigin: options.corsOrigin ?? envOptions.corsOrigin,
    cookieSecure: envOptions.cookieSecure,
    env,
  })
  assertCloudProductionDeploymentSafe({
    tier: envOptions.deploymentTier,
    role: policy.role,
    config,
    auth: authConfig,
    env,
    checkpointsEnabled: envOptions.checkpointsEnabled,
    autoProcessCommands: envOptions.autoProcessCommands,
    publicUrl: envOptions.publicUrl,
    cookieSecure: envOptions.cookieSecure,
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
  const startupCleanup = createCloudStartupCleanupStack()
  startupCleanup.add(() => observability?.close?.())
  try {
    const paths = options.paths || createCloudPathProvider(envOptions.root)
  const executionIsolationPolicy = resolveCloudExecutionIsolationPolicy({
    deploymentTier: envOptions.deploymentTier,
    role: policy.role,
    env,
  })
  const cloudWorkerIdentity = shouldRunCloudWorker(policy.role)
    ? resolveCloudExecutionWorkerId({
        deploymentTier: envOptions.deploymentTier,
        role: policy.role,
        isolationMode: executionIsolationPolicy.mode,
        env,
      })
    : {
        workerId: `${policy.role}-worker`,
        usedDevelopmentFallback: false,
      }
  const cloudWorkerId = cloudWorkerIdentity.workerId
  const runtimeCapabilityPolicy = compileCloudRuntimeCapabilityPolicy({
    appConfig: config,
    policy,
  })
  if (executionIsolationPolicy.required && options.runtime) {
    throw new Error('Production Cloud workers cannot bypass the execution isolation provider with a shared runtime adapter.')
  }
  if (
    executionIsolationPolicy.mode === 'external-provider'
    && !options.executionIsolationProvider
  ) {
    throw new CloudExecutionIsolationError(
      'external_isolation_provider_missing',
      'External Cloud execution isolation requires an injected provider.',
    )
  }
  if (
    executionIsolationPolicy.mode !== 'development-process'
    && options.runtimeFactory
    && !options.executionIsolationProvider
  ) {
    throw new Error('Isolated Cloud runtime factory overrides require an explicit execution isolation provider.')
  }
  const knowledgeRuntime = resolveCloudKnowledgeRuntimeAssets({
    policy,
    isolationPolicy: executionIsolationPolicy,
    env,
  })
  let knowledgeAgentSpawnOptions: KnowledgeAgentSpawnOptions | null = null
  const defaultSandboxIsolationProvider = executionIsolationPolicy.mode === 'sandbox'
    ? createSandboxCloudExecutionIsolationProvider({
        policy: executionIsolationPolicy,
        workerId: cloudWorkerId,
        runtimeRootPath: envOptions.root,
        resourceLimits: resolveCloudSandboxResourceLimits(env),
        observability,
        runtimeAssetPaths: knowledgeRuntime.runtimeAssetPaths,
        prepareInput(input) {
          return knowledgeAgentSpawnOptions
            ? prepareDefaultCloudRuntimeFactoryInput(input, knowledgeAgentSpawnOptions)
            : input
        },
      })
    : null
  const executionIsolationProvider = options.executionIsolationProvider
    || defaultSandboxIsolationProvider
  const isolationProviderCleanup = startupCleanup.add(
    () => executionIsolationProvider?.close?.(),
  )
  const executionIsolationCapability = executionIsolationProvider
    ? await executionIsolationProvider.capability()
    : developmentProcessIsolationCapability()
  assertCloudExecutionIsolationCapability(
    executionIsolationPolicy,
    executionIsolationCapability,
  )
  if (executionIsolationPolicy.warning) {
    await recordCloudLog(observability, {
      level: 'warn',
      name: 'cloud.execution_isolation.development_only',
      message: executionIsolationPolicy.warning,
      attributes: {
        deployment_tier: envOptions.deploymentTier,
        isolation_mode: executionIsolationPolicy.mode,
      },
    })
  }
  if (cloudWorkerIdentity.usedDevelopmentFallback) {
    await recordCloudLog(observability, {
      level: 'warn',
      name: 'cloud.worker_identity.development_fallback',
      message: 'Development-only Cloud execution is using a non-unique fallback worker identity.',
      attributes: {
        cloud_role: policy.role,
        isolation_mode: executionIsolationPolicy.mode,
      },
    })
  }
  const store = options.store || await (options.storeFactory || createControlPlaneStoreForCloud)({ config, env })
  startupCleanup.add(() => store.close?.())
  // When the control plane resolves to Postgres (same condition as
  // createControlPlaneStoreForCloud), back cloud knowledge with the same Postgres
  // (cloud_knowledge_* tables) so it is durable + shared across replicas rather
  // than a node-local SQLite file. Owns its own pool so it is closed on shutdown.
  // Only auto-built on the default control-plane path; an injected store/factory
  // (e.g. tests) makes the backend unknown, so we leave knowledge to the HTTP
  // server's SQLite fallback unless explicitly overridden.
  const knowledgeControlPlaneUrl = resolveCloudControlPlaneUrl(config, env)
  const usesDefaultPostgresControlPlane = !options.store
    && !options.storeFactory
    && (config.cloud.storage.controlPlane.kind === 'postgres' || Boolean(knowledgeControlPlaneUrl))
  // Only the store we mint here owns a pool we must close; an injected override is
  // the caller's responsibility.
  const ownedKnowledgeStore: KnowledgeStore | null = !options.knowledgeStore
    && usesDefaultPostgresControlPlane
    && knowledgeControlPlaneUrl
    ? createPostgresKnowledgeStore(loadPgPool(knowledgeControlPlaneUrl), { ownsPool: true })
    : null
  if (ownedKnowledgeStore) {
    startupCleanup.add(() => ownedKnowledgeStore.close?.())
  }
  const knowledgeStore: KnowledgeStore | null = options.knowledgeStore ?? ownedKnowledgeStore
  // Instrument the durable object store so get/put/head/delete (and, transitively, checkpoint
  // save/restore) emit success/error + latency metrics (audit P1-O4).
  const objectStore = instrumentObjectStore(
    options.objectStore || await (options.objectStoreFactory || createObjectStoreForCloud)({ config, env, paths }),
    observability,
  )
  startupCleanup.add(() => objectStore.close?.())
  const secretAdapter = options.secretAdapter || await createCloudSecretAdapterFromEnv(env, {
    requireStrongKeyMaterial: envOptions.deploymentTier === 'public_production',
  })
  assertCloudProductionCoreAdaptersSafe({
    tier: envOptions.deploymentTier,
    store,
    objectStore,
    secretAdapter,
  })
  assertCloudWebhookSecurityStoreSafe({
    tier: envOptions.deploymentTier,
    role: policy.role,
    store,
  })
  if (shouldRunCloudWorker(policy.role) || shouldRunCloudScheduler(policy.role)) {
    assertSecretAdapterRoundTrips(secretAdapter)
  }
  const ephemeralStorageRisk = describeUnacknowledgedEphemeralStorage({
    tier: envOptions.deploymentTier,
    store,
    objectStore,
    env,
  })
  if (ephemeralStorageRisk) {
    await recordCloudLog(observability, {
      level: 'warn',
      name: 'cloud.storage.ephemeral',
      message: `Cloud deployment tier "${envOptions.deploymentTier}" resolved to ephemeral storage `
        + `(control-plane=${ephemeralStorageRisk.controlPlane}, object-store=${ephemeralStorageRisk.objectStore}) `
        + `that loses all state on restart. Configure durable Postgres control-plane + provider-backed object `
        + `storage, or set ${ALLOW_EPHEMERAL_STORAGE_ENV}=true to acknowledge this trade-off and silence this warning.`,
      attributes: {
        deployment_tier: envOptions.deploymentTier,
        control_plane: ephemeralStorageRisk.controlPlane,
        object_store: ephemeralStorageRisk.objectStore,
      },
    })
  }
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
  // Knowledge-agent write-path inputs, resolved for BOTH the worker (which spawns
  // the runtime + mints the per-session token) and the web role (which verifies
  // the token on the agent-propose route). Reuses the cloud cookie/invite signing
  // secret + the stable public URL. Any missing piece ⇒ no token minted, no env
  // injected, and the route fails closed.
  const knowledgeAgentSecret = await resolveCloudCookieSecretForRuntime(resolvedAuthConfig, env)
  // Only the shared-process development runtime can use the web process's host
  // loopback. Sandboxed/split workers use the stable HTTPS origin through their
  // declared restricted network; the provider probes the exact token-auth
  // proposal route from inside each boundary before admitting the session.
  const knowledgeAgentPublicUrl = resolveCloudKnowledgeAgentOrigin({
    isolationMode: executionIsolationPolicy.mode,
    role: policy.role,
    allInOnePort: options.port ?? envOptions.port,
    publicUrl: envOptions.publicUrl,
  })
  knowledgeAgentSpawnOptions = {
    knowledgeEnabled: knowledgeRuntime.knowledgeEnabled,
    secret: knowledgeAgentSecret,
    publicUrl: knowledgeAgentPublicUrl,
    mcpScriptPath: knowledgeRuntime.mcpScriptPath,
  }
  const runtimeFactory = options.runtimeFactory || createDefaultCloudRuntimeFactory(
    knowledgeAgentSpawnOptions,
  )
  const effectiveIsolationProvider = executionIsolationProvider
    || createDevelopmentProcessIsolationProvider(runtimeFactory)
  const projectSources = createCloudProjectSourceService({
    policy,
    objectStore,
    credentialResolver: (credentialRef) => resolveCloudSecretRef(credentialRef, { env }),
  })
  const prepareWorkerRuntimeProvision = async (input: Pick<
    CloudExecutionProvisionInput,
    'execution' | 'paths'
  >) => {
    await mkdir(
      input.paths.resolveWorkspacePath(
        input.execution.tenantId,
        input.execution.sessionId,
      ),
      { recursive: true },
    )
    let restoredCheckpointEntries = 0
    if (checkpointStore) {
      try {
        const restored = await checkpointStore.restoreSessionCheckpoint({
          tenantId: input.execution.tenantId,
          sessionId: input.execution.sessionId,
          roots: defaultCloudSessionCheckpointRoots(
            input.paths,
            input.execution.tenantId,
            input.execution.sessionId,
          ),
        })
        restoredCheckpointEntries = restored.restoredEntries
      } catch (error) {
        if (!isMissingCheckpointError(error)) throw error
      }
    }
    if (restoredCheckpointEntries === 0) {
      const projection = await store.getSessionProjection(
        input.execution.tenantId,
        input.execution.sessionId,
      )
      const source = normalizeCloudProjectSource(projection?.view?.projectSource)
      if (source) {
        await projectSources.restoreProjectSource({
          tenantId: input.execution.tenantId,
          sessionId: input.execution.sessionId,
          source,
          paths: input.paths,
        })
      }
    }
  }
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
          observability,
          runtimeFactory,
          isolationPolicy: executionIsolationPolicy,
          isolationProvider: effectiveIsolationProvider,
          prepareProvision: prepareWorkerRuntimeProvision,
          maxRuntimeEntries: options.runtimeCacheMaxEntries ?? envOptions.runtimeCacheMaxEntries,
          runtimeIdleTtlMs: options.runtimeCacheIdleTtlMs ?? envOptions.runtimeCacheIdleTtlMs,
          maxAdmissionQueueEntries:
            options.runtimeAdmissionQueueMaxEntries
            ?? envOptions.runtimeAdmissionQueueMaxEntries,
          admissionQueueTimeoutMs:
            options.runtimeAdmissionQueueTimeoutMs
            ?? envOptions.runtimeAdmissionQueueTimeoutMs,
          runtimeProvisionTimeoutMs:
            options.runtimeProvisionTimeoutMs
            ?? envOptions.runtimeProvisionTimeoutMs,
          runtimeTeardownTimeoutMs:
            options.runtimeTeardownTimeoutMs
            ?? envOptions.runtimeTeardownTimeoutMs,
        })
      : createUnavailableRuntimeAdapter()
  )
  const runtimeOwnsIsolationProvider = !options.runtime
    && shouldRunCloudWorker(policy.role)
  if (runtimeOwnsIsolationProvider) isolationProviderCleanup.deactivate()
  startupCleanup.add(() => runtime.close?.())
  // Resolved before the service so the same signing secret powers both session cookies and the
  // stateless team-invite tokens. Invites are a cloud-web capability; null for non-web roles.
  const hasSessionCookieOverride = Object.prototype.hasOwnProperty.call(options, 'sessionCookies')
  const cookieSecret = shouldRunCloudWeb(policy.role)
    ? await resolveCloudCookieSecretForRuntime(resolvedAuthConfig, env)
    : null
  // Optional, pluggable monetization (#897). The resolver decides feature/quota
  // access purely from stored plan/subscription state — the payment provider is
  // never called from here. Kill switch OFF (default) ⇒ the unlimited resolver.
  const entitlementResolver = resolveEntitlementResolver({
    config: entitlementsConfig,
    billingConfig,
    loadSubscription: (orgId) => Promise.resolve(store.getBillingSubscription(orgId)),
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
    {
      allowSelfServiceSignup: authConfig.allowSelfServiceSignup ?? authConfig.mode !== 'oidc',
      signupMode: authConfig.signupMode,
      allowedEmailDomains: authConfig.allowedEmailDomains || [],
      apiTokenDefaultTtlMs: authConfig.apiTokens?.defaultTtlMs,
      apiTokenMaxTtlMs: authConfig.apiTokens?.maxTtlMs,
      apiTokenAllowedScopes: authConfig.apiTokens?.allowedScopes,
      orgMode: envOptions.orgMode,
      singleOrgId: envOptions.singleOrgId,
      singleOrgName: envOptions.singleOrgName,
    },
    projectSources,
    cookieSecret,
    options.emailSender ?? null,
    entitlementResolver,
    observability,
    // Envelope-encryption adapter for enterprise SSO IdP secrets (#895).
    secretAdapter,
  )
  await service.domains.workflows.migrateLegacyWebhookSecrets()
  const artifacts = new CloudArtifactService(service, objectStore)
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
            clientSecret: await resolveCloudOidcClientSecretForRuntime(resolvedAuthConfig, env),
            publicUrl: envOptions.publicUrl,
            stateCookieSecret: cookieSecret,
            secureCookies: envOptions.cookieSecure,
          })
        : null
    : null
  assertCloudProductionRoleRuntimeSafe({
    tier: envOptions.deploymentTier,
    role: policy.role,
    auth: authConfig,
    checkpointStore,
    sessionCookies,
    browserAuth,
  })
  const worker = shouldRunCloudWorker(policy.role)
    ? new CloudWorker(
        store,
        service,
        cloudWorkerId,
        30_000,
        {
          ...(options.runtime
            ? {
                async restoreBeforeCommand(lease) {
                  await prepareWorkerRuntimeProvision({
                    paths: createCloudSessionPathProvider(
                      paths,
                      lease.tenantId,
                      lease.sessionId,
                    ),
                    execution: {
                      tenantId: lease.tenantId,
                      sessionId: lease.sessionId,
                    },
                  })
                },
              }
            : {}),
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
        observability,
        {
          sessionConcurrency: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_SESSION_CONCURRENCY'), 4),
          maxCommandsPerSessionPerTick: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_MAX_COMMANDS_PER_SESSION_PER_TICK'), 50),
          maxLeases: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_MAX_LEASES'), 4096),
        },
      )
    : null
  if (worker) {
    startupCleanup.add(async () => {
      worker.beginShutdown()
      await worker.completeShutdown({ drained: false })
    })
  }
  const retention: CloudRetentionOptions = {
    // Default null (disabled) — retention is opt-in per the operator's compliance policy.
    channelDeliveryMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_CHANNEL_DELIVERY_MS'), 0) || null,
    channelInteractionMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_CHANNEL_INTERACTION_MS'), 0) || null,
    // Stale throttle state is pure bookkeeping that grows one row per client IP forever, so
    // unlike the compliance tables this prune defaults ON (1h). 0 disables it.
    staleThrottleMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_STALE_THROTTLE_MS'), 60 * 60 * 1000) || null,
    // Compliance/projection-sensitive event logs (P1-C3): default OFF (null). Set an explicit window
    // (ms) to opt in — session events are the unbounded SSE replay log; audit/usage are billing and
    // compliance trails, so prune them only if your retention policy allows it.
    sessionEventMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_SESSION_EVENT_MS'), 0) || null,
    auditEventMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_AUDIT_EVENT_MS'), 0) || null,
    usageEventMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_USAGE_EVENT_MS'), 0) || null,
    workspaceEventMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_WORKSPACE_EVENT_MS'), 0) || null,
    intervalMs: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_INTERVAL_MS'), 60 * 60 * 1000),
    batchSize: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_BATCH_SIZE'), 500),
    maxBatches: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_RETENTION_MAX_BATCHES'), 20),
  }
  // Opt-in periodic concurrency-gauge reconcile (P2-7). Off by default — the clamp-on-read trigger
  // is already drift-free for post-migration activity; set this to recompute the gauges on an interval.
  const concurrencyReconcileMs = parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_CONCURRENCY_RECONCILE_MS'), 0) || null
  const scheduler = shouldRunCloudScheduler(policy.role)
    ? new CloudScheduler(store, service, envValue(env, 'OPEN_COWORK_CLOUD_SCHEDULER_ID') || `${policy.role}-scheduler`, observability, retention, concurrencyReconcileMs)
    : null

  // Coalesce token-granular streaming deltas before materializing (PERF-1): one
  // materialize+persist per ~flush window instead of one per token.
  const runtimeDeltaCoalescer = worker && runtime.subscribeEvents
    ? createRuntimeDeltaCoalescer({
        // Serialized per session (issue #855): the coalescer issues route() calls
        // synchronously in transcript order (flushed delta, then boundary); the wrapper
        // guarantees those appends persist in exactly that order.
        route: ((serializedRoute) => async (event: CloudRuntimeEvent) => {
          try {
            await serializedRoute(event)
          } catch (error) {
            await recordLoopError(
              observability,
              'cloud.worker.runtime_event.error',
              error,
              { event_type: event.type },
            )
            throw error
          }
        })(createSessionSerializedRuntimeEventRouter(createRetryingRuntimeEventRouter({
          route: (event) => routeRuntimeEvent(store, worker, event),
        }))),
      })
    : null
  if (runtimeDeltaCoalescer) {
    startupCleanup.add(() => runtimeDeltaCoalescer.flushAll())
  }
  const runtimeUnsubscribe = runtimeDeltaCoalescer && runtime.subscribeEvents
    ? await runtime.subscribeEvents((event) => runtimeDeltaCoalescer.handle(event), {
      onDroppedEvent(event) {
        void recordCloudMetric(observability, {
            name: 'open_cowork_cloud_opencode_events_dropped_total',
            value: 1,
            unit: '1',
            attributes: {
              reason: event.reason,
          },
        })
      },
      onError(error) {
        void recordLoopError(
          observability,
          'cloud.worker.runtime_event_stream.error',
          error,
        )
      },
    })
    : null
  if (runtimeUnsubscribe) {
    startupCleanup.add(() => runtimeUnsubscribe())
  }
  // Worker/scheduler roles run no HTTP server, so a liveness heartbeat + a tiny /livez
  // server lets the orchestrator restart a wedged-event-loop pod. The web (and all-in-one)
  // role already exposes /livez through its main server, so it needs neither.
  const workerPollMs = options.workerPollMs || envOptions.workerPollMs
  const schedulerPollMs = options.schedulerPollMs || envOptions.schedulerPollMs
  const loopHeartbeat = !shouldRunCloudWeb(policy.role) && (worker || scheduler) ? createLoopHeartbeat() : null
  const stopWorkerLoop = worker
    ? startWorkerLoop(
      worker,
      workerPollMs,
      observability,
      options.shutdownGraceMs || envOptions.shutdownGraceMs,
      loopHeartbeat ?? undefined,
    )
    : null
  if (stopWorkerLoop) startupCleanup.add(() => stopWorkerLoop())
  const stopSchedulerLoop = scheduler
    ? startSchedulerLoop(
      scheduler,
      schedulerPollMs,
      observability,
      options.shutdownGraceMs || envOptions.shutdownGraceMs,
      loopHeartbeat ?? undefined,
    )
    : null
  if (stopSchedulerLoop) startupCleanup.add(() => stopSchedulerLoop())
  // Opt-in via an explicitly-set port (the Helm chart sets it for worker/scheduler).
  // Unset (local/test runs) ⇒ no server, so the fixed port can't conflict across them.
  const livenessPort = parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_LIVENESS_PORT'), 0)
  const livenessServer = loopHeartbeat && livenessPort > 0
    ? await startCloudLivenessServer(
      livenessPort,
      options.hostname || envOptions.hostname,
      () => loopHeartbeat.ageMs() < Math.max(30_000, Math.max(workerPollMs, schedulerPollMs) * 10),
    )
    : null
  if (livenessServer) startupCleanup.add(() => livenessServer.close())

  const webhookSecurity = isWorkflowWebhookSecurityStore(store) ? store : undefined
  // Opt-in Postgres LISTEN/NOTIFY accelerator (audit F1b). Default OFF ⇒ sseReplayHub
  // stays null, the HTTP server makes its own hub exactly as before, and no LISTEN
  // connection is opened — SSE delivery is byte-for-byte the unchanged poll loop. ON ⇒ a
  // shared replay hub is threaded into the HTTP server so the dedicated LISTEN connection
  // below can wake the matching topic early. Requires a Postgres control plane URL and the
  // web role (NOTIFY is emitted by the worker write path; LISTEN/SSE live on web pods).
  const ssePgNotifyEnabled = envOptions.ssePgNotifyEnabled
    && shouldRunCloudWeb(policy.role)
    && Boolean(knowledgeControlPlaneUrl)
  // With the accelerator on, wake-addressable topics poll at the long backstop cadence
  // (NOTIFY delivers low latency; polling only catches missed notifications). Off ⇒ the
  // HTTP server builds its own default hub and every topic polls at ssePollMs as before.
  const sseReplayHub = ssePgNotifyEnabled
    ? new CloudSseReplayHub({ wakeBackstopPollMs: envOptions.sseNotifyBackstopPollMs })
    : null
  const server = shouldRunCloudWeb(policy.role)
      ? createCloudHttpServer({
        sseReplayHub: sseReplayHub ?? undefined,
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
          createManagedWorkerCloudAuthResolver(store),
          createApiTokenCloudAuthResolver(store),
          createCloudAuthResolverForConfig(resolvedAuthConfig),
        ),
        internalToken: resolveCloudInternalToken(env),
        webhookSecurity,
        autoProcessCommands: options.autoProcessCommands ?? (policy.role === 'all-in-one' && envOptions.autoProcessCommands),
        corsOrigin: options.corsOrigin ?? envOptions.corsOrigin,
        strictTransportSecurity: publicUrlEnablesStrictTransportSecurity(envOptions.publicUrl),
        maxSseConnectionsPerOrg: envOptions.maxSseConnectionsPerOrg,
        maxConnections: envOptions.maxConnections,
        ssePollMs: options.ssePollMs ?? envOptions.ssePollIntervalMs,
        trustProxyHeaders: envOptions.trustProxyHeaders,
        trustedProxyCidrs: envOptions.trustedProxyCidrs,
        knowledgeDataDir: paths.getAppDataDir(),
        knowledgeStore: knowledgeStore ?? undefined,
        // Verifies the per-session agent token on /api/knowledge/agent/propose.
        // Same signing secret the worker uses to mint the token. Null ⇒ the route
        // fails closed (401).
        knowledgeAgentTokenSecret: knowledgeAgentSecret,
        runtimeCapabilityPolicy,
        readiness: createCloudReadinessCheck({
          policy,
          store,
          objectStore,
          secretAdapter,
          billingConfig,
          billingAdapter,
          authConfig,
          deploymentTier: envOptions.deploymentTier,
          publicUrl: envOptions.publicUrl,
          cookieSecure: envOptions.cookieSecure,
          sessionCookiesConfigured: Boolean(sessionCookies),
          browserAuthConfigured: Boolean(browserAuth),
          checkpointsEnabled,
          checkpointStoreConfigured: Boolean(checkpointStore),
          executionIsolationPolicy,
          executionIsolationCapability: () => effectiveIsolationProvider.capability(),
          requireSchemaMigrations: envOptions.deploymentTier === 'public_production',
        }),
      })
    : null
  if (server) startupCleanup.add(() => server.close())
  const url = server
    ? await server.listen(options.port ?? envOptions.port, listenHostname)
    : null

  // Dedicated LISTEN connection for the SSE accelerator. Only constructed when the flag is
  // on (sseReplayHub != null) and the web server exists; it wakes the shared hub when a
  // worker writes an event. Self-healing (reconnect with backoff) and error-isolated — any
  // failure degrades to the still-running poll loop, never to broken delivery.
  const ssePgNotifyListener = sseReplayHub && server && knowledgeControlPlaneUrl
    ? new CloudSsePgNotifyListener({ connectionString: knowledgeControlPlaneUrl, hub: sseReplayHub })
    : null
  if (ssePgNotifyListener) {
    startupCleanup.add(() => ssePgNotifyListener.close())
  }
  ssePgNotifyListener?.start()

  startupCleanup.disarm()
  let appClosePromise: Promise<void> | null = null
  const closeApp = () => {
    if (!appClosePromise) {
      appClosePromise = (async () => {
        worker?.beginShutdown()
        let workerLoopDrained = !stopWorkerLoop
        await settleCloudCleanups([
          async () => {
            workerLoopDrained = await stopWorkerLoop?.() ?? true
          },
          async () => {
            await stopSchedulerLoop?.()
          },
          () => livenessServer?.close(),
          () => runtimeUnsubscribe?.(),
          () => runtimeDeltaCoalescer?.flushAll(),
          () => ssePgNotifyListener?.close(),
          () => server?.close(),
          () => worker?.completeShutdown({
            drained: workerLoopDrained && worker.getActiveCommandCount() === 0,
          }),
          () => runtime.close?.(),
          () => runtimeOwnsIsolationProvider
            ? undefined
            : executionIsolationProvider?.close?.(),
          () => objectStore.close?.(),
          () => ownedKnowledgeStore?.close?.(),
          () => store.close?.(),
          () => observability?.close?.(),
        ])
      })()
    }
    return appClosePromise
  }
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
    executionIsolationPolicy,
    executionIsolationCapability,
    url,
    close: closeApp,
    }
  } catch (error) {
    await startupCleanup.unwind()
    throw error
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
