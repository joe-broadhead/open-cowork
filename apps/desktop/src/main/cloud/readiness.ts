import { randomUUID } from 'node:crypto'
import type { CloudBillingConfig } from '../config-types.ts'
import type { BillingAdapter } from './billing-adapter.ts'
import type { CloudRuntimePolicy } from './cloud-config.ts'
import type { ControlPlaneStore } from './control-plane-store.ts'
import type { ObjectStoreAdapter } from './object-store.ts'
import { CLOUD_CONTROL_PLANE_MIGRATIONS } from './postgres-schema.ts'
import type { SecretAdapter } from './secret-adapter.ts'

export type CloudReadinessCheckStatus = 'ok' | 'error'

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
  requireSchemaMigrations?: boolean
  now?: () => Date
  objectStoreCheckTtlMs?: number
}

type CachedCheck = {
  expiresAt: number
  result: CloudReadinessCheckResult
}

const DEFAULT_OBJECT_STORE_CHECK_TTL_MS = 30_000
const READINESS_SECRET_CONTEXT = 'cloud:readiness'
const READINESS_OBJECT_PREFIX = 'health/readiness'

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

async function check(name: string, fn: () => Promise<void> | void): Promise<CloudReadinessCheckResult> {
  try {
    await fn()
    return { name, status: 'ok' }
  } catch (error) {
    return { name, status: 'error', detail: errorDetail(error).slice(0, 512) }
  }
}

async function checkControlPlaneStore(store: ControlPlaneStore, requireSchemaMigrations: boolean) {
  const migrations = await store.listSchemaMigrations()
  if (!requireSchemaMigrations) return
  const applied = new Set(migrations.map((migration) => migration.id))
  const missing = CLOUD_CONTROL_PLANE_MIGRATIONS
    .map((migration) => migration.id)
    .filter((id) => !applied.has(id))
  if (missing.length > 0) {
    throw new Error(`Missing cloud control-plane migrations: ${missing.join(', ')}.`)
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

    return {
      ok: checks.every((entry) => entry.status === 'ok'),
      role: options.policy.role,
      profileName: options.policy.profileName,
      checks,
    }
  }
}
