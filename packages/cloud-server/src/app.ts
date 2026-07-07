import { createPostgresKnowledgeStore } from '@open-cowork/runtime-host/knowledge/postgres-knowledge-store'
import type { WorkflowWebhookSecurityStore } from '@open-cowork/shared/node'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac } from 'node:crypto'
import { constantTimeEquals as constantTimeStringEqual } from '@open-cowork/shared/node'
import { mkdir } from 'node:fs/promises'
import { createServer, type IncomingMessage } from 'node:http'
import { splitTrustedProxyCidrs, type KnowledgeStore } from '@open-cowork/shared'
import { DEFAULT_CONFIG, type CloudAuthConfig, type CloudBillingConfig, type OpenCoworkConfig } from '@open-cowork/shared'
import { CloudArtifactService } from './artifact-service.ts'
import { evaluateBillingEntitlement, type BillingAdapter } from './billing-adapter.ts'
import {
  DEFAULT_HEADER_AUTH_SIGNATURE_AGE_MS,
  parseCloudDeploymentTier,
  resolveCloudAbuseConfig,
  resolveCloudAuthConfig,
  resolveCloudBillingConfig,
  resolveCloudEntitlementsConfig,
  resolveCloudRuntimePolicy,
  type CloudDeploymentTier,
  type CloudRuntimePolicy,
} from './cloud-config.ts'
export { parseCloudDeploymentTier, resolveCloudAbuseConfig, resolveCloudAuthConfig, resolveCloudBillingConfig, resolveCloudEntitlementsConfig, type CloudDeploymentTier } from './cloud-config.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import { InMemoryControlPlaneStore } from './in-memory-control-plane-store.ts'
import {
  createCloudHttpServer,
  CloudHttpError,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudDesktopAuthConfig,
  type CloudHttpServer,
} from './http-server.ts'
import { CloudSseReplayHub } from './sse-replay.ts'
import { CloudSsePgNotifyListener } from './sse-pg-notify.ts'
import {
  createCloudObservabilityFromEnv,
  recordCloudLog,
  recordCloudMetric,
  recordCloudSchedulerMetric,
  recordCloudWorkerMetric,
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
  createOidcCloudAuthResolver,
  type OidcCloudAuthResolverOptions,
} from './oidc-auth.ts'
import { createCloudPathProvider, createCloudSessionPathProvider, type PathProvider } from './path-provider.ts'
import { createPostgresControlPlaneStore, loadPgPool } from './postgres-control-plane-store.ts'
import { createCloudProjectSourceService } from './project-source-service.ts'
import { createCloudReadinessCheck } from './readiness.ts'
import { createNodeOpencodeCloudRuntimeAdapter } from './opencode-runtime-adapter.ts'
import type { CloudRuntimeAdapter, CloudRuntimeEvent } from './runtime-adapter.ts'
import {
  assertCloudSecretKeyMaterialStrong,
  createCloudSecretAdapterFromEnv,
  resolveCloudSecretRef,
  type SecretAdapter,
} from './secret-adapter.ts'
import { isManagedCloudSecretRef } from './secret-ref-policy.ts'
import { createCloudSessionCookieManager, type CloudSessionCookieManager } from './session-cookie-auth.ts'
import { CloudSessionService, type ByokManagementPolicy, type CloudEmailSender, type CloudPrincipal } from './session-service.ts'
import { CloudScheduler, type CloudRetentionOptions } from './scheduler.ts'
import { createStripeBillingAdapter } from './stripe-billing-adapter.ts'
import { createStubBillingAdapter } from './stub-billing-adapter.ts'
import { resolveEntitlementResolver } from './entitlements/entitlement-provider.ts'
import { CloudWorker } from './worker.ts'
import { createWorkerScopedRuntimeAdapter } from './worker-scoped-runtime-adapter.ts'
import {
  applyKnowledgeAgentRuntimeAugmentation,
  buildKnowledgeAgentRuntimeAugmentation,
} from './knowledge-agent-runtime.ts'
import { createUnavailableRuntimeAdapter } from './unavailable-runtime-adapter.ts'
import {
  createObjectWorkspaceCheckpointStore,
  defaultCloudSessionCheckpointRoots,
  type WorkspaceCheckpointStore,
} from './workspace-checkpoint-store.ts'
import { type Env, envValue, parseBoolean, parsePort, parsePositiveInt, resolveEnvRef } from './cloud-config-parse.ts'
import { resolveCloudPublicBranding } from './cloud-branding-config.ts'
export { resolveCloudPublicBranding } from './cloud-branding-config.ts'

const ALLOW_INSECURE_CLOUD_AUTH_ENV = 'OPEN_COWORK_CLOUD_ALLOW_INSECURE_AUTH'
const ALLOW_EPHEMERAL_STORAGE_ENV = 'OPEN_COWORK_CLOUD_ALLOW_EPHEMERAL_STORAGE'
const RUN_MIGRATIONS_ENV = 'OPEN_COWORK_CLOUD_RUN_MIGRATIONS'
// Opt-in Postgres LISTEN/NOTIFY accelerator for SSE delivery (audit F1b). Default OFF:
// with it unset, no LISTEN connection is opened and no NOTIFY is issued — SSE delivery is
// the unchanged poll loop. ON only wakes the matching SSE topic earlier; polling remains
// the guaranteed backstop. Postgres-only (the in-memory store path ignores it).
const SSE_PG_NOTIFY_ENV = 'OPEN_COWORK_CLOUD_SSE_PG_NOTIFY'
const HEADER_AUTH_SIGNED_HEADERS = [
  'x-open-cowork-tenant-id',
  'x-open-cowork-tenant-name',
  'x-open-cowork-user-id',
  'x-open-cowork-user-email',
  'x-open-cowork-user-role',
] as const

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
  onUnexpectedExit?: () => void
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

async function resolveConfiguredSecretRef(ref: string | null | undefined, env: Env) {
  const value = ref?.trim()
  if (!value) return null
  if (value.startsWith('env:') || secretRefIsManaged(value)) {
    return resolveCloudSecretRef(value, { env })
  }
  return resolveEnvRef(value, env)
}

async function resolveCloudSecretMaterial(input: {
  value?: string | null
  ref?: string | null
  env: Env
}) {
  const direct = input.value?.trim()
  if (direct) return direct
  return resolveConfiguredSecretRef(input.ref, input.env)
}

async function resolveCloudAuthRuntimeSecrets(auth: CloudAuthConfig, env: Env): Promise<CloudAuthConfig> {
  if (auth.mode !== 'header') return auth
  const headerSecret = await resolveCloudSecretMaterial({
    value: auth.headerSecret,
    ref: auth.headerSecretRef,
    env,
  })
  return {
    ...auth,
    headerSecret: headerSecret || auth.headerSecret,
  }
}

export function resolveCloudControlPlaneUrl(config: OpenCoworkConfig, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_CONTROL_PLANE_URL')
    || resolveEnvRef(config.cloud.storage.controlPlane.urlRef, env)
}

export function resolveCloudCookieSecret(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env) {
  const cookieSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF') || config.cloud.auth.cookieSecretRef
  return envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
    || resolveEnvRef(cookieSecretRef, env)
    || envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
}

async function resolveCloudCookieSecretForRuntime(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env) {
  const cookieSecret = envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
  if (cookieSecret) return cookieSecret
  const cookieSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF') || config.cloud.auth.cookieSecretRef
  const resolvedCookieSecret = await resolveConfiguredSecretRef(cookieSecretRef, env)
  if (resolvedCookieSecret) return resolvedCookieSecret
  const cloudSecret = envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
  if (cloudSecret) return cloudSecret
  return resolveConfiguredSecretRef(envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY_REF'), env)
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
  const clientSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF') || config.cloud.auth.clientSecretRef
  return envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET')
    || resolveEnvRef(clientSecretRef, env)
}

async function resolveCloudOidcClientSecretForRuntime(config: Pick<OpenCoworkConfig, 'cloud'>, env: Env = process.env) {
  const clientSecret = envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET')
  if (clientSecret) return clientSecret
  const clientSecretRef = envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF') || config.cloud.auth.clientSecretRef
  return resolveConfiguredSecretRef(clientSecretRef, env)
}

// Filesystem path to the bundled cloud knowledge MCP. build-cloud.mjs bundles
// mcps/knowledge/src/index.ts → apps/desktop/dist/cloud/mcp-knowledge.mjs, which
// sits next to the bundled cloud entrypoint (this module). An env override lets
// non-default deployments relocate it; null/missing means the agent path is not
// wired (fail closed). Resolved lazily so a bad URL never throws at import time.
export function resolveCloudKnowledgeMcpScriptPath(env: Env = process.env): string | null {
  const override = envValue(env, 'OPEN_COWORK_CLOUD_KNOWLEDGE_MCP_PATH')
  if (override) return override
  try {
    return fileURLToPath(new URL('./mcp-knowledge.mjs', import.meta.url))
  } catch {
    return null
  }
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
    // Allow change-managed rollouts to boot instances with embedded migrations
    // disabled (OPEN_COWORK_CLOUD_RUN_MIGRATIONS=false) and run `cloud:migrate`
    // as a separate step. Defaults to true so the embedded path is unchanged.
    return createPostgresControlPlaneStore({
      connectionString: url,
      runMigrations: parseBoolean(envValue(input.env, RUN_MIGRATIONS_ENV), true),
      // Opt-in NOTIFY-on-write for the SSE LISTEN/NOTIFY accelerator (default off).
      ssePgNotify: parseBoolean(envValue(input.env, SSE_PG_NOTIFY_ENV), false),
    })
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
    // HTTP connection caps resolved/validated here (instead of read from process.env
    // inside the HTTP server) so they travel through CloudHttpServerOptions like every
    // other knob. Defaults preserve the previous in-server behaviour (200 / 10000).
    maxSseConnectionsPerOrg: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_MAX_SSE_CONNECTIONS_PER_ORG'), 200),
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
    trustProxyHeaders: parseBoolean(envValue(env, 'OPEN_COWORK_CLOUD_TRUST_PROXY_HEADERS'), false),
    trustedProxyCidrs: splitTrustedProxyCidrs(envValue(env, 'OPEN_COWORK_CLOUD_TRUSTED_PROXY_CIDRS')),
  }
}

// Per-session knowledge-agent spawn options. When all three are present the
// default runtime factory mints a per-session token and injects the knowledge
// MCP + its env so a cloud coworker can propose a knowledge edit. Any missing
// field ⇒ nothing is injected (fail closed).
export type KnowledgeAgentSpawnOptions = {
  knowledgeEnabled: boolean
  secret: string | null
  publicUrl: string | null
  mcpScriptPath: string | null
}

export function createDefaultCloudRuntimeFactory(
  knowledgeAgent: KnowledgeAgentSpawnOptions,
): CloudRuntimeFactory {
  return (input: CloudRoleRuntimeFactoryInput) => {
    // Mint the per-session token + inject the knowledge MCP/env only for THIS
    // session's tenant. Returns null (no augmentation) when fail-closed.
    const augmentation = buildKnowledgeAgentRuntimeAugmentation({
      knowledgeEnabled: knowledgeAgent.knowledgeEnabled,
      secret: knowledgeAgent.secret,
      publicUrl: knowledgeAgent.publicUrl,
      mcpScriptPath: knowledgeAgent.mcpScriptPath,
      execution: input.execution,
    })
    const { env, runtimeConfig } = applyKnowledgeAgentRuntimeAugmentation({
      env: input.env,
      runtimeConfig: input.runtimeConfig,
      augmentation,
    })
    return createNodeOpencodeCloudRuntimeAdapter({
      paths: input.paths,
      env: env as NodeJS.ProcessEnv,
      // The augmentation only ever adds a valid local-MCP entry to `mcp`; this
      // module owns the OpenCode `Config` typing (the helper stays SDK-free so it
      // sits outside the OpenCode SDK boundary), so re-narrow back to it here.
      config: runtimeConfig as CloudRoleRuntimeFactoryInput['runtimeConfig'],
      configDelivery: 'ephemeral-file',
      cwd: input.paths.resolveWorkspacePath(input.execution.tenantId, input.execution.sessionId),
      // Crash recovery: forward the cache-eviction hook so a dead managed child is rebuilt.
      onUnexpectedExit: input.onUnexpectedExit,
    })
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

function readHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}



export function createHeaderCloudAuthResolver(defaults: Partial<CloudPrincipal> = {}, options: {
  headerSecret?: string | null
  requireSignedHeaders?: boolean
  maxSignatureAgeMs?: number
  now?: () => Date
} = {}): CloudAuthResolver {
  return (req) => {
    const expectedSecret = options.headerSecret?.trim()
    if (expectedSecret && !constantTimeStringEqual(readHeader(req, 'x-open-cowork-header-auth-secret'), expectedSecret)) {
      throw new CloudHttpError(401, 'Trusted header authentication secret is invalid.')
    }
    if (expectedSecret && options.requireSignedHeaders) {
      assertHeaderAuthSignature(req, expectedSecret, {
        maxAgeMs: options.maxSignatureAgeMs || DEFAULT_HEADER_AUTH_SIGNATURE_AGE_MS,
        now: options.now,
      })
    }
    const tenantId = readHeader(req, 'x-open-cowork-tenant-id') || defaults.tenantId || 'default'
    const userId = readHeader(req, 'x-open-cowork-user-id') || defaults.userId || 'local-user'
    const email = readHeader(req, 'x-open-cowork-user-email') || defaults.email || 'local@example.test'
    const role = readHeader(req, 'x-open-cowork-user-role') || defaults.role || 'member'
    if (role !== 'owner' && role !== 'admin' && role !== 'member') {
      throw new CloudHttpError(401, 'Trusted header authentication role is invalid.')
    }
    return {
      tenantId,
      orgId: defaults.orgId || tenantId,
      tenantName: readHeader(req, 'x-open-cowork-tenant-name') || defaults.tenantName || tenantId,
      userId,
      accountId: defaults.accountId || userId,
      email,
      role,
      authSource: 'header',
    }
  }
}

function canonicalHeaderAuthPayload(req: IncomingMessage, timestamp: string) {
  return [
    'v1',
    timestamp,
    ...HEADER_AUTH_SIGNED_HEADERS.map((name) => readHeader(req, name) || ''),
  ].join('\n')
}

export function signHeaderCloudAuthRequest(input: {
  headers: Record<string, string | undefined>
  secret: string
  timestamp: string
}) {
  const payload = [
    'v1',
    input.timestamp,
    ...HEADER_AUTH_SIGNED_HEADERS.map((name) => input.headers[name] || input.headers[name.toLowerCase()] || ''),
  ].join('\n')
  return `v1=${createHmac('sha256', input.secret).update(payload).digest('hex')}`
}

function assertHeaderAuthSignature(req: IncomingMessage, secret: string, options: {
  maxAgeMs: number
  now?: () => Date
}) {
  const timestamp = readHeader(req, 'x-open-cowork-header-auth-timestamp')
  const signature = readHeader(req, 'x-open-cowork-header-auth-signature')
  if (!timestamp || !signature) {
    throw new CloudHttpError(401, 'Trusted header authentication signature is required.')
  }
  const timestampMs = Number(timestamp) * 1000
  if (!Number.isFinite(timestampMs)) {
    throw new CloudHttpError(401, 'Trusted header authentication timestamp is invalid.')
  }
  const nowMs = (options.now?.() || new Date()).getTime()
  if (Math.abs(nowMs - timestampMs) > options.maxAgeMs) {
    throw new CloudHttpError(401, 'Trusted header authentication timestamp is outside the allowed window.')
  }
  const expected = `v1=${createHmac('sha256', secret).update(canonicalHeaderAuthPayload(req, timestamp)).digest('hex')}`
  if (!constantTimeStringEqual(signature, expected)) {
    throw new CloudHttpError(401, 'Trusted header authentication signature is invalid.')
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

export function createManagedWorkerCloudAuthResolver(store: ControlPlaneStore): CloudAuthResolver {
  return async (req) => {
    const token = readBearerToken(req)
    if (!token) throw new CloudHttpError(401, 'Managed worker authorization is required.')
    if (!token.startsWith('ocw_')) throw new CloudHttpError(401, 'Managed worker authorization is required.')
    const resolved = await store.findManagedWorkerCredentialByPlaintext(token)
    if (!resolved) throw new CloudHttpError(401, 'Managed worker credential is invalid or expired.')
    return {
      tenantId: resolved.worker.tenantId || resolved.pool.tenantId || resolved.pool.orgId,
      orgId: resolved.pool.orgId,
      tenantName: resolved.pool.name,
      userId: resolved.worker.workerId,
      accountId: resolved.worker.workerId,
      email: `${resolved.worker.workerId}@workers.open-cowork.local`,
      role: 'member',
      authSource: 'worker',
      workerId: resolved.worker.workerId,
      workerPoolId: resolved.pool.poolId,
      workerCredentialId: resolved.credential.credentialId,
      workerScopes: resolved.credential.scopes,
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
        // Only a clean "credential not recognized" signal (CloudHttpError 401) may fall
        // through to the next resolver. Anything else — a DB timeout, a provider outage,
        // a programming error — is an infrastructure failure; masking it as 401 would
        // silently degrade authentication to a laxer resolver, so surface it instead.
        if (!(error instanceof CloudHttpError) || error.status !== 401) throw error
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
    return createHeaderCloudAuthResolver({}, {
      headerSecret: config.cloud.auth.headerSecret,
      requireSignedHeaders: Boolean(config.cloud.auth.headerSecret && !config.cloud.auth.headerAllowUnsigned),
      maxSignatureAgeMs: config.cloud.auth.headerMaxSignatureAgeMs,
    })
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
  if (url.protocol !== 'https:' || isLoopbackCloudHost(url.hostname)) {
    throw new Error(`${label} for public deployments must use HTTPS with a non-loopback host.`)
  }
  return url
}

function publicUrlEnablesStrictTransportSecurity(value: string | null | undefined) {
  try {
    const url = parseDeploymentOrigin(value, 'OPEN_COWORK_CLOUD_PUBLIC_URL')
    return Boolean(url && url.protocol === 'https:' && !isLoopbackCloudHost(url.hostname))
  } catch {
    return false
  }
}

export function assertCloudAuthDeploymentSafe(input: {
  role: CloudRuntimePolicy['role']
  hostname: string
  auth: CloudAuthConfig
  publicUrl?: string | null
  corsOrigin?: string | null
  cookieSecure?: boolean
  env?: Env
}) {
  if (!shouldRunCloudWeb(input.role)) return
  if (parseBoolean(envValue(input.env || process.env, ALLOW_INSECURE_CLOUD_AUTH_ENV), false)) return
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
  } catch (error) {
    throw new Error(
      `Cloud secret adapter failed its encrypt/decrypt boot canary (${error instanceof Error ? error.message : String(error)}). The configured cloud secret key cannot round-trip — refusing to start a worker/scheduler that would fail to reveal stored secrets at runtime.`,
      { cause: error },
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

// Per-session serialization for runtime-event routing (issue #855). routeRuntimeEvent →
// worker.appendRuntimeEvent crosses multiple awaits with no per-session locking, and the
// store assigns the durable sequence at append time — so two overlapping route() calls
// for the SAME session can interleave and persist out of arrival order (e.g. a boundary
// tool/idle event landing before the delta the coalescer flushed ahead of it), and can
// race the projection read-modify-write into the 'Projection sequence must be monotonic'
// guard. This wrapper chains every call for a session onto a per-session promise tail:
// enqueueing is synchronous, so CALL order (which the coalescer issues in transcript
// order) is exactly the order appends run and persist. Distinct sessions stay concurrent.
export function createSessionSerializedRuntimeEventRouter(
  route: (event: CloudRuntimeEvent) => Promise<void>,
): (event: CloudRuntimeEvent) => Promise<void> {
  const tailBySession = new Map<string, Promise<void>>()
  return (event) => {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null
    if (!sessionId) return route(event)
    const tail = tailBySession.get(sessionId) ?? Promise.resolve()
    const next = tail.then(() => route(event))
    // The stored tail must never reject, or one failed route would wedge every later
    // event on the session. Callers awaiting `next` still observe the route's rejection.
    const guarded = next.then(() => {}, () => {})
    tailBySession.set(sessionId, guarded)
    void guarded.then(() => {
      // Drop the tail once idle so the map does not grow with every session ever seen.
      if (tailBySession.get(sessionId) === guarded) tailBySession.delete(sessionId)
    })
    return next
  }
}

// Token-granular `assistant.message` append deltas (projected from the SDK
// `message.part.delta`) arrive one per token. Materializing each one rewrites the WHOLE
// session projection (+ ~5 DB round-trips per event), so M streamed tokens cost O(M²)
// write amplification. This coalescer buffers consecutive append deltas per session and
// flushes them as ONE append on a short timer (a streaming window, not a debounce — so a
// long stream still advances every ~flushDelayMs) or at the next non-append boundary
// event, so a single materialize+persist covers many tokens.
//
// Correctness: the projection reducer appends each delta onto the same message, so
// `existing + (d1 + d2 + … + dN)` is byte-identical to `((existing + d1) + d2) … + dN`.
// Non-append events flush the session's pending delta FIRST so transcript order is
// preserved (deltas land before the snapshot/tool/idle that follows them). The coalescer
// invokes route() synchronously in transcript order; the production route is additionally
// wrapped in createSessionSerializedRuntimeEventRouter so the multi-await append path
// cannot re-order those calls durably (issue #855). Pending deltas
// are flushed when the session goes idle (a boundary), and `flushAll` flushes any tail on
// shutdown, so no token is lost. Sequence ordering is preserved: coalescing only reduces
// the number of appended events; the survivors stay monotonic and in arrival order.
export const DEFAULT_RUNTIME_DELTA_FLUSH_MS = 60

type RuntimeDeltaPending = {
  event: CloudRuntimeEvent
  messageId: string
  timer: ReturnType<typeof setTimeout> | null
}

export type RuntimeDeltaCoalescer = {
  handle(event: CloudRuntimeEvent): void
  flushAll(): Promise<void>
}

function isAppendDeltaEvent(event: CloudRuntimeEvent) {
  return event.type === 'assistant.message'
    && event.payload.mode === 'append'
    && typeof event.payload.content === 'string'
    && typeof event.payload.sessionId === 'string'
}

function runtimeEventMessageId(event: CloudRuntimeEvent) {
  return typeof event.payload.messageId === 'string' ? event.payload.messageId : ''
}

export function createRuntimeDeltaCoalescer(options: {
  route: (event: CloudRuntimeEvent) => Promise<void>
  flushDelayMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}): RuntimeDeltaCoalescer {
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_RUNTIME_DELTA_FLUSH_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle))
  const pendingBySession = new Map<string, RuntimeDeltaPending>()

  // Flush the buffered append for a session. Returns the route promise so shutdown can
  // await it; timer/boundary flushes ignore the return (fire-and-forget, matching the
  // existing per-event routing).
  const flushSession = (sessionId: string): Promise<void> => {
    const pending = pendingBySession.get(sessionId)
    if (!pending) return Promise.resolve()
    pendingBySession.delete(sessionId)
    if (pending.timer) clearTimer(pending.timer)
    return options.route(pending.event)
  }

  const handle = (event: CloudRuntimeEvent) => {
    const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null

    if (sessionId && isAppendDeltaEvent(event)) {
      const messageId = runtimeEventMessageId(event)
      const pending = pendingBySession.get(sessionId)
      if (pending && pending.messageId === messageId) {
        // Same streaming message: concatenate the delta onto the buffered append. The
        // timer keeps running (window, not debounce) so the stream still flushes on cadence.
        pending.event = {
          ...pending.event,
          payload: {
            ...pending.event.payload,
            content: String(pending.event.payload.content ?? '') + String(event.payload.content ?? ''),
          },
        }
        return
      }
      // A delta for a different message (or none buffered): flush the old one first to keep
      // order, then start a fresh window for this message.
      if (pending) void flushSession(sessionId)
      const timer = setTimer(() => { void flushSession(sessionId) }, flushDelayMs)
      pendingBySession.set(sessionId, {
        event: { ...event, payload: { ...event.payload } },
        messageId,
        timer,
      })
      return
    }

    // Boundary event: flush this session's pending deltas before routing it so the
    // transcript order (deltas → snapshot/tool/idle) is preserved. Both route() calls are
    // issued synchronously in transcript order; DURABLE ordering additionally requires the
    // route itself to serialize per session (the production wiring wraps routeRuntimeEvent
    // in createSessionSerializedRuntimeEventRouter — issue #855).
    // INVARIANT: these are fire-and-forget (`void`), so `options.route` must never reject —
    // the production wiring pre-wraps it in `.catch(recordLoopError)`. Keep that catch if you
    // rewire the route, or these calls will surface as unhandled promise rejections.
    if (sessionId) void flushSession(sessionId)
    void options.route(event)
  }

  const flushAll = async () => {
    await Promise.all([...pendingBySession.keys()].map((sessionId) => flushSession(sessionId)))
  }

  return { handle, flushAll }
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
  await recordCloudMetric(observability, {
    name: 'open_cowork_cloud_loop_errors_total',
    value: 1,
    unit: '1',
    attributes: {
      loop: name,
      ...attributes,
      error_name: error instanceof Error ? error.name : 'Error',
    },
  })
  await recordCloudLog(observability, {
    level: 'error',
    name,
    message: error instanceof Error ? error.message : String(error),
    attributes: {
      ...attributes,
      ...loopErrorAttributes(error),
    },
  })
}

type LoopStopper = () => Promise<void>

async function waitForLoopDrain(
  loopName: 'worker' | 'scheduler',
  current: Promise<void> | null,
  graceMs: number,
  observability: CloudObservabilityAdapter | null,
) {
  if (!current) return
  let timeout: ReturnType<typeof setTimeout> | null = null
  const timeoutMarker = Symbol('shutdown-timeout')
  const result = await Promise.race([
    current.then(() => null),
    new Promise<symbol>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(timeoutMarker), graceMs)
    }),
  ])
  if (timeout) clearTimeout(timeout)
  if (result === timeoutMarker) {
    await recordCloudLog(observability, {
      level: 'warn',
      name: `cloud.${loopName}.shutdown_timeout`,
      message: `Cloud ${loopName} loop did not finish before shutdown grace elapsed.`,
      attributes: { grace_ms: graceMs },
    })
  }
}

// Liveness heartbeat for the worker/scheduler loops. Beaten at the TOP of each timer
// fire (independent of the async work), so it stays fresh through long legitimate
// command execution and only goes stale when the event loop itself stalls — the failure
// a liveness probe must catch on roles that run no HTTP server.
type LoopHeartbeat = { beat(): void; ageMs(): number }

function createLoopHeartbeat(): LoopHeartbeat {
  let lastBeatMs = Date.now()
  return {
    beat() { lastBeatMs = Date.now() },
    ageMs() { return Date.now() - lastBeatMs },
  }
}

// Minimal /livez server for the worker + scheduler roles (which otherwise expose no HTTP
// surface), so a wedged-event-loop pod is restarted instead of silently processing nothing.
function startCloudLivenessServer(
  port: number,
  hostname: string,
  isLive: () => boolean,
): { close(): Promise<void> } {
  const server = createServer((req, res) => {
    if (req.url === '/livez' || req.url === '/healthz') {
      const live = isLive()
      res.writeHead(live ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: live }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false }))
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 8_000
  server.maxConnections = 64
  // A liveness server must never crash the role it protects; tolerate a bind failure.
  server.on('error', () => undefined)
  server.listen(port, hostname)
  return {
    async close() {
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

function startWorkerLoop(
  worker: CloudWorker,
  pollMs: number,
  observability: CloudObservabilityAdapter | null,
  shutdownGraceMs: number,
  heartbeat?: LoopHeartbeat,
): LoopStopper {
  let active = false
  let stopping = false
  let current: Promise<void> | null = null
  const timer = setInterval(() => {
    heartbeat?.beat()
    if (active || stopping) return
    active = true
    current = worker.processAllSessionCommands()
      .then(() => undefined)
      .catch(async (error) => {
        await recordCloudWorkerMetric(observability, {
          name: 'open_cowork_cloud_worker_loop_failures_total',
          workerId: 'loop',
          status: 'error',
        })
        await recordLoopError(observability, 'cloud.worker.loop.error', error)
      })
      .finally(() => {
        active = false
        current = null
      })
  }, pollMs)
  return async () => {
    stopping = true
    clearInterval(timer)
    await waitForLoopDrain('worker', current, shutdownGraceMs, observability)
  }
}

function startSchedulerLoop(
  scheduler: CloudScheduler,
  pollMs: number,
  observability: CloudObservabilityAdapter | null,
  shutdownGraceMs: number,
  heartbeat?: LoopHeartbeat,
): LoopStopper {
  let active = false
  let stopping = false
  let current: Promise<void> | null = null
  const timer = setInterval(() => {
    heartbeat?.beat()
    if (active || stopping) return
    active = true
    current = scheduler.processDueWorkflows()
      .then(() => undefined)
      .catch(async (error) => {
        await recordCloudSchedulerMetric(observability, {
          name: 'open_cowork_cloud_scheduler_failures_total',
          schedulerId: 'loop',
          status: 'error',
        })
        await recordLoopError(observability, 'cloud.scheduler.loop.error', error)
      })
      .finally(() => {
        active = false
        current = null
      })
  }, pollMs)
  return async () => {
    stopping = true
    clearInterval(timer)
    await waitForLoopDrain('scheduler', current, shutdownGraceMs, observability)
  }
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
  const paths = options.paths || createCloudPathProvider(envOptions.root)
  const store = options.store || await (options.storeFactory || createControlPlaneStoreForCloud)({ config, env })
  // When the control plane resolves to Postgres (same condition as
  // createControlPlaneStoreForCloud), back cloud knowledge with the same Postgres
  // (016_cloud_knowledge tables) so it is durable + shared across replicas rather
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
  const knowledgeStore: KnowledgeStore | null = options.knowledgeStore ?? ownedKnowledgeStore
  // Instrument the durable object store so get/put/head/delete (and, transitively, checkpoint
  // save/restore) emit success/error + latency metrics (audit P1-O4).
  const objectStore = instrumentObjectStore(
    options.objectStore || await (options.objectStoreFactory || createObjectStoreForCloud)({ config, env, paths }),
    observability,
  )
  const secretAdapter = options.secretAdapter || await createCloudSecretAdapterFromEnv(env, {
    requireStrongKeyMaterial: envOptions.deploymentTier === 'public_production',
  })
  assertCloudProductionCoreAdaptersSafe({
    tier: envOptions.deploymentTier,
    store,
    objectStore,
    secretAdapter,
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
  // The knowledge MCP requires a loopback http endpoint. In all-in-one the worker
  // (which mints the per-session token + spawns the MCP) is co-located with the web
  // role (which verifies the token on the propose route), so the MCP reaches it over
  // loopback at the bind port — regardless of the (possibly https) public URL. Split
  // roles can't reach the web over loopback and the MCP rejects a remote https URL,
  // so they fall through to the public URL which fails closed at the MCP — i.e. the
  // cloud agent write-path is effectively all-in-one-only today (broadening to split
  // would need the MCP to accept a same-origin https endpoint).
  const knowledgeAgentPublicUrl = policy.role === 'all-in-one'
    ? `http://127.0.0.1:${options.port ?? envOptions.port}`
    : (envOptions.publicUrl?.trim() || null)
  const knowledgeAgentMcpScriptPath = resolveCloudKnowledgeMcpScriptPath(env)
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
          runtimeFactory: options.runtimeFactory || createDefaultCloudRuntimeFactory({
            knowledgeEnabled: policy.features.knowledge,
            secret: knowledgeAgentSecret,
            publicUrl: knowledgeAgentPublicUrl,
            mcpScriptPath: knowledgeAgentMcpScriptPath,
          }),
          maxRuntimeEntries: options.runtimeCacheMaxEntries ?? envOptions.runtimeCacheMaxEntries,
          runtimeIdleTtlMs: options.runtimeCacheIdleTtlMs ?? envOptions.runtimeCacheIdleTtlMs,
        })
      : createUnavailableRuntimeAdapter()
  )
  const projectSources = createCloudProjectSourceService({
    policy,
    objectStore,
    credentialResolver: (credentialRef) => resolveCloudSecretRef(credentialRef, { env }),
  })
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
  )
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
        observability,
        {
          sessionConcurrency: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_SESSION_CONCURRENCY'), 4),
          maxCommandsPerSessionPerTick: parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_WORKER_MAX_COMMANDS_PER_SESSION_PER_TICK'), 50),
        },
      )
    : null
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
        route: createSessionSerializedRuntimeEventRouter((event) => routeRuntimeEvent(store, worker, event).catch((error) => recordLoopError(
          observability,
          'cloud.worker.runtime_event.error',
          error,
          { event_type: event.type },
        ))),
      })
    : null
  const runtimeUnsubscribe = runtimeDeltaCoalescer && runtime.subscribeEvents
    ? await runtime.subscribeEvents((event) => {
        runtimeDeltaCoalescer.handle(event)
      }, {
        onDroppedEvent(event) {
          void recordCloudMetric(observability, {
            name: 'open_cowork_cloud_opencode_events_dropped_total',
            value: 1,
            unit: '1',
            attributes: {
              sdk_event_type: event.sdkEventType || 'unknown',
              reason: event.reason,
            },
          })
        },
      })
    : null
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
  const stopSchedulerLoop = scheduler
    ? startSchedulerLoop(
      scheduler,
      schedulerPollMs,
      observability,
      options.shutdownGraceMs || envOptions.shutdownGraceMs,
      loopHeartbeat ?? undefined,
    )
    : null
  // Opt-in via an explicitly-set port (the Helm chart sets it for worker/scheduler).
  // Unset (local/test runs) ⇒ no server, so the fixed port can't conflict across them.
  const livenessPort = parsePositiveInt(envValue(env, 'OPEN_COWORK_CLOUD_LIVENESS_PORT'), 0)
  const livenessServer = loopHeartbeat && livenessPort > 0
    ? startCloudLivenessServer(
      livenessPort,
      options.hostname || envOptions.hostname,
      () => loopHeartbeat.ageMs() < Math.max(30_000, Math.max(workerPollMs, schedulerPollMs) * 10),
    )
    : null

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
          requireSchemaMigrations: envOptions.deploymentTier === 'public_production',
        }),
      })
    : null
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
  ssePgNotifyListener?.start()

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
      await Promise.all([
        stopWorkerLoop?.(),
        stopSchedulerLoop?.(),
      ])
      await livenessServer?.close()
      runtimeUnsubscribe?.()
      // Flush any buffered streaming deltas before teardown so no token is lost (PERF-1).
      await runtimeDeltaCoalescer?.flushAll()
      // Stop waking before the server (which owns/closes the shared hub) shuts down.
      await ssePgNotifyListener?.close()
      await server?.close()
      try {
        await observability?.close?.()
      } catch {
        // Telemetry shutdown must not block runtime, object-store, or control-plane cleanup.
      }
      await runtime.close?.()
      await objectStore.close?.()
      await ownedKnowledgeStore?.close?.()
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
