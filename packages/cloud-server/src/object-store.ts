import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { GoogleAuth } from 'google-auth-library'
import type { OpenCoworkConfig } from '@open-cowork/shared'
import type { PathProvider } from './path-provider.ts'
import { recordCloudMetric, type CloudObservabilityAdapter } from './observability.ts'

type Env = Record<string, string | undefined>

export type ObjectStoreKind =
  | 'filesystem'
  | 's3'
  | 'gcs'
  | 'azure-blob'
  | 'digitalocean-spaces'
  | 'minio'
  | 'unavailable'

export type ObjectStorePutInput = {
  key: string
  body: Buffer | string
  contentType?: string | null
  metadata?: Record<string, string>
}

export type ObjectStoreReadResult = {
  key: string
  body: Buffer
  contentType: string | null
  metadata: Record<string, string>
}

export type ObjectStoreHeadResult = {
  key: string
  size: number
  contentType: string | null
  metadata: Record<string, string>
}

export type ObjectStoreAdapter = {
  kind: ObjectStoreKind
  putObject(input: ObjectStorePutInput): Promise<ObjectStoreHeadResult>
  getObject(key: string): Promise<ObjectStoreReadResult | null>
  headObject(key: string): Promise<ObjectStoreHeadResult | null>
  deleteObject(key: string): Promise<void>
  close?: () => Promise<void> | void
}

// Wrap any object-store adapter so the durable-state layer actually emits telemetry (audit P1-O4).
// The get/put/head/delete path was completely dark — the catalogued object-store error alert (the one
// alert covering session-state loss) had ZERO emission sites and could never fire. Each operation now
// records an operations_total counter (status=ok|error, so errors are a status filter) and a duration
// histogram, tagged with the store kind + operation. Best-effort: telemetry failures never break I/O,
// and the wrapper is transparent when no observability adapter is configured.
export function instrumentObjectStore(
  adapter: ObjectStoreAdapter,
  observability: CloudObservabilityAdapter | null | undefined,
): ObjectStoreAdapter {
  if (!observability) return adapter
  const emit = async (operation: string, status: 'ok' | 'error', startedAtMs: number, error?: unknown) => {
    const attributes = {
      cloud_object_store_kind: adapter.kind,
      operation,
      status,
      ...(status === 'error' ? { error: error instanceof Error ? error.name : 'unknown' } : {}),
    }
    await recordCloudMetric(observability, { name: 'open_cowork_cloud_object_store_operations_total', value: 1, unit: '1', attributes })
    await recordCloudMetric(observability, { name: 'open_cowork_cloud_object_store_operation_duration_ms', value: Math.max(0, Date.now() - startedAtMs), unit: 'ms', attributes })
  }
  const instrument = async <T>(operation: string, run: () => Promise<T>): Promise<T> => {
    const startedAtMs = Date.now()
    try {
      const result = await run()
      await emit(operation, 'ok', startedAtMs)
      return result
    } catch (error) {
      await emit(operation, 'error', startedAtMs, error)
      throw error
    }
  }
  return {
    kind: adapter.kind,
    putObject: (input) => instrument('put', () => adapter.putObject(input)),
    getObject: (key) => instrument('get', () => adapter.getObject(key)),
    headObject: (key) => instrument('head', () => adapter.headObject(key)),
    deleteObject: (key) => instrument('delete', () => adapter.deleteObject(key)),
    ...(adapter.close ? { close: () => adapter.close!() } : {}),
  }
}

export type ObjectStoreCredentials = {
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  bearerToken?: string
  sasToken?: string
  accountName?: string
}

export type S3ObjectStoreCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type S3CompatibleObjectStoreOptions = {
  kind?: ObjectStoreKind
  bucket: string
  prefix?: string | null
  region?: string | null
  endpoint?: string | null
  forcePathStyle?: boolean
  credentials?: S3ObjectStoreCredentials | null
  client?: Pick<S3Client, 'send' | 'destroy'>
}

export type ObjectStoreHttpResponse = {
  ok: boolean
  status: number
  headers: {
    get(name: string): string | null
    forEach?: (callback: (value: string, key: string) => void) => void
  }
  arrayBuffer?: () => Promise<ArrayBuffer>
  text?: () => Promise<string>
}

export type ObjectStoreHttpClient = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: Buffer | string
  },
) => Promise<ObjectStoreHttpResponse>

export type GcsObjectStoreOptions = {
  bucket: string
  prefix?: string | null
  endpoint?: string | null
  credentials?: Pick<ObjectStoreCredentials, 'bearerToken'> | null
  tokenProvider?: () => Promise<string | null> | string | null
  fetch?: ObjectStoreHttpClient
}

export type AzureBlobObjectStoreOptions = {
  container: string
  prefix?: string | null
  endpoint?: string | null
  credentials?: Pick<ObjectStoreCredentials, 'sasToken' | 'bearerToken' | 'accountName'> | null
  tokenProvider?: () => Promise<string | null> | string | null
  fetch?: ObjectStoreHttpClient
}

type MetadataFile = {
  contentType: string | null
  metadata: Record<string, string>
}

const MAX_KEY_LENGTH = 1024

function normalizeMetadata(metadata: Record<string, string> | undefined) {
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(metadata || {})) {
    const normalizedKey = key.trim().toLowerCase()
    if (!normalizedKey || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(normalizedKey)) continue
    normalized[normalizedKey] = String(value).slice(0, 1024)
  }
  return normalized
}

function bodyBuffer(body: Buffer | string) {
  return Buffer.isBuffer(body) ? body : Buffer.from(body)
}

export function assertSafeObjectKey(key: string) {
  if (typeof key !== 'string' || !key.trim()) throw new Error('Object key is required.')
  if (key.length > MAX_KEY_LENGTH) throw new Error('Object key is too large.')
  if (key.includes('\0') || key.includes('\\') || isAbsolute(key)) {
    throw new Error('Object key must be a relative POSIX-style key.')
  }
  const parts = key.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Object key must not contain empty, dot, or traversal segments.')
  }
  return parts.join('/')
}

function resolveObjectPath(root: string, key: string) {
  const safeKey = assertSafeObjectKey(key)
  const resolvedRoot = resolve(root)
  const target = resolve(resolvedRoot, ...safeKey.split('/'))
  const rel = relative(resolvedRoot, target)
  if (rel && (rel.startsWith('..') || isAbsolute(rel))) {
    throw new Error(`Object key escapes object store root ${resolvedRoot}.`)
  }
  return target
}

function metadataPath(objectPath: string) {
  return `${objectPath}.metadata.json`
}

async function readMetadata(objectPath: string): Promise<MetadataFile> {
  try {
    const parsed = JSON.parse(await readFile(metadataPath(objectPath), 'utf8')) as Partial<MetadataFile>
    return {
      contentType: typeof parsed.contentType === 'string' ? parsed.contentType : null,
      metadata: normalizeMetadata(parsed.metadata),
    }
  } catch {
    return { contentType: null, metadata: {} }
  }
}

function prefixedKey(prefix: string | null | undefined, key: string) {
  const safeKey = assertSafeObjectKey(key)
  const cleanPrefix = prefix?.trim().replace(/^\/+|\/+$/g, '')
  return cleanPrefix ? `${assertSafeObjectKey(cleanPrefix)}/${safeKey}` : safeKey
}

function encodeObjectPath(key: string) {
  return assertSafeObjectKey(key).split('/').map(encodeURIComponent).join('/')
}

async function streamToBuffer(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0)
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (typeof body === 'string') return Buffer.from(body)
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray())
  }
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function defaultHttpFetch(): ObjectStoreHttpClient {
  return (url, init) => globalThis.fetch(url, init as Parameters<typeof fetch>[1]) as Promise<ObjectStoreHttpResponse>
}

async function responseBodyText(response: ObjectStoreHttpResponse) {
  try {
    return response.text ? await response.text() : ''
  } catch {
    return ''
  }
}

async function assertHttpOk(response: ObjectStoreHttpResponse, action: string) {
  if (response.ok) return
  const body = await responseBodyText(response)
  throw new Error(`${action} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 512)}` : ''}.`)
}

async function responseBuffer(response: ObjectStoreHttpResponse) {
  if (!response.arrayBuffer) return Buffer.alloc(0)
  return Buffer.from(await response.arrayBuffer())
}

function headerMetadata(headers: ObjectStoreHttpResponse['headers'], prefix: string) {
  const metadata: Record<string, string> = {}
  headers.forEach?.((value, key) => {
    const normalizedKey = key.toLowerCase()
    if (normalizedKey.startsWith(prefix)) {
      metadata[normalizedKey.slice(prefix.length)] = value
    }
  })
  return normalizeMetadata(metadata)
}

function contentLength(headers: ObjectStoreHttpResponse['headers']) {
  const value = Number(headers.get('content-length') || 0)
  return Number.isFinite(value) ? value : 0
}

async function tokenFromProvider(
  tokenProvider: (() => Promise<string | null> | string | null) | undefined,
  fallback: string | undefined,
) {
  const token = fallback || await tokenProvider?.()
  return token?.trim() || null
}

function createGcsAccessTokenProvider() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/devstorage.read_write'],
  })
  return async () => {
    const client = await auth.getClient()
    const accessToken = await client.getAccessToken()
    return typeof accessToken === 'string' ? accessToken : accessToken?.token || null
  }
}

async function bearerHeaders(
  tokenProvider: (() => Promise<string | null> | string | null) | undefined,
  credentials: Pick<ObjectStoreCredentials, 'bearerToken'> | null | undefined,
): Promise<Record<string, string>> {
  const token = await tokenFromProvider(tokenProvider, credentials?.bearerToken)
  return token ? { authorization: `Bearer ${token}` } : {}
}

export function createFilesystemObjectStore(root: string): ObjectStoreAdapter {
  const objectRoot = resolve(root)
  return {
    kind: 'filesystem',
    async putObject(input) {
      const objectPath = resolveObjectPath(objectRoot, input.key)
      const buffer = bodyBuffer(input.body)
      await mkdir(dirname(objectPath), { recursive: true })
      await writeFile(objectPath, buffer, { mode: 0o600 })
      await writeFile(metadataPath(objectPath), JSON.stringify({
        contentType: input.contentType || null,
        metadata: normalizeMetadata(input.metadata),
      }), { mode: 0o600 })
      return {
        key: assertSafeObjectKey(input.key),
        size: buffer.byteLength,
        contentType: input.contentType || null,
        metadata: normalizeMetadata(input.metadata),
      }
    },
    async getObject(key) {
      const objectPath = resolveObjectPath(objectRoot, key)
      try {
        const [body, metadata] = await Promise.all([
          readFile(objectPath),
          readMetadata(objectPath),
        ])
        return {
          key: assertSafeObjectKey(key),
          body,
          contentType: metadata.contentType,
          metadata: metadata.metadata,
        }
      } catch {
        return null
      }
    },
    async headObject(key) {
      const objectPath = resolveObjectPath(objectRoot, key)
      try {
        const [stats, metadata] = await Promise.all([
          stat(objectPath),
          readMetadata(objectPath),
        ])
        return {
          key: assertSafeObjectKey(key),
          size: stats.size,
          contentType: metadata.contentType,
          metadata: metadata.metadata,
        }
      } catch {
        return null
      }
    },
    async deleteObject(key) {
      const objectPath = resolveObjectPath(objectRoot, key)
      await Promise.all([
        rm(objectPath, { force: true }),
        rm(metadataPath(objectPath), { force: true }),
      ])
    },
  }
}

export function createInMemoryObjectStore(): ObjectStoreAdapter {
  const objects = new Map<string, ObjectStoreReadResult>()
  return {
    kind: 'filesystem',
    async putObject(input) {
      const key = assertSafeObjectKey(input.key)
      const body = bodyBuffer(input.body)
      const record = {
        key,
        body,
        contentType: input.contentType || null,
        metadata: normalizeMetadata(input.metadata),
      }
      objects.set(key, record)
      return {
        key,
        size: body.byteLength,
        contentType: record.contentType,
        metadata: record.metadata,
      }
    },
    async getObject(key) {
      const object = objects.get(assertSafeObjectKey(key))
      return object ? { ...object, body: Buffer.from(object.body) } : null
    },
    async headObject(key) {
      const object = objects.get(assertSafeObjectKey(key))
      return object ? {
        key: object.key,
        size: object.body.byteLength,
        contentType: object.contentType,
        metadata: object.metadata,
      } : null
    },
    async deleteObject(key) {
      objects.delete(assertSafeObjectKey(key))
    },
  }
}

export function createUnavailableObjectStore(reason = 'Cloud object storage is not configured.'): ObjectStoreAdapter {
  return {
    kind: 'unavailable',
    async putObject() {
      throw new Error(reason)
    },
    async getObject() {
      throw new Error(reason)
    },
    async headObject() {
      throw new Error(reason)
    },
    async deleteObject() {
      throw new Error(reason)
    },
  }
}

export function createS3CompatibleObjectStore(options: S3CompatibleObjectStoreOptions): ObjectStoreAdapter {
  const client = options.client || new S3Client({
    region: options.region || 'us-east-1',
    endpoint: options.endpoint || undefined,
    forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    credentials: options.credentials || undefined,
  } satisfies S3ClientConfig)
  return {
    kind: options.kind || 's3',
    async putObject(input) {
      const key = prefixedKey(options.prefix, input.key)
      const body = bodyBuffer(input.body)
      await client.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: body,
        ContentType: input.contentType || undefined,
        Metadata: normalizeMetadata(input.metadata),
      }))
      return {
        key: assertSafeObjectKey(input.key),
        size: body.byteLength,
        contentType: input.contentType || null,
        metadata: normalizeMetadata(input.metadata),
      }
    },
    async getObject(key) {
      const safeKey = assertSafeObjectKey(key)
      try {
        const result = await client.send(new GetObjectCommand({
          Bucket: options.bucket,
          Key: prefixedKey(options.prefix, safeKey),
        }))
        return {
          key: safeKey,
          body: await streamToBuffer(result.Body),
          contentType: result.ContentType || null,
          metadata: normalizeMetadata(result.Metadata),
        }
      } catch (error) {
        if (String((error as { name?: unknown }).name || '').includes('NoSuchKey')) return null
        throw error
      }
    },
    async headObject(key) {
      const safeKey = assertSafeObjectKey(key)
      try {
        const result = await client.send(new HeadObjectCommand({
          Bucket: options.bucket,
          Key: prefixedKey(options.prefix, safeKey),
        }))
        return {
          key: safeKey,
          size: Number(result.ContentLength || 0),
          contentType: result.ContentType || null,
          metadata: normalizeMetadata(result.Metadata),
        }
      } catch (error) {
        if (String((error as { name?: unknown }).name || '').includes('NotFound')) return null
        throw error
      }
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({
        Bucket: options.bucket,
        Key: prefixedKey(options.prefix, key),
      }))
    },
    close() {
      client.destroy?.()
    },
  }
}

export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStoreAdapter {
  const httpFetch = options.fetch || defaultHttpFetch()
  const tokenProvider = options.tokenProvider || createGcsAccessTokenProvider()
  const endpoint = (options.endpoint || 'https://storage.googleapis.com').replace(/\/+$/, '')
  const objectUrl = (key: string) => `${endpoint}/${encodeURIComponent(options.bucket)}/${encodeObjectPath(prefixedKey(options.prefix, key))}`
  const metadataHeaders = (metadata: Record<string, string> | undefined) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(normalizeMetadata(metadata))) {
      headers[`x-goog-meta-${key}`] = value
    }
    return headers
  }

  return {
    kind: 'gcs',
    async putObject(input) {
      const body = bodyBuffer(input.body)
      const response = await httpFetch(objectUrl(input.key), {
        method: 'PUT',
        headers: {
          ...await bearerHeaders(tokenProvider, options.credentials),
          'content-type': input.contentType || 'application/octet-stream',
          ...metadataHeaders(input.metadata),
        },
        body,
      })
      await assertHttpOk(response, 'GCS putObject')
      return {
        key: assertSafeObjectKey(input.key),
        size: body.byteLength,
        contentType: input.contentType || null,
        metadata: normalizeMetadata(input.metadata),
      }
    },
    async getObject(key) {
      const safeKey = assertSafeObjectKey(key)
      const response = await httpFetch(objectUrl(safeKey), {
        method: 'GET',
        headers: await bearerHeaders(tokenProvider, options.credentials),
      })
      if (response.status === 404) return null
      await assertHttpOk(response, 'GCS getObject')
      return {
        key: safeKey,
        body: await responseBuffer(response),
        contentType: response.headers.get('content-type'),
        metadata: headerMetadata(response.headers, 'x-goog-meta-'),
      }
    },
    async headObject(key) {
      const safeKey = assertSafeObjectKey(key)
      const response = await httpFetch(objectUrl(safeKey), {
        method: 'HEAD',
        headers: await bearerHeaders(tokenProvider, options.credentials),
      })
      if (response.status === 404) return null
      await assertHttpOk(response, 'GCS headObject')
      return {
        key: safeKey,
        size: contentLength(response.headers),
        contentType: response.headers.get('content-type'),
        metadata: headerMetadata(response.headers, 'x-goog-meta-'),
      }
    },
    async deleteObject(key) {
      const response = await httpFetch(objectUrl(key), {
        method: 'DELETE',
        headers: await bearerHeaders(tokenProvider, options.credentials),
      })
      if (response.status === 404) return
      await assertHttpOk(response, 'GCS deleteObject')
    },
  }
}

function azureContainerBaseUrl(options: AzureBlobObjectStoreOptions) {
  if (!options.endpoint?.trim()) {
    const accountName = options.credentials?.accountName?.trim()
    if (!accountName) {
      throw new Error('Azure Blob object storage requires an endpoint or credentials.accountName.')
    }
    return new URL(`https://${accountName}.blob.core.windows.net/${encodeURIComponent(options.container)}`)
  }
  const url = new URL(options.endpoint)
  const path = url.pathname.replace(/\/+$/, '')
  const hasContainer = path.split('/').filter(Boolean)[0] === options.container
  if (!hasContainer) {
    url.pathname = `${path}/${encodeURIComponent(options.container)}`.replace(/^\/?/, '/')
  }
  return url
}

function appendSasToken(url: URL, sasToken: string | undefined) {
  const trimmed = sasToken?.trim().replace(/^\?/, '')
  if (!trimmed) return
  const params = new URLSearchParams(trimmed)
  params.forEach((value, key) => {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value)
  })
}

function azureObjectUrl(baseUrl: URL, prefix: string | null | undefined, key: string, sasToken: string | undefined) {
  const next = new URL(baseUrl.toString())
  const basePath = next.pathname.replace(/\/+$/, '')
  next.pathname = `${basePath}/${encodeObjectPath(prefixedKey(prefix, key))}`
  appendSasToken(next, sasToken)
  return next.toString()
}

function azureHeaders(input: {
  contentType?: string | null
  metadata?: Record<string, string>
  bearerToken?: string | null
  includeBlobType?: boolean
}) {
  const headers: Record<string, string> = {
    'x-ms-version': '2023-11-03',
    'x-ms-date': new Date().toUTCString(),
  }
  if (input.bearerToken) headers.authorization = `Bearer ${input.bearerToken}`
  if (input.contentType) headers['content-type'] = input.contentType
  if (input.includeBlobType) headers['x-ms-blob-type'] = 'BlockBlob'
  for (const [key, value] of Object.entries(normalizeMetadata(input.metadata))) {
    headers[`x-ms-meta-${key}`] = value
  }
  return headers
}

export function createAzureBlobObjectStore(options: AzureBlobObjectStoreOptions): ObjectStoreAdapter {
  const httpFetch = options.fetch || defaultHttpFetch()
  const baseUrl = azureContainerBaseUrl(options)
  const tokenProvider = options.tokenProvider
  const objectUrl = (key: string) => azureObjectUrl(baseUrl, options.prefix, key, options.credentials?.sasToken)
  const authToken = () => tokenFromProvider(tokenProvider, options.credentials?.bearerToken)

  return {
    kind: 'azure-blob',
    async putObject(input) {
      const body = bodyBuffer(input.body)
      const response = await httpFetch(objectUrl(input.key), {
        method: 'PUT',
        headers: azureHeaders({
          bearerToken: await authToken(),
          contentType: input.contentType || 'application/octet-stream',
          metadata: input.metadata,
          includeBlobType: true,
        }),
        body,
      })
      await assertHttpOk(response, 'Azure Blob putObject')
      return {
        key: assertSafeObjectKey(input.key),
        size: body.byteLength,
        contentType: input.contentType || null,
        metadata: normalizeMetadata(input.metadata),
      }
    },
    async getObject(key) {
      const safeKey = assertSafeObjectKey(key)
      const response = await httpFetch(objectUrl(safeKey), {
        method: 'GET',
        headers: azureHeaders({ bearerToken: await authToken() }),
      })
      if (response.status === 404) return null
      await assertHttpOk(response, 'Azure Blob getObject')
      return {
        key: safeKey,
        body: await responseBuffer(response),
        contentType: response.headers.get('content-type'),
        metadata: headerMetadata(response.headers, 'x-ms-meta-'),
      }
    },
    async headObject(key) {
      const safeKey = assertSafeObjectKey(key)
      const response = await httpFetch(objectUrl(safeKey), {
        method: 'HEAD',
        headers: azureHeaders({ bearerToken: await authToken() }),
      })
      if (response.status === 404) return null
      await assertHttpOk(response, 'Azure Blob headObject')
      return {
        key: safeKey,
        size: contentLength(response.headers),
        contentType: response.headers.get('content-type'),
        metadata: headerMetadata(response.headers, 'x-ms-meta-'),
      }
    },
    async deleteObject(key) {
      const response = await httpFetch(objectUrl(key), {
        method: 'DELETE',
        headers: azureHeaders({ bearerToken: await authToken() }),
      })
      if (response.status === 404) return
      await assertHttpOk(response, 'Azure Blob deleteObject')
    },
  }
}

function envValue(env: Env, key: string) {
  const value = env[key]?.trim()
  return value || null
}

function resolveEnvRef(ref: string | undefined, env: Env) {
  if (!ref) return null
  const envName = ref.startsWith('env:') ? ref.slice('env:'.length) : ref
  return envValue(env, envName)
}

function resolveObjectStoreKind(config: OpenCoworkConfig, env: Env): ObjectStoreKind {
  const raw = envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_KIND') || config.cloud.storage.objectStore.kind
  if (
    raw === 'filesystem'
    || raw === 's3'
    || raw === 'gcs'
    || raw === 'azure-blob'
    || raw === 'digitalocean-spaces'
    || raw === 'minio'
  ) {
    return raw
  }
  throw new Error(`Unsupported cloud object store kind ${raw}.`)
}

function parseCredentials(value: string | null): ObjectStoreCredentials | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ObjectStoreCredentials>
    return {
      accessKeyId: typeof parsed.accessKeyId === 'string' ? parsed.accessKeyId : undefined,
      secretAccessKey: typeof parsed.secretAccessKey === 'string' ? parsed.secretAccessKey : undefined,
      sessionToken: typeof parsed.sessionToken === 'string' ? parsed.sessionToken : undefined,
      bearerToken: typeof parsed.bearerToken === 'string' ? parsed.bearerToken : undefined,
      sasToken: typeof parsed.sasToken === 'string' ? parsed.sasToken : undefined,
      accountName: typeof parsed.accountName === 'string' ? parsed.accountName : undefined,
    }
  } catch {
    return null
  }
}

export function resolveCloudObjectStoreConfig(config: OpenCoworkConfig, env: Env = process.env) {
  const objectStore = config.cloud.storage.objectStore
  const credentialsFromRef = parseCredentials(resolveEnvRef(objectStore.credentialsRef, env)) || {}
  const accessKeyId = envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_ACCESS_KEY_ID') || credentialsFromRef.accessKeyId
  const secretAccessKey = envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_SECRET_ACCESS_KEY') || credentialsFromRef.secretAccessKey
  const credentials: ObjectStoreCredentials = {
    ...credentialsFromRef,
    accessKeyId: accessKeyId || undefined,
    secretAccessKey: secretAccessKey || undefined,
    sessionToken: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_SESSION_TOKEN') || credentialsFromRef.sessionToken,
    bearerToken: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_BEARER_TOKEN') || credentialsFromRef.bearerToken,
    sasToken: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_SAS_TOKEN') || credentialsFromRef.sasToken,
    accountName: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_ACCOUNT_NAME') || credentialsFromRef.accountName,
  }
  return {
    kind: resolveObjectStoreKind(config, env),
    bucket: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_BUCKET') || objectStore.bucket || null,
    region: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_REGION') || objectStore.region || null,
    endpoint: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_ENDPOINT') || objectStore.endpoint || null,
    prefix: envValue(env, 'OPEN_COWORK_CLOUD_OBJECT_STORE_PREFIX') || objectStore.prefix || null,
    credentials: Object.values(credentials).some(Boolean) ? credentials : null,
  }
}

export function createObjectStoreForCloud(input: {
  config: OpenCoworkConfig
  env?: Env
  paths: PathProvider
}) {
  const resolved = resolveCloudObjectStoreConfig(input.config, input.env || process.env)
  switch (resolved.kind) {
    case 'filesystem':
      return createFilesystemObjectStore(input.paths.getArtifactRoot())
    case 's3':
    case 'minio':
    case 'digitalocean-spaces': {
      if (!resolved.bucket) {
        throw new Error(`Cloud object store ${resolved.kind} requires a bucket.`)
      }
      if (resolved.credentials && (!resolved.credentials.accessKeyId || !resolved.credentials.secretAccessKey)) {
        throw new Error(`Cloud object store ${resolved.kind} credentials require accessKeyId and secretAccessKey.`)
      }
      const s3Credentials = resolved.credentials
        ? {
            accessKeyId: resolved.credentials.accessKeyId!,
            secretAccessKey: resolved.credentials.secretAccessKey!,
            sessionToken: resolved.credentials.sessionToken,
          }
        : null
      return createS3CompatibleObjectStore({
        kind: resolved.kind,
        bucket: resolved.bucket,
        region: resolved.region,
        endpoint: resolved.endpoint,
        prefix: resolved.prefix,
        credentials: s3Credentials,
        forcePathStyle: resolved.kind === 'minio' || Boolean(resolved.endpoint),
      })
    }
    case 'gcs':
      if (!resolved.bucket) {
        throw new Error('Cloud object store gcs requires a bucket.')
      }
      return createGcsObjectStore({
        bucket: resolved.bucket,
        endpoint: resolved.endpoint,
        prefix: resolved.prefix,
        credentials: resolved.credentials,
      })
    case 'azure-blob':
      if (!resolved.bucket) {
        throw new Error('Cloud object store azure-blob requires a container in bucket.')
      }
      return createAzureBlobObjectStore({
        container: resolved.bucket,
        endpoint: resolved.endpoint,
        prefix: resolved.prefix,
        credentials: resolved.credentials,
      })
    default:
      return createUnavailableObjectStore()
  }
}

export function artifactObjectKey(input: {
  tenantId: string
  sessionId: string
  artifactId: string
  filename: string
}) {
  const extension = input.filename.includes('.') ? input.filename.split('.').pop() || 'bin' : 'bin'
  const safeExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) || 'bin'
  const digest = createHash('sha256').update(input.filename).digest('hex').slice(0, 16)
  return assertSafeObjectKey([
    'tenants',
    input.tenantId,
    'sessions',
    input.sessionId,
    'artifacts',
    `${input.artifactId}-${digest}.${safeExtension}`,
  ].join('/'))
}

export function readFilesystemObjectStream(root: string, key: string) {
  return createReadStream(resolveObjectPath(root, key))
}
