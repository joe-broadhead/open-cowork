import test from 'node:test'
import assert from 'node:assert/strict'

import type { ControlPlaneStore } from '@open-cowork/cloud-server/control-plane-store'
import { InMemoryControlPlaneStore } from '@open-cowork/cloud-server/in-memory-control-plane-store'
import { createPostgresControlPlaneStore } from '@open-cowork/cloud-server/postgres-control-plane-store'
import { createPglitePool } from './helpers/pglite-pool.ts'

const NOW = new Date('2026-08-02T12:00:00.000Z')
const CHECKSUM = 'a'.repeat(64)

const backends = [
  {
    name: 'in-memory',
    async create() {
      return { store: new InMemoryControlPlaneStore() as ControlPlaneStore, close: async () => {} }
    },
  },
  {
    name: 'pglite',
    async create() {
      const store = await createPostgresControlPlaneStore({
        connectionString: 'pglite://memory',
        pool: createPglitePool(),
      })
      return { store, close: () => store.close() }
    },
  },
] as const

for (const backend of backends) {
  test(`${backend.name} artifact upload lifecycle store contract`, async () => {
    const { store, close } = await backend.create()
    try {
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
      const input = reservationInput(org.orgId, 'artifact-1')
      const first = await store.createArtifactUploadReservation(input)
      const replay = await store.createArtifactUploadReservation({
        ...input,
        expiresAt: '2026-08-02T12:15:01.000Z',
      })
      assert.equal(store.artifactUploadLifecycleCapability.reconciliation, 'bounded-claims')
      assert.equal(first.reservation?.status, 'reserved')
      assert.deepEqual(first.reservation?.publication, input.publication)
      assert.equal(replay.reservation?.expiresAt, '2026-08-02T12:15:00.000Z')
      assert.equal(replay.quota, null)
      await assert.rejects(
        async () => store.createArtifactUploadReservation({ ...input, checksumSha256: 'b'.repeat(64) }),
        /idempotency key conflicts/i,
      )
      await assert.rejects(
        async () => store.createArtifactUploadReservation({
          ...input,
          publication: { ...input.publication, taskId: 'other-task' },
        }),
        /idempotency key conflicts/i,
      )

      const identity = reservationIdentity(org.orgId, 'artifact-1')
      const claimed = await store.claimArtifactUploadFinalization({
        ...identity,
        claimOwner: 'worker-1',
        claimToken: 'claim-1',
        claimTtlMs: 30_000,
        now: NOW,
      })
      assert.equal(claimed?.status, 'finalizing')
      assert.equal(await store.claimArtifactUploadFinalization({
        ...identity,
        claimOwner: 'worker-2',
        claimToken: 'claim-2',
        claimTtlMs: 30_000,
        now: NOW,
      }), null)
      const finalized = await store.completeArtifactUploadFinalization({
        ...identity,
        claimOwner: 'worker-1',
        claimToken: 'claim-1',
        now: NOW,
      })
      assert.equal(finalized?.status, 'finalized')

      const stagingClaims = await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-1',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:15:00.000Z'),
      })
      assert.deepEqual(stagingClaims.map((claim) => claim.action), ['cleanup_staging'])
      assert.deepEqual(
        await store.getArtifactUploadReconciliationStats(new Date('2026-08-02T12:15:00.000Z')),
        { pendingCount: 1, oldestPendingAgeMs: 0 },
      )
      const stagingDeferred = await store.deferArtifactUploadCleanup({
        ...identity,
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-1',
        retryAt: new Date('2026-08-02T12:45:00.000Z'),
        now: new Date('2026-08-02T12:15:00.000Z'),
      })
      assert.equal(stagingDeferred?.status, 'finalized')
      assert.equal(stagingDeferred?.cleanupPasses, 1)
      assert.equal(stagingDeferred?.stagingCleanedAt, null)
      const confirmedStagingClaims = await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-1-confirmed',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:45:00.000Z'),
      })
      assert.deepEqual(confirmedStagingClaims.map((claim) => claim.action), ['cleanup_staging'])
      const stagingCleaned = await store.completeArtifactUploadCleanup({
        ...identity,
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-1-confirmed',
        now: new Date('2026-08-02T12:45:00.000Z'),
      })
      assert.equal(stagingCleaned?.status, 'finalized')
      assert.equal(stagingCleaned?.stagingCleanedAt, '2026-08-02T12:45:00.000Z')

      await store.createArtifactUploadReservation(reservationInput(org.orgId, 'artifact-2'))
      const cleanupIdentity = reservationIdentity(org.orgId, 'artifact-2')
      const cleanup = await store.requestArtifactUploadCleanup({
        ...cleanupIdentity,
        reason: 'aborted',
        claimOwner: 'web-1',
        claimToken: 'cleanup-1',
        claimTtlMs: 30_000,
        now: NOW,
      })
      assert.equal(cleanup?.status, 'cleanup_pending')
      assert.equal(
        (await store.listUsageQuotaCounters(org.orgId)).find((counter) => counter.quotaKey === 'artifact-bytes')?.quantity,
        20,
      )
      await store.failArtifactUploadCleanup({
        ...cleanupIdentity,
        claimOwner: 'web-1',
        claimToken: 'cleanup-1',
        errorCode: 'provider_delete_failed',
        retryAt: new Date('2026-08-02T12:00:01.000Z'),
        now: NOW,
      })
      assert.deepEqual(
        await store.getArtifactUploadReconciliationStats(NOW),
        { pendingCount: 1, oldestPendingAgeMs: 0 },
      )
      assert.deepEqual(await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-2',
        claimTtlMs: 30_000,
        limit: 1,
        now: NOW,
      }), [])
      const cleanupClaims = await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-3',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:00:01.000Z'),
      })
      assert.deepEqual(cleanupClaims.map((claim) => claim.action), ['cleanup'])
      assert.deepEqual(
        await store.getArtifactUploadReconciliationStats(new Date('2026-08-02T12:00:01.000Z')),
        { pendingCount: 1, oldestPendingAgeMs: 1_000 },
      )
      const cleanupDeferred = await store.deferArtifactUploadCleanup({
        ...cleanupIdentity,
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-3',
        retryAt: new Date('2026-08-02T12:30:01.000Z'),
        now: new Date('2026-08-02T12:00:01.000Z'),
      })
      assert.equal(cleanupDeferred?.cleanupPasses, 1)
      assert.equal(cleanupDeferred?.status, 'cleanup_pending')
      assert.equal(
        (await store.listUsageQuotaCounters(org.orgId)).find((counter) => counter.quotaKey === 'artifact-bytes')?.quantity,
        20,
      )
      const cleanupConfirmationClaims = await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-3-confirmed',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:30:01.000Z'),
      })
      assert.deepEqual(cleanupConfirmationClaims.map((claim) => claim.action), ['cleanup'])
      assert.equal((await store.completeArtifactUploadCleanup({
        ...cleanupIdentity,
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-3-confirmed',
        now: new Date('2026-08-02T12:30:01.000Z'),
      }))?.status, 'cleaned')
      assert.equal(
        (await store.listUsageQuotaCounters(org.orgId)).find((counter) => counter.quotaKey === 'artifact-bytes')?.quantity,
        10,
      )

      await store.createArtifactUploadReservation(reservationInput(org.orgId, 'artifact-delayed-cleanup'))
      const delayedCleanupIdentity = reservationIdentity(org.orgId, 'artifact-delayed-cleanup')
      const delayedCleanup = await store.requestArtifactUploadCleanup({
        ...delayedCleanupIdentity,
        reason: 'aborted',
        claimOwner: 'web-1',
        claimToken: 'cleanup-delayed',
        claimTtlMs: 30_000,
        cleanupNotBefore: new Date('2026-08-02T12:15:00.000Z'),
        now: NOW,
      })
      assert.equal(delayedCleanup?.status, 'cleanup_pending')
      assert.equal(delayedCleanup?.claimOwner, null)
      assert.equal(delayedCleanup?.claimToken, null)
      assert.equal(delayedCleanup?.nextCleanupAttemptAt, '2026-08-02T12:15:00.000Z')
      assert.deepEqual(await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-delayed-early',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:14:59.999Z'),
      }), [])
      assert.equal(
        (await store.listUsageQuotaCounters(org.orgId)).find((counter) => counter.quotaKey === 'artifact-bytes')?.quantity,
        20,
      )
      const delayedCleanupClaims = await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-delayed-due',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:15:00.000Z'),
      })
      assert.deepEqual(delayedCleanupClaims.map((claim) => claim.action), ['cleanup'])
      assert.equal(
        (await store.listUsageQuotaCounters(org.orgId)).find((counter) => counter.quotaKey === 'artifact-bytes')?.quantity,
        20,
      )
      await store.deferArtifactUploadCleanup({
        ...delayedCleanupIdentity,
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-delayed-due',
        retryAt: new Date('2026-08-02T12:45:00.000Z'),
        now: new Date('2026-08-02T12:15:00.000Z'),
      })
      const delayedCleanupConfirmationClaims = await store.claimArtifactUploadReconciliation({
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-delayed-confirmed',
        claimTtlMs: 30_000,
        limit: 1,
        now: new Date('2026-08-02T12:45:00.000Z'),
      })
      assert.deepEqual(delayedCleanupConfirmationClaims.map((claim) => claim.action), ['cleanup'])
      assert.equal((await store.completeArtifactUploadCleanup({
        ...delayedCleanupIdentity,
        claimOwner: 'scheduler-1',
        claimToken: 'sweep-delayed-confirmed',
        now: new Date('2026-08-02T12:45:00.000Z'),
      }))?.status, 'cleaned')
      assert.equal(
        (await store.listUsageQuotaCounters(org.orgId)).find((counter) => counter.quotaKey === 'artifact-bytes')?.quantity,
        10,
      )

      await store.createArtifactUploadReservation({
        ...reservationInput(org.orgId, 'artifact-3'),
        expiresAt: NOW,
      })
      await store.createArtifactUploadReservation({
        ...reservationInput(org.orgId, 'artifact-4'),
        expiresAt: new Date(NOW.getTime() + 500),
      })
      await store.claimArtifactUploadFinalization({
        ...reservationIdentity(org.orgId, 'artifact-4'),
        claimOwner: 'worker-4',
        claimToken: 'claim-4',
        claimTtlMs: 30_000,
        now: NOW,
      })
      assert.deepEqual(
        await store.getArtifactUploadReconciliationStats(new Date(NOW.getTime() + 1_000)),
        { pendingCount: 2, oldestPendingAgeMs: 1_000 },
      )

      await store.createArtifactUploadReservation(reservationInput(org.orgId, 'artifact-quarantined'))
      const quarantinedIdentity = reservationIdentity(org.orgId, 'artifact-quarantined')
      await store.requestArtifactUploadCleanup({
        ...quarantinedIdentity,
        reason: 'aborted',
        claimOwner: 'web-1',
        claimToken: 'quarantined-cleanup',
        claimTtlMs: 30_000,
        cleanupNotBefore: new Date('2026-08-02T14:00:00.000Z'),
        now: NOW,
      })

      assert.equal(await store.pruneArtifactUploadReservations({
        olderThan: new Date('2026-08-02T13:00:00.000Z'),
        limit: 1,
      }), 1)
      assert.equal(await store.getArtifactUploadReservation(cleanupIdentity), null)
      assert.equal(await store.pruneArtifactUploadReservations({
        olderThan: new Date('2026-08-02T13:00:00.000Z'),
        limit: 10,
      }), 2)
      assert.equal(await store.getArtifactUploadReservation(identity), null)
      assert.equal(await store.getArtifactUploadReservation(delayedCleanupIdentity), null)
      assert.equal(await store.getArtifactUploadReservation(reservationIdentity(org.orgId, 'artifact-3')) !== null, true)
      assert.equal(await store.getArtifactUploadReservation(reservationIdentity(org.orgId, 'artifact-4')) !== null, true)
      assert.equal(await store.getArtifactUploadReservation(quarantinedIdentity) !== null, true)
    } finally {
      await close()
    }
  })

  test(`${backend.name} artifact upload finalization retry budget is durable`, async () => {
    const { store, close } = await backend.create()
    try {
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
      await store.createArtifactUploadReservation(reservationInput(org.orgId, 'artifact-retry-budget'))
      const identity = reservationIdentity(org.orgId, 'artifact-retry-budget')
      let nowMs = NOW.getTime()
      let claimToken = 'retry-claim-1'
      await store.claimArtifactUploadFinalization({
        ...identity,
        claimOwner: 'worker-1',
        claimToken,
        claimTtlMs: 30_000,
        now: new Date(nowMs),
      })

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const retryAt = new Date(nowMs + 2 ** (attempt - 1) * 1_000)
        const released = await store.releaseArtifactUploadClaim({
          ...identity,
          claimOwner: 'worker-1',
          claimToken,
          errorCode: 'finalize_failed',
          retryAt,
          cleanupNotBefore: new Date('2026-08-02T12:15:00.000Z'),
          maxAttempts: 5,
          now: new Date(nowMs),
        })
        assert.equal(released?.finalizationAttempts, attempt)
        if (attempt === 5) {
          assert.equal(released?.status, 'cleanup_pending')
          assert.equal(released?.cleanupReason, 'failed')
          assert.equal(released?.claimOwner, null)
          assert.equal(released?.nextCleanupAttemptAt, '2026-08-02T12:15:00.000Z')
          continue
        }
        assert.equal(released?.status, 'finalizing')
        assert.equal(await store.claimArtifactUploadFinalization({
          ...identity,
          claimOwner: 'worker-1',
          claimToken: `retry-claim-early-${attempt}`,
          claimTtlMs: 30_000,
          now: new Date(retryAt.getTime() - 1),
        }), null)
        nowMs = retryAt.getTime()
        claimToken = `retry-claim-${attempt + 1}`
        assert.equal((await store.claimArtifactUploadFinalization({
          ...identity,
          claimOwner: 'worker-1',
          claimToken,
          claimTtlMs: 30_000,
          now: new Date(nowMs),
        }))?.claimToken, claimToken)
      }

      assert.equal(await store.pruneArtifactUploadReservations({
        olderThan: new Date('2026-08-03T12:00:00.000Z'),
        limit: 10,
      }), 0)
      assert.equal(await store.getArtifactUploadReservation(identity) !== null, true)
    } finally {
      await close()
    }
  })
}

function reservationInput(orgId: string, artifactId: string) {
  return {
    orgId,
    tenantId: 'tenant-1',
    userId: 'user-1',
    sessionId: 'session-1',
    artifactId,
    objectKey: `final/${artifactId}`,
    stagingObjectKey: `staging/${artifactId}`,
    finalObjectKey: `final/${artifactId}`,
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

function reservationIdentity(orgId: string, artifactId: string) {
  return {
    orgId,
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    artifactId,
  } as const
}
