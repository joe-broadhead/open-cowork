import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto'
import { GoogleAuth } from 'google-auth-library'

export const CLOUD_SECRET_ENVELOPE_PREFIX = 'enc:v1:'
export const CLOUD_SECRET_PLAINTEXT_PREFIX = 'plain:v1:'

export type SecretAdapterMode = 'envelope-v1' | 'plaintext' | 'unavailable'

export type SecretAdapter = {
  mode: SecretAdapterMode
  protect: (plaintext: string, context?: string) => string
  reveal: (stored: string, context?: string) => string
}

type SecretEnvelope = {
  alg: 'A256GCM'
  iv: string
  tag: string
  ciphertext: string
}

export type CloudSecretStoreKind =
  | 'env'
  | 'gcp-secret-manager'
  | 'aws-secrets-manager'
  | 'azure-key-vault'

export type CloudSecretStoreHttpResponse = {
  ok: boolean
  status: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}

export type CloudSecretStoreHttpClient = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
  },
) => Promise<CloudSecretStoreHttpResponse>

export type AwsSecretStoreCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string | null
}

export type ResolveCloudSecretRefOptions = {
  env?: Record<string, string | undefined>
  fetch?: CloudSecretStoreHttpClient
  now?: () => Date
  gcpAccessTokenProvider?: () => Promise<string | null> | string | null
  azureAccessTokenProvider?: () => Promise<string | null> | string | null
  awsCredentialsProvider?: () => Promise<AwsSecretStoreCredentials | null> | AwsSecretStoreCredentials | null
}

function base64urlEncode(input: Buffer | string) {
  return Buffer.from(input).toString('base64url')
}

function base64urlDecode(input: string) {
  return Buffer.from(input, 'base64url')
}

function base64Decode(input: string) {
  return Buffer.from(input, 'base64').toString('utf8')
}

function deriveKey(keyMaterial: string | Buffer) {
  return createHash('sha256').update(keyMaterial).digest()
}

function setAad(cipher: { setAAD: (buffer: Buffer) => void }, context: string | undefined) {
  if (context) cipher.setAAD(Buffer.from(context))
}

function envValue(env: Record<string, string | undefined>, key: string) {
  const value = env[key]?.trim()
  return value || null
}

function defaultHttpFetch(): CloudSecretStoreHttpClient {
  return (url, init) => globalThis.fetch(url, init as Parameters<typeof fetch>[1]) as Promise<CloudSecretStoreHttpResponse>
}

async function responseText(response: CloudSecretStoreHttpResponse) {
  try {
    return response.text ? await response.text() : ''
  } catch {
    return ''
  }
}

async function responseJson(response: CloudSecretStoreHttpResponse, action: string) {
  if (!response.ok) {
    const body = await responseText(response)
    throw new Error(`${action} failed with HTTP ${response.status}${body ? `: ${body.slice(0, 256)}` : ''}.`)
  }
  if (!response.json) throw new Error(`${action} returned a non-JSON response.`)
  return response.json()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function defaultGcpAccessTokenProvider() {
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })
  return async () => {
    const client = await auth.getClient()
    const accessToken = await client.getAccessToken()
    return typeof accessToken === 'string' ? accessToken : accessToken?.token || null
  }
}

function defaultAzureAccessTokenProvider(fetcher: CloudSecretStoreHttpClient) {
  return async () => {
    const url = new URL('http://169.254.169.254/metadata/identity/oauth2/token')
    url.searchParams.set('api-version', '2018-02-01')
    url.searchParams.set('resource', 'https://vault.azure.net')
    const response = await fetcher(url.toString(), {
      method: 'GET',
      headers: { Metadata: 'true' },
    })
    const parsed = asRecord(await responseJson(response, 'Azure managed identity token request'))
    return readString(parsed.access_token)
  }
}

async function resolveMaybeProvider<T>(provider: (() => Promise<T | null> | T | null) | undefined) {
  return provider ? await provider() : null
}

function defaultAwsCredentialsProvider(env: Record<string, string | undefined>) {
  return (): AwsSecretStoreCredentials | null => {
    const accessKeyId = envValue(env, 'AWS_ACCESS_KEY_ID')
    const secretAccessKey = envValue(env, 'AWS_SECRET_ACCESS_KEY')
    if (!accessKeyId || !secretAccessKey) return null
    return {
      accessKeyId,
      secretAccessKey,
      sessionToken: envValue(env, 'AWS_SESSION_TOKEN'),
    }
  }
}

function dateParts(date: Date) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  }
}

function sha256Hex(input: string) {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, input: string) {
  return createHmac('sha256', key).update(input, 'utf8').digest()
}

function hmacHex(key: Buffer | string, input: string) {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex')
}

function awsSigningKey(secretAccessKey: string, dateStamp: string, region: string) {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp)
  const dateRegionKey = hmac(dateKey, region)
  const dateRegionServiceKey = hmac(dateRegionKey, 'secretsmanager')
  return hmac(dateRegionServiceKey, 'aws4_request')
}

function parseAwsSecretRef(url: URL, env: Record<string, string | undefined>) {
  const region = url.searchParams.get('region')?.trim() || envValue(env, 'AWS_REGION') || envValue(env, 'AWS_DEFAULT_REGION')
  const secretId = decodeURIComponent(`${url.host}${url.pathname}`.replace(/^\/+/, ''))
  if (!region) throw new Error('AWS Secrets Manager references require a region query parameter or AWS_REGION.')
  if (!secretId) throw new Error('AWS Secrets Manager references require a secret id.')
  return {
    region,
    secretId,
    versionStage: url.searchParams.get('versionStage')?.trim() || null,
    versionId: url.searchParams.get('versionId')?.trim() || null,
  }
}

async function resolveAwsSecretsManagerRef(
  ref: string,
  options: ResolveCloudSecretRefOptions,
  fetcher: CloudSecretStoreHttpClient,
) {
  const parsed = parseAwsSecretRef(new URL(ref), options.env || process.env)
  const credentials = await resolveMaybeProvider(options.awsCredentialsProvider)
    || defaultAwsCredentialsProvider(options.env || process.env)()
  if (!credentials) {
    throw new Error('AWS Secrets Manager references require AWS credentials.')
  }

  const endpoint = `https://secretsmanager.${parsed.region}.amazonaws.com/`
  const body = JSON.stringify({
    SecretId: parsed.secretId,
    ...(parsed.versionStage ? { VersionStage: parsed.versionStage } : {}),
    ...(parsed.versionId ? { VersionId: parsed.versionId } : {}),
  })
  const { amzDate, dateStamp } = dateParts((options.now || (() => new Date()))())
  const host = new URL(endpoint).host
  const headers: Record<string, string> = {
    'content-type': 'application/x-amz-json-1.1',
    host,
    'x-amz-date': amzDate,
    'x-amz-target': 'secretsmanager.GetSecretValue',
  }
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken
  const signedHeaderNames = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('')
  const signedHeaders = signedHeaderNames.join(';')
  const scope = `${dateStamp}/${parsed.region}/secretsmanager/aws4_request`
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join('\n')
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n')
  const signature = hmacHex(awsSigningKey(credentials.secretAccessKey, dateStamp, parsed.region), stringToSign)
  headers.authorization = [
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ')

  const result = asRecord(await responseJson(await fetcher(endpoint, {
    method: 'POST',
    headers,
    body,
  }), 'AWS Secrets Manager GetSecretValue'))
  const secretString = readString(result.SecretString)
  if (secretString) return secretString
  const secretBinary = readString(result.SecretBinary)
  if (secretBinary) return base64Decode(secretBinary)
  throw new Error('AWS Secrets Manager response did not include SecretString or SecretBinary.')
}

async function resolveGcpSecretManagerRef(
  ref: string,
  options: ResolveCloudSecretRefOptions,
  fetcher: CloudSecretStoreHttpClient,
) {
  const url = new URL(ref)
  const resource = `${url.host}${url.pathname}`.replace(/^\/+/, '')
  if (!/^projects\/[^/]+\/secrets\/[^/]+\/versions\/[^/]+$/.test(resource)) {
    throw new Error('GCP Secret Manager references must use gcp-sm://projects/{project}/secrets/{secret}/versions/{version}.')
  }
  const tokenProvider = options.gcpAccessTokenProvider || defaultGcpAccessTokenProvider()
  const token = await resolveMaybeProvider(tokenProvider)
  if (!token) throw new Error('GCP Secret Manager references require an access token.')
  const result = asRecord(await responseJson(await fetcher(
    `https://secretmanager.googleapis.com/v1/${resource}:access`,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    },
  ), 'GCP Secret Manager access'))
  const payload = asRecord(result.payload)
  const data = readString(payload.data)
  if (!data) throw new Error('GCP Secret Manager response did not include payload.data.')
  return base64Decode(data)
}

function azureVaultUrlFromRef(ref: string) {
  if (ref.startsWith('https://')) return new URL(ref)
  const url = new URL(ref)
  const [first, second, third] = `${url.host}${url.pathname}`.split('/').filter(Boolean)
  if (!first || second !== 'secrets' || !third) {
    throw new Error('Azure Key Vault references must use azure-kv://{vault}/secrets/{secret}/{version?}.')
  }
  const version = `${url.host}${url.pathname}`.split('/').filter(Boolean)[3]
  return new URL(`https://${first}.vault.azure.net/secrets/${encodeURIComponent(third)}${version ? `/${encodeURIComponent(version)}` : ''}`)
}

async function resolveAzureKeyVaultRef(
  ref: string,
  options: ResolveCloudSecretRefOptions,
  fetcher: CloudSecretStoreHttpClient,
) {
  const url = azureVaultUrlFromRef(ref)
  url.searchParams.set('api-version', url.searchParams.get('api-version') || '7.4')
  const tokenProvider = options.azureAccessTokenProvider || defaultAzureAccessTokenProvider(fetcher)
  const token = await resolveMaybeProvider(tokenProvider)
  if (!token) throw new Error('Azure Key Vault references require an access token.')
  const result = asRecord(await responseJson(await fetcher(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  }), 'Azure Key Vault secret get'))
  const value = readString(result.value)
  if (!value) throw new Error('Azure Key Vault response did not include value.')
  return value
}

export async function resolveCloudSecretRef(
  ref: string,
  options: ResolveCloudSecretRefOptions = {},
): Promise<string> {
  const trimmed = ref.trim()
  if (!trimmed) throw new Error('Cloud secret reference is required.')
  const env = options.env || process.env
  if (trimmed.startsWith('env:')) {
    const value = envValue(env, trimmed.slice('env:'.length))
    if (!value) throw new Error(`Cloud secret env reference ${trimmed} is not set.`)
    return value
  }
  const fetcher = options.fetch || defaultHttpFetch()
  if (trimmed.startsWith('gcp-sm://')) return resolveGcpSecretManagerRef(trimmed, options, fetcher)
  if (trimmed.startsWith('aws-sm://')) return resolveAwsSecretsManagerRef(trimmed, options, fetcher)
  if (trimmed.startsWith('azure-kv://') || trimmed.startsWith('https://')) {
    return resolveAzureKeyVaultRef(trimmed, options, fetcher)
  }
  throw new Error(`Unsupported cloud secret reference ${trimmed}.`)
}

export function createEnvelopeSecretAdapter(keyMaterial: string | Buffer): SecretAdapter {
  const key = deriveKey(keyMaterial)
  return {
    mode: 'envelope-v1',
    protect(plaintext, context) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      setAad(cipher, context)
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final(),
      ])
      const envelope: SecretEnvelope = {
        alg: 'A256GCM',
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
      }
      return `${CLOUD_SECRET_ENVELOPE_PREFIX}${base64urlEncode(JSON.stringify(envelope))}`
    },
    reveal(stored, context) {
      if (!stored.startsWith(CLOUD_SECRET_ENVELOPE_PREFIX)) {
        throw new Error('Secret is not an encrypted cloud secret envelope.')
      }
      const raw = base64urlDecode(stored.slice(CLOUD_SECRET_ENVELOPE_PREFIX.length)).toString('utf8')
      const envelope = JSON.parse(raw) as SecretEnvelope
      if (envelope.alg !== 'A256GCM') throw new Error(`Unsupported cloud secret algorithm ${envelope.alg}.`)
      const decipher = createDecipheriv('aes-256-gcm', key, base64urlDecode(envelope.iv))
      setAad(decipher, context)
      decipher.setAuthTag(base64urlDecode(envelope.tag))
      return Buffer.concat([
        decipher.update(base64urlDecode(envelope.ciphertext)),
        decipher.final(),
      ]).toString('utf8')
    },
  }
}

export function createPlaintextSecretAdapter(): SecretAdapter {
  return {
    mode: 'plaintext',
    protect(plaintext) {
      return `${CLOUD_SECRET_PLAINTEXT_PREFIX}${base64urlEncode(plaintext)}`
    },
    reveal(stored) {
      if (!stored.startsWith(CLOUD_SECRET_PLAINTEXT_PREFIX)) {
        throw new Error('Secret is not a plaintext cloud secret envelope.')
      }
      return base64urlDecode(stored.slice(CLOUD_SECRET_PLAINTEXT_PREFIX.length)).toString('utf8')
    },
  }
}

export function createUnavailableSecretAdapter(reason = 'Secret storage is not configured.'): SecretAdapter {
  return {
    mode: 'unavailable',
    protect() {
      throw new Error(reason)
    },
    reveal() {
      throw new Error(reason)
    },
  }
}

export function createEnvSecretAdapter(
  envName = 'OPEN_COWORK_CLOUD_SECRET_KEY',
  env: Record<string, string | undefined> = process.env,
): SecretAdapter {
  const keyMaterial = env[envName]?.trim()
  return keyMaterial
    ? createEnvelopeSecretAdapter(keyMaterial)
    : createUnavailableSecretAdapter(`Secret storage is not configured; set ${envName}.`)
}

export async function createCloudSecretAdapterFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: ResolveCloudSecretRefOptions = {},
): Promise<SecretAdapter> {
  const keyMaterial = envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY')
  if (keyMaterial) return createEnvelopeSecretAdapter(keyMaterial)

  const ref = envValue(env, 'OPEN_COWORK_CLOUD_SECRET_KEY_REF')
  if (!ref) {
    return createUnavailableSecretAdapter('Secret storage is not configured; set OPEN_COWORK_CLOUD_SECRET_KEY or OPEN_COWORK_CLOUD_SECRET_KEY_REF.')
  }
  return createEnvelopeSecretAdapter(await resolveCloudSecretRef(ref, {
    ...options,
    env,
  }))
}
