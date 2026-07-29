import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import { CloudArtifactService } from '@open-cowork/cloud-server/artifact-service'
import { resolveCloudRuntimePolicy } from '@open-cowork/cloud-server/cloud-config'
import {
  createInMemoryObjectStore,
  createS3CompatibleObjectStore,
  type ObjectStoreAdapter,
} from '@open-cowork/cloud-server/object-store'
import { CloudSessionService, type CloudPrincipal } from '@open-cowork/cloud-server/session-service'
import { createFixture } from './helpers/cloud-http-fixture.ts'
import {
  readJson,
  asRecord,
  asArray,
  testAbuseConfig,
} from './helpers/cloud-http-test-support.ts'

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

test('cloud HTTP artifact upload issues a presigned PUT, then finalize records the row (F4)', async () => {
  const inner = createInMemoryObjectStore()
  let presignedPutKey: string | null = null
  const uploadBody = Buffer.from('direct upload body')
  const abuse = testAbuseConfig({ maxArtifactBytesPerDay: uploadBody.byteLength })
  // A size-enforcing adapter hands back a direct PUT URL; real storage stays in-memory so
  // the test can simulate the landed PUT and finalize's headObject finds it.
  const presigningStore: ObjectStoreAdapter = {
    ...inner,
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 25 * 1024 * 1024,
      async presignPut(input) {
        presignedPutKey = input.key
        assert.equal(input.expectedSize, uploadBody.byteLength)
        return {
          method: 'PUT',
          url: `https://object-store.test/${input.key}?sig=put`,
          headers: input.contentType ? { 'content-type': input.contentType } : {},
          expiresAt: '2099-01-01T00:00:00.000Z',
        }
      },
    },
  }
  const fixture = createFixture({ objectStore: presigningStore, abuse })
  const baseUrl = await fixture.server.listen()
  try {
    const created = await readJson(await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))
    const sessionId = String(asRecord(created.session).sessionId)

    // Begin: ask for a presigned upload. The store supports it, so we get a direct PUT URL.
    const begin = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain', expectedSize: uploadBody.byteLength }),
    }))).upload)
    assert.equal(begin.transfer, 'presigned')
    assert.match(String(begin.uploadUrl), /^https:\/\/object-store\.test\//)
    assert.equal(begin.uploadMethod, 'PUT')
    assert.equal(begin.uploadExpiresAt, '2099-01-01T00:00:00.000Z')
    assert.deepEqual(begin.uploadHeaders, { 'content-type': 'text/plain' })
    const artifactId = String(begin.artifactId)
    assert.ok(artifactId)
    assert.ok(presignedPutKey, 'expected the store to be asked to presign the upload key')

    // Simulate the client PUTting bytes directly to the object store at the presigned key.
    await inner.putObject({ key: presignedPutKey!, body: uploadBody, contentType: 'text/plain' })
    // Lower the quota after the object has landed. Because begin reserved the declared
    // bytes and finalize only settles the delta, this valid upload must still complete.
    abuse.maxArtifactBytesPerDay = 1

    // Finalize: record the metadata row. Size is read authoritatively from the store (headObject).
    const finalized = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain' }),
    }))).artifact)
    assert.equal(finalized.filename, 'report.txt')
    assert.equal(finalized.contentType, 'text/plain')
    assert.equal(finalized.size, uploadBody.byteLength)
    assert.equal(String(finalized.cloudArtifactId || finalized.artifactId), artifactId)
    const finalizedRetry = asRecord(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain' }),
    }))).artifact)
    assert.equal(String(finalizedRetry.cloudArtifactId || finalizedRetry.artifactId), artifactId)

    // The finalized artifact now shows up in the session's artifact list, like a buffered upload.
    const listed = asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts`))).artifacts).map(asRecord)
    assert.equal(listed.some((entry) => String(entry.cloudArtifactId || entry.artifactId) === artifactId), true)

    // Finalize attributes the uploaded bytes for usage/billing, exactly like the buffered path.
    const usageEvents = asArray(asRecord(await readJson(await fetch(`${baseUrl}/api/usage/events`))).events).map(asRecord)
    const uploadEvents = usageEvents.filter((event) => event.eventType === 'artifact.uploaded')
    assert.equal(uploadEvents.length, 1)
    assert.equal(uploadEvents[0]?.quantity, uploadBody.byteLength)

    // Finalize before the PUT lands is a 409 (object missing), so the client can retry/fall back.
    const missing = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}-not-real/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'report.txt', contentType: 'text/plain' }),
    })
    assert.equal(missing.status, 409)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP size-enforced presigned upload rejects missing, oversized, and over-quota declarations without returning a URL', async () => {
  const inner = createInMemoryObjectStore()
  let presignCalls = 0
  const fixture = createFixture({
    objectStore: {
      ...inner,
      presignedUpload: {
        enforcement: 'exact-content-length',
        maxBytes: 25 * 1024 * 1024,
        async presignPut() {
          presignCalls += 1
          return {
            method: 'PUT',
            url: 'https://object-store.test/should-not-be-minted',
            headers: {},
            expiresAt: '2099-01-01T00:00:00.000Z',
          }
        },
      },
    },
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
      body: JSON.stringify({ filename: 'missing-size.bin', contentType: 'application/octet-stream' }),
    })
    assert.equal(begin.status, 400)
    const body = await readJson(begin)
    assert.match(String(body.error), /expectedSize/)
    assert.equal(presignCalls, 0)
    assert.equal(
      fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day'),
      undefined,
    )

    const oversized = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'oversized.bin',
        contentType: 'application/octet-stream',
        expectedSize: 25 * 1024 * 1024 + 1,
      }),
    })
    assert.equal(oversized.status, 413)
    assert.equal('upload' in await readJson(oversized), false)
    assert.equal(presignCalls, 0)

    const overQuota = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts?transfer=presigned`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filename: 'over-quota.bin',
        contentType: 'application/octet-stream',
        expectedSize: 9,
      }),
    })
    assert.equal(overQuota.status, 429)
    assert.equal('upload' in await readJson(overQuota), false)
    assert.equal(presignCalls, 1)
  } finally {
    await fixture.server.close()
  }
})

test('cloud HTTP presigned artifact upload expiration deletes landed objects and releases quota', async () => {
  const inner = createInMemoryObjectStore()
  let presignedPutKey: string | null = null
  const expiredBody = Buffer.from('expired direct upload')
  const presigningStore: ObjectStoreAdapter = {
    ...inner,
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 25 * 1024 * 1024,
      async presignPut(input) {
        presignedPutKey = input.key
        return {
          method: 'PUT',
          url: `https://object-store.test/${input.key}?sig=expired`,
          headers: input.contentType ? { 'content-type': input.contentType } : {},
          expiresAt: '2000-01-01T00:00:00.000Z',
        }
      },
    },
  }
  const fixture = createFixture({
    objectStore: presigningStore,
    abuse: testAbuseConfig({ maxArtifactBytesPerDay: expiredBody.byteLength }),
  })
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
      body: JSON.stringify({ filename: 'expired.txt', contentType: 'text/plain', expectedSize: expiredBody.byteLength }),
    }))).upload)
    const artifactId = String(begin.artifactId)
    assert.ok(presignedPutKey)
    assert.equal(fixture.store.listUsageQuotaCounters('tenant-1').find((counter) => counter.quotaKey === 'artifact_bytes:day')?.quantity, expiredBody.byteLength)
    await inner.putObject({ key: presignedPutKey!, body: expiredBody, contentType: 'text/plain' })

    const expired = await fetch(`${baseUrl}/api/sessions/${sessionId}/artifacts/${artifactId}/finalize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'expired.txt', contentType: 'text/plain' }),
    })
    assert.equal(expired.status, 409)
    assert.equal(await inner.headObject(presignedPutKey!), null)
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
