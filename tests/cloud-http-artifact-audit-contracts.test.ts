import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { CloudArtifactService } from '@open-cowork/cloud-server/artifact-service'
import {
  ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS,
  ArtifactUploadLifecycle,
} from '@open-cowork/cloud-server/artifact-upload-lifecycle'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import {
  createInMemoryObjectStore,
  createS3CompatibleObjectStore,
  type ObjectStoreAdapter,
  type ObjectStorePresignedPostRequest,
} from '@open-cowork/cloud-server/object-store'
import type { CloudObservabilityAdapter } from '@open-cowork/cloud-server/observability'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  testAbuseConfig,
} from './helpers/cloud-http-test-support.ts'

const DIRECT_UPLOAD_CONFIG = {
  mode: 'enabled',
  requested: true,
  configStatus: 'valid',
  reason: 'enabled',
  cleanupBatchSize: 100,
  cleanupIntervalMs: 60_000,
} as const

function createAttestedTestObjectStore(now: () => Date = () => new Date()) {
  const base = createInMemoryObjectStore()
  let presignCalls = 0
  const store: ObjectStoreAdapter = {
    ...base,
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 25 * 1024 * 1024,
      origin: 'https://object-store.test',
      verifyCleanupSafety: async () => true,
      verifyBrowserPostSafety: async (origin) => origin === 'https://cloud.example.test',
      async presignPost(input) {
        presignCalls += 1
        return {
          method: 'POST',
          url: 'https://object-store.test/upload',
          fields: {
            key: input.key,
            checksum: input.checksumSha256,
            exactSize: String(input.expectedSize),
          },
          expiresAt: new Date(now().getTime() + (input.expiresSeconds || 900) * 1_000).toISOString(),
        }
      },
      async inspect(key) {
        const object = await base.getObject(key)
        if (!object) return null
        return {
          size: object.body.byteLength,
          contentType: object.contentType,
          checksumSha256: createHash('sha256').update(object.body).digest('hex'),
          versionToken: `etag:${createHash('sha256').update(object.body).digest('hex')}`,
        }
      },
      async promote(input) {
        const object = await base.getObject(input.stagingKey)
        if (!object) throw new Error('staging object missing')
        await base.putObject({
          key: input.finalKey,
          body: object.body,
          contentType: object.contentType,
        })
      },
      delete: (key) => base.deleteObject(key),
    },
  }
  return { base, store, presignCalls: () => presignCalls }
}

function createDirectUploadFixture(input: {
  objectStore: ObjectStoreAdapter
  now?: () => Date
  abuse?: ReturnType<typeof testAbuseConfig>
}) {
  let lifecycle: ArtifactUploadLifecycle | null = null
  const fixture = createFixture({
    objectStore: input.objectStore,
    abuse: input.abuse || testAbuseConfig(),
    artifactServiceFactory({ service, objectStore, store, ids }) {
      Object.defineProperty(store, 'artifactUploadLifecycleCapability', {
        value: { persistence: 'durable', reconciliation: 'bounded-claims' },
      })
      lifecycle = new ArtifactUploadLifecycle({
        store,
        provider: objectStore.presignedUpload!,
        now: input.now,
        isPublished: (reservation) => service.isFinalizedArtifactUploadPublished(reservation),
      })
      return new CloudArtifactService(service, objectStore, ids, {
        directUpload: {
          config: DIRECT_UPLOAD_CONFIG,
          lifecycle,
          browserOrigin: 'https://cloud.example.test',
          claimOwner: 'web-test',
          now: input.now,
        },
      })
    },
  })
  return { ...fixture, lifecycle: lifecycle! }
}

test('cloud HTTP artifacts use object storage and durable artifact events', async () => {
  const fixture = createFixture({ abuse: testAbuseConfig() })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const uploadedResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'report.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('cloud artifact').toString('base64'),
        authorAgentId: 'agent-writer',
        projectId: 'project-1',
        taskId: 'task-1',
        statusUpdatedBy: 'creator-1',
      }),
    })
    assert.equal(uploadedResponse.status, 201)
    const uploadedBody = await readJson(uploadedResponse)
    const uploaded = asRecord(uploadedBody.artifact)
    assert.equal(uploaded.filename, 'report.txt')
    assert.equal(uploaded.size, 'cloud artifact'.length)
    assert.equal(uploaded.kind, 'document')
    assert.equal(uploaded.status, 'draft')
    assert.equal(uploaded.authorAgentId, 'agent-writer')
    assert.equal(uploaded.projectId, 'project-1')
    assert.equal(uploaded.taskId, 'task-1')
    assert.equal(uploaded.statusUpdatedBy, 'creator-1')
    assert.equal(uploaded.statusUpdatedAt, uploaded.createdAt)
    assert.equal('key' in uploaded, false)

    const listed = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    const artifacts = asArray(listed.artifacts)
    assert.equal(artifacts.length, 1)
    const listedArtifact = asRecord(artifacts[0])
    assert.equal(listedArtifact.artifactId, uploaded.artifactId)
    assert.equal(listedArtifact.status, 'draft')
    assert.equal('key' in listedArtifact, false)

    const invalidTimestampResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'bad-timestamp.txt',
        contentType: 'text/plain',
        dataBase64: Buffer.from('bad timestamp').toString('base64'),
        statusUpdatedAt: 'next week',
      }),
    })
    assert.equal(invalidTimestampResponse.status, 400)
    const afterInvalidTimestamp = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))
    assert.equal(asArray(afterInvalidTimestamp.artifacts).length, 1)

    const indexed = await readJson(await fetch(`${baseUrl}/api/artifacts?projectId=project-1&status=draft&kind=document`))
    const indexedArtifacts = asArray(indexed.artifacts).map(asRecord)
    assert.equal(indexedArtifacts.length, 1)
    assert.equal(indexedArtifacts[0]?.artifactId, uploaded.artifactId)
    assert.equal(indexedArtifacts[0]?.sessionId, sessionId)
    assert.equal(indexedArtifacts[0]?.projectId, 'project-1')
    assert.equal('key' in indexedArtifacts[0]!, false)

    const indexedByTaskIds = await readJson(await fetch(`${baseUrl}/api/artifacts?projectId=project-other&taskIds=task-1&taskIds=missing`))
    const taskLinkedArtifacts = asArray(indexedByTaskIds.artifacts).map(asRecord)
    assert.equal(taskLinkedArtifacts.length, 1)
    assert.equal(taskLinkedArtifacts[0]?.artifactId, uploaded.artifactId)
    assert.equal(taskLinkedArtifacts[0]?.taskId, 'task-1')
    assert.equal('key' in taskLinkedArtifacts[0]!, false)

    const emptyTaskIdsResponse = await fetch(`${baseUrl}/api/artifacts?taskIds=,,`)
    assert.equal(emptyTaskIdsResponse.status, 200)
    const emptyTaskIds = await readJson(emptyTaskIdsResponse)
    assert.equal(asArray(emptyTaskIds.artifacts).length, 1)

    const statusResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'in-review',
        updatedBy: 'reviewer-1',
      }),
    })
    assert.equal(statusResponse.status, 200)
    const statusBody = await readJson(statusResponse)
    const reviewedArtifact = asRecord(statusBody.artifact)
    assert.equal(reviewedArtifact.status, 'in-review')
    assert.equal(reviewedArtifact.statusUpdatedBy, 'reviewer-1')
    assert.equal('key' in reviewedArtifact, false)

    const principal = {
      tenantId: 'tenant-1',
      tenantName: 'Tenant 1',
      orgId: 'tenant-1',
      userId: 'user-1',
      accountId: 'user-1',
      email: 'user@example.test',
      role: 'owner' as const,
      authSource: 'local' as const,
    }
    const eventsAfterReview = await fixture.service.listEvents(principal, sessionId)
    const firstUpdatePayload = asRecord(eventsAfterReview.find((event) => event.type === 'artifact.updated')?.payload)
    assert.equal(firstUpdatePayload.statusUpdatedBy, 'reviewer-1')
    assert.equal('key' in firstUpdatePayload, false)

    const regressionResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'draft', updatedBy: 'reviewer-1' }),
    })
    assert.equal(regressionResponse.status, 409)

    const finalResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'final' }),
    })
    assert.equal(finalResponse.status, 200)
    const finalArtifact = asRecord(asRecord(await readJson(finalResponse)).artifact)
    assert.equal(finalArtifact.status, 'final')
    assert.equal(finalArtifact.statusUpdatedBy, null)
    assert.equal('key' in finalArtifact, false)

    const updateEvents = (await fixture.service.listEvents(principal, sessionId)).filter((event) => event.type === 'artifact.updated')
    assert.equal(updateEvents.length, 2)
    const finalUpdatePayload = asRecord(updateEvents.at(-1)?.payload)
    assert.equal(finalUpdatePayload.status, 'final')
    assert.equal(finalUpdatePayload.statusUpdatedBy, null)
    assert.equal('key' in finalUpdatePayload, false)

    const read = await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${uploaded.artifactId}`))
    const artifact = asRecord(read.artifact)
    assert.equal(Buffer.from(String(artifact.dataBase64), 'base64').toString('utf8'), 'cloud artifact')
    assert.equal(artifact.status, 'final')
    assert.equal(artifact.statusUpdatedBy, null)
    assert.equal('key' in artifact, false)
    const usage = await readJson(await fetch(`${baseUrl}/api/usage/events`))
    const usageEvents = asArray(usage.events).map(asRecord)
    const downloaded = usageEvents.find((event) => event.eventType === 'artifact.downloaded')
    assert.equal(downloaded?.quantity, 'cloud artifact'.length)

    await assert.rejects(() => fixture.artifacts.readSessionArtifact({
      tenantId: 'tenant-2',
      orgId: 'tenant-2',
      tenantName: 'Tenant 2',
      userId: 'user-2',
      accountId: 'user-2',
      email: 'user2@example.test',
      role: 'owner' as const,
      authSource: 'user' as const,
    }, sessionId, String(uploaded.artifactId)), /Cloud session was not found|Unknown session|Unknown tenant/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP artifact download hands back a presigned URL when the store supports it, else buffers (F4)', async () => {
  const inner = createInMemoryObjectStore()
  let presignedKey: string | null = null
  // A presign-capable store: real storage stays in-memory (so the buffered fallback still
  // works), but presignGet returns a direct URL — modelling the S3 adapter's behaviour.
  const presigningStore: ObjectStoreAdapter = {
    ...inner,
    async presignGet(key) {
      presignedKey = key
      return { method: 'GET', url: `https://object-store.test/${key}?sig=test`, headers: {}, expiresAt: '2099-01-01T00:00:00.000Z' }
    },
  }
  const fixture = createFixture({ objectStore: presigningStore, abuse: testAbuseConfig() })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const uploaded = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain', dataBase64: Buffer.from('direct transfer').toString('base64') }),
    }))).artifact)
    const artifactId = String(uploaded.artifactId)

    // Opt-in presigned transfer ⇒ a direct download URL, no base64 buffered through the pod.
    const presigned = asRecord(asRecord(await readJson(await fetch(
      `${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}?transfer=presigned`,
    ))).artifact)
    assert.equal(presigned.transfer, 'presigned')
    assert.match(String(presigned.downloadUrl), /^https:\/\/object-store\.test\//)
    assert.equal(presigned.downloadExpiresAt, '2099-01-01T00:00:00.000Z')
    assert.equal('dataBase64' in presigned, false)
    assert.equal('key' in presigned, false)
    assert.ok(presignedKey, 'expected the store to be asked to presign the artifact key')

    // Presign download still records usage (attributed by the recorded size).
    const usageEvents = asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/usage/events`))).events).map(asRecord)
    assert.equal(usageEvents.find((event) => event.eventType === 'artifact.downloaded')?.quantity, 'direct transfer'.length)

    // Default (no opt-in) ⇒ buffered base64 response is unchanged.
    const buffered = asRecord(asRecord(await readJson(await fetch(
      `${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}`,
    ))).artifact)
    assert.equal(Buffer.from(String(buffered.dataBase64), 'base64').toString('utf8'), 'direct transfer')
    assert.equal('downloadUrl' in buffered, false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP artifact download falls back to buffered base64 when the store cannot presign (F4)', async () => {
  // The default in-memory store has no presign capability, so ?transfer=presigned must
  // transparently fall back to the buffered base64 response.
  const fixture = createFixture({ abuse: testAbuseConfig() })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const uploaded = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain', dataBase64: Buffer.from('buffered body').toString('base64') }),
    }))).artifact)
    const artifactId = String(uploaded.artifactId)

    const download = asRecord(asRecord(await readJson(await fetch(
      `${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}?transfer=presigned`,
    ))).artifact)
    assert.equal(Buffer.from(String(download.dataBase64), 'base64').toString('utf8'), 'buffered body')
    assert.equal('downloadUrl' in download, false)
    assert.equal('transfer' in download, false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP artifact upload reserves before exact POST and finalizes idempotently (F4)', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const uploadBody = Buffer.from('direct upload body')
  const abuse = testAbuseConfig({ maxArtifactBytesPerDay: uploadBody.byteLength })
  const provider = createAttestedTestObjectStore(() => now)
  const fixture = createDirectUploadFixture({ objectStore: provider.store, abuse, now: () => now })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const artifactId = '11111111-1111-4111-8111-111111111111'
    const checksumSha256 = createHash('sha256').update(uploadBody).digest('hex')
    const begin = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId,
        checksumSha256,
        filename: 'report.txt',
        contentType: 'text/plain',
        expectedSize: uploadBody.byteLength,
        status: 'in-review',
        statusUpdatedBy: 'reviewer-1',
      }),
    }))).upload)
    assert.equal(begin.transfer, 'presigned')
    assert.match(String(begin.uploadUrl), /^https:\/\/object-store\.test\//)
    assert.equal(begin.uploadMethod, 'POST')
    assert.equal(begin.artifactId, artifactId)
    const uploadFields = asRecord(begin.uploadFields)
    const stagingKey = String(uploadFields.key)
    assert.match(stagingKey, /^artifact-uploads\/staging\/[0-9a-f]{64}$/)
    assert.doesNotMatch(stagingKey, /tenant|session|report/)
    assert.equal(uploadFields.checksum, checksumSha256)

    await provider.base.putObject({ key: stagingKey, body: uploadBody, contentType: 'text/plain' })
    // Lower the quota after the object has landed. Because begin reserved the declared
    // bytes and finalize only settles the delta, this valid upload must still complete.
    abuse.maxArtifactBytesPerDay = 1

    const finalized = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'report.txt',
        contentType: 'text/plain',
        status: 'in-review',
        statusUpdatedBy: 'reviewer-1',
      }),
    }))).artifact)
    assert.equal(finalized.filename, 'report.txt')
    assert.equal(finalized.contentType, 'text/plain')
    assert.equal(finalized.size, uploadBody.byteLength)
    assert.equal(finalized.status, 'in-review')
    assert.equal(finalized.statusUpdatedBy, 'reviewer-1')
    assert.equal(finalized.statusUpdatedAt, finalized.createdAt)
    assert.equal(String(finalized.cloudArtifactId || finalized.artifactId), artifactId)
    const finalizedRetry = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'report.txt',
        contentType: 'text/plain',
        status: 'in-review',
        statusUpdatedBy: 'reviewer-1',
      }),
    }))).artifact)
    assert.equal(String(finalizedRetry.cloudArtifactId || finalizedRetry.artifactId), artifactId)
    const reservation = await fixture.store.getArtifactUploadReservation({
      orgId: 'tenant-1',
      tenantId: 'tenant-1',
      sessionId,
      artifactId,
    })
    assert.ok(reservation)
    assert.equal(await fixture.service.isFinalizedArtifactUploadPublished(reservation), true)
    assert.equal(await fixture.service.isFinalizedArtifactUploadPublished({
      ...reservation,
      finalObjectKey: `${reservation.finalObjectKey}-tampered`,
    }), false)

    // The finalized artifact now shows up in the session's artifact list, like a buffered upload.
    const listed = asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))).artifacts).map(asRecord)
    assert.equal(listed.some((entry) => String(entry.cloudArtifactId || entry.artifactId) === artifactId), true)

    // Finalize attributes the uploaded bytes for usage/billing, exactly like the buffered path.
    const usageEvents = asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/usage/events`))).events).map(asRecord)
    const uploadEvents = usageEvents.filter((event) => event.eventType === 'artifact.uploaded')
    assert.equal(uploadEvents.length, 1)
    assert.equal(uploadEvents[0]?.quantity, uploadBody.byteLength)

    // Once terminal reservation retention eventually prunes the saga row, the durable
    // publication still owns this UUID. A new begin must not reuse deterministic keys,
    // projected-event identity, or usage identity for the published artifact.
    now.setTime(Date.parse(reservation.expiresAt) + 1)
    assert.equal((await fixture.lifecycle.reconcile({
      claimOwner: 'cleanup-worker',
      claimTtlMs: 30_000,
      limit: 1,
    })).stagingCleaned, 0)
    now.setTime(now.getTime() + ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS + 1)
    assert.equal((await fixture.lifecycle.reconcile({
      claimOwner: 'cleanup-worker',
      claimTtlMs: 30_000,
      limit: 1,
    })).stagingCleaned, 1)
    assert.ok((await fixture.store.getArtifactUploadReservation({
      orgId: 'tenant-1',
      tenantId: 'tenant-1',
      sessionId,
      artifactId,
    }))?.stagingCleanedAt)
    assert.equal(await fixture.store.pruneArtifactUploadReservations({
      olderThan: new Date(now.getTime() + 1),
      limit: 1,
    }), 1)
    const reused = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId,
        checksumSha256,
        filename: 'replacement.txt',
        contentType: 'text/plain',
        expectedSize: uploadBody.byteLength,
      }),
    })
    assert.equal(reused.status, 409)
    assert.equal(provider.presignCalls(), 1)

    const missing = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/22222222-2222-4222-8222-222222222222/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain' }),
    })
    assert.equal(missing.status, 409)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP unexpected direct-upload errors emit only route templates', async () => {
  const logs: unknown[] = []
  const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const artifactId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const objectKey = 'artifact-uploads/staging/private-customer-object'
  const observability: CloudObservabilityAdapter = {
    log(record) { logs.push(record) },
    metric() {},
    span() {},
  }
  const fixture = createFixture({
    observability,
    artifactServiceFactory({ service, objectStore, ids }) {
      const artifacts = new CloudArtifactService(service, objectStore, ids)
      artifacts.finalizeSessionArtifactUpload = async () => {
        throw new Error(`provider unavailable for ${sessionId}/${artifactId} at ${objectKey}`)
      }
      return artifacts
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain' }),
    })
    assert.equal(response.status, 500)
    await response.text()
    await new Promise((resolve) => setImmediate(resolve))

    const unexpected = logs.find((record) => (
      (record as Record<string, unknown>).name === 'cloud.http.unexpected_error'
    )) as Record<string, unknown> | undefined
    assert.ok(unexpected)
    assert.equal(unexpected.message, 'Unexpected cloud HTTP request failure.')
    const attributes = unexpected.attributes as Record<string, unknown>
    assert.equal(
      attributes['url.path'],
      '/api/sessions/:sessionId/artifacts/:artifactId/finalize',
    )
    assert.equal(attributes.error_code, 'unexpected_http_error')
    assert.equal('error_name' in attributes, false)
    assert.equal('error_message' in attributes, false)
    const telemetry = JSON.stringify(logs)
    assert.equal(telemetry.includes(sessionId), false)
    assert.equal(telemetry.includes(artifactId), false)
    assert.equal(telemetry.includes(objectKey), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP size-enforced presigned upload rejects missing, oversized, and over-quota declarations without returning a URL', async () => {
  const provider = createAttestedTestObjectStore()
  const fixture = createDirectUploadFixture({
    objectStore: provider.store,
    abuse: testAbuseConfig({ maxArtifactBytesPerDay: 8 }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const begin = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: '33333333-3333-4333-8333-333333333333',
        checksumSha256: '0'.repeat(64),
        filename: 'missing-size.bin',
        contentType: 'application/octet-stream',
      }),
    })
    assert.equal(begin.status, 400)
    const body = await readJson(begin)
    assert.match(String(body.error), /expectedSize/)
    assert.equal(provider.presignCalls(), 0)
    assert.equal(
      fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day'),
      undefined,
    )

    const oversized = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: '44444444-4444-4444-8444-444444444444',
        checksumSha256: '0'.repeat(64),
        filename: 'oversized.bin',
        contentType: 'application/octet-stream',
        expectedSize: 25 * 1024 * 1024 + 1,
      }),
    })
    assert.equal(oversized.status, 413)
    assert.equal('upload' in await readJson(oversized), false)
    assert.equal(provider.presignCalls(), 0)

    const overQuota = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId: '55555555-5555-4555-8555-555555555555',
        checksumSha256: '0'.repeat(64),
        filename: 'over-quota.bin',
        contentType: 'application/octet-stream',
        expectedSize: 9,
      }),
    })
    assert.equal(overQuota.status, 429)
    assert.equal('upload' in await readJson(overQuota), false)
    assert.equal(provider.presignCalls(), 0)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP rejects malformed provider credentials without exposing them and tombstones each reservation', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const provider = createAttestedTestObjectStore(() => now)
  const fixture = createDirectUploadFixture({
    objectStore: provider.store,
    now: () => now,
    abuse: testAbuseConfig({ maxArtifactBytesPerDay: 100 }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const validFields = { key: 'opaque-staging-key' }
    const cases: Array<{
      name: string
      response: () => unknown
    }> = [
      {
        name: 'non-date expiry',
        response: () => ({
          method: 'POST', url: 'https://object-store.test/upload', fields: validFields, expiresAt: 'NaN',
        }),
      },
      {
        name: 'past expiry',
        response: () => ({
          method: 'POST',
          url: 'https://object-store.test/upload',
          fields: validFields,
          expiresAt: new Date(now.getTime() - 1).toISOString(),
        }),
      },
      {
        name: 'expiry beyond the reservation',
        response: () => ({
          method: 'POST',
          url: 'https://object-store.test/upload',
          fields: validFields,
          expiresAt: new Date(now.getTime() + 15 * 60 * 1_000 + 1).toISOString(),
        }),
      },
      {
        name: 'cross-origin URL',
        response: () => ({
          method: 'POST',
          url: 'https://attacker.example.test/upload',
          fields: validFields,
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      },
      {
        name: 'non-plain fields',
        response: () => ({
          method: 'POST',
          url: 'https://object-store.test/upload',
          fields: Object.assign(Object.create({ inherited: 'not-allowed' }), validFields),
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      },
      {
        name: 'oversized fields',
        response: () => ({
          method: 'POST',
          url: 'https://object-store.test/upload',
          fields: { key: 'x'.repeat(16_385) },
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
        }),
      },
    ]
    const uploadCapability = provider.store.presignedUpload!
    for (const [index, scenario] of cases.entries()) {
      uploadCapability.presignPost = async () => scenario.response() as ObjectStorePresignedPostRequest
      const artifactId = `77777777-7777-4777-8${String(index).padStart(3, '0')}-777777777777`
      const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          artifactId,
          checksumSha256: '0'.repeat(64),
          filename: `${scenario.name}.bin`,
          contentType: 'application/octet-stream',
          expectedSize: 1,
        }),
      })
      assert.equal(response.status, 503, scenario.name)
      assert.equal('upload' in await readJson(response), false, scenario.name)
      const reservation = await fixture.store.getArtifactUploadReservation({
        orgId: 'tenant-1',
        tenantId: 'tenant-1',
        sessionId,
        artifactId,
      })
      assert.ok(reservation, scenario.name)
      assert.equal(reservation.status, 'cleanup_pending', scenario.name)
      assert.equal(reservation.cleanupReason, 'aborted', scenario.name)
      assert.equal(reservation.cleanupPasses, 0, scenario.name)
      assert.equal(reservation.nextCleanupAttemptAt, reservation.expiresAt, scenario.name)
      assert.equal(await provider.base.headObject(reservation.stagingObjectKey), null, scenario.name)
      assert.equal(
        fixture.store.listUsageQuotaCounters('tenant-1')
          .find((counter) => counter.quotaKey === 'artifact_bytes:day')?.quantity,
        index + 1,
        scenario.name,
      )
    }
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP direct-upload abort quarantines late writes before idempotent cleanup and quota release', async () => {
  const now = new Date('2026-08-02T12:00:00.000Z')
  const uploadBody = Buffer.from('aborted direct upload')
  const provider = createAttestedTestObjectStore(() => now)
  const fixture = createDirectUploadFixture({
    objectStore: provider.store,
    now: () => now,
    abuse: testAbuseConfig({ maxArtifactBytesPerDay: uploadBody.byteLength }),
  })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)
    const artifactId = '66666666-6666-4666-8666-666666666666'
    const begin = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        artifactId,
        checksumSha256: createHash('sha256').update(uploadBody).digest('hex'),
        filename: 'aborted.txt',
        contentType: 'text/plain',
        expectedSize: uploadBody.byteLength,
      }),
    }))).upload)
    const stagingKey = String(asRecord(begin.uploadFields).key)
    assert.equal(fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day')?.quantity, uploadBody.byteLength)
    await provider.base.putObject({ key: stagingKey, body: uploadBody, contentType: 'text/plain' })

    const abort = () => fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/abort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal((await abort()).status, 200)
    assert.equal((await abort()).status, 200)
    assert.notEqual(await provider.base.headObject(stagingKey), null)
    assert.equal(fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day')?.quantity, uploadBody.byteLength)
    const quarantined = await fixture.store.getArtifactUploadReservation({
      orgId: 'tenant-1',
      tenantId: 'tenant-1',
      sessionId,
      artifactId,
    })
    assert.ok(quarantined)
    assert.equal(quarantined.status, 'cleanup_pending')
    assert.equal(quarantined.cleanupPasses, 0)

    now.setTime(Date.parse(quarantined.expiresAt) + 1)
    const firstPass = await fixture.lifecycle.reconcile({
      claimOwner: 'cleanup-worker',
      claimTtlMs: 30_000,
      limit: 1,
    })
    assert.equal(firstPass.claimed, 1)
    assert.equal(firstPass.cleaned, 0)
    assert.equal(await provider.base.headObject(stagingKey), null)
    assert.equal(fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day')?.quantity, uploadBody.byteLength)

    await provider.base.putObject({ key: stagingKey, body: uploadBody, contentType: 'text/plain' })
    now.setTime(now.getTime() + ARTIFACT_UPLOAD_CLEANUP_CONFIRMATION_HORIZON_MS + 1)
    const confirmationPass = await fixture.lifecycle.reconcile({
      claimOwner: 'cleanup-worker',
      claimTtlMs: 30_000,
      limit: 1,
    })
    assert.equal(confirmationPass.claimed, 1)
    assert.equal(confirmationPass.cleaned, 1)
    assert.equal(await provider.base.headObject(stagingKey), null)
    assert.equal(fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day')?.quantity, 0)
    assert.equal((await fixture.service.listEvents({
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: 'user@example.test',
      role: 'owner',
      authSource: 'local',
    }, sessionId)).some((event) => event.type === 'artifact.created'), false)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP S3 upload begin fails closed to buffered transfer while downloads remain presign-capable', async () => {
  const objectStore = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    region: 'eu-west-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: { send: async () => ({}), destroy() {} } as never,
  })
  const fixture = createFixture({ objectStore, abuse: testAbuseConfig() })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    const begin = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain', expectedSize: 'buffered body'.length }),
    }))).upload)
    assert.equal(begin.transfer, 'unsupported')
    assert.equal('uploadUrl' in begin, false)
    assert.equal(typeof objectStore.presignGet, 'function')

    // The buffered upload (no transfer opt-in) is unchanged and still records the artifact.
    const uploaded = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain', dataBase64: Buffer.from('buffered body').toString('base64') }),
    }))).artifact)
    assert.equal(uploaded.size, 'buffered body'.length)
    const download = asRecord(asRecord(await readJson(await fetch(
      `${baseUrl}/api/sessions/${sessionId}/artifacts/${String(uploaded.artifactId)}?transfer=presigned`,
    ))).artifact)
    assert.equal(download.transfer, 'presigned')
    assert.match(String(download.downloadUrl), /X-Amz-Signature=/)
  } finally {
    await fixture.server.close()
  }
})

test('cloud artifact index reads persisted rows without paging sessions', async () => {
  const principal: CloudPrincipal = {
    tenantId: 'tenant-1',
    tenantName: 'Tenant 1',
    orgId: 'tenant-1',
    userId: 'user-1',
    accountId: 'user-1',
    email: 'user1@example.test',
    role: 'owner',
    authSource: 'user',
  }
  const indexRequests: unknown[] = []
  const sessionService = {
    async listSessionsPage() {
      assert.fail('Artifact index must not page sessions.')
    },
    async getSessionView() {
      assert.fail('Artifact index must not hydrate session projections.')
    },
    async listEvents() {
      assert.fail('Artifact index must not replay session events.')
    },
    async listCloudArtifactIndex(_principal: CloudPrincipal, request: Record<string, unknown>) {
      indexRequests.push(request)
      return {
        items: [{
          tenantId: 'tenant-1',
          userId: 'user-1',
          sessionId: 'session-artifact',
          sessionTitle: 'Artifact session',
          artifactId: 'artifact-newer',
          filename: 'newer.txt',
          contentType: 'text/plain',
          size: 7,
          key: 'tenants/tenant-1/private-object-key-newer',
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          kind: 'document',
          status: 'draft',
          authorAgentId: 'agent-writer',
          projectId: 'project-1',
          taskId: 'task-1',
          statusUpdatedBy: null,
          statusUpdatedAt: null,
        }],
        totalEstimate: 2,
        truncated: true,
      }
    },
  } as unknown as CloudSessionService
  const artifacts = new CloudArtifactService(sessionService, createInMemoryObjectStore())

  const indexed = await artifacts.listArtifactIndex(principal, {
    projectId: 'project-with-task-only-artifacts',
    taskIds: ['task-1'],
    limit: 1,
  })
  assert.equal(indexed.artifacts.length, 1)
  assert.equal(indexed.artifacts[0]?.artifactId, 'artifact-newer')
  assert.equal(indexed.artifacts[0]?.sessionTitle, 'Artifact session')
  assert.equal(indexed.total, 2)
  assert.equal(indexed.scannedSessions, 0)
  assert.equal('key' in indexed.artifacts[0]!, false)
  assert.equal(indexed.truncated, true)
  assert.deepEqual(indexRequests, [{
    sessionId: undefined,
    projectId: 'project-with-task-only-artifacts',
    taskId: undefined,
    taskIds: ['task-1'],
    status: undefined,
    kind: undefined,
    limit: 1,
  }])
})

test('cloud HTTP returns policy verdicts when artifacts are disabled', async () => {
  const basePolicy = resolveCloudRuntimePolicy(DEFAULT_CONFIG)
  const fixture = createFixture({
    policy: {
      ...basePolicy,
      features: {
        ...basePolicy.features,
        artifacts: false,
      },
    },
  })
  const baseUrl = await fixture.server.listen()
  try {
    const response = await fetch(`${baseUrl}/api/sessions/oc-session-1/artifacts`)
    assert.equal(response.status, 403)
    const body = await readJson(response)
    assert.match(String(body.error), /Artifacts are disabled/)
    assert.deepEqual(asRecord(body.verdict), {
      allowed: false,
      reason: 'Artifacts are disabled for this cloud profile.',
      policyCode: 'artifacts.disabled',
    })
    const indexResponse = await fetch(`${baseUrl}/api/artifacts`)
    assert.equal(indexResponse.status, 403)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP admin audit log is queryable, filterable, and exportable (JSON + CSV)', async () => {
  const fixture = createFixture()
  const baseUrl = await fixture.server.listen()
  try {
    // Creating a session emits a fire-and-forget session.created data-plane audit event.
    const createdResponse = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(createdResponse.status, 201)

    // Poll the query endpoint until the async emission lands (best-effort, non-blocking).
    let events: Array<Record<string, unknown>> = []
    for (let attempt = 0; attempt < 200 && events.length === 0; attempt += 1) {
      const page = await readJson(await fetch(`${baseUrl}/api/admin/audit?action=session.`))
      events = asArray(page.events) as Array<Record<string, unknown>>
      if (events.length === 0) await new Promise((resolve) => setImmediate(resolve))
    }
    assert.ok(events.some((event) => event.eventType === 'session.created'), 'session.created is queryable')

    // The paginated query shape carries a nextCursor (null when the page is the last).
    const firstPage = await readJson(await fetch(`${baseUrl}/api/admin/audit?limit=100`))
    assert.ok('nextCursor' in firstPage)

    // JSON export streams an attachment with the redacted event set.
    const jsonExport = await fetch(`${baseUrl}/api/admin/audit/export?format=json&action=session.`)
    assert.equal(jsonExport.status, 200)
    assert.match(jsonExport.headers.get('content-type') || '', /application\/json/)
    assert.match(jsonExport.headers.get('content-disposition') || '', /attachment; filename=/)
    const exportBody = JSON.parse(await jsonExport.text()) as { events: Array<Record<string, unknown>> }
    assert.ok(exportBody.events.some((event) => event.eventType === 'session.created'))

    // CSV export streams a header row + one row per event.
    const csvExport = await fetch(`${baseUrl}/api/admin/audit/export?format=csv`)
    assert.equal(csvExport.status, 200)
    assert.match(csvExport.headers.get('content-type') || '', /text\/csv/)
    const csv = await csvExport.text()
    assert.ok(csv.startsWith('eventId,createdAt,orgId,'))
  } finally {
    await fixture.server.close()
  }
})
