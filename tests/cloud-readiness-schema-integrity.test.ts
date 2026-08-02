import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore } from '@open-cowork/cloud-server/object-store'
import { CLOUD_CONTROL_PLANE_MIGRATIONS } from '@open-cowork/cloud-server/postgres-schema'
import { createPlaintextSecretAdapter } from '@open-cowork/cloud-server/secret-adapter'
import { createCloudReadinessCheck } from '../packages/cloud-server/src/readiness.ts'

test('cloud readiness does not trust current migration ledger rows without physical integrity', async () => {
  const store = new InMemoryControlPlaneStore()
  for (const migration of CLOUD_CONTROL_PLANE_MIGRATIONS) store.recordSchemaMigration(migration.id)
  let integrityChecks = 0
  store.assertSchemaIntegrity = () => {
    integrityChecks += 1
    throw new Error('required production tables are missing (cloud_sessions)')
  }
  const readiness = createCloudReadinessCheck({
    policy: { role: 'web' } as never,
    store,
    objectStore: createInMemoryObjectStore(),
    secretAdapter: createPlaintextSecretAdapter(),
    billingConfig: { enabled: false, provider: 'none' } as never,
    requireSchemaMigrations: false,
  })

  const report = await readiness()

  assert.equal(integrityChecks, 1)
  assert.equal(report.ok, false)
  const controlPlane = report.checks.find((entry) => entry.name === 'control_plane')
  assert.equal(controlPlane?.status, 'error')
  assert.match(controlPlane?.detail || '', /required production tables are missing/)
})

test('cloud readiness never exposes injected isolation provider or reason detail', async () => {
  const sentinel = 'synthetic-readiness-secret'
  const readiness = createCloudReadinessCheck({
    policy: { role: 'worker' } as never,
    store: new InMemoryControlPlaneStore(),
    objectStore: createInMemoryObjectStore(),
    secretAdapter: createPlaintextSecretAdapter(),
    billingConfig: { enabled: false, provider: 'none' } as never,
    executionIsolationPolicy: {
      required: true,
      mode: 'external-provider',
      deploymentTier: 'public_production',
      engine: null,
      opencodeCommand: null,
      imageComponentId: null,
      componentManifest: null,
      network: { kind: 'deny-all' },
      blockers: [],
      warning: null,
    },
    executionIsolationCapability: {
      provider: `external;\nsecret=${sentinel}`,
      available: false,
      verified: false,
      engine: 'external',
      processIsolation: 'external-boundary',
      userIsolation: 'external-identity',
      mountScope: 'execution',
      runtimeHomeScope: 'execution',
      descendantCleanup: 'provider-owned',
      networkPolicy: 'deny-all',
      reasonCode: `provider_failed_${sentinel};token=do-not-leak`,
    },
  })

  const report = await readiness()
  const isolation = report.checks.find((entry) => entry.name === 'execution_isolation')

  assert.equal(isolation?.status, 'error')
  assert.equal(
    isolation?.detail,
    'provider=invalid;engine=external;network=deny-all;verified=false;reason=isolation_capability_unavailable',
  )
  assert.equal(JSON.stringify(report).includes(sentinel), false)
})

test('direct upload readiness fails closed for every requested missing dependency', async () => {
  const base = {
    policy: { role: 'web' } as never,
    store: new InMemoryControlPlaneStore(),
    objectStore: createInMemoryObjectStore(),
    secretAdapter: createPlaintextSecretAdapter(),
    billingConfig: { enabled: false, provider: 'none' } as never,
  }
  for (const [artifactDirectUpload, expectedDetail] of [
    [{ requested: true, configStatus: 'invalid', durableStore: true, cleanupOwnerReady: true }, 'config_invalid'],
    [{ requested: true, configStatus: 'valid', durableStore: true, cleanupOwnerReady: true }, 'provider_unattested'],
    [{ requested: true, configStatus: 'valid', durableStore: false, cleanupOwnerReady: true }, 'provider_unattested'],
    [{ requested: true, configStatus: 'valid', durableStore: true, cleanupOwnerReady: false }, 'provider_unattested'],
  ] as const) {
    const report = await createCloudReadinessCheck({ ...base, artifactDirectUpload })()
    assert.equal(report.ok, false)
    assert.deepEqual(report.checks.find((entry) => entry.name === 'artifact_direct_upload'), {
      name: 'artifact_direct_upload',
      status: 'error',
      detail: expectedDetail,
    })
  }
})

test('direct upload readiness requires an attested provider, durable store, and cleanup owner', async () => {
  const objectStore = {
    ...createInMemoryObjectStore(),
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 1024,
      origin: 'https://objects.example.test',
      verifyCleanupSafety: async () => true,
      verifyBrowserPostSafety: async (origin: string) => origin === 'https://cloud.example.test',
      presignPost: async () => null,
      inspect: async () => null,
      promote: async () => undefined,
      delete: async () => undefined,
    },
  } as never
  const base = {
    policy: { role: 'web' } as never,
    store: new InMemoryControlPlaneStore(),
    objectStore,
    secretAdapter: createPlaintextSecretAdapter(),
    billingConfig: { enabled: false, provider: 'none' } as never,
    publicUrl: 'https://cloud.example.test',
  }
  for (const [durableStore, cleanupOwnerReady, expectedDetail] of [
    [false, true, 'durable_store_required'],
    [true, false, 'cleanup_owner_unavailable'],
    [true, true, 'enabled'],
  ] as const) {
    const report = await createCloudReadinessCheck({
      ...base,
      artifactDirectUpload: {
        requested: true,
        configStatus: 'valid',
        durableStore,
        cleanupOwnerReady: async () => cleanupOwnerReady,
      },
    })()
    const directUpload = report.checks.find((entry) => entry.name === 'artifact_direct_upload')
    assert.equal(directUpload?.detail, expectedDetail)
    assert.equal(directUpload?.status, expectedDetail === 'enabled' ? 'ok' : 'error')
  }
})
