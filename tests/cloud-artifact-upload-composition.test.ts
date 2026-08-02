import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createCloudArtifactUploadComposition } from '@open-cowork/cloud-server/artifact-upload-composition'
import { ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS } from '@open-cowork/cloud-server/artifact-upload-lifecycle'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createInMemoryObjectStore, type ObjectStoreAdapter } from '@open-cowork/cloud-server/object-store'
import type { CloudMetricRecord, CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import type { CloudSessionService } from '@open-cowork/cloud-server/session-service'

function durableStore() {
  const store = new InMemoryControlPlaneStore()
  Object.defineProperty(store, 'artifactUploadLifecycleCapability', {
    value: { persistence: 'durable', reconciliation: 'bounded-claims' },
  })
  return store
}

function attestedStore(input: {
  cleanupSafe?: () => boolean
  browserSafe?: (origin: string) => boolean
  deleteSafe?: () => boolean
  inspectSafe?: () => boolean
  promoteSafe?: () => boolean
  onPut?: (key: string) => void
  origin?: string
} = {}): ObjectStoreAdapter {
  const base = createInMemoryObjectStore()
  return {
    ...base,
    async putObject(value) {
      input.onPut?.(value.key)
      return base.putObject(value)
    },
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 1024,
      origin: input.origin || 'https://objects.example.test',
      verifyCleanupSafety: async () => input.cleanupSafe?.() ?? true,
      verifyBrowserPostSafety: async (origin) => input.browserSafe?.(origin) ?? origin === 'https://cloud.example.test',
      presignPost: async () => null,
      async inspect(key) {
        if (input.inspectSafe?.() === false) throw new Error('inspect denied')
        const object = await base.getObject(key)
        if (!object) return null
        const checksumSha256 = createHash('sha256').update(object.body).digest('hex')
        return {
          size: object.body.byteLength,
          contentType: object.contentType,
          checksumSha256,
          versionToken: `etag:${checksumSha256}`,
        }
      },
      async promote(value) {
        if (input.promoteSafe?.() === false) throw new Error('copy denied')
        const object = await base.getObject(value.stagingKey)
        if (!object) throw new Error('staging object missing')
        await base.putObject({
          key: value.finalKey,
          body: object.body,
          contentType: object.contentType,
        })
      },
      async delete(key) {
        if (input.deleteSafe?.() === false) throw new Error('delete denied')
        await base.deleteObject(key)
      },
    },
  }
}

class RecordingObservability implements CloudObservabilityAdapter {
  readonly metrics: CloudMetricRecord[] = []
  log() {}
  metric(record: CloudMetricRecord) { this.metrics.push(record) }
  span() {}
}

async function seedUploadReservation(input: {
  store: InMemoryControlPlaneStore
  createdAt: Date
  expiresAt: Date
  stagingObjectKey?: string
  finalObjectKey?: string
}) {
  await input.store.createTenant({ tenantId: 'tenant-1', name: 'Tenant' })
  await input.store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test' })
  const org = await input.store.ensureOrgForTenant({ tenantId: 'tenant-1', orgId: 'org-1', name: 'Org' })
  await input.store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    opencodeSessionId: 'runtime-1',
    profileName: 'default',
  })
  const stagingObjectKey = input.stagingObjectKey || 'staging/upload-1'
  const finalObjectKey = input.finalObjectKey || 'final/upload-1'
  const body = Buffer.from('0123456789')
  const checksumSha256 = createHash('sha256').update(body).digest('hex')
  const created = await input.store.createArtifactUploadReservation({
    orgId: org.orgId,
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    artifactId: 'upload-1',
    objectKey: finalObjectKey,
    stagingObjectKey,
    finalObjectKey,
    filename: 'report.txt',
    contentType: 'text/plain',
    checksumSha256,
    publication: {
      kind: 'document',
      artifactStatus: 'draft',
      authorAgentId: null,
      projectId: null,
      taskId: null,
      statusUpdatedBy: null,
      statusUpdatedAt: null,
    },
    reservedBytes: body.byteLength,
    expiresAt: input.expiresAt,
    quota: {
      orgId: org.orgId,
      quotaKey: 'artifact-bytes',
      limit: 100,
      quantity: body.byteLength,
      windowMs: 86_400_000,
      now: input.createdAt,
    },
    createdAt: input.createdAt,
  })
  assert.ok(created.reservation)
  return { body, checksumSha256, org, reservation: created.reservation }
}

test('artifact upload composition defaults issuance off but still drains durable lifecycle work', async () => {
  const store = durableStore()
  let statsReads = 0
  const originalStats = store.getArtifactUploadReconciliationStats.bind(store)
  store.getArtifactUploadReconciliationStats = (now) => {
    statsReads += 1
    return originalStats(now)
  }
  const composition = createCloudArtifactUploadComposition({
    env: { OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test' },
    service: {} as CloudSessionService,
    store,
    objectStore: attestedStore(),
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
  })

  await composition.reconcile()

  assert.equal(composition.config.mode, 'off')
  assert.equal(await composition.cleanupOwnerReady(), false)
  assert.equal(statsReads, 1)
  assert.equal(await composition.artifacts.presignedUploadOrigin(), null)
})

test('default-off startup with no backlog never probes a failing direct-upload provider', async () => {
  let providerProbeCalls = 0
  const composition = createCloudArtifactUploadComposition({
    env: { OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test' },
    service: {} as CloudSessionService,
    store: durableStore(),
    objectStore: attestedStore({
      cleanupSafe: () => {
        providerProbeCalls += 1
        throw new Error('provider unavailable')
      },
      browserSafe: () => {
        providerProbeCalls += 1
        throw new Error('provider unavailable')
      },
    }),
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
  })

  await composition.reconcile()

  assert.equal(composition.config.mode, 'off')
  assert.equal(providerProbeCalls, 0)
  assert.equal(await composition.cleanupOwnerReady(), false)
})

test('scheduler prunes only seven-day terminal reservations in a bounded daily pass', async () => {
  const now = new Date('2026-08-10T12:00:00.000Z')
  const store = durableStore()
  const pruneCalls: Array<{ olderThan: Date, limit: number }> = []
  store.pruneArtifactUploadReservations = (input) => {
    pruneCalls.push(input)
    return 3
  }
  const observability = new RecordingObservability()
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_INTERVAL_MS: '86400000',
    },
    service: {} as CloudSessionService,
    store,
    objectStore: attestedStore(),
    observability,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })

  await composition.reconcile(now)
  now.setTime(now.getTime() + 60 * 60_000)
  await composition.reconcile(now)
  now.setTime(now.getTime() + 24 * 60 * 60_000)
  await composition.reconcile(now)

  assert.equal(pruneCalls.length, 2)
  assert.equal(pruneCalls[0]?.olderThan.toISOString(), '2026-08-03T12:00:00.000Z')
  assert.equal(pruneCalls[0]?.limit, composition.config.cleanupBatchSize)
  assert.deepEqual(
    observability.metrics
      .filter((metric) => metric.name === 'open_cowork_cloud_artifact_upload_reservations_pruned_total')
      .map((metric) => metric.value),
    [3, 3],
  )
})

test('artifact upload composition runs one bounded startup sweep and exposes cleanup gauges', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const observability = new RecordingObservability()
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_BATCH_SIZE: '7',
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_INTERVAL_MS: '60000',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store: durableStore(),
    objectStore: attestedStore(),
    observability,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })

  await composition.reconcile(now)
  await composition.reconcile(new Date(now.getTime() + 1_000))

  assert.equal(await composition.cleanupOwnerReady(), true)
  assert.equal(await composition.artifacts.presignedUploadOrigin(), 'https://objects.example.test')
  assert.equal(
    observability.metrics.filter((metric) => metric.name === 'open_cowork_cloud_artifact_upload_reconciliation_total').length,
    1,
  )
  assert.equal(
    observability.metrics.some((metric) => metric.name === 'open_cowork_cloud_artifact_upload_cleanup_oldest_age_ms'),
    true,
  )
})

test('web upload composition requires a fresh matching provider cleanup attestation', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const store = durableStore()
  const objectStore = attestedStore()
  const headObject = objectStore.headObject.bind(objectStore)
  let markerHeadReads = 0
  objectStore.headObject = async (key) => {
    if (key.startsWith('health/artifact-upload-cleanup/') && !key.includes('-probe/')) {
      markerHeadReads += 1
    }
    return headObject(key)
  }
  const env = {
    OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
    OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_INTERVAL_MS: '86400000',
    OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test/',
  }
  const scheduler = createCloudArtifactUploadComposition({
    env: { ...env, OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test' },
    service: {} as CloudSessionService,
    store,
    objectStore,
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })
  const web = createCloudArtifactUploadComposition({
    env,
    service: {} as CloudSessionService,
    store,
    objectStore,
    observability: null,
    claimOwner: 'web-1',
    schedulerOwner: false,
    now: () => now,
  })

  assert.equal(await web.cleanupOwnerReady(), false)
  assert.equal(markerHeadReads, 1)
  await scheduler.reconcile(now)
  assert.equal(await web.cleanupOwnerReady(), true)
  assert.equal(await web.artifacts.presignedUploadOrigin(), 'https://objects.example.test')
  assert.equal(await web.cleanupOwnerReady(), true)
  assert.equal(markerHeadReads, 2)

  now.setTime(now.getTime() + 31_000)
  assert.equal(await web.cleanupOwnerReady(), false)
  assert.equal(markerHeadReads, 3)
  await scheduler.reconcile(now)
  assert.equal(await web.cleanupOwnerReady(), true)
  assert.equal(markerHeadReads, 4)

  const mismatchedWeb = createCloudArtifactUploadComposition({
    env: {
      ...env,
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_BATCH_SIZE: '99',
    },
    service: {} as CloudSessionService,
    store,
    objectStore,
    observability: null,
    claimOwner: 'web-mismatched',
    schedulerOwner: false,
    now: () => now,
  })
  assert.equal(await mismatchedWeb.cleanupOwnerReady(), false)
})

test('scheduler refreshes cleanup-owner attestation only near expiry and fails closed on refresh error', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  let markerWrites = 0
  let failMarkerWrite = false
  const objectStore = attestedStore()
  const putObject = objectStore.putObject.bind(objectStore)
  objectStore.putObject = async (input) => {
    if (input.key.startsWith('health/artifact-upload-cleanup/') && !input.key.includes('-probe/')) {
      markerWrites += 1
      if (failMarkerWrite) throw new Error('attestation write unavailable')
    }
    return putObject(input)
  }
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store: durableStore(),
    objectStore,
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })

  await composition.reconcile(now)
  assert.equal(markerWrites, 1)
  now.setTime(now.getTime() + 19_999)
  await composition.reconcile(now)
  assert.equal(markerWrites, 1)
  now.setTime(now.getTime() + 1)
  await composition.reconcile(now)
  assert.equal(markerWrites, 2)

  failMarkerWrite = true
  now.setTime(now.getTime() + 20_000)
  await composition.reconcile(now)
  assert.equal(markerWrites, 3)
  assert.equal(await composition.cleanupOwnerReady(), false)
})

test('web cleanup attestation lookup fails closed within a bounded timeout', async () => {
  const objectStore = attestedStore()
  objectStore.headObject = async () => new Promise(() => {})
  const web = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store: durableStore(),
    objectStore,
    observability: null,
    claimOwner: 'web-1',
    schedulerOwner: false,
  })

  const startedAt = Date.now()
  assert.equal(await web.cleanupOwnerReady(), false)
  assert.ok(Date.now() - startedAt < 750, 'attestation lookup must not stall web readiness')
})

test('cleanup safety drift fences reconciliation and upload readiness until re-attested', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  let cleanupSafe = true
  const store = durableStore()
  let reconciliationClaims = 0
  const originalClaim = store.claimArtifactUploadReconciliation.bind(store)
  store.claimArtifactUploadReconciliation = (input) => {
    reconciliationClaims += 1
    return originalClaim(input)
  }
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store,
    objectStore: attestedStore({ cleanupSafe: () => cleanupSafe }),
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })

  await composition.reconcile(now)
  assert.equal(reconciliationClaims, 1)
  assert.equal(await composition.cleanupOwnerReady(), true)

  cleanupSafe = false
  now.setTime(now.getTime() + 31_000)
  await composition.reconcile(now)
  assert.equal(reconciliationClaims, 1)
  assert.equal(await composition.cleanupOwnerReady(), false)

  cleanupSafe = true
  await composition.reconcile(now)
  assert.equal(reconciliationClaims, 2)
  assert.equal(await composition.cleanupOwnerReady(), true)
})

test('cleanup-owner attestation fails closed when provider delete permission is missing', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store: durableStore(),
    objectStore: attestedStore({ deleteSafe: () => false }),
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })

  await composition.reconcile(now)

  assert.equal(await composition.cleanupOwnerReady(), false)
  assert.equal(await composition.artifacts.presignedUploadOrigin(), null)
})

for (const [permission, providerOptions] of [
  ['inspect', { inspectSafe: () => false }],
  ['copy', { promoteSafe: () => false }],
] as const) {
  test(`cleanup-owner attestation fails closed without provider ${permission} permission and removes probes`, async () => {
    const now = new Date('2026-08-02T12:00:00.000Z')
    const probeKeys: string[] = []
    const objectStore = attestedStore({ ...providerOptions, onPut: (key) => probeKeys.push(key) })
    const composition = createCloudArtifactUploadComposition({
      env: {
        OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
        OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
      },
      service: {} as CloudSessionService,
      store: durableStore(),
      objectStore,
      observability: null,
      claimOwner: 'scheduler-1',
      schedulerOwner: true,
      now: () => now,
    })

    await composition.reconcile(now)

    assert.equal(await composition.cleanupOwnerReady(), false)
    assert.equal(await composition.artifacts.presignedUploadOrigin(), null)
    const writtenProbeKeys = probeKeys.filter((key) => key.includes('-probe/'))
    assert.ok(writtenProbeKeys.length > 0)
    for (const key of writtenProbeKeys) assert.equal(await objectStore.headObject(key), null)
  })
}

test('https browser deployments reject a mixed-content direct-upload provider origin', async () => {
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store: durableStore(),
    objectStore: attestedStore({ origin: 'http://objects.example.test' }),
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
  })

  await composition.reconcile()

  assert.equal(composition.providerAttested, false)
  assert.equal(await composition.artifacts.presignedUploadOrigin(), null)
})

test('removing browser signing capability does not strand an existing direct-upload reservation', async () => {
  const now = new Date('2026-08-02T12:15:00.000Z')
  const store = durableStore()
  const objectStore = attestedStore()
  objectStore.directUploadLifecycle = objectStore.presignedUpload
  delete objectStore.presignedUpload
  const seeded = await seedUploadReservation({
    store,
    createdAt: new Date('2026-08-02T12:00:00.000Z'),
    expiresAt: new Date('2026-08-02T12:14:00.000Z'),
  })
  await objectStore.putObject({
    key: seeded.reservation!.stagingObjectKey,
    body: seeded.body,
    contentType: 'text/plain',
  })
  let published = false
  let publicationCalls = 0
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_MODE: 'enabled',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {
      async publishFinalizedArtifactUpload() {
        publicationCalls += 1
        published = true
        return {} as never
      },
      async isFinalizedArtifactUploadPublished() { return published },
    } as CloudSessionService,
    store,
    objectStore,
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })

  assert.equal(composition.providerAttested, false)
  assert.equal(await composition.artifacts.presignedUploadOrigin(), null)
  await composition.reconcile(now)

  const identity = {
    orgId: seeded.org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'upload-1',
  }
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'finalized')
  assert.equal(publicationCalls, 1)
  assert.ok(await objectStore.headObject(seeded.reservation!.finalObjectKey))
  assert.equal(
    (await store.listUsageQuotaCounters(seeded.org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    seeded.body.byteLength,
  )
})

test('legacy adapters without a lifecycle port wait for expiry and refund quota after two cleanup passes', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const expiresAt = new Date('2026-08-02T12:15:00.000Z')
  const store = durableStore()
  const objectStore = createInMemoryObjectStore()
  let deleteCalls = 0
  const deleteObject = objectStore.deleteObject.bind(objectStore)
  objectStore.deleteObject = async (key) => {
    deleteCalls += 1
    await deleteObject(key)
  }
  const seeded = await seedUploadReservation({
    store,
    createdAt: now,
    expiresAt,
    stagingObjectKey: 'legacy/upload-1',
    finalObjectKey: 'legacy/upload-1',
  })
  await objectStore.putObject({
    key: seeded.reservation!.stagingObjectKey,
    body: seeded.body,
    contentType: 'text/plain',
  })
  await store.requestArtifactUploadCleanup({
    orgId: seeded.org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'upload-1',
    reason: 'failed',
    claimOwner: 'migration',
    claimToken: 'migration-cleanup',
    claimTtlMs: 30_000,
    cleanupNotBefore: expiresAt,
    now,
  })
  const composition = createCloudArtifactUploadComposition({
    env: {
      OPEN_COWORK_CLOUD_ARTIFACT_DIRECT_UPLOAD_CLEANUP_INTERVAL_MS: '1',
      OPEN_COWORK_CLOUD_PUBLIC_URL: 'https://cloud.example.test',
    },
    service: {} as CloudSessionService,
    store,
    objectStore,
    observability: null,
    claimOwner: 'scheduler-1',
    schedulerOwner: true,
    now: () => now,
  })
  const identity = {
    orgId: seeded.org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'upload-1',
  }

  await composition.reconcile(now)
  assert.equal(deleteCalls, 0)
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'cleanup_pending')
  assert.equal(
    (await store.listUsageQuotaCounters(seeded.org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    seeded.body.byteLength,
  )

  now.setTime(expiresAt.getTime())
  await composition.reconcile(now)
  assert.equal(deleteCalls, 1)
  assert.equal((await store.getArtifactUploadReservation(identity))?.cleanupPasses, 1)
  assert.equal(
    (await store.listUsageQuotaCounters(seeded.org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    seeded.body.byteLength,
  )

  now.setTime(expiresAt.getTime() + ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS)
  await composition.reconcile(now)
  assert.equal(deleteCalls, 2)
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'cleaned')
  assert.equal(
    (await store.listUsageQuotaCounters(seeded.org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    0,
  )
})
