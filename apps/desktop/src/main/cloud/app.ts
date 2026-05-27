import { resolve } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { DEFAULT_CONFIG, type OpenCoworkConfig } from '../config-types.ts'
import { CloudArtifactService } from './artifact-service.ts'
import {
  resolveCloudRuntimePolicy,
  type CloudRuntimePolicy,
} from './cloud-config.ts'
import { type ControlPlaneStore, InMemoryControlPlaneStore } from './control-plane-store.ts'
import {
  createCloudHttpServer,
  type CloudAuthResolver,
  type CloudBrowserAuthProvider,
  type CloudHttpServer,
} from './http-server.ts'
import {
  createCloudObservabilityFromEnv,
  type CloudObservabilityAdapter,
} from './observability.ts'
import { createObjectStoreForCloud, type ObjectStoreAdapter } from './object-store.ts'
import {
  createOidcBrowserAuthProvider,
  createOidcCloudAuthResolver,
  type OidcCloudAuthResolverOptions,
} from './oidc-auth.ts'
import { createCloudPathProvider, type PathProvider } from './path-provider.ts'
import { createPostgresControlPlaneStore } from './postgres-control-plane-store.ts'
import { createNodeOpencodeCloudRuntimeAdapter } from './opencode-runtime-adapter.ts'
import type { CloudRuntimeAdapter, CloudRuntimeEvent } from './runtime-adapter.ts'
import { createCloudSecretAdapterFromEnv } from './secret-adapter.ts'
import { createCloudSessionCookieManager, type CloudSessionCookieManager } from './session-cookie-auth.ts'
import { CloudScheduler, CloudSessionService, CloudWorker, type CloudPrincipal } from './session-service.ts'
import {
  createObjectWorkspaceCheckpointStore,
  defaultCloudSessionCheckpointRoots,
  type WorkspaceCheckpointStore,
} from './workspace-checkpoint-store.ts'

type Env = Record<string, string | undefined>

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

export function resolveCloudControlPlaneUrl(config: OpenCoworkConfig, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_CONTROL_PLANE_URL')
    || resolveEnvRef(config.cloud.storage.controlPlane.urlRef, env)
}

export function resolveCloudCookieSecret(config: OpenCoworkConfig, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_COOKIE_SECRET')
    || resolveEnvRef(config.cloud.auth.cookieSecretRef, env)
    || envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
}

export function resolveCloudOidcClientSecret(config: OpenCoworkConfig, env: Env = process.env) {
  return envValue(env, 'OPEN_COWORK_CLOUD_OIDC_CLIENT_SECRET')
    || resolveEnvRef(config.cloud.auth.clientSecretRef, env)
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
      tenantName: readHeader(req, 'x-open-cowork-tenant-name') || defaults.tenantName || tenantId,
      userId,
      email,
    }
  }
}

export function createCloudAuthResolverForConfig(
  config: OpenCoworkConfig,
  options: OidcCloudAuthResolverOptions = {},
): CloudAuthResolver {
  if (config.cloud.auth.mode === 'oidc') {
    return createOidcCloudAuthResolver(config.cloud.auth, options)
  }
  return createHeaderCloudAuthResolver()
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

function startWorkerLoop(worker: CloudWorker, pollMs: number) {
  let active = false
  const timer = setInterval(() => {
    if (active) return
    active = true
    void worker.processAllSessionCommands().finally(() => {
      active = false
    })
  }, pollMs)
  return () => clearInterval(timer)
}

function startSchedulerLoop(scheduler: CloudScheduler, pollMs: number) {
  let active = false
  const timer = setInterval(() => {
    if (active) return
    active = true
    void scheduler.processDueWorkflows().finally(() => {
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
  const hasObservabilityOverride = Object.prototype.hasOwnProperty.call(options, 'observability')
  const observability = hasObservabilityOverride
    ? options.observability || null
    : createCloudObservabilityFromEnv(env)
  const paths = options.paths || createCloudPathProvider(envOptions.root)
  const store = options.store || await (options.storeFactory || createControlPlaneStoreForCloud)({ config, env })
  const objectStore = options.objectStore || await (options.objectStoreFactory || createObjectStoreForCloud)({ config, env, paths })
  const checkpointsEnabled = options.checkpointsEnabled ?? envOptions.checkpointsEnabled
  const hasCheckpointStoreOverride = Object.prototype.hasOwnProperty.call(options, 'checkpointStore')
  const checkpointStore = shouldRunCloudWorker(policy.role)
    ? hasCheckpointStoreOverride
      ? options.checkpointStore || null
      : checkpointsEnabled
        ? createObjectWorkspaceCheckpointStore({
            objectStore,
            secretAdapter: await createCloudSecretAdapterFromEnv(env),
          })
        : null
    : null
  const runtime = options.runtime || (
    shouldRunCloudWorker(policy.role)
      ? await (options.runtimeFactory || defaultCloudRuntimeFactory)({ paths, policy, env })
      : createUnavailableRuntimeAdapter()
  )
  const service = new CloudSessionService(store, runtime, policy)
  const artifacts = new CloudArtifactService(service, objectStore)
  const hasSessionCookieOverride = Object.prototype.hasOwnProperty.call(options, 'sessionCookies')
  const cookieSecret = resolveCloudCookieSecret(config, env)
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
      : sessionCookies && cookieSecret && config.cloud.auth.mode === 'oidc'
        ? createOidcBrowserAuthProvider(config.cloud.auth, {
            clientSecret: resolveCloudOidcClientSecret(config, env),
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
        void routeRuntimeEvent(store, worker, event).catch(() => {})
      })
    : null
  const stopWorkerLoop = worker
    ? startWorkerLoop(worker, options.workerPollMs || envOptions.workerPollMs)
    : null
  const stopSchedulerLoop = scheduler
    ? startSchedulerLoop(scheduler, options.schedulerPollMs || envOptions.schedulerPollMs)
    : null

  const server = shouldRunCloudWeb(policy.role)
      ? createCloudHttpServer({
        service,
        artifacts,
        policy,
        worker,
        sessionCookies,
        observability,
        browserAuth,
        auth: options.auth || createCloudAuthResolverForConfig(config),
        autoProcessCommands: options.autoProcessCommands ?? (policy.role === 'all-in-one' && envOptions.autoProcessCommands),
        corsOrigin: options.corsOrigin ?? envOptions.corsOrigin,
      })
    : null
  const url = server
    ? await server.listen(options.port ?? envOptions.port, options.hostname || envOptions.hostname)
    : null

  return {
    policy,
    store,
    objectStore,
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
