import { createHash, createHmac } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetBucketVersioningCommand,
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

// A time-limited URL the client can use to transfer an object directly to/from the backing
// store, bypassing the pod heap. Returned by the optional presign* capability below.
export type ObjectStorePresignedRequest = {
  method: 'GET' | 'PUT'
  url: string
  // Headers the client MUST send with the request (e.g. content-type on a PUT). May be empty.
  headers: Record<string, string>
  expiresAt: string
}

export type ObjectStorePresignedPostRequest = {
  method: 'POST'
  url: string
  // Every field must be copied verbatim into the multipart form before the file part.
  fields: Record<string, string>
  expiresAt: string
}

export type ObjectStoreDirectUploadObject = {
  size: number
  contentType: string | null
  checksumSha256: string
  // Opaque provider token used to bind promotion to the object version that was inspected.
  versionToken: string
}

// A plain ability to sign PUT requests says nothing about how many bytes the backing
// store accepts. Adapters may expose direct upload only when a provider-enforced POST
// policy binds the declared content length and SHA-256 checksum exactly.
export type ObjectStoreDirectUploadLifecycleCapability = {
  /**
   * Proves that key-only cleanup removes bytes instead of creating retained delete markers.
   * Reconciliation must fail closed unless this provider check succeeds.
   */
  verifyCleanupSafety(): Promise<boolean>
  inspect(key: string): Promise<ObjectStoreDirectUploadObject | null>
  promote(input: {
    stagingKey: string
    finalKey: string
    expected: ObjectStoreDirectUploadObject
  }): Promise<void>
  delete(key: string): Promise<void>
}

export type ObjectStorePresignedUploadCapability = ObjectStoreDirectUploadLifecycleCapability & {
  enforcement: 'exact-content-length'
  maxBytes: number
  /** Serialized provider origin used for CSP without minting throwaway credentials. */
  origin: string
  /** Proves that the browser's exact origin may submit POST uploads to the bucket. */
  verifyBrowserPostSafety(browserOrigin: string): Promise<boolean>
  presignPost(input: {
    key: string
    browserOrigin: string
    contentType?: string | null
    expectedSize: number
    // Lowercase hexadecimal SHA-256 digest of the exact object bytes.
    checksumSha256: string
    expiresSeconds?: number
  }): Promise<ObjectStorePresignedPostRequest | null>
}

export type ObjectStoreAdapter = {
  kind: ObjectStoreKind
  putObject(input: ObjectStorePutInput): Promise<ObjectStoreHeadResult>
  getObject(key: string): Promise<ObjectStoreReadResult | null>
  headObject(key: string): Promise<ObjectStoreHeadResult | null>
  deleteObject(key: string): Promise<void>
  // OPTIONAL direct-to-store transfer. Downloads require only a presigned GET. Uploads require
  // explicit size enforcement; a plain presigned PUT must never qualify. An absent capability
  // or null request means the caller MUST use the bounded buffered path.
  presignGet?(key: string, options?: { expiresSeconds?: number }): Promise<ObjectStorePresignedRequest | null>
  // Kept independent from browser issuance so removing static signing credentials or
  // fail-closing an unsafe browser origin cannot strand already-reserved provider bytes.
  directUploadLifecycle?: ObjectStoreDirectUploadLifecycleCapability
  presignedUpload?: ObjectStorePresignedUploadCapability
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
  const emit = async (operation: string, status: 'ok' | 'error', startedAtMs: number) => {
    const attributes = {
      cloud_object_store_kind: adapter.kind,
      operation,
      status,
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
      await emit(operation, 'error', startedAtMs)
      throw error
    }
  }
  return {
    kind: adapter.kind,
    putObject: (input) => instrument('put', () => adapter.putObject(input)),
    getObject: (key) => instrument('get', () => adapter.getObject(key)),
    headObject: (key) => instrument('head', () => adapter.headObject(key)),
    deleteObject: (key) => instrument('delete', () => adapter.deleteObject(key)),
    // Signing is local and passed through. Provider inspection/promotion/cleanup are I/O and use
    // fixed operation labels so the direct path stays visible without adding sensitive dimensions.
    ...(adapter.presignGet ? { presignGet: (key, options) => adapter.presignGet!(key, options) } : {}),
    ...(adapter.directUploadLifecycle
      ? {
          directUploadLifecycle: {
            verifyCleanupSafety: () => instrument(
              'head',
              () => adapter.directUploadLifecycle!.verifyCleanupSafety(),
            ),
            inspect: (key) => instrument('head', () => adapter.directUploadLifecycle!.inspect(key)),
            promote: (input) => instrument('put', () => adapter.directUploadLifecycle!.promote(input)),
            delete: (key) => instrument('delete', () => adapter.directUploadLifecycle!.delete(key)),
          },
        }
      : {}),
    ...(adapter.presignedUpload
      ? {
          presignedUpload: {
            enforcement: adapter.presignedUpload.enforcement,
            maxBytes: adapter.presignedUpload.maxBytes,
            origin: adapter.presignedUpload.origin,
            verifyCleanupSafety: () => instrument(
              'head',
              () => adapter.presignedUpload!.verifyCleanupSafety(),
            ),
            verifyBrowserPostSafety: (browserOrigin) => instrument(
              'head',
              () => adapter.presignedUpload!.verifyBrowserPostSafety(browserOrigin),
            ),
            presignPost: (input) => adapter.presignedUpload!.presignPost(input),
            inspect: (key) => instrument('head', () => adapter.presignedUpload!.inspect(key)),
            promote: (input) => instrument('put', () => adapter.presignedUpload!.promote(input)),
            delete: (key) => instrument('delete', () => adapter.presignedUpload!.delete(key)),
          },
        }
      : {}),
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
  /** Injectable monotonic-enough wall clock for the bounded provider-safety cache. */
  safetyNowMs?: () => number
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

const SLASH_CHAR_CODE = 47 // '/'

function stripTrailingSlashes(value: string): string {
  let end = value.length
  while (end > 0 && value.charCodeAt(end - 1) === SLASH_CHAR_CODE) end--
  return value.slice(0, end)
}

function stripEdgeSlashes(value: string): string {
  let start = 0
  const end = value.length
  while (start < end && value.charCodeAt(start) === SLASH_CHAR_CODE) start++
  return stripTrailingSlashes(value.slice(start))
}

function prefixedKey(prefix: string | null | undefined, key: string) {
  const safeKey = assertSafeObjectKey(key)
  const cleanPrefix = prefix == null ? undefined : stripEdgeSlashes(prefix.trim())
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

// AWS SigV4 query-string ("presigned URL") signing, implemented with node:crypto only so the
// presign capability needs no extra dependency. Validatable locally against AWS's published
// presigned-GET test vector (see cloud-object-store.test.ts); the actual S3 round-trip is only
// validatable against real S3 (staging). Encodes per RFC3986 with AWS's stricter rule set.
function awsUriEncode(value: string, encodeSlash = true) {
  let out = ''
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte)
    if (
      (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
      || char === '-' || char === '_' || char === '.' || char === '~'
    ) {
      out += char
    } else if (char === '/') {
      out += encodeSlash ? '%2F' : '/'
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

function hmacSha256(key: Buffer | string, data: string) {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

export type S3PresignInput = {
  method: 'GET' | 'PUT'
  protocol: 'http:' | 'https:'
  host: string
  // Already AWS-URI-encoded request path, with a leading '/'.
  canonicalUri: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | null
  expiresSeconds: number
  now: Date
}

export type S3PresignedPostInput = {
  url: string
  bucket: string
  key: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | null
  contentType?: string | null
  expectedSize: number
  checksumSha256: string
  expiresSeconds: number
  now: Date
}

export function signS3PresignedPost(input: S3PresignedPostInput): ObjectStorePresignedPostRequest {
  const key = assertSafeObjectKey(input.key)
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0) {
    throw new Error('S3 presigned POST expectedSize must be a positive safe integer.')
  }
  if (!/^[0-9a-f]{64}$/.test(input.checksumSha256)) {
    throw new Error('S3 presigned POST checksumSha256 must be a lowercase hexadecimal SHA-256 digest.')
  }
  const contentType = input.contentType?.trim() || 'application/octet-stream'
  const service = 's3'
  const amzDate = input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const credential = `${input.accessKeyId}/${credentialScope}`
  const expires = Math.max(1, Math.min(604_800, Math.floor(input.expiresSeconds)))
  const expiresAt = new Date(input.now.getTime() + expires * 1000).toISOString()
  const checksumBase64 = Buffer.from(input.checksumSha256, 'hex').toString('base64')
  const fields: Record<string, string> = {
    key,
    'Content-Type': contentType,
    success_action_status: '204',
    'x-amz-algorithm': 'AWS4-HMAC-SHA256',
    'x-amz-credential': credential,
    'x-amz-date': amzDate,
    'x-amz-checksum-algorithm': 'SHA256',
    'x-amz-checksum-sha256': checksumBase64,
  }
  const conditions: Array<Record<string, string> | ['content-length-range', number, number]> = [
    { bucket: input.bucket },
    { key },
    { 'Content-Type': contentType },
    { success_action_status: '204' },
    { 'x-amz-algorithm': fields['x-amz-algorithm']! },
    { 'x-amz-credential': credential },
    { 'x-amz-date': amzDate },
    { 'x-amz-checksum-algorithm': 'SHA256' },
    { 'x-amz-checksum-sha256': checksumBase64 },
  ]
  if (input.sessionToken) {
    fields['x-amz-security-token'] = input.sessionToken
    conditions.push({ 'x-amz-security-token': input.sessionToken })
  }
  conditions.push(['content-length-range', input.expectedSize, input.expectedSize])
  const policy = Buffer.from(JSON.stringify({ expiration: expiresAt, conditions }), 'utf8').toString('base64')
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service),
    'aws4_request',
  )
  fields.policy = policy
  fields['x-amz-signature'] = createHmac('sha256', signingKey).update(policy, 'utf8').digest('hex')
  return {
    method: 'POST',
    url: input.url,
    fields,
    expiresAt,
  }
}

// Exported for the AWS-vector unit test; not part of the public adapter surface.
export function signS3PresignedUrl(input: S3PresignInput): ObjectStorePresignedRequest {
  const service = 's3'
  const amzDate = `${input.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`
  const dateStamp = amzDate.slice(0, 8)
  const credentialScope = `${dateStamp}/${input.region}/${service}/aws4_request`
  const expires = Math.max(1, Math.min(604_800, Math.floor(input.expiresSeconds)))
  const queryParams: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expires)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
  if (input.sessionToken) queryParams.push(['X-Amz-Security-Token', input.sessionToken])
  const canonicalQuery = queryParams
    .map(([rawKey, rawValue]) => [awsUriEncode(rawKey), awsUriEncode(rawValue)] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([encodedKey, encodedValue]) => `${encodedKey}=${encodedValue}`)
    .join('&')
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    canonicalQuery,
    `host:${input.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')
  const signingKey = hmacSha256(
    hmacSha256(hmacSha256(hmacSha256(`AWS4${input.secretAccessKey}`, dateStamp), input.region), service),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex')
  return {
    method: input.method,
    url: `${input.protocol}//${input.host}${input.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers: {},
    expiresAt: new Date(input.now.getTime() + expires * 1000).toISOString(),
  }
}

// Derive the signed host + canonical path for an object, mirroring how the S3 client builds the
// request URL (virtual-hosted by default; path-style when forced or a custom endpoint is set).
function s3PresignTarget(options: S3CompatibleObjectStoreOptions, key: string) {
  const fullKey = prefixedKey(options.prefix, key)
  const encodedKey = fullKey.split('/').map((segment) => awsUriEncode(segment, false)).join('/')
  const forcePathStyle = options.forcePathStyle ?? Boolean(options.endpoint)
  if (options.endpoint) {
    const endpoint = new URL(options.endpoint)
    const protocol = (endpoint.protocol === 'http:' ? 'http:' : 'https:') as 'http:' | 'https:'
    const basePath = endpoint.pathname.replace(/\/+$/, '')
    return forcePathStyle
      ? { protocol, host: endpoint.host, canonicalUri: `${basePath}/${options.bucket}/${encodedKey}` }
      : { protocol, host: `${options.bucket}.${endpoint.host}`, canonicalUri: `/${encodedKey}` }
  }
  const region = options.region || 'us-east-1'
  return forcePathStyle
    ? { protocol: 'https:' as const, host: `s3.${region}.amazonaws.com`, canonicalUri: `/${options.bucket}/${encodedKey}` }
    : { protocol: 'https:' as const, host: `${options.bucket}.s3.${region}.amazonaws.com`, canonicalUri: `/${encodedKey}` }
}

function s3PostTarget(options: S3CompatibleObjectStoreOptions, key: string) {
  const fullKey = prefixedKey(options.prefix, key)
  if (options.endpoint) {
    const endpoint = new URL(options.endpoint)
    const basePath = endpoint.pathname.replace(/\/+$/, '')
    return {
      key: fullKey,
      url: `${endpoint.protocol}//${options.bucket}.${endpoint.host}${basePath || '/'}`,
    }
  }
  const region = options.region || 'us-east-1'
  return {
    key: fullKey,
    url: `https://${options.bucket}.s3.${region}.amazonaws.com/`,
  }
}

const DEFAULT_PRESIGN_EXPIRES_SECONDS = 900
const DEFAULT_S3_PRESIGNED_UPLOAD_MAX_BYTES = 25 * 1024 * 1024
const S3_DIRECT_UPLOAD_SAFETY_CACHE_TTL_MS = 30_000

function s3ChecksumSha256Hex(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('S3 direct-upload object is missing its SHA-256 checksum attestation.')
  }
  const checksum = Buffer.from(value, 'base64')
  if (checksum.byteLength !== 32) {
    throw new Error('S3 direct-upload object has an invalid SHA-256 checksum attestation.')
  }
  return checksum.toString('hex')
}

function directUploadObjectMatches(
  actual: ObjectStoreDirectUploadObject | null,
  expected: ObjectStoreDirectUploadObject,
) {
  return Boolean(
    actual
    && actual.size === expected.size
    && actual.contentType === expected.contentType
    && actual.checksumSha256 === expected.checksumSha256
  )
}

function exactHttpOrigin(value: string) {
  try {
    const parsed = new URL(value)
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.origin === value
      && !parsed.username
      && !parsed.password
  } catch {
    return false
  }
}

export function createS3CompatibleObjectStore(options: S3CompatibleObjectStoreOptions): ObjectStoreAdapter {
  const kind = options.kind || 's3'
  const credentials = options.credentials
  const forcePathStyle = options.forcePathStyle ?? Boolean(options.endpoint)
  // A virtual-hosted bucket gives CSP a bucket-specific origin. AWS path-style
  // addressing uses a region-wide shared origin, and dotted virtual-host names do
  // not match AWS's wildcard TLS certificate, so both remain on buffered upload.
  const browserPostAddressingSafe = !forcePathStyle && !options.bucket.includes('.')
  const safetyNowMs = options.safetyNowMs || Date.now
  let cleanupSafetyExpiresAtMs = 0
  let browserPostSafetyCache: { origin: string, expiresAtMs: number } | null = null
  const client = options.client || new S3Client({
    region: options.region || 'us-east-1',
    endpoint: options.endpoint || undefined,
    forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
    credentials: options.credentials || undefined,
  } satisfies S3ClientConfig)
  const inspectDirectUpload = async (key: string): Promise<ObjectStoreDirectUploadObject | null> => {
    const safeKey = assertSafeObjectKey(key)
    try {
      const result = await client.send(new HeadObjectCommand({
        Bucket: options.bucket,
        Key: prefixedKey(options.prefix, safeKey),
        ChecksumMode: 'ENABLED',
      }))
      const versionToken = result.VersionId
        ? `version:${result.VersionId}`
        : result.ETag
          ? `etag:${result.ETag}`
          : null
      if (!versionToken) {
        throw new Error('S3 direct-upload object is missing a version attestation.')
      }
      return {
        size: Number(result.ContentLength || 0),
        contentType: result.ContentType || null,
        checksumSha256: s3ChecksumSha256Hex(result.ChecksumSHA256),
        versionToken,
      }
    } catch (error) {
      const errorName = String((error as { name?: unknown }).name || '')
      const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
      if (statusCode === 404 || errorName.includes('NotFound') || errorName.includes('NoSuchKey')) return null
      throw error
    }
  }
  const verifyDirectUploadCleanupSafety = async () => {
    if (cleanupSafetyExpiresAtMs > safetyNowMs()) return true
    const result = await client.send(new GetBucketVersioningCommand({
      Bucket: options.bucket,
    }))
    // AWS omits Status only when versioning has never been enabled. Both Enabled and
    // Suspended retain versions behind key-only deletes, so neither is cleanup-safe.
    const safe = result.Status === undefined
    if (safe) cleanupSafetyExpiresAtMs = safetyNowMs() + S3_DIRECT_UPLOAD_SAFETY_CACHE_TTL_MS
    return safe
  }
  const verifyDirectUploadBrowserPostSafety = async (browserOrigin: string) => {
    let parsedOrigin: URL
    try {
      parsedOrigin = new URL(browserOrigin)
    } catch {
      return false
    }
    if (
      parsedOrigin.origin !== browserOrigin
      || (parsedOrigin.protocol !== 'https:' && parsedOrigin.protocol !== 'http:')
    ) return false
    if (
      browserPostSafetyCache?.origin === browserOrigin
      && browserPostSafetyCache.expiresAtMs > safetyNowMs()
    ) return true
    // Retain at most one successful exact-origin attestation. A request for a new
    // canonical origin evicts the previous entry before touching the provider.
    if (browserPostSafetyCache?.origin !== browserOrigin) browserPostSafetyCache = null
    const result = await client.send(new GetBucketCorsCommand({
      Bucket: options.bucket,
    }))
    const postRules = (result.CORSRules || []).filter((rule) => rule.AllowedMethods?.includes('POST'))
    const safe = postRules.some((rule) => rule.AllowedOrigins?.includes(browserOrigin))
      && postRules.every((rule) => (rule.AllowedOrigins || []).every(exactHttpOrigin))
    if (safe) {
      browserPostSafetyCache = {
        origin: browserOrigin,
        expiresAtMs: safetyNowMs() + S3_DIRECT_UPLOAD_SAFETY_CACHE_TTL_MS,
      }
    }
    return safe
  }
  const promoteDirectUpload = async (input: {
    stagingKey: string
    finalKey: string
    expected: ObjectStoreDirectUploadObject
  }) => {
    const stagingKey = assertSafeObjectKey(input.stagingKey)
    const finalKey = assertSafeObjectKey(input.finalKey)
    if (stagingKey === finalKey) throw new Error('S3 direct-upload promotion requires distinct keys.')
    const sourceKey = prefixedKey(options.prefix, stagingKey)
    const encodedSource = `${encodeURIComponent(options.bucket)}/${encodeObjectPath(sourceKey)}`
    let copySource = encodedSource
    let copySourceIfMatch: string | undefined
    if (input.expected.versionToken.startsWith('version:')) {
      const versionId = input.expected.versionToken.slice('version:'.length)
      if (!versionId) throw new Error('S3 direct-upload promotion has an invalid version token.')
      copySource = `${encodedSource}?versionId=${encodeURIComponent(versionId)}`
    } else if (input.expected.versionToken.startsWith('etag:')) {
      copySourceIfMatch = input.expected.versionToken.slice('etag:'.length)
      if (!copySourceIfMatch) throw new Error('S3 direct-upload promotion has an invalid ETag token.')
    } else {
      throw new Error('S3 direct-upload promotion has an unsupported version token.')
    }
    await client.send(new CopyObjectCommand({
      Bucket: options.bucket,
      Key: prefixedKey(options.prefix, finalKey),
      CopySource: copySource,
      CopySourceIfMatch: copySourceIfMatch,
      ChecksumAlgorithm: 'SHA256',
      MetadataDirective: 'COPY',
    }))
    const promoted = await inspectDirectUpload(finalKey)
    if (!directUploadObjectMatches(promoted, input.expected)) {
      throw new Error('S3 direct-upload promotion failed provider attestation.')
    }
  }
  const deleteDirectUpload = async (key: string) => {
    await client.send(new DeleteObjectCommand({
      Bucket: options.bucket,
      Key: prefixedKey(options.prefix, key),
    }))
  }
  const directUploadLifecycle: ObjectStoreDirectUploadLifecycleCapability | null = kind === 's3'
    ? {
        verifyCleanupSafety: verifyDirectUploadCleanupSafety,
        inspect: inspectDirectUpload,
        promote: promoteDirectUpload,
        delete: deleteDirectUpload,
      }
    : null
  return {
    kind,
    async putObject(input) {
      const key = prefixedKey(options.prefix, input.key)
      const body = bodyBuffer(input.body)
      await client.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: body,
        ...(kind === 's3'
          ? {
              ChecksumAlgorithm: 'SHA256' as const,
              ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
            }
          : {}),
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
    async presignGet(key, presignOptions) {
      const signed = presignS3Object('GET', key, undefined, presignOptions?.expiresSeconds)
      return signed
    },
    ...(directUploadLifecycle ? { directUploadLifecycle } : {}),
    ...(kind === 's3'
      && browserPostAddressingSafe
      && credentials?.accessKeyId
      && credentials.secretAccessKey
      ? {
          presignedUpload: {
            enforcement: 'exact-content-length' as const,
            maxBytes: DEFAULT_S3_PRESIGNED_UPLOAD_MAX_BYTES,
            origin: new URL(s3PostTarget(options, 'origin-probe').url).origin,
            ...directUploadLifecycle!,
            verifyBrowserPostSafety: verifyDirectUploadBrowserPostSafety,
            async presignPost(input) {
              if (input.expectedSize > DEFAULT_S3_PRESIGNED_UPLOAD_MAX_BYTES) return null
              // Provider reads are owned by the scheduler/readiness safety lease. Trusted
              // composition must gate this local signer on that current cross-process proof.
              const target = s3PostTarget(options, input.key)
              return signS3PresignedPost({
                url: target.url,
                bucket: options.bucket,
                key: target.key,
                region: options.region || 'us-east-1',
                accessKeyId: credentials.accessKeyId,
                secretAccessKey: credentials.secretAccessKey,
                sessionToken: credentials.sessionToken,
                contentType: input.contentType,
                expectedSize: input.expectedSize,
                checksumSha256: input.checksumSha256,
                expiresSeconds: input.expiresSeconds && input.expiresSeconds > 0
                  ? input.expiresSeconds
                  : DEFAULT_PRESIGN_EXPIRES_SECONDS,
                now: new Date(),
              })
            },
          },
        }
      : {}),
    close() {
      client.destroy?.()
    },
  }

  // Presign only when STATIC credentials are configured. With the default AWS credential chain
  // (e.g. IRSA/instance role) the keys are resolved asynchronously by the SDK and are not
  // available here, so we return null and the caller falls back to the buffered path.
  function presignS3Object(
    method: 'GET' | 'PUT',
    key: string,
    _contentType: string | null | undefined,
    expiresSeconds: number | undefined,
  ): ObjectStorePresignedRequest | null {
    const staticCredentials = options.credentials
    if (!staticCredentials?.accessKeyId || !staticCredentials?.secretAccessKey) return null
    const target = s3PresignTarget(options, key)
    return signS3PresignedUrl({
      method,
      protocol: target.protocol,
      host: target.host,
      canonicalUri: target.canonicalUri,
      region: options.region || 'us-east-1',
      accessKeyId: staticCredentials.accessKeyId,
      secretAccessKey: staticCredentials.secretAccessKey,
      sessionToken: staticCredentials.sessionToken,
      expiresSeconds: expiresSeconds && expiresSeconds > 0 ? expiresSeconds : DEFAULT_PRESIGN_EXPIRES_SECONDS,
      now: new Date(),
    })
  }
}

export function createGcsObjectStore(options: GcsObjectStoreOptions): ObjectStoreAdapter {
  const httpFetch = options.fetch || defaultHttpFetch()
  const tokenProvider = options.tokenProvider || createGcsAccessTokenProvider()
  const endpoint = stripTrailingSlashes(options.endpoint || 'https://storage.googleapis.com')
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
