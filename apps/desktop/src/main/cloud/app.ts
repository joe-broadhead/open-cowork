import { resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { DEFAULT_CONFIG, type CloudAuthConfig, type OpenCoworkConfig } from '../config-types.ts'
import { CloudArtifactService } from './artifact-service.ts'
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
import { createByokSecretStore, type ByokSecretStore } from './byok-secret-store.ts'
import {
  createOidcBrowserAuthProvider,
  createOidcCloudAuthResolver,
  type OidcCloudAuthResolverOptions,
} from './oidc-auth.ts'
import { createCloudPathProvider, type PathProvider } from './path-provider.ts'
import { createPostgresControlPlaneStore } from './postgres-control-plane-store.ts'
import { createNodeOpencodeCloudRuntimeAdapter } from './opencode-runtime-adapter.ts'
import type { CloudRuntimeAdapter, CloudRuntimeEvent } from './runtime-adapter.ts'
import { createCloudSecretAdapterFromEnv, type SecretAdapter } from './secret-adapter.ts'
import { createCloudSessionCookieManager, type CloudSessionCookieManager } from './session-cookie-auth.ts'
import { CloudSessionService, type CloudPrincipal } from './session-service.ts'
import { CloudScheduler } from './scheduler.ts'
import { CloudWorker } from './worker.ts'
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
  return {
    ...config.cloud.auth,
    mode,
    issuerUrl: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_ISSUER_URL') || config.cloud.auth.issuerUrl,
    clientId: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_ID') || config.cloud.auth.clientId,
    clientSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET_REF') || config.cloud.auth.clientSecretRef,
    callbackPath: envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CALLBACK_PATH') || config.cloud.auth.callbackPath,
    cookieSecretRef: envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET_REF') || config.cloud.auth.cookieSecretRef,
    allowedEmailDomains: parseCsv(envValue(env, 'OPEN_COWORK_CLOUD_ALLOWED_EMAIL_DOMAINS')) || config.cloud.auth.allowedEmailDomains,
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
  }
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
  })
}

function readHeader(req: IncomingMessage, name: string) {
  const value = req.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

export function createHeaderCloudAuthResolver(defaults: Partial<CloudPrincipal> = {}): CloudAuthResolver {
  return (req) => {
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
    return createHeaderCloudAuthResolver()
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
  env?: Env
}) {
  if (!shouldRunCloudWeb(input.role)) return
  if (input.auth.mode !== 'none') return
  if (isLoopbackCloudHost(input.hostname)) return
  if (parseBoolean(envValue(input.env || process.env, ALLOW_INSECURE_CLOUD_AUTH_ENV), false)) return
  throw new Error(
    `Cloud auth mode "none" may only bind to loopback addresses. Set cloud.auth.mode to "oidc" for public browser/JWT auth, "header" for a trusted reverse proxy, or set ${ALLOW_INSECURE_CLOUD_AUTH_ENV}=true for an explicit local/demo override.`,
  )
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
  const listenHostname = options.hostname || envOptions.hostname
  assertCloudAuthDeploymentSafe({
    role: policy.role,
    hostname: listenHostname,
    auth: authConfig,
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
  const byokSecrets = createByokSecretStore(store, secretAdapter)
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
      ? await (options.runtimeFactory || defaultCloudRuntimeFactory)({ paths, policy, env })
      : createUnavailableRuntimeAdapter()
  )
  const service = new CloudSessionService(store, runtime, policy, undefined, undefined, undefined, byokSecrets)
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
        checkpointStore
          ? {
              async restoreBeforeCommands(lease) {
                try {
                  await checkpointStore.restoreSessionCheckpoint({
                    tenantId: lease.tenantId,
                    sessionId: lease.sessionId,
                    roots: defaultCloudSessionCheckpointRoots(paths, lease.tenantId, lease.sessionId),
                  })
                } catch (error) {
                  if (!isMissingCheckpointError(error)) throw error
                }
              },
              async saveAfterCommand(lease) {
                await checkpointStore.saveSessionCheckpoint({
                  tenantId: lease.tenantId,
                  sessionId: lease.sessionId,
                  checkpointVersion: lease.checkpointVersion,
                  roots: defaultCloudSessionCheckpointRoots(paths, lease.tenantId, lease.sessionId),
                })
              },
            }
          : {},
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
