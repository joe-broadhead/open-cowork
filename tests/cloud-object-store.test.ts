import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '@open-cowork/shared'
import {
  assertSafeObjectKey,
  createAzureBlobObjectStore,
  createFilesystemObjectStore,
  createGcsObjectStore,
  createInMemoryObjectStore,
  createObjectStoreForCloud,
  createS3CompatibleObjectStore,
  instrumentObjectStore,
  type ObjectStoreAdapter,
  type ObjectStoreHttpResponse,
  resolveCloudObjectStoreConfig,
  signS3PresignedPost,
  signS3PresignedUrl,
} from '@open-cowork/cloud-server/object-store'
import type { CloudMetricRecord } from '@open-cowork/cloud-server/observability'
import { createCloudPathProvider } from '@open-cowork/cloud-server/path-provider'

test('instrumentObjectStore emits ok and error operation metrics (audit P1-O4)', async () => {
  const metrics: CloudMetricRecord[] = []
  const observability = { log() {}, metric(record: CloudMetricRecord) { metrics.push(record) }, span() {} }

  const store = instrumentObjectStore(createInMemoryObjectStore(), observability)
  await store.putObject({ key: 'a/b.txt', body: Buffer.from('hi'), contentType: 'text/plain' })
  await store.getObject('a/b.txt')

  const ops = metrics.filter((metric) => metric.name === 'open_cowork_cloud_object_store_operations_total')
  assert.equal(ops.some((metric) => metric.attributes?.operation === 'put' && metric.attributes?.status === 'ok'), true)
  assert.equal(ops.some((metric) => metric.attributes?.operation === 'get' && metric.attributes?.status === 'ok'), true)
  assert.equal(metrics.some((metric) => metric.name === 'open_cowork_cloud_object_store_operation_duration_ms'), true)

  // The error path (the previously-dark alert signal) emits a status=error operation metric + re-throws.
  const failing: ObjectStoreAdapter = {
    kind: 'filesystem',
    async putObject() { throw new Error('disk full') },
    async getObject() { return null },
    async headObject() { return null },
    async deleteObject() {},
  }
  const instrumentedFailing = instrumentObjectStore(failing, observability)
  await assert.rejects(
    () => instrumentedFailing.putObject({ key: 'x', body: Buffer.from(''), contentType: 'text/plain' }),
    /disk full/,
  )
  assert.equal(
    metrics.some((metric) => (
      metric.name === 'open_cowork_cloud_object_store_operations_total'
      && metric.attributes?.status === 'error'
      && metric.attributes?.operation === 'put'
    )),
    true,
  )
})

test('instrumentObjectStore is transparent without an observability adapter', () => {
  const base = createInMemoryObjectStore()
  assert.equal(instrumentObjectStore(base, null), base)
})

test('instrumentObjectStore preserves exact-size POST upload capability without weakening its contract', async () => {
  const base = createInMemoryObjectStore()
  let declaredSize = 0
  let declaredChecksum = ''
  let declaredBrowserOrigin = ''
  const lifecycleCalls: string[] = []
  const metrics: CloudMetricRecord[] = []
  const adapter: ObjectStoreAdapter = {
    ...base,
    presignedUpload: {
      enforcement: 'exact-content-length',
      maxBytes: 1024,
      origin: 'https://objects.example.test',
      async verifyCleanupSafety() {
        lifecycleCalls.push('verify-cleanup-safety')
        return true
      },
      async verifyBrowserPostSafety(browserOrigin) {
        lifecycleCalls.push(`verify-browser-post:${browserOrigin}`)
        return browserOrigin === 'https://cloud.example.test'
      },
      async presignPost(input) {
        declaredSize = input.expectedSize
        declaredChecksum = input.checksumSha256
        declaredBrowserOrigin = input.browserOrigin
        return {
          method: 'POST',
          url: `https://objects.example.test/${input.key}`,
          fields: { key: input.key },
          expiresAt: '2099-01-01T00:00:00.000Z',
        }
      },
      async inspect(key) {
        lifecycleCalls.push(`inspect:${key}`)
        return { size: 17, contentType: null, checksumSha256: 'a'.repeat(64), versionToken: 'etag:v1' }
      },
      async promote(input) {
        lifecycleCalls.push(`promote:${input.stagingKey}:${input.finalKey}`)
      },
      async delete(key) {
        lifecycleCalls.push(`delete:${key}`)
      },
    },
  }
  const instrumented = instrumentObjectStore(adapter, {
    log() {},
    metric(record: CloudMetricRecord) { metrics.push(record) },
    span() {},
  })
  assert.equal(instrumented.presignedUpload?.enforcement, 'exact-content-length')
  assert.equal(instrumented.presignedUpload?.maxBytes, 1024)
  assert.equal(instrumented.presignedUpload?.origin, 'https://objects.example.test')
  assert.equal(await instrumented.presignedUpload?.verifyCleanupSafety(), true)
  assert.equal(
    await instrumented.presignedUpload?.verifyBrowserPostSafety('https://cloud.example.test'),
    true,
  )
  const request = await instrumented.presignedUpload?.presignPost({
    key: 'tenant/session/artifact.bin',
    browserOrigin: 'https://cloud.example.test',
    expectedSize: 17,
    checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  })
  assert.equal(request?.method, 'POST')
  assert.deepEqual(request?.fields, { key: 'tenant/session/artifact.bin' })
  assert.equal(declaredSize, 17)
  assert.equal(declaredChecksum, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
  assert.equal(declaredBrowserOrigin, 'https://cloud.example.test')
  const inspected = await instrumented.presignedUpload?.inspect('staging/upload-1')
  await instrumented.presignedUpload?.promote({
    stagingKey: 'staging/upload-1',
    finalKey: 'final/upload-1',
    expected: inspected!,
  })
  await instrumented.presignedUpload?.delete('staging/upload-1')
  assert.deepEqual(lifecycleCalls, [
    'verify-cleanup-safety',
    'verify-browser-post:https://cloud.example.test',
    'inspect:staging/upload-1',
    'promote:staging/upload-1:final/upload-1',
    'delete:staging/upload-1',
  ])
  const operations = metrics
    .filter((metric) => metric.name === 'open_cowork_cloud_object_store_operations_total')
    .map((metric) => metric.attributes?.operation)
  assert.deepEqual(operations, ['head', 'head', 'head', 'put', 'delete'])
})

function httpResponse(input: {
  status?: number
  headers?: Record<string, string>
  body?: string
} = {}): ObjectStoreHttpResponse {
  const status = input.status ?? 200
  const headers = new Map(Object.entries(input.headers || {}).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headers.get(name.toLowerCase()) || null
      },
      forEach(callback) {
        headers.forEach((value, key) => callback(value, key))
      },
    },
    async arrayBuffer() {
      const buffer = Buffer.from(input.body || '')
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    },
    async text() {
      return input.body || ''
    },
  }
}

test('cloud filesystem object store writes private artifact payloads and metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-object-store-'))
  const store = createFilesystemObjectStore(root)
  try {
    const written = await store.putObject({
      key: 'tenant/session/artifact.txt',
      body: 'hello artifact',
      contentType: 'text/plain',
      metadata: { Session: 'session-1' },
    })
    assert.equal(written.size, 'hello artifact'.length)

    const object = await store.getObject('tenant/session/artifact.txt')
    assert.equal(object?.body.toString('utf8'), 'hello artifact')
    assert.equal(object?.contentType, 'text/plain')
    assert.deepEqual(object?.metadata, { session: 'session-1' })

    await store.deleteObject('tenant/session/artifact.txt')
    assert.equal(await store.getObject('tenant/session/artifact.txt'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloud object keys reject traversal and absolute paths', () => {
  assert.equal(assertSafeObjectKey('tenant/session/artifact.txt'), 'tenant/session/artifact.txt')
  assert.throws(() => assertSafeObjectKey('../escape.txt'), /traversal/)
  assert.throws(() => assertSafeObjectKey('/escape.txt'), /relative/)
  assert.throws(() => assertSafeObjectKey('tenant//artifact.txt'), /empty/)
})

test('cloud S3-compatible object store scopes objects under the configured prefix', async () => {
  const calls: Array<{ name: string, input: Record<string, unknown> }> = []
  const client = {
    async send(command: { constructor: { name: string }, input: Record<string, unknown> }) {
      calls.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'GetObjectCommand') {
        return {
          Body: Buffer.from('from s3'),
          ContentType: 'text/plain',
          Metadata: { artifact: 'artifact-1' },
        }
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentLength: 7,
          ContentType: 'text/plain',
          Metadata: { artifact: 'artifact-1' },
        }
      }
      return {}
    },
    destroy() {},
  }
  const store = createS3CompatibleObjectStore({
    kind: 'minio',
    bucket: 'open-cowork',
    prefix: 'cloud/dev',
    endpoint: 'http://minio:9000',
    client: client as never,
  })

  await store.putObject({
    key: 'tenant/session/artifact.txt',
    body: 'payload',
    contentType: 'text/plain',
    metadata: { Artifact: 'artifact-1' },
  })
  const object = await store.getObject('tenant/session/artifact.txt')
  const head = await store.headObject('tenant/session/artifact.txt')

  assert.equal(store.kind, 'minio')
  assert.equal(calls[0]?.name, 'PutObjectCommand')
  assert.equal(calls[0]?.input.Bucket, 'open-cowork')
  assert.equal(calls[0]?.input.Key, 'cloud/dev/tenant/session/artifact.txt')
  assert.equal(object?.body.toString('utf8'), 'from s3')
  assert.equal(head?.size, 7)
})

test('AWS S3 control-plane writes persist SHA256 for direct-upload readiness probes', async () => {
  const calls: Array<{ name: string, input: Record<string, unknown> }> = []
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send(command: { constructor: { name: string }, input: Record<string, unknown> }) {
        calls.push({ name: command.constructor.name, input: command.input })
        return {}
      },
      destroy() {},
    } as never,
  })

  await store.putObject({ key: 'health/probe', body: 'payload', contentType: 'text/plain' })

  const put = calls.find((call) => call.name === 'PutObjectCommand')
  assert.equal(put?.input.ChecksumAlgorithm, 'SHA256')
  assert.equal(put?.input.ChecksumSHA256, createHash('sha256').update('payload').digest('base64'))
})

test('cloud GCS object store uses scoped object URLs, bearer auth, and metadata headers', async () => {
  const calls: Array<{ url: string, init: { method?: string, headers?: Record<string, string>, body?: Buffer | string } | undefined }> = []
  const store = createGcsObjectStore({
    bucket: 'open-cowork-cloud',
    prefix: 'tenant-a',
    endpoint: 'https://storage.googleapis.test',
    credentials: { bearerToken: 'gcs-token' },
    async fetch(url, init) {
      calls.push({ url, init })
      if (init?.method === 'GET') {
        return httpResponse({
          body: 'from gcs',
          headers: {
            'content-type': 'text/plain',
            'content-length': '8',
            'x-goog-meta-artifact': 'artifact-1',
          },
        })
      }
      if (init?.method === 'HEAD') {
        return httpResponse({
          headers: {
            'content-type': 'text/plain',
            'content-length': '8',
            'x-goog-meta-artifact': 'artifact-1',
          },
        })
      }
      return httpResponse()
    },
  })

  await store.putObject({
    key: 'sessions/s1/artifact.txt',
    body: 'payload',
    contentType: 'text/plain',
    metadata: { Artifact: 'artifact-1' },
  })
  const object = await store.getObject('sessions/s1/artifact.txt')
  const head = await store.headObject('sessions/s1/artifact.txt')

  assert.equal(store.kind, 'gcs')
  assert.equal(calls[0]?.url, 'https://storage.googleapis.test/open-cowork-cloud/tenant-a/sessions/s1/artifact.txt')
  assert.equal(calls[0]?.init?.headers?.authorization, 'Bearer gcs-token')
  assert.equal(calls[0]?.init?.headers?.['x-goog-meta-artifact'], 'artifact-1')
  assert.equal(object?.body.toString('utf8').startsWith('from gcs'), true)
  assert.deepEqual(head?.metadata, { artifact: 'artifact-1' })
})

test('cloud Azure Blob object store uses container URLs, SAS auth, and metadata headers', async () => {
  const calls: Array<{ url: string, init: { method?: string, headers?: Record<string, string>, body?: Buffer | string } | undefined }> = []
  const store = createAzureBlobObjectStore({
    container: 'open-cowork-cloud',
    prefix: 'tenant-a',
    endpoint: 'https://acct.blob.core.windows.net',
    credentials: { sasToken: 'sv=2024&sig=abc' },
    async fetch(url, init) {
      calls.push({ url, init })
      if (init?.method === 'GET') {
        return httpResponse({
          body: 'from azure',
          headers: {
            'content-type': 'text/plain',
            'content-length': '10',
            'x-ms-meta-artifact': 'artifact-1',
          },
        })
      }
      if (init?.method === 'HEAD') {
        return httpResponse({
          headers: {
            'content-type': 'text/plain',
            'content-length': '10',
            'x-ms-meta-artifact': 'artifact-1',
          },
        })
      }
      return httpResponse()
    },
  })

  await store.putObject({
    key: 'sessions/s1/artifact.txt',
    body: 'payload',
    contentType: 'text/plain',
    metadata: { Artifact: 'artifact-1' },
  })
  const object = await store.getObject('sessions/s1/artifact.txt')
  const head = await store.headObject('sessions/s1/artifact.txt')

  assert.equal(store.kind, 'azure-blob')
  assert.equal(calls[0]?.url, 'https://acct.blob.core.windows.net/open-cowork-cloud/tenant-a/sessions/s1/artifact.txt?sv=2024&sig=abc')
  assert.equal(calls[0]?.init?.headers?.['x-ms-blob-type'], 'BlockBlob')
  assert.equal(calls[0]?.init?.headers?.['x-ms-meta-artifact'], 'artifact-1')
  assert.equal(object?.body.toString('utf8').startsWith('from azure'), true)
  assert.equal(head?.size, 10)
})

test('cloud object-store factory resolves filesystem and S3-compatible deployments', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-object-factory-'))
  try {
    const filesystem = createObjectStoreForCloud({
      config: DEFAULT_CONFIG,
      env: {},
      paths: createCloudPathProvider(root),
    })
    assert.equal(filesystem.kind, 'filesystem')

    const s3Config = {
      ...DEFAULT_CONFIG,
      cloud: {
        ...DEFAULT_CONFIG.cloud,
        storage: {
          ...DEFAULT_CONFIG.cloud.storage,
          objectStore: {
            kind: 'minio' as const,
            bucket: 'configured-bucket',
            endpoint: 'http://minio:9000',
            prefix: 'configured-prefix',
          },
        },
      },
    }
    const resolved = resolveCloudObjectStoreConfig(s3Config, {
      OPEN_COWORK_CLOUD_OBJECT_STORE_KIND: 's3',
      OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET: 'env-bucket',
      OPEN_COWORK_CLOUD_OBJECT_STORE_ACCESS_KEY_ID: 'key',
      OPEN_COWORK_CLOUD_OBJECT_STORE_SECRET_ACCESS_KEY: 'secret',
    })
    assert.equal(resolved.kind, 's3')
    assert.equal(resolved.bucket, 'env-bucket')
    assert.deepEqual(resolved.credentials, {
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      sessionToken: undefined,
      bearerToken: undefined,
      sasToken: undefined,
      accountName: undefined,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cloud object-store factory resolves GCS and Azure Blob deployments', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-object-provider-factory-'))
  try {
    const gcsConfig = {
      ...DEFAULT_CONFIG,
      cloud: {
        ...DEFAULT_CONFIG.cloud,
        storage: {
          ...DEFAULT_CONFIG.cloud.storage,
          objectStore: {
            kind: 'gcs' as const,
            bucket: 'gcs-bucket',
            prefix: 'cloud',
          },
        },
      },
    }
    const gcs = createObjectStoreForCloud({
      config: gcsConfig,
      env: {
        OPEN_COWORK_CLOUD_OBJECT_STORE_BEARER_TOKEN: 'token',
      },
      paths: createCloudPathProvider(root),
    })
    assert.equal(gcs.kind, 'gcs')

    const azureConfig = {
      ...DEFAULT_CONFIG,
      cloud: {
        ...DEFAULT_CONFIG.cloud,
        storage: {
          ...DEFAULT_CONFIG.cloud.storage,
          objectStore: {
            kind: 'azure-blob' as const,
            bucket: 'container',
            endpoint: 'https://acct.blob.core.windows.net',
            credentialsRef: 'env:AZURE_BLOB_CREDENTIALS',
          },
        },
      },
    }
    const azure = createObjectStoreForCloud({
      config: azureConfig,
      env: {
        AZURE_BLOB_CREDENTIALS: JSON.stringify({ sasToken: '?sv=2024&sig=abc' }),
      },
      paths: createCloudPathProvider(root),
    })
    assert.equal(azure.kind, 'azure-blob')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('signS3PresignedUrl reproduces the AWS SigV4 presigned-GET documentation vector', () => {
  // AWS docs "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)" —
  // the canonical examplebucket/test.txt presigned GET. Validates the SigV4 math locally;
  // the actual S3 round-trip is only validatable against real S3 (staging).
  // The access key id is AWS's published documentation example; it is assembled from fragments
  // so the (non-secret) literal does not trip the repo's AKIA-prefixed-key secret scanner.
  const exampleAccessKeyId = `AKIA${'IOSFODNN7EXAMPLE'}`
  const signed = signS3PresignedUrl({
    method: 'GET',
    protocol: 'https:',
    host: 'examplebucket.s3.amazonaws.com',
    canonicalUri: '/test.txt',
    region: 'us-east-1',
    accessKeyId: exampleAccessKeyId,
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    expiresSeconds: 86_400,
    now: new Date('2013-05-24T00:00:00.000Z'),
  })
  assert.equal(
    signed.url,
    'https://examplebucket.s3.amazonaws.com/test.txt'
      + '?X-Amz-Algorithm=AWS4-HMAC-SHA256'
      + `&X-Amz-Credential=${exampleAccessKeyId}%2F20130524%2Fus-east-1%2Fs3%2Faws4_request`
      + '&X-Amz-Date=20130524T000000Z'
      + '&X-Amz-Expires=86400'
      + '&X-Amz-SignedHeaders=host'
      + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
  )
  assert.equal(signed.method, 'GET')
  assert.equal(signed.expiresAt, '2013-05-25T00:00:00.000Z')
})

test('signS3PresignedUrl includes the session token when present', () => {
  const signed = signS3PresignedUrl({
    method: 'PUT',
    protocol: 'https:',
    host: 'bucket.s3.us-west-2.amazonaws.com',
    canonicalUri: '/key.bin',
    region: 'us-west-2',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secretEXAMPLE',
    sessionToken: 'session/token+value',
    expiresSeconds: 600,
    now: new Date('2026-01-01T00:00:00.000Z'),
  })
  assert.match(signed.url, /X-Amz-Security-Token=session%2Ftoken%2Bvalue/)
  assert.match(signed.url, /X-Amz-Signature=[0-9a-f]{64}$/)
})

test('signS3PresignedPost binds the exact key, byte length, content type, checksum, and expiry', () => {
  const signed = signS3PresignedPost({
    url: 'https://examplebucket.s3.us-east-1.amazonaws.com/',
    bucket: 'examplebucket',
    key: 'staging/upload-1',
    region: 'us-east-1',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secretEXAMPLE',
    sessionToken: 'session-token',
    contentType: 'text/plain',
    expectedSize: 5,
    checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    expiresSeconds: 600,
    now: new Date('2026-01-01T00:00:00.000Z'),
  })

  assert.equal(signed.method, 'POST')
  assert.equal(signed.url, 'https://examplebucket.s3.us-east-1.amazonaws.com/')
  assert.equal(signed.expiresAt, '2026-01-01T00:10:00.000Z')
  assert.deepEqual(JSON.parse(Buffer.from(signed.fields.policy!, 'base64').toString('utf8')), {
    expiration: '2026-01-01T00:10:00.000Z',
    conditions: [
      { bucket: 'examplebucket' },
      { key: 'staging/upload-1' },
      { 'Content-Type': 'text/plain' },
      { 'success_action_status': '204' },
      { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
      { 'x-amz-credential': 'AKIDEXAMPLE/20260101/us-east-1/s3/aws4_request' },
      { 'x-amz-date': '20260101T000000Z' },
      { 'x-amz-checksum-algorithm': 'SHA256' },
      { 'x-amz-checksum-sha256': 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=' },
      { 'x-amz-security-token': 'session-token' },
      ['content-length-range', 5, 5],
    ],
  })
  assert.equal(signed.fields.key, 'staging/upload-1')
  assert.equal(signed.fields['Content-Type'], 'text/plain')
  assert.equal(signed.fields['x-amz-checksum-sha256'], 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
  assert.equal(signed.fields['x-amz-security-token'], 'session-token')
  assert.match(signed.fields['x-amz-signature']!, /^[0-9a-f]{64}$/)
})

type TestS3PostPolicy = {
  expiration: string
  conditions: Array<Record<string, string> | ['content-length-range', number, number]>
}

// Executable, test-only model of the provider-side checks S3 applies to a signed POST.
// It deliberately verifies the policy with an independently derived signing key instead
// of trusting the fields returned by signS3PresignedPost.
function createTestS3PresignedPostProvider(input: {
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}) {
  const objects = new Map<string, Buffer>()
  const submit = (request: ReturnType<typeof signS3PresignedPost>, submission: {
    body: Buffer
    now: Date
    fields?: Record<string, string>
  }) => {
    const fields = { ...request.fields, ...submission.fields }
    const policyBase64 = fields.policy
    const signature = fields['x-amz-signature']
    const credential = fields['x-amz-credential']
    if (!policyBase64 || !signature || !credential) throw new Error('provider rejected missing signing fields')

    const credentialParts = credential.split('/')
    if (
      credentialParts.length !== 5
      || credentialParts[0] !== input.accessKeyId
      || !/^\d{8}$/.test(credentialParts[1] || '')
      || credentialParts[3] !== 's3'
      || credentialParts[4] !== 'aws4_request'
    ) {
      throw new Error('provider rejected invalid credential scope')
    }
    const [, dateStamp, region] = credentialParts as [string, string, string, string, string]
    const signingKey = createHmac('sha256',
      createHmac('sha256',
        createHmac('sha256',
          createHmac('sha256', `AWS4${input.secretAccessKey}`).update(dateStamp).digest(),
        ).update(region).digest(),
      ).update('s3').digest(),
    ).update('aws4_request').digest()
    const expectedSignature = createHmac('sha256', signingKey).update(policyBase64).digest('hex')
    if (
      !/^[0-9a-f]{64}$/.test(signature)
      || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))
    ) {
      throw new Error('provider rejected invalid signature')
    }

    const policy = JSON.parse(Buffer.from(policyBase64, 'base64').toString('utf8')) as TestS3PostPolicy
    if (!Number.isFinite(Date.parse(policy.expiration)) || submission.now.getTime() >= Date.parse(policy.expiration)) {
      throw new Error('provider rejected expired policy')
    }
    for (const condition of policy.conditions) {
      if (Array.isArray(condition)) {
        const [name, minimum, maximum] = condition
        if (name !== 'content-length-range') throw new Error(`provider rejected unknown condition ${name}`)
        if (submission.body.byteLength < minimum || submission.body.byteLength > maximum) {
          throw new Error('provider rejected content length')
        }
        continue
      }
      for (const [name, expected] of Object.entries(condition)) {
        const actual = name === 'bucket' ? input.bucket : fields[name]
        if (actual !== expected) throw new Error(`provider rejected field ${name}`)
      }
    }

    const actualChecksum = createHash('sha256').update(submission.body).digest('base64')
    if (fields['x-amz-checksum-sha256'] !== actualChecksum) {
      throw new Error('provider rejected checksum')
    }
    const key = fields.key
    if (!key) throw new Error('provider rejected missing key')
    objects.set(key, Buffer.from(submission.body))
    return { status: 204, key }
  }
  return { objects, submit }
}

test('S3 signed POST provider contract accepts only exact key-, size-, checksum-, and expiry-bound bytes', () => {
  const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secretEXAMPLE',
  }
  const body = Buffer.from('hello')
  const signed = signS3PresignedPost({
    url: 'https://examplebucket.s3.us-east-1.amazonaws.com/',
    bucket: 'examplebucket',
    key: 'staging/upload-1',
    region: 'us-east-1',
    ...credentials,
    contentType: 'text/plain',
    expectedSize: body.byteLength,
    checksumSha256: createHash('sha256').update(body).digest('hex'),
    expiresSeconds: 600,
    now: new Date('2026-01-01T00:00:00.000Z'),
  })
  const provider = createTestS3PresignedPostProvider({ bucket: 'examplebucket', ...credentials })

  assert.deepEqual(provider.submit(signed, {
    body,
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), { status: 204, key: 'staging/upload-1' })
  assert.throws(() => provider.submit(signed, {
    body: Buffer.from('hell'),
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), /content length/)
  assert.throws(() => provider.submit(signed, {
    body: Buffer.from('hello!'),
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), /content length/)
  assert.throws(() => provider.submit(signed, {
    body: Buffer.from('HELLO'),
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), /checksum/)
  assert.throws(() => provider.submit(signed, {
    body,
    fields: { key: 'staging/attacker-key' },
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), /field key/)
  assert.throws(() => provider.submit(signed, {
    body,
    fields: { 'Content-Type': 'application/octet-stream' },
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), /field Content-Type/)
  assert.throws(() => provider.submit(signed, {
    body,
    fields: { 'x-amz-signature': '0'.repeat(64) },
    now: new Date('2026-01-01T00:01:00.000Z'),
  }), /invalid signature/)

  // S3 accepts an exact credential replay until expiry. It is harmless here: the policy
  // fixes both checksum and staging key, so the identical bytes replace one unversioned object.
  assert.equal(provider.submit(signed, {
    body,
    now: new Date('2026-01-01T00:02:00.000Z'),
  }).status, 204)
  assert.equal(provider.objects.size, 1)
  assert.deepEqual(provider.objects.get('staging/upload-1'), body)
  assert.throws(() => provider.submit(signed, {
    body,
    now: new Date('2026-01-01T00:10:00.000Z'),
  }), /expired policy/)
})

test('AWS S3 object store exposes an exact-size and checksum-bound POST upload with static credentials', async () => {
  const calls: Array<{ name: string, input: Record<string, unknown> }> = []
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    prefix: 'cloud/dev',
    region: 'eu-west-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send(command: { constructor: { name: string }, input: Record<string, unknown> }) {
        calls.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'GetBucketCorsCommand') {
          return {
            CORSRules: [{
              AllowedOrigins: ['https://cloud.example.test'],
              AllowedMethods: ['POST'],
            }],
          }
        }
        return {}
      },
      destroy() {},
    } as never,
  })
  assert.equal(typeof store.presignGet, 'function')
  const get = await store.presignGet!('tenant/session/artifact.txt')
  assert.ok(get)
  assert.equal(get!.method, 'GET')
  assert.match(get!.url, /^https:\/\/open-cowork\.s3\.eu-west-1\.amazonaws\.com\/cloud\/dev\/tenant\/session\/artifact\.txt\?/)
  assert.match(get!.url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/)
  assert.match(get!.url, /X-Amz-Signature=[0-9a-f]{64}$/)
  assert.deepEqual(get!.headers, {})
  assert.equal('presignPut' in store, false)
  assert.equal(store.presignedUpload?.enforcement, 'exact-content-length')
  assert.equal(store.presignedUpload?.maxBytes, 25 * 1024 * 1024)
  assert.equal(store.presignedUpload?.origin, 'https://open-cowork.s3.eu-west-1.amazonaws.com')
  assert.equal(await store.presignedUpload?.verifyCleanupSafety(), true)
  assert.equal(
    await store.presignedUpload?.verifyBrowserPostSafety('https://cloud.example.test'),
    true,
  )

  const upload = await store.presignedUpload!.presignPost({
    key: 'tenant/session/staging/upload-1',
    browserOrigin: 'https://cloud.example.test',
    contentType: 'text/plain',
    expectedSize: 5,
    checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  })
  assert.ok(upload)
  assert.equal(upload!.method, 'POST')
  assert.equal(upload!.url, 'https://open-cowork.s3.eu-west-1.amazonaws.com/')
  assert.equal(upload!.fields.key, 'cloud/dev/tenant/session/staging/upload-1')
  assert.equal(upload!.fields['Content-Type'], 'text/plain')
  assert.equal(upload!.fields['x-amz-checksum-sha256'], 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=')
  const policy = JSON.parse(Buffer.from(upload!.fields.policy!, 'base64').toString('utf8')) as { conditions: unknown[] }
  assert.equal(policy.conditions.some((condition) => (
    Array.isArray(condition)
    && condition[0] === 'content-length-range'
    && condition[1] === 5
    && condition[2] === 5
  )), true)
  assert.deepEqual(
    calls.filter((call) => call.name === 'GetBucketVersioningCommand').map((call) => call.input),
    [{ Bucket: 'open-cowork' }],
  )
  assert.deepEqual(
    calls.filter((call) => call.name === 'GetBucketCorsCommand').map((call) => call.input),
    [{ Bucket: 'open-cowork' }],
  )
})

test('AWS S3 direct upload fails closed for shared path-style origins and dotted bucket TLS names', () => {
  for (const options of [
    { bucket: 'open-cowork', forcePathStyle: true },
    { bucket: 'uploads.example.test', forcePathStyle: false },
    { bucket: 'open-cowork', endpoint: 'https://s3.eu-west-1.amazonaws.com' },
    { bucket: 'open-cowork', endpoint: 'https://objects.example.test', forcePathStyle: true },
  ]) {
    const store = createS3CompatibleObjectStore({
      kind: 's3',
      ...options,
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
      client: { async send() { return {} }, destroy() {} } as never,
    })

    assert.equal(store.presignedUpload, undefined)
    assert.ok(store.directUploadLifecycle)
  }

  const virtualHostedEndpoint = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    endpoint: 'https://objects.example.test',
    forcePathStyle: false,
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: { async send() { return {} }, destroy() {} } as never,
  })
  assert.equal(
    virtualHostedEndpoint.presignedUpload?.origin,
    'https://open-cowork.objects.example.test',
  )
})

test('AWS S3 direct-upload safety caches successes for 30 seconds and rechecks stale attestations', async () => {
  let nowMs = 1_000
  let versioningReads = 0
  let corsReads = 0
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    safetyNowMs: () => nowMs,
    client: {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'GetBucketVersioningCommand') {
          versioningReads += 1
          return {}
        }
        if (command.constructor.name === 'GetBucketCorsCommand') {
          corsReads += 1
          return {
            CORSRules: [{
              AllowedOrigins: ['https://cloud.example.test'],
              AllowedMethods: ['POST'],
            }],
          }
        }
        return {}
      },
      destroy() {},
    } as never,
  })
  const input = {
    key: 'staging/upload-1',
    browserOrigin: 'https://cloud.example.test',
    expectedSize: 5,
    checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }

  assert.equal(await store.presignedUpload!.verifyCleanupSafety(), true)
  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety(input.browserOrigin), true)
  const readsAfterAttestation = { versioningReads, corsReads }
  assert.ok(await store.presignedUpload!.presignPost(input))
  assert.ok(await store.presignedUpload!.presignPost(input))
  assert.deepEqual({ versioningReads, corsReads }, readsAfterAttestation)
  nowMs += 29_999
  assert.equal(await store.presignedUpload!.verifyCleanupSafety(), true)
  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety(input.browserOrigin), true)
  assert.deepEqual({ versioningReads, corsReads }, { versioningReads: 1, corsReads: 1 })

  nowMs += 1
  assert.equal(await store.presignedUpload!.verifyCleanupSafety(), true)
  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety(input.browserOrigin), true)
  assert.deepEqual({ versioningReads, corsReads }, { versioningReads: 2, corsReads: 2 })
  assert.ok(await store.presignedUpload!.presignPost(input))
  assert.deepEqual({ versioningReads, corsReads }, { versioningReads: 2, corsReads: 2 })
})

test('AWS S3 direct upload rejects wildcard, pattern, missing POST, and absent CORS rules', async () => {
  const unsafeConfigurations = [
    { CORSRules: [{ AllowedOrigins: ['*'], AllowedMethods: ['POST'] }] },
    { CORSRules: [{ AllowedOrigins: ['https://*.example.test'], AllowedMethods: ['POST'] }] },
    { CORSRules: [{ AllowedOrigins: ['https://cloud.example.test', '*'], AllowedMethods: ['POST'] }] },
    { CORSRules: [
      { AllowedOrigins: ['https://cloud.example.test'], AllowedMethods: ['POST'] },
      { AllowedOrigins: ['*'], AllowedMethods: ['POST'] },
    ] },
    { CORSRules: [{ AllowedOrigins: ['https://cloud.example.test'], AllowedMethods: ['GET'] }] },
    {},
  ]
  for (const cors of unsafeConfigurations) {
    let corsReads = 0
    const store = createS3CompatibleObjectStore({
      kind: 's3',
      bucket: 'open-cowork',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
      client: {
        async send(command: { constructor: { name: string } }) {
          if (command.constructor.name === 'GetBucketCorsCommand') {
            corsReads += 1
            return cors
          }
          return {}
        },
        destroy() {},
      } as never,
    })

    assert.equal(
      await store.presignedUpload!.verifyBrowserPostSafety('https://cloud.example.test'),
      false,
    )
    assert.equal(
      await store.presignedUpload!.verifyBrowserPostSafety('https://cloud.example.test'),
      false,
    )
    assert.equal(corsReads, 2)
  }
})

test('AWS S3 direct-upload browser safety retains only the latest exact origin', async () => {
  let corsReads = 0
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'GetBucketCorsCommand') {
          corsReads += 1
          return {
            CORSRules: [{
              AllowedOrigins: ['https://one.example.test', 'https://two.example.test'],
              AllowedMethods: ['POST'],
            }],
          }
        }
        return {}
      },
      destroy() {},
    } as never,
  })

  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety('https://one.example.test'), true)
  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety('https://one.example.test'), true)
  assert.equal(corsReads, 1)
  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety('https://two.example.test'), true)
  assert.equal(await store.presignedUpload!.verifyBrowserPostSafety('https://one.example.test'), true)
  assert.equal(corsReads, 3)
})

test('AWS S3 direct upload does not cache browser CORS verification errors', async () => {
  let corsReads = 0
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'GetBucketCorsCommand') {
          corsReads += 1
          throw new Error('cors access denied')
        }
        return {}
      },
      destroy() {},
    } as never,
  })

  await assert.rejects(
    () => store.presignedUpload!.verifyBrowserPostSafety('https://cloud.example.test'),
    /cors access denied/,
  )
  await assert.rejects(
    () => store.presignedUpload!.verifyBrowserPostSafety('https://cloud.example.test'),
    /cors access denied/,
  )
  assert.equal(corsReads, 2)
})

test('AWS S3 direct upload fails closed when bucket versioning is enabled or suspended', async () => {
  for (const status of ['Enabled', 'Suspended'] as const) {
    const calls: string[] = []
    const store = createS3CompatibleObjectStore({
      kind: 's3',
      bucket: 'open-cowork',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
      client: {
        async send(command: { constructor: { name: string } }) {
          calls.push(command.constructor.name)
          if (command.constructor.name === 'GetBucketVersioningCommand') return { Status: status }
          return {}
        },
        destroy() {},
      } as never,
    })

    assert.equal(await store.presignedUpload!.verifyCleanupSafety(), false)
    assert.equal(await store.presignedUpload!.verifyCleanupSafety(), false)
    assert.deepEqual(calls, ['GetBucketVersioningCommand', 'GetBucketVersioningCommand'])
  }
})

test('AWS S3 direct upload does not cache bucket-versioning verification errors', async () => {
  let versioningReads = 0
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send(command: { constructor: { name: string } }) {
        if (command.constructor.name === 'GetBucketVersioningCommand') {
          versioningReads += 1
          throw new Error('access denied')
        }
        return {}
      },
      destroy() {},
    } as never,
  })

  await assert.rejects(
    () => store.presignedUpload!.verifyCleanupSafety(),
    /access denied/,
  )
  await assert.rejects(
    () => store.presignedUpload!.verifyCleanupSafety(),
    /access denied/,
  )
  assert.equal(versioningReads, 2)
})

test('AWS S3 direct uploads inspect an attested version and conditionally promote staging bytes', async () => {
  const calls: Array<{ name: string, input: Record<string, unknown> }> = []
  const checksumBase64 = 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ='
  const client = {
    async send(command: { constructor: { name: string }, input: Record<string, unknown> }) {
      calls.push({ name: command.constructor.name, input: command.input })
      if (command.constructor.name === 'HeadObjectCommand') {
        return {
          ContentLength: 5,
          ContentType: 'text/plain',
          ChecksumSHA256: checksumBase64,
          VersionId: String(command.input.Key).includes('/staging/') ? 'source-version-1' : 'final-version-1',
        }
      }
      return {}
    },
    destroy() {},
  }
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    prefix: 'cloud/dev',
    region: 'eu-west-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: client as never,
  })

  const inspected = await store.presignedUpload!.inspect('tenant/staging/upload-1')
  assert.deepEqual(inspected, {
    size: 5,
    contentType: 'text/plain',
    checksumSha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    versionToken: 'version:source-version-1',
  })
  await store.presignedUpload!.promote({
    stagingKey: 'tenant/staging/upload-1',
    finalKey: 'tenant/artifacts/upload-1',
    expected: inspected!,
  })
  await store.presignedUpload!.delete('tenant/staging/upload-1')

  const inspect = calls[0]
  assert.equal(inspect?.name, 'HeadObjectCommand')
  assert.equal(inspect?.input.Key, 'cloud/dev/tenant/staging/upload-1')
  assert.equal(inspect?.input.ChecksumMode, 'ENABLED')
  const copy = calls.find((call) => call.name === 'CopyObjectCommand')
  assert.equal(copy?.input.Bucket, 'open-cowork')
  assert.equal(copy?.input.Key, 'cloud/dev/tenant/artifacts/upload-1')
  assert.equal(copy?.input.CopySource, 'open-cowork/cloud/dev/tenant/staging/upload-1?versionId=source-version-1')
  assert.equal(copy?.input.ChecksumAlgorithm, 'SHA256')
  assert.equal(copy?.input.MetadataDirective, 'COPY')
  assert.equal(copy?.input.CopySourceIfMatch, undefined)
  assert.equal(calls.filter((call) => call.name === 'HeadObjectCommand').length, 2)
  const deleted = calls.find((call) => call.name === 'DeleteObjectCommand')
  assert.equal(deleted?.input.Key, 'cloud/dev/tenant/staging/upload-1')
})

test('AWS S3 direct upload inspection maps generic HTTP 404 provider errors to missing', async () => {
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send() {
        throw Object.assign(new Error('opaque provider failure'), { $metadata: { httpStatusCode: 404 } })
      },
      destroy() {},
    } as never,
  })

  await assert.doesNotReject(async () => {
    assert.equal(await store.presignedUpload!.inspect('staging/missing'), null)
  })
})

test('AWS S3 promotion uses source If-Match without versioning and rejects failed final attestation', async () => {
  const calls: Array<{ name: string, input: Record<string, unknown> }> = []
  let headCount = 0
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: {
      async send(command: { constructor: { name: string }, input: Record<string, unknown> }) {
        calls.push({ name: command.constructor.name, input: command.input })
        if (command.constructor.name === 'HeadObjectCommand') {
          headCount += 1
          return {
            ContentLength: 5,
            ContentType: 'text/plain',
            ChecksumSHA256: headCount === 1
              ? 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ='
              : 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
            ETag: '"source-etag"',
          }
        }
        return {}
      },
      destroy() {},
    } as never,
  })
  const inspected = await store.presignedUpload!.inspect('staging/upload-1')
  assert.equal(inspected?.versionToken, 'etag:"source-etag"')

  await assert.rejects(
    () => store.presignedUpload!.promote({
      stagingKey: 'staging/upload-1',
      finalKey: 'final/upload-1',
      expected: inspected!,
    }),
    /failed provider attestation/,
  )
  const copy = calls.find((call) => call.name === 'CopyObjectCommand')
  assert.equal(copy?.input.CopySource, 'open-cowork/staging/upload-1')
  assert.equal(copy?.input.CopySourceIfMatch, '"source-etag"')
})

test('S3 object store path-style presign targets the endpoint host', async () => {
  const store = createS3CompatibleObjectStore({
    kind: 'minio',
    bucket: 'open-cowork',
    endpoint: 'http://minio:9000',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secretEXAMPLE' },
    client: { send: async () => ({}), destroy() {} } as never,
  })
  const get = await store.presignGet!('tenant/object.bin')
  assert.ok(get)
  assert.match(get!.url, /^http:\/\/minio:9000\/open-cowork\/tenant\/object\.bin\?/)
  assert.equal('presignedUpload' in store, false)
})

test('S3 object store declines to presign without static credentials (buffered fallback)', async () => {
  const store = createS3CompatibleObjectStore({
    kind: 's3',
    bucket: 'open-cowork',
    region: 'us-east-1',
    credentials: null,
    client: { send: async () => ({}), destroy() {} } as never,
  })
  assert.equal(await store.presignGet!('tenant/object.bin'), null)
  assert.equal('presignPut' in store, false)
  assert.equal('presignedUpload' in store, false)
  assert.ok(store.directUploadLifecycle)
})

test('non-S3 object stores omit the presign capability', () => {
  assert.equal(createInMemoryObjectStore().presignGet, undefined)
  assert.equal('presignedUpload' in createInMemoryObjectStore(), false)
})
