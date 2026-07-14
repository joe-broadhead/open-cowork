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
