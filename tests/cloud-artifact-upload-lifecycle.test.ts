import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { CloudArtifactIndexService } from '../packages/cloud-server/src/services/artifact-index-service.ts'
import {
  ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS,
  ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS,
  ArtifactUploadLifecycle,
  type ArtifactUploadProviderPort,
} from '../packages/cloud-server/src/artifact-upload-lifecycle.ts'

const NOW = new Date('2026-08-02T12:00:00.000Z')
const CHECKSUM = 'a'.repeat(64)

async function createFixture(providerOverride?: ArtifactUploadProviderPort) {
  const store = new InMemoryControlPlaneStore()
  await store.createTenant({ tenantId: 'tenant-1', name: 'Tenant' })
  await store.ensureUser({ tenantId: 'tenant-1', userId: 'user-1', email: 'user@example.test' })
  const org = await store.ensureOrgForTenant({ tenantId: 'tenant-1', orgId: 'org-1', name: 'Org' })
  await store.createSession({
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    opencodeSessionId: 'runtime-1',
    profileName: 'default',
  })
  const provider: ArtifactUploadProviderPort = providerOverride || {
    async inspect() { return null },
    async promote() {},
    async delete() {},
  }
  let claimSequence = 0
  return {
    store,
    org,
    lifecycle: new ArtifactUploadLifecycle({
      store,
      provider,
      now: () => new Date(NOW),
      ids: { randomUUID: () => `claim-${++claimSequence}` },
    }),
  }
}

function reservationInput(orgId: string) {
  return {
    orgId,
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    objectKey: 'final/client-upload-1',
    stagingObjectKey: 'staging/client-upload-1',
    finalObjectKey: 'final/client-upload-1',
    filename: 'report.txt',
    contentType: 'text/plain',
    checksumSha256: CHECKSUM,
    publication: {
      kind: 'document',
      artifactStatus: 'in-review',
      authorAgentId: 'agent-writer',
      projectId: 'project-1',
      taskId: 'task-1',
      statusUpdatedBy: 'user-1',
      statusUpdatedAt: '2026-08-02T11:59:00.000Z',
    },
    reservedBytes: 10,
    expiresAt: '2026-08-02T12:15:00.000Z',
    quota: {
      orgId,
      quotaKey: 'artifact-bytes',
      limit: 100,
      quantity: 10,
      windowMs: 86_400_000,
      now: NOW,
    },
    createdAt: NOW,
  } as const
}

test('artifact upload reserve is idempotent by client upload id and charges quota once', async () => {
  const { store, org } = await createFixture()
  const input = reservationInput(org.orgId)

  const first = await store.createArtifactUploadReservation(input)
  const replay = await store.createArtifactUploadReservation({
    ...input,
    expiresAt: '2026-08-02T12:15:01.000Z',
  })

  assert.equal(first.reservation?.status, 'reserved')
  assert.equal(first.reservation?.checksumSha256, CHECKSUM)
  assert.equal(first.reservation?.stagingObjectKey, 'staging/client-upload-1')
  assert.deepEqual(first.reservation?.publication, input.publication)
  assert.equal(replay.reservation?.artifactId, first.reservation?.artifactId)
  assert.equal(replay.reservation?.expiresAt, '2026-08-02T12:15:00.000Z')
  assert.equal(replay.quota, null)
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )

  await assert.rejects(
    async () => store.createArtifactUploadReservation({ ...input, checksumSha256: 'b'.repeat(64) }),
    /idempotency key conflicts/i,
  )
  await assert.rejects(
    async () => store.createArtifactUploadReservation({
      ...input,
      publication: { ...input.publication, artifactStatus: 'final' },
    }),
    /idempotency key conflicts/i,
  )
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )
})

test('finalize retry repairs publication after a usage-boundary crash exactly once', async () => {
  const { store, org } = await createFixture()
  const created = await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const reservation = created.reservation
  assert.ok(reservation)
  const projectedEvents = new Map<string, unknown>()
  const usageEvents = new Map<string, unknown>()
  let failUsageOnce = true
  const publication = new CloudArtifactIndexService({
    store,
    async ensurePrincipal() {},
    async assertSessionRead() {},
    async appendProjectedEvent(input) {
      projectedEvents.set(input.eventId, input)
    },
    async recordUsage(input) {
      if (failUsageOnce) {
        failUsageOnce = false
        throw new Error('injected usage-store response loss')
      }
      assert.equal(input.accountId, null, 'IdP user subjects must not be used as cloud account foreign keys')
      assert.deepEqual(input.metadata, {})
      const record = { ...input, createdAt: NOW.toISOString() }
      usageEvents.set(input.eventId, record)
      return record
    },
  })

  await assert.rejects(
    publication.publishFinalizedUpload(reservation),
    /usage-store response loss/,
  )
  assert.equal(await store.getCloudArtifactIndexRecord({
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }), null)
  assert.equal(projectedEvents.size, 0)
  assert.equal(usageEvents.size, 0)

  const claimed = await store.claimArtifactUploadFinalization({
    orgId: reservation.orgId,
    tenantId: reservation.tenantId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
    claimOwner: 'web-1',
    claimToken: 'publication-recovery-claim',
    claimTtlMs: 30_000,
    now: NOW,
  })
  assert.ok(claimed)
  assert.ok(await store.completeArtifactUploadFinalization({
    orgId: reservation.orgId,
    tenantId: reservation.tenantId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
    claimOwner: 'web-1',
    claimToken: 'publication-recovery-claim',
    now: NOW,
  }))
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider: {
      async inspect() { throw new Error('an already-finalized replay must not inspect staging') },
      async promote() { throw new Error('an already-finalized replay must not promote') },
      async delete() { throw new Error('an already-finalized replay must not delete') },
    },
    async isPublished(candidate) {
      return publication.isFinalizedUploadPublished(candidate)
    },
  })
  const retryInput = {
    orgId: reservation.orgId,
    tenantId: reservation.tenantId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
    claimOwner: 'web-2',
    claimTtlMs: 30_000,
  }

  assert.equal((await lifecycle.finalize(retryInput)).outcome, 'already_finalized')
  assert.equal((await lifecycle.finalize(retryInput)).outcome, 'already_finalized')
  assert.equal(projectedEvents.size, 1)
  assert.equal(usageEvents.size, 1)
})

test('publication rejects a canonical usage-event id collision instead of treating it as proof', async () => {
  const { store, org } = await createFixture()
  const created = await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const reservation = created.reservation
  assert.ok(reservation)
  let projectedEvents = 0
  const publication = new CloudArtifactIndexService({
    store,
    async ensurePrincipal() {},
    async assertSessionRead() {},
    async appendProjectedEvent() { projectedEvents += 1 },
    async recordUsage(input) {
      return {
        ...input,
        orgId: 'different-org',
        quantity: input.quantity + 1,
        metadata: { attacker: true },
        createdAt: NOW.toISOString(),
      }
    },
  })

  await assert.rejects(
    publication.publishFinalizedUpload(reservation),
    /usage identity collides/i,
  )
  assert.equal(await publication.isFinalizedUploadPublished(reservation), false)
  assert.equal(projectedEvents, 0)
  assert.equal(await store.getCloudArtifactIndexRecord({
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }), null)

  await store.upsertCloudArtifactIndex({
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
    filename: reservation.filename,
    contentType: reservation.contentType,
    size: reservation.reservedBytes,
    key: reservation.finalObjectKey,
    createdAt: reservation.createdAt,
    updatedAt: reservation.createdAt,
    kind: reservation.publication.kind,
    status: reservation.publication.artifactStatus,
    authorAgentId: reservation.publication.authorAgentId,
    projectId: reservation.publication.projectId,
    taskId: reservation.publication.taskId,
    statusUpdatedBy: reservation.publication.statusUpdatedBy,
    statusUpdatedAt: reservation.publication.statusUpdatedAt,
  })
  await assert.rejects(
    publication.isFinalizedUploadPublished(reservation),
    /usage identity collides/i,
    'an exact visible index must keep collision recovery non-destructive',
  )
})

test('a mismatched visible artifact index fences its promoted object from cleanup', async () => {
  let nowMs = NOW.getTime()
  const deleted: string[] = []
  const { store, org } = await createFixture()
  const created = await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const reservation = created.reservation
  assert.ok(reservation)
  await store.upsertCloudArtifactIndex({
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
    filename: reservation.filename,
    contentType: 'application/json',
    size: reservation.reservedBytes,
    key: reservation.finalObjectKey,
    createdAt: reservation.createdAt,
    updatedAt: reservation.createdAt,
    kind: reservation.publication.kind,
    status: reservation.publication.artifactStatus,
    authorAgentId: reservation.publication.authorAgentId,
    projectId: reservation.publication.projectId,
    taskId: reservation.publication.taskId,
    statusUpdatedBy: reservation.publication.statusUpdatedBy,
    statusUpdatedAt: reservation.publication.statusUpdatedAt,
  })
  let usageCalls = 0
  const publication = new CloudArtifactIndexService({
    store,
    async ensurePrincipal() {},
    async assertSessionRead() {},
    async appendProjectedEvent() {},
    async recordUsage(input) {
      usageCalls += 1
      return { ...input, createdAt: NOW.toISOString() }
    },
  })
  await assert.rejects(
    publication.isFinalizedUploadPublished(reservation),
    /conflicts with its existing artifact index/i,
  )

  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider: {
      async inspect() {
        return {
          size: reservation.reservedBytes,
          contentType: reservation.contentType,
          checksumSha256: CHECKSUM,
          versionToken: 'visible-index-version',
        }
      },
      async promote() { throw new Error('a visible index conflict must not promote again') },
      async delete(key) { deleted.push(key) },
    },
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `visible-index-claim-${++claimSequence}` },
    onPromoted: candidate => publication.publishFinalizedUpload(candidate).then(() => undefined),
    isPublished: candidate => publication.isFinalizedUploadPublished(candidate),
  })
  const identity = {
    orgId: reservation.orgId,
    tenantId: reservation.tenantId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }

  await assert.rejects(
    lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /conflicts with its existing artifact index/i,
  )
  for (let attempt = 0; attempt < ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS + 1; attempt += 1) {
    const pending = await store.getArtifactUploadReservation(identity)
    assert.ok(pending?.nextCleanupAttemptAt)
    nowMs = Date.parse(pending.nextCleanupAttemptAt)
    assert.deepEqual(
      await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
      { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 1 },
    )
  }

  const fenced = await store.getArtifactUploadReservation(identity)
  assert.equal(fenced?.status, 'finalizing')
  assert.ok(fenced!.finalizationAttempts > ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS)
  assert.equal(usageCalls, 0)
  assert.deepEqual(deleted, [])
  assert.equal((await store.getCloudArtifactIndexRecord({
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }))?.key, reservation.finalObjectKey)
})

test('an authoritative usage collision never publishes before bounded cleanup reclaims bytes and quota', async () => {
  let nowMs = NOW.getTime()
  let finalExists = false
  const deleted: string[] = []
  const provider: ArtifactUploadProviderPort = {
    async inspect(key) {
      if (key.startsWith('final/') && !finalExists) return null
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'usage-collision-version',
      }
    },
    async promote() { finalExists = true },
    async delete(key) {
      deleted.push(key)
      if (key.startsWith('final/')) finalExists = false
    },
  }
  const { store, org } = await createFixture(provider)
  const created = await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const reservation = created.reservation
  assert.ok(reservation)
  await store.recordUsageEvent({
    eventId: `artifact.uploaded:${reservation.tenantId}:${reservation.sessionId}:${reservation.artifactId}`,
    orgId: reservation.orgId,
    accountId: null,
    eventType: 'artifact.uploaded',
    quantity: reservation.reservedBytes + 1,
    unit: 'byte',
    metadata: { collision: true },
    createdAt: NOW,
  })
  let projectedEvents = 0
  const publication = new CloudArtifactIndexService({
    store,
    async ensurePrincipal() {},
    async assertSessionRead() {},
    async appendProjectedEvent() { projectedEvents += 1 },
    async recordUsage(input) { return store.recordUsageEvent(input) },
  })
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `usage-collision-claim-${++claimSequence}` },
    onPromoted: candidate => publication.publishFinalizedUpload(candidate).then(() => undefined),
    isPublished: candidate => publication.isFinalizedUploadPublished(candidate),
  })
  const identity = {
    orgId: reservation.orgId,
    tenantId: reservation.tenantId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }

  await assert.rejects(
    lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /publication is incomplete/i,
  )
  while ((await store.getArtifactUploadReservation(identity))?.status === 'finalizing') {
    const pending = await store.getArtifactUploadReservation(identity)
    assert.ok(pending?.nextCleanupAttemptAt)
    nowMs = Date.parse(pending.nextCleanupAttemptAt)
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 })
  }

  const quarantined = await store.getArtifactUploadReservation(identity)
  assert.equal(quarantined?.status, 'cleanup_pending')
  assert.equal(quarantined?.finalizationAttempts, ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS)
  assert.equal(projectedEvents, 0)
  assert.equal(await store.getCloudArtifactIndexRecord({
    tenantId: reservation.tenantId,
    userId: reservation.userId,
    sessionId: reservation.sessionId,
    artifactId: reservation.artifactId,
  }), null)
  assert.deepEqual(deleted, [])

  nowMs = Date.parse(quarantined!.expiresAt)
  await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 })
  nowMs += ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS
  await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 })
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'cleaned')
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    0,
  )
})

test('artifact upload finalize verifies the exact provider contract and promotes once', async () => {
  const promoted: unknown[] = []
  const provider: ArtifactUploadProviderPort = {
    async inspect(key) {
      assert.equal(key, 'staging/client-upload-1')
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'version-1',
      }
    },
    async promote(input) { promoted.push(input) },
    async delete() { throw new Error('finalize must not delete through the cleanup port') },
  }
  const { lifecycle, store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))

  const finalized = await lifecycle.finalize({
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    claimOwner: 'worker-1',
    claimTtlMs: 30_000,
  })
  const replay = await lifecycle.finalize({
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    claimOwner: 'worker-1',
    claimTtlMs: 30_000,
  })

  assert.equal(finalized.outcome, 'finalized')
  assert.equal(finalized.reservation?.status, 'finalized')
  assert.equal(replay.outcome, 'already_finalized')
  assert.equal(promoted.length, 1)
  assert.deepEqual(promoted[0], {
    stagingKey: 'staging/client-upload-1',
    finalKey: 'final/client-upload-1',
    expected: {
      size: 10,
      contentType: 'text/plain',
      checksumSha256: CHECKSUM,
      versionToken: 'version-1',
    },
  })
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )
})

test('artifact upload finalize accepts the provider canonical MIME for an omitted content type', async () => {
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'application/octet-stream',
        checksumSha256: CHECKSUM,
        versionToken: 'version-generic-mime',
      }
    },
    async promote() {},
    async delete() {},
  }
  const { lifecycle, store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation({
    ...reservationInput(org.orgId),
    contentType: null,
  })

  const finalized = await lifecycle.finalize({
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    claimOwner: 'worker-1',
    claimTtlMs: 30_000,
  })

  assert.equal(finalized.outcome, 'finalized')
  assert.equal(finalized.reservation?.contentType, null)
})

test('artifact upload mismatch keeps its tombstone and quota until credentials expire', async () => {
  let nowMs = NOW.getTime()
  const deleted: string[] = []
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 9,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'version-under',
      }
    },
    async promote() { throw new Error('mismatched uploads must not be promoted') },
    async delete(key) { deleted.push(key) },
  }
  const { store, org } = await createFixture(provider)
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `mismatch-claim-${++claimSequence}` },
  })
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const finalizeInput = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    claimOwner: 'worker-1',
    claimTtlMs: 30_000,
  } as const

  const rejected = await lifecycle.finalize(finalizeInput)
  const replay = await lifecycle.finalize(finalizeInput)

  assert.equal(rejected.outcome, 'rejected')
  assert.equal(rejected.reservation?.status, 'cleanup_pending')
  assert.equal(rejected.reservation?.cleanupReason, 'mismatch')
  assert.equal(replay.outcome, 'rejected')
  assert.deepEqual(deleted, [])
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )

  nowMs = Date.parse('2026-08-02T12:15:00.000Z')
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 }),
    { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.deepEqual(deleted.sort(), ['final/client-upload-1', 'staging/client-upload-1'])
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )
  assert.equal((await store.getArtifactUploadReservation(finalizeInput))?.cleanupPasses, 1)

  nowMs += ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 }),
    { claimed: 1, finalized: 0, cleaned: 1, stagingCleaned: 0, failed: 0 },
  )
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    0,
  )
})

test('artifact upload abort retains quota until post-expiry cleanup removes a late credential write', async () => {
  let nowMs = NOW.getTime()
  const deleted: string[] = []
  const objects = new Set(['staging/client-upload-1'])
  let failNextDelete = true
  const provider: ArtifactUploadProviderPort = {
    async inspect() { return null },
    async promote() {},
    async delete(key) {
      deleted.push(key)
      if (failNextDelete) {
        failNextDelete = false
        throw new Error('injected provider outage')
      }
      objects.delete(key)
    },
  }
  const { store, org } = await createFixture(provider)
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `abort-claim-${++claimSequence}` },
  })
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const

  const aborted = await lifecycle.abort({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 })
  const immediateReplay = await lifecycle.abort({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 })

  assert.equal(aborted.outcome, 'cleanup_pending')
  assert.equal(aborted.reservation?.cleanupAttempts, 0)
  assert.equal(immediateReplay.outcome, 'cleanup_pending')
  assert.deepEqual(deleted, [])
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )

  // The still-valid credential can recreate the staging key after abort. Cleanup before
  // credential expiry is therefore advisory; the post-expiry delete is authoritative.
  nowMs = Date.parse('2026-08-02T12:15:00.000Z')
  const failed = await lifecycle.reconcile({
    claimOwner: 'scheduler-1',
    claimTtlMs: 30_000,
    limit: 10,
  })
  assert.deepEqual(failed, { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 1 })
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )

  nowMs += 1_000
  const reconciled = await lifecycle.reconcile({
    claimOwner: 'scheduler-1',
    claimTtlMs: 30_000,
    limit: 10,
  })
  assert.deepEqual(reconciled, { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 })
  assert.equal((await store.getArtifactUploadReservation(identity))?.cleanupPasses, 1)
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'cleanup_pending')
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )

  // A request already accepted by the provider can commit after the first delete completes.
  objects.add('staging/client-upload-1')
  objects.add('final/client-upload-1')
  nowMs += ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS - 1
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 }),
    { claimed: 0, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  nowMs += 1
  const confirmed = await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 })
  const replay = await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 })

  assert.deepEqual(confirmed, { claimed: 1, finalized: 0, cleaned: 1, stagingCleaned: 0, failed: 0 })
  assert.deepEqual(replay, { claimed: 0, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 })
  assert.deepEqual(deleted, [
    'staging/client-upload-1',
    'staging/client-upload-1',
    'final/client-upload-1',
    'staging/client-upload-1',
    'final/client-upload-1',
  ])
  assert.deepEqual([...objects], [])
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'cleaned')
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    0,
  )
})

test('reconciliation reclaims finalized staging only after upload credentials expire', async () => {
  let nowMs = NOW.getTime()
  const deleted: string[] = []
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'version-1',
      }
    },
    async promote() {},
    async delete(key) { deleted.push(key) },
  }
  const { store, org } = await createFixture(provider)
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `expiry-claim-${++claimSequence}` },
  })
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const
  await lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 })

  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 }),
    { claimed: 0, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  nowMs = Date.parse('2026-08-02T12:15:00.000Z')
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 }),
    { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal((await store.getArtifactUploadReservation(identity))?.cleanupPasses, 1)
  assert.equal((await store.getArtifactUploadReservation(identity))?.stagingCleanedAt, null)

  nowMs += ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 10 }),
    { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 1, failed: 0 },
  )

  const finalized = await store.getArtifactUploadReservation(identity)
  assert.equal(finalized?.status, 'finalized')
  assert.equal(finalized?.stagingCleanedAt, new Date(nowMs).toISOString())
  assert.deepEqual(deleted, ['staging/client-upload-1', 'staging/client-upload-1'])
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )
})

test('reconciliation finalizes a valid reserved upload after credentials expire', async () => {
  const deleted: string[] = []
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'crash-recovery-version',
      }
    },
    async promote() {},
    async delete(key) { deleted.push(key) },
  }
  const { store, org } = await createFixture(provider)
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date('2026-08-02T12:15:00.000Z'),
    ids: { randomUUID: () => 'recovery-claim-1' },
  })
  await store.createArtifactUploadReservation(reservationInput(org.orgId))

  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 1, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal((await store.getArtifactUploadReservation({
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  }))?.status, 'finalized')
  assert.deepEqual(deleted, [])
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )
})

test('concurrent finalizers promote exactly once under a durable claim lease', async () => {
  let releasePromotion!: () => void
  const promotionGate = new Promise<void>((resolve) => { releasePromotion = resolve })
  let promotionStarted!: () => void
  const started = new Promise<void>((resolve) => { promotionStarted = resolve })
  let promoteCalls = 0
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'version-1',
      }
    },
    async promote() {
      promoteCalls += 1
      promotionStarted()
      await promotionGate
    },
    async delete() {},
  }
  const { lifecycle, store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const input = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    claimTtlMs: 30_000,
  } as const

  const first = lifecycle.finalize({ ...input, claimOwner: 'worker-1' })
  await started
  const competing = await lifecycle.finalize({ ...input, claimOwner: 'worker-2' })
  releasePromotion()

  assert.equal(competing.outcome, 'in_progress')
  assert.equal((await first).outcome, 'finalized')
  assert.equal(promoteCalls, 1)
})

test('reconciliation reclaims and finishes a stale finalization lease', async () => {
  let nowMs = NOW.getTime()
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'version-1',
      }
    },
    async promote() {},
    async delete() {},
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  await store.claimArtifactUploadFinalization({
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
    claimOwner: 'crashed-worker',
    claimToken: 'stale-token',
    claimTtlMs: 1_000,
    now: new Date(nowMs),
  })
  nowMs += 1_000
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => 'recovery-token' },
  })

  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 1, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
})

test('authoritative publication repair failures exhaust a retry budget before quarantined cleanup', async () => {
  let nowMs = NOW.getTime()
  let promoteCalls = 0
  let publicationCalls = 0
  let finalExists = false
  const deleted: string[] = []
  const provider: ArtifactUploadProviderPort = {
    async inspect(key) {
      if (key.startsWith('final/') && !finalExists) return null
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: `failed-publication-version-${promoteCalls}`,
      }
    },
    async promote() {
      promoteCalls += 1
      finalExists = true
    },
    async delete(key) { deleted.push(key) },
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `retry-budget-claim-${++claimSequence}` },
    async onPromoted() {
      publicationCalls += 1
      throw new Error('injected authoritative publication outage')
    },
    async isPublished() { return false },
  })
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const

  await assert.rejects(
    lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /publication is incomplete/,
  )
  while ((await store.getArtifactUploadReservation(identity))?.status === 'finalizing') {
    const pending = await store.getArtifactUploadReservation(identity)
    assert.ok(pending?.nextCleanupAttemptAt)
    nowMs = Date.parse(pending.nextCleanupAttemptAt)
    assert.deepEqual(
      await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
      { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 1 },
    )
  }

  const quarantined = await store.getArtifactUploadReservation(identity)
  assert.equal(promoteCalls, 1)
  assert.equal(publicationCalls, ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS)
  assert.equal(quarantined?.finalizationAttempts, ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS)
  assert.equal(quarantined?.status, 'cleanup_pending')
  assert.equal(quarantined?.cleanupReason, 'failed')
  assert.equal(quarantined?.claimOwner, null)
  assert.equal(quarantined?.nextCleanupAttemptAt, quarantined?.expiresAt)
  assert.deepEqual(deleted, [])
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )

  nowMs = Date.parse(quarantined!.expiresAt)
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    10,
  )
  nowMs += ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 0, cleaned: 1, stagingCleaned: 0, failed: 0 },
  )
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'cleaned')
  assert.equal(
    (await store.listUsageQuotaCounters(org.orgId)).find((row) => row.quotaKey === 'artifact-bytes')?.quantity,
    0,
  )
})

test('reconciliation retries safely after the provider copied the final object before returning failure', async () => {
  let nowMs = NOW.getTime()
  let promoteCalls = 0
  let publicationCalls = 0
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'post-copy-version',
      }
    },
    async promote() {
      promoteCalls += 1
      if (promoteCalls === 1) throw new Error('response lost after provider copy')
    },
    async delete() {},
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `post-copy-claim-${++claimSequence}` },
    onPromoted() { publicationCalls += 1 },
  })
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const

  await assert.rejects(
    lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /response lost/,
  )
  const retryAt = (await store.getArtifactUploadReservation(identity))?.nextCleanupAttemptAt
  assert.ok(retryAt)
  nowMs = Date.parse(retryAt)
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 1, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal(promoteCalls, 2)
  assert.equal(publicationCalls, 1)
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'finalized')
})

test('durable publication plus final-object proof closes a lost publication response without deletion', async () => {
  let published = false
  let promoteCalls = 0
  let publicationCalls = 0
  let publicationProbes = 0
  let finalExists = false
  const provider: ArtifactUploadProviderPort = {
    async inspect(key) {
      if (key.startsWith('final/') && !finalExists) return null
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'published-version',
      }
    },
    async promote() {
      promoteCalls += 1
      finalExists = true
    },
    async delete() { throw new Error('published uploads must not be deleted') },
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(NOW),
    ids: { randomUUID: () => 'published-response-loss-claim' },
    async onPromoted() {
      publicationCalls += 1
      published = true
      throw new Error('response lost after durable publication')
    },
    async isPublished() {
      publicationProbes += 1
      return published
    },
  })
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const

  const finalized = await lifecycle.finalize({
    ...identity,
    claimOwner: 'web-1',
    claimTtlMs: 30_000,
  })

  assert.equal(finalized.outcome, 'finalized')
  assert.equal(finalized.reservation?.status, 'finalized')
  assert.equal(promoteCalls, 1)
  assert.equal(publicationCalls, 1)
  assert.equal(publicationProbes >= 1, true)
  assert.equal((await store.getArtifactUploadReservation(identity))?.finalizationAttempts, 0)
})

test('transient publication verification after a committed promotion never authorizes cleanup', async () => {
  let nowMs = NOW.getTime()
  let stagingExists = true
  let finalExists = false
  let published = false
  let publicationReads = 0
  let deleteCalls = 0
  const provider: ArtifactUploadProviderPort = {
    async inspect(key) {
      const exists = key.startsWith('final/') ? finalExists : stagingExists
      return exists
        ? {
            size: 10,
            contentType: 'text/plain',
            checksumSha256: CHECKSUM,
            versionToken: key.startsWith('final/') ? 'final-version' : 'staging-version',
          }
        : null
    },
    async promote() {
      finalExists = true
      stagingExists = false
    },
    async delete() { deleteCalls += 1 },
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const completeFinalization = store.completeArtifactUploadFinalization.bind(store)
  let failCommitOnce = true
  store.completeArtifactUploadFinalization = (input) => {
    if (failCommitOnce) {
      failCommitOnce = false
      throw new Error('injected status commit crash')
    }
    return completeFinalization(input)
  }
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `transient-publication-claim-${++claimSequence}` },
    async onPromoted() {
      published = true
    },
    async isPublished() {
      publicationReads += 1
      if (publicationReads <= ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS + 1) {
        throw new Error('transient publication read outage')
      }
      return published
    },
  })
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const

  await assert.rejects(
    lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /publication read outage/,
  )
  const deferred = await store.getArtifactUploadReservation(identity)
  assert.equal(deferred?.status, 'finalizing')
  assert.equal(deferred?.cleanupReason, null)
  assert.equal(deleteCalls, 0)

  let pending = deferred!
  for (let attempt = 0; attempt < ARTIFACT_UPLOAD_MAX_FINALIZATION_ATTEMPTS; attempt += 1) {
    nowMs = Date.parse(pending.nextCleanupAttemptAt!)
    assert.deepEqual(
      await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
      { claimed: 1, finalized: 0, cleaned: 0, stagingCleaned: 0, failed: 1 },
    )
    pending = (await store.getArtifactUploadReservation(identity))!
    assert.equal(pending.status, 'finalizing')
    assert.equal(pending.cleanupReason, null)
    assert.equal(deleteCalls, 0)
  }
  nowMs = Date.parse(pending.nextCleanupAttemptAt!)
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 1, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'finalized')
  assert.equal(deleteCalls, 0)
})

test('restart repairs publication when promotion committed before the publisher ran', async () => {
  let nowMs = NOW.getTime()
  let stagingExists = true
  let finalExists = false
  let published = false
  let promoteCalls = 0
  let deleteCalls = 0
  const provider: ArtifactUploadProviderPort = {
    async inspect(key) {
      const exists = key.startsWith('final/') ? finalExists : stagingExists
      return exists
        ? {
            size: 10,
            contentType: 'text/plain',
            checksumSha256: CHECKSUM,
            versionToken: key.startsWith('final/') ? 'final-version' : 'staging-version',
          }
        : null
    },
    async promote() {
      promoteCalls += 1
      finalExists = true
      stagingExists = false
    },
    async delete() { deleteCalls += 1 },
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const
  const firstProcess = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => 'before-publish-crash-claim' },
    async onPromoted() { throw new Error('injected crash before publication') },
    async isPublished() { return false },
  })

  await assert.rejects(
    firstProcess.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /publication is incomplete/,
  )
  const deferred = await store.getArtifactUploadReservation(identity)
  assert.equal(deferred?.status, 'finalizing')
  assert.equal(finalExists, true)
  assert.equal(stagingExists, false)
  assert.equal(deleteCalls, 0)

  nowMs = Date.parse(deferred!.nextCleanupAttemptAt!)
  const restarted = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => 'restart-publication-repair-claim' },
    async onPromoted() { published = true },
    async isPublished() { return published },
  })
  assert.deepEqual(
    await restarted.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 1, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'finalized')
  assert.equal(promoteCalls, 1)
  assert.equal(deleteCalls, 0)
})

test('reconciliation retries idempotent publication before marking a promoted upload finalized', async () => {
  let nowMs = NOW.getTime()
  let promoteCalls = 0
  let publicationCalls = 0
  const provider: ArtifactUploadProviderPort = {
    async inspect() {
      return {
        size: 10,
        contentType: 'text/plain',
        checksumSha256: CHECKSUM,
        versionToken: 'version-1',
      }
    },
    async promote() { promoteCalls += 1 },
    async delete() {},
  }
  const { store, org } = await createFixture(provider)
  await store.createArtifactUploadReservation(reservationInput(org.orgId))
  let claimSequence = 0
  const lifecycle = new ArtifactUploadLifecycle({
    store,
    provider,
    now: () => new Date(nowMs),
    ids: { randomUUID: () => `publication-claim-${++claimSequence}` },
    async onPromoted(reservation) {
      publicationCalls += 1
      assert.equal(reservation.publication.kind, 'document')
      if (publicationCalls === 1) throw new Error('injected publication outage')
    },
  })
  const identity = {
    orgId: org.orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId: 'client-upload-1',
  } as const

  await assert.rejects(
    lifecycle.finalize({ ...identity, claimOwner: 'web-1', claimTtlMs: 30_000 }),
    /publication outage/,
  )
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'finalizing')
  nowMs += 1_000
  assert.deepEqual(
    await lifecycle.reconcile({ claimOwner: 'scheduler-1', claimTtlMs: 30_000, limit: 1 }),
    { claimed: 1, finalized: 1, cleaned: 0, stagingCleaned: 0, failed: 0 },
  )
  assert.equal((await store.getArtifactUploadReservation(identity))?.status, 'finalized')
  assert.equal(promoteCalls, 2)
  assert.equal(publicationCalls, 2)
})
