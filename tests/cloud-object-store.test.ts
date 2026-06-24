import test from 'node:test'
import assert from 'node:assert/strict'
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
