import { randomUUID } from 'node:crypto'
import { sanitizeForExport, type CloudAuthConfig, type CloudBillingConfig } from '@open-cowork/shared'
import type { BillingAdapter } from './billing-adapter.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import type { ObjectStoreAdapter } from './object-store.ts'
import { CLOUD_CONTROL_PLANE_MIGRATIONS } from './postgres-schema.ts'
import type { SecretAdapter } from './secret-adapter.ts'
import { isNonPublicCloudHost } from './cloud-host-policy.ts'
import {
  evaluateCloudExecutionIsolationCapability,
  type CloudExecutionIsolationCapability,
  type CloudExecutionIsolationPolicy,
} from './execution-isolation.ts'

type CloudReadinessCheckStatus = 'ok' | 'error'

export type CloudReadinessCheckResult = {
  name: string
  status: CloudReadinessCheckStatus
  detail?: string
}

export type CloudReadinessReport = {
  ok: boolean
  role: CloudRuntimePolicy['role']
  profileName?: string
  checks: CloudReadinessCheckResult[]
}

export type CloudReadinessOptions = {
  policy: CloudRuntimePolicy
  store: ControlPlaneStore
  objectStore: ObjectStoreAdapter
  secretAdapter: SecretAdapter
  billingConfig: CloudBillingConfig
  billingAdapter?: BillingAdapter | null
  authConfig?: CloudAuthConfig | null
  deploymentTier?: 'local' | 'self_host_beta' | 'private_beta' | 'public_production'
  publicUrl?: string | null
  cookieSecure?: boolean
  sessionCookiesConfigured?: boolean
  browserAuthConfigured?: boolean
  checkpointsEnabled?: boolean
  checkpointStoreConfigured?: boolean
  executionIsolationPolicy?: CloudExecutionIsolationPolicy
  executionIsolationCapability?:
    | CloudExecutionIsolationCapability
    | (() => Promise<CloudExecutionIsolationCapability> | CloudExecutionIsolationCapability)
  requireSchemaMigrations?: boolean
  now?: () => Date
  objectStoreCheckTtlMs?: number
  artifactDirectUpload?: {
    requested: boolean
    configStatus: 'valid' | 'invalid'
    durableStore: boolean
    cleanupOwnerReady: boolean | (() => boolean | Promise<boolean>)
  }
}

type CachedCheck = {
  expiresAt: number
  result: CloudReadinessCheckResult
}

const DEFAULT_OBJECT_STORE_CHECK_TTL_MS = 30_000
const READINESS_SECRET_CONTEXT = 'cloud:readiness'
const READINESS_OBJECT_PREFIX = 'health/readiness'
const READINESS_DETAIL_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

function readinessDetailToken(value: unknown, fallback: string) {
  return typeof value === 'string' && READINESS_DETAIL_TOKEN_PATTERN.test(value)
    ? value
    : fallback
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function check(name: string, fn: () => Promise<void> | void): Promise<CloudReadinessCheckResult> {
  try {
    await fn()
    return { name, status: 'ok' }
  } catch (error) {
    // /readyz is unauthenticated (orchestrator probes it), and these checks throw raw
    // object-store / pg / secret-adapter errors that can echo access-key ids, secret
    // refs, vault URLs, or connection strings. Strip secrets + home paths before the
    // detail enters the public report.
    return { name, status: 'error', detail: sanitizeForExport(errorDetail(error)).slice(0, 512) }
  }
}

async function checkControlPlaneStore(store: ControlPlaneStore, requireSchemaMigrations: boolean) {
  const migrations = await store.listSchemaMigrations()
  if (requireSchemaMigrations) {
    const applied = new Set(migrations.map((migration) => migration.id))
    const missing = CLOUD_CONTROL_PLANE_MIGRATIONS
      .map((migration) => migration.id)
      .filter((id) => !applied.has(id))
    if (missing.length > 0) {
      throw new Error(`Missing cloud control-plane migrations: ${missing.join(', ')}.`)
    }
  }
  if (store.assertSchemaIntegrity) {
    await store.assertSchemaIntegrity()
  } else if (requireSchemaMigrations) {
    throw new Error('Cloud control-plane store does not expose physical schema integrity validation.')
  }
}

async function checkObjectStore(objectStore: ObjectStoreAdapter, now: Date) {
  if (objectStore.kind === 'unavailable') {
    throw new Error('Cloud object store is unavailable.')
  }
  const key = `${READINESS_OBJECT_PREFIX}/${now.toISOString().slice(0, 10)}/${randomUUID()}.txt`
  await objectStore.putObject({
    key,
    body: 'ok',
    contentType: 'text/plain',
    metadata: { purpose: 'readiness' },
  })
  const head = await objectStore.headObject(key)
  if (!head || head.size !== 2) {
    throw new Error('Cloud object store readiness object was not readable after write.')
  }
  await objectStore.deleteObject(key)
}

function checkSecretAdapter(secretAdapter: SecretAdapter) {
  if (secretAdapter.mode === 'unavailable') {
    throw new Error('Cloud secret adapter is unavailable.')
  }
  const stored = secretAdapter.protect('ok', READINESS_SECRET_CONTEXT)
  const revealed = secretAdapter.reveal(stored, READINESS_SECRET_CONTEXT)
  if (revealed !== 'ok') {
    throw new Error('Cloud secret adapter failed round-trip encryption check.')
  }
}

function checkBillingAdapter(config: CloudBillingConfig, adapter: BillingAdapter | null | undefined) {
  if (!config.enabled || config.provider === 'none') return
  if (!adapter || !adapter.enabled) {
    throw new Error(`Cloud billing provider "${config.provider}" is enabled but no ready adapter is configured.`)
  }
  if (adapter.providerId !== config.provider) {
    throw new Error(`Cloud billing adapter provider "${adapter.providerId}" does not match configured provider "${config.provider}".`)
  }
}

function assertPublicHttpsOrigin(value: string | null | undefined) {
  const raw = value?.trim()
  if (!raw) throw new Error('Public production readiness requires a configured public URL.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Public URL is not a valid origin.')
  }
  if (url.protocol !== 'https:' || isNonPublicCloudHost(url.hostname) || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Public production readiness requires an HTTPS publicly routable origin.')
  }
}

function checkAuthConfig(options: CloudReadinessOptions) {
  const auth = options.authConfig
  if (!auth) return
  const isPublicProduction = options.deploymentTier === 'public_production'
  if (isPublicProduction) {
    assertPublicHttpsOrigin(options.publicUrl)
    if (auth.mode === 'none') throw new Error('Public production readiness requires authenticated access.')
  }
  if (auth.mode === 'header') {
    if (!auth.headerSecret?.trim() && !auth.headerSecretRef?.trim()) {
      throw new Error('Trusted-header auth readiness requires a header auth secret or secret ref.')
    }
    if (isPublicProduction && auth.headerAllowUnsigned) {
      throw new Error('Public production trusted-header readiness requires signed identity headers.')
    }
  }
  if (auth.mode === 'oidc') {
    if (!auth.issuerUrl?.trim() || !auth.clientId?.trim()) {
      throw new Error('OIDC readiness requires issuer URL and client ID.')
    }
    if (!options.sessionCookiesConfigured) {
      throw new Error('OIDC readiness requires signed browser session cookies.')
    }
    if (!options.browserAuthConfigured) {
      throw new Error('OIDC readiness requires a browser auth provider.')
    }
  }
  if (isPublicProduction && options.cookieSecure === false) {
    throw new Error('Public production readiness requires Secure browser cookies.')
  }
}

function checkRoleDependencies(options: CloudReadinessOptions) {
  if (options.deploymentTier !== 'public_production') return
  if ((options.policy.role === 'worker' || options.policy.role === 'all-in-one') && !options.checkpointsEnabled) {
    throw new Error('Public production worker readiness requires checkpoints to be enabled.')
  }
  if ((options.policy.role === 'worker' || options.policy.role === 'all-in-one') && !options.checkpointStoreConfigured) {
    throw new Error('Public production worker readiness requires a checkpoint store.')
  }
}

async function checkArtifactDirectUpload(options: CloudReadinessOptions): Promise<CloudReadinessCheckResult | null> {
  const direct = options.artifactDirectUpload
  if (!direct) return null
  if (!direct.requested) {
    return { name: 'artifact_direct_upload', status: 'ok', detail: 'disabled' }
  }
  if (direct.configStatus !== 'valid') {
    return { name: 'artifact_direct_upload', status: 'error', detail: 'config_invalid' }
  }
  const capability = options.objectStore.presignedUpload as unknown as {
    enforcement?: unknown
    maxBytes?: unknown
    origin?: unknown
    verifyCleanupSafety?: unknown
    verifyBrowserPostSafety?: unknown
    presignPost?: unknown
    inspect?: unknown
    promote?: unknown
    delete?: unknown
  } | undefined
  if (
    capability?.enforcement !== 'exact-content-length'
    || !Number.isSafeInteger(capability.maxBytes)
    || Number(capability.maxBytes) <= 0
    || typeof capability.origin !== 'string'
    || typeof capability.verifyCleanupSafety !== 'function'
    || typeof capability.verifyBrowserPostSafety !== 'function'
    || typeof capability.presignPost !== 'function'
    || typeof capability.inspect !== 'function'
    || typeof capability.promote !== 'function'
    || typeof capability.delete !== 'function'
  ) {
    return { name: 'artifact_direct_upload', status: 'error', detail: 'provider_unattested' }
  }
  let browserOrigin: string | null = null
  let providerOrigin: string | null = null
  try {
    const parsed = new URL(options.publicUrl || '')
    browserOrigin = parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
      ? parsed.origin
      : null
  } catch {
    // Invalid public URLs remain unattested.
  }
  try {
    const parsed = new URL(String(capability.origin))
    providerOrigin = parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password
      ? parsed.origin
      : null
  } catch {
    // Invalid provider URLs remain unattested.
  }
  if (!browserOrigin || !providerOrigin || (browserOrigin.startsWith('https:') && !providerOrigin.startsWith('https:'))) {
    return { name: 'artifact_direct_upload', status: 'error', detail: 'provider_unattested' }
  }
  if (!direct.durableStore) {
    return { name: 'artifact_direct_upload', status: 'error', detail: 'durable_store_required' }
  }
  const cleanupOwnerReady = typeof direct.cleanupOwnerReady === 'function'
    ? await direct.cleanupOwnerReady()
    : direct.cleanupOwnerReady
  if (!cleanupOwnerReady) {
    return { name: 'artifact_direct_upload', status: 'error', detail: 'cleanup_owner_unavailable' }
  }
  return { name: 'artifact_direct_upload', status: 'ok', detail: 'enabled' }
}

async function checkExecutionIsolation(options: CloudReadinessOptions): Promise<CloudReadinessCheckResult> {
  const policy = options.executionIsolationPolicy
  const capability = typeof options.executionIsolationCapability === 'function'
    ? await options.executionIsolationCapability()
    : options.executionIsolationCapability
  if (!policy || !capability) {
    return {
      name: 'execution_isolation',
      status: policy?.required ? 'error' : 'ok',
      detail: policy?.required ? 'reason=isolation_capability_missing' : 'not_applicable',
    }
  }
  const verdict = evaluateCloudExecutionIsolationCapability(policy, capability)
  const provider = readinessDetailToken(capability.provider, 'invalid')
  const engine = readinessDetailToken(capability.engine, 'unverified')
  const networkPolicy = readinessDetailToken(capability.networkPolicy, 'unverified')
  const reasonCode = readinessDetailToken(
    verdict.blockers[0] || capability.reasonCode,
    'isolation_capability_unavailable',
  )
  const summary = [
    `provider=${provider}`,
    `engine=${engine}`,
    `network=${networkPolicy}`,
    `verified=${capability.verified === true}`,
  ].join(';')
  return {
    name: 'execution_isolation',
    status: verdict.ok ? 'ok' : 'error',
    detail: verdict.ok
      ? summary
      : `${summary};reason=${reasonCode}`,
  }
}

export function createCloudReadinessCheck(options: CloudReadinessOptions) {
  let cachedObjectStore: CachedCheck | null = null
  const objectStoreCheckTtlMs = options.objectStoreCheckTtlMs ?? DEFAULT_OBJECT_STORE_CHECK_TTL_MS

  return async (): Promise<CloudReadinessReport> => {
    const now = options.now?.() || new Date()
    const checks: CloudReadinessCheckResult[] = []

    checks.push(await check('control_plane', () => (
      checkControlPlaneStore(options.store, Boolean(options.requireSchemaMigrations))
    )))

    if (cachedObjectStore && cachedObjectStore.expiresAt > now.getTime()) {
      checks.push(cachedObjectStore.result)
    } else {
      const result = await check('object_store', () => checkObjectStore(options.objectStore, now))
      cachedObjectStore = {
        expiresAt: now.getTime() + objectStoreCheckTtlMs,
        result,
      }
      checks.push(result)
    }

    checks.push(await check('secret_adapter', () => checkSecretAdapter(options.secretAdapter)))
    checks.push(await check('billing_adapter', () => checkBillingAdapter(options.billingConfig, options.billingAdapter)))
    checks.push(await check('auth_config', () => checkAuthConfig(options)))
    checks.push(await check('role_dependencies', () => checkRoleDependencies(options)))
    checks.push(await checkExecutionIsolation(options))
    const directUpload = await checkArtifactDirectUpload(options)
    if (directUpload) checks.push(directUpload)

    return {
      ok: checks.every((entry) => entry.status === 'ok'),
      role: options.policy.role,
      profileName: options.policy.profileName,
      checks,
    }
  }
}
