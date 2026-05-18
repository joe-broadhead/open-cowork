import type {
  AuthState,
  UpdateCheckResult,
  UpdateInstallUnsupportedReason,
  UpdateReleaseSourceDescriptor,
} from '@open-cowork/shared'
import type { OpenCoworkConfig, UpdateReleaseSourceConfig } from './config-types.ts'
import { getAppConfig, getBranding } from './config-loader.ts'
import { compareVersions, normalizeVersion } from './update-version.ts'
import {
  githubApiReleaseUrl,
  githubHtmlReleasesUrl,
  githubReleaseSourceDescriptor,
  resolveGithubReleaseSourceInput,
} from './update-release-source-github.ts'
import {
  genericReleaseSourceDescriptor,
  normalizeUpdateChannel,
  normalizeUpdateSourceUrl,
  parseUpdateInfoVersion,
  releaseFeedFileUrl,
} from './update-release-source-generic.ts'
import {
  gcsReleaseBaseUrl,
  gcsReleaseSourceDescriptor,
  normalizeBrokerProviderPayload,
} from './update-release-source-gcs.ts'

const DEFAULT_CHANNEL = 'latest'
const DEFAULT_GCS_REQUIRED_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only'
const GOOGLE_CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
const FETCH_TIMEOUT_MS = 5000

export type ElectronUpdaterProviderConfig = Record<string, unknown>

export interface ResolvedUpdateReleaseSource {
  descriptor: UpdateReleaseSourceDescriptor
  manualReleaseUrl: string | null
  installProvider: ElectronUpdaterProviderConfig
  requestHeaders: Record<string, string>
  discoverLatest: () => Promise<UpdateCheckResult>
}

export class UpdateReleaseSourceError extends Error {
  readonly reason: UpdateInstallUnsupportedReason
  readonly descriptor: UpdateReleaseSourceDescriptor | null
  readonly manualReleaseUrl: string | null

  constructor(
    reason: UpdateInstallUnsupportedReason,
    message: string,
    options: {
      descriptor?: UpdateReleaseSourceDescriptor | null
      manualReleaseUrl?: string | null
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'UpdateReleaseSourceError'
    this.reason = reason
    this.descriptor = options.descriptor ?? null
    this.manualReleaseUrl = options.manualReleaseUrl ?? null
  }
}

export interface ResolveUpdateReleaseSourceOptions {
  config?: OpenCoworkConfig
  currentVersion?: string
  fetchImpl?: typeof fetch
  getAuthState?: () => AuthState
  refreshGoogleAccessToken?: () => Promise<string | null>
}

function safeManualReleaseUrl(value?: string | null) {
  if (!value) return null
  const normalized = normalizeUpdateSourceUrl(value.trim())
  if (!normalized) return null
  const parsed = new URL(normalized)
  parsed.search = ''
  return parsed.toString()
}

function updateConfig(config: OpenCoworkConfig) {
  return config.updates || { enabled: true }
}

function releaseSourceConfig(config: OpenCoworkConfig): UpdateReleaseSourceConfig | undefined {
  return updateConfig(config).releaseSource
}

function manualReleaseUrlFor(config: OpenCoworkConfig, fallback?: string | null) {
  return safeManualReleaseUrl(updateConfig(config).manualFallbackUrl) || safeManualReleaseUrl(fallback)
}

function channelFromConfig(
  config: { channel?: string } | undefined,
  descriptor?: UpdateReleaseSourceDescriptor | null,
  manualReleaseUrl?: string | null,
) {
  const channel = normalizeUpdateChannel(config?.channel || DEFAULT_CHANNEL)
  if (channel) return channel
  throw new UpdateReleaseSourceError(
    'source-misconfigured',
    'The update release source channel must use 1-80 letters, numbers, dots, underscores, or hyphens.',
    { descriptor, manualReleaseUrl },
  )
}

async function currentVersionFromOptions(options: ResolveUpdateReleaseSourceOptions) {
  if (options.currentVersion) return options.currentVersion
  try {
    const electron = await import('electron')
    return electron.app?.getVersion?.() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchTextOrThrow(input: {
  fetchImpl: typeof fetch
  url: string
  headers?: Record<string, string>
  descriptor: UpdateReleaseSourceDescriptor
  manualReleaseUrl: string | null
}) {
  const response = await fetchWithTimeout(input.fetchImpl, input.url, {
    headers: input.headers || {},
  })
  if (response.status === 401 || response.status === 403) {
    throw new UpdateReleaseSourceError(
      'auth-forbidden',
      'The private update release source rejected the current credentials.',
      { descriptor: input.descriptor, manualReleaseUrl: input.manualReleaseUrl },
    )
  }
  if (!response.ok) {
    throw new UpdateReleaseSourceError(
      'source-unreachable',
      `The update release source responded with ${response.status}.`,
      { descriptor: input.descriptor, manualReleaseUrl: input.manualReleaseUrl },
    )
  }
  return response.text()
}

function hasRequiredGoogleScopes(config: OpenCoworkConfig, requiredScopes: string[]) {
  if (config.auth.mode !== 'google-oauth') return false
  const configured = new Set(config.auth.googleOAuth?.scopes?.length
    ? config.auth.googleOAuth.scopes
    : [GOOGLE_CLOUD_PLATFORM_SCOPE])
  if (configured.has(GOOGLE_CLOUD_PLATFORM_SCOPE)) return true
  return requiredScopes.every((scope) => configured.has(scope))
}

async function resolveGoogleAccessToken(input: {
  config: OpenCoworkConfig
  descriptor: UpdateReleaseSourceDescriptor
  manualReleaseUrl: string | null
  options: ResolveUpdateReleaseSourceOptions
  requiredScopes?: string[]
}) {
  const requiredScopes = input.requiredScopes?.length ? input.requiredScopes : [DEFAULT_GCS_REQUIRED_SCOPE]
  if (input.config.auth.mode !== 'google-oauth' || !hasRequiredGoogleScopes(input.config, requiredScopes)) {
    throw new UpdateReleaseSourceError(
      'source-misconfigured',
      'This private update release source requires Google OAuth with release-read scopes.',
      { descriptor: input.descriptor, manualReleaseUrl: input.manualReleaseUrl },
    )
  }
  const authState = input.options.getAuthState
    ? input.options.getAuthState()
    : (await import('./auth.ts')).getAuthState()
  if (!authState.authenticated) {
    throw new UpdateReleaseSourceError(
      'auth-required',
      'Sign in with Google to check this private update release source.',
      { descriptor: input.descriptor, manualReleaseUrl: input.manualReleaseUrl },
    )
  }
  const token = input.options.refreshGoogleAccessToken
    ? await input.options.refreshGoogleAccessToken()
    : await (await import('./auth.ts')).refreshAccessToken()
  if (!token) {
    throw new UpdateReleaseSourceError(
      'auth-expired',
      'Your Google session expired before the private update release source could be checked.',
      { descriptor: input.descriptor, manualReleaseUrl: input.manualReleaseUrl },
    )
  }
  return token
}

function checkResultFromLatest(input: {
  currentVersion: string
  latestVersion: string
  releaseUrl: string
}): UpdateCheckResult {
  const latestVersion = normalizeVersion(input.latestVersion)
  return {
    status: 'ok',
    currentVersion: input.currentVersion,
    latestVersion,
    hasUpdate: compareVersions(latestVersion, input.currentVersion) > 0,
    releaseUrl: input.releaseUrl,
  }
}

async function resolveGithubSource(input: {
  config: OpenCoworkConfig
  sourceConfig?: Extract<UpdateReleaseSourceConfig, { kind: 'github-releases' }>
  options: ResolveUpdateReleaseSourceOptions
  currentVersion: string
}) {
  const normalized = resolveGithubReleaseSourceInput({
    config: input.sourceConfig,
    brandingHelpUrl: input.config.branding.helpUrl,
  })
  if (!normalized) {
    throw new UpdateReleaseSourceError(
      'source-misconfigured',
      'No GitHub release source is configured.',
      { manualReleaseUrl: manualReleaseUrlFor(input.config, null) },
    )
  }
  const descriptor = githubReleaseSourceDescriptor(normalized)
  const manualReleaseUrl = manualReleaseUrlFor(input.config, githubHtmlReleasesUrl(normalized.owner, normalized.repo))
  const requestHeaders: Record<string, string> = normalized.token ? { Authorization: `Bearer ${normalized.token}` } : {}

  return {
    descriptor,
    manualReleaseUrl,
    installProvider: {
      provider: 'github',
      owner: normalized.owner,
      repo: normalized.repo,
      channel: normalized.channel,
      ...(normalized.token ? { private: true, token: normalized.token } : {}),
    },
    requestHeaders,
    discoverLatest: async () => {
      const responseText = await fetchTextOrThrow({
        fetchImpl: input.options.fetchImpl || fetch,
        url: githubApiReleaseUrl(normalized.owner, normalized.repo, normalized.channel),
        headers: {
          'User-Agent': 'open-cowork-update-check',
          'Accept': 'application/vnd.github+json',
          ...requestHeaders,
        },
        descriptor,
        manualReleaseUrl,
      })
      const body = JSON.parse(responseText) as { tag_name?: string; html_url?: string }
      if (!body.tag_name || !body.html_url) {
        throw new UpdateReleaseSourceError(
          'source-unreachable',
          'The GitHub release payload was malformed.',
          { descriptor, manualReleaseUrl },
        )
      }
      return checkResultFromLatest({
        currentVersion: input.currentVersion,
        latestVersion: body.tag_name,
        releaseUrl: body.html_url,
      })
    },
  } satisfies ResolvedUpdateReleaseSource
}

function staticHeaders(sourceConfig: Extract<UpdateReleaseSourceConfig, { kind: 'generic-http' }>) {
  if (sourceConfig.auth?.kind !== 'static-headers') return {}
  return Object.fromEntries(
    Object.entries(sourceConfig.auth.headers || {})
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].trim().length > 0),
  )
}

async function resolveGenericSource(input: {
  config: OpenCoworkConfig
  sourceConfig: Extract<UpdateReleaseSourceConfig, { kind: 'generic-http' }>
  currentVersion: string
  options: ResolveUpdateReleaseSourceOptions
}) {
  const url = normalizeUpdateSourceUrl(input.sourceConfig.url)
  if (!url) {
    throw new UpdateReleaseSourceError('source-misconfigured', 'The generic update release source URL must be HTTPS.')
  }
  const channel = channelFromConfig(input.sourceConfig)
  const requestHeaders = staticHeaders(input.sourceConfig)
  const descriptor = genericReleaseSourceDescriptor({
    label: input.sourceConfig.label?.trim() || 'Private release feed',
    channel,
    hasHeaders: Object.keys(requestHeaders).length > 0,
  })
  const manualReleaseFallback = Object.keys(requestHeaders).length > 0 ? null : url
  const manualReleaseUrl = manualReleaseUrlFor(input.config, manualReleaseFallback)
  return {
    descriptor,
    manualReleaseUrl,
    installProvider: {
      provider: 'generic',
      url,
      channel,
      ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
    },
    requestHeaders,
    discoverLatest: async () => {
      const yamlText = await fetchTextOrThrow({
        fetchImpl: input.options.fetchImpl || fetch,
        url: releaseFeedFileUrl(url, channel),
        headers: requestHeaders,
        descriptor,
        manualReleaseUrl,
      })
      const latestVersion = parseUpdateInfoVersion(yamlText)
      if (!latestVersion) {
        throw new UpdateReleaseSourceError(
          'source-unreachable',
          'The update feed metadata did not include a version.',
          { descriptor, manualReleaseUrl },
        )
      }
      return checkResultFromLatest({
        currentVersion: input.currentVersion,
        latestVersion,
        releaseUrl: manualReleaseUrl || (Object.keys(requestHeaders).length > 0 ? '' : url),
      })
    },
  } satisfies ResolvedUpdateReleaseSource
}

async function resolveGcsSource(input: {
  config: OpenCoworkConfig
  sourceConfig: Extract<UpdateReleaseSourceConfig, { kind: 'gcs' }>
  currentVersion: string
  options: ResolveUpdateReleaseSourceOptions
}) {
  const channel = channelFromConfig(input.sourceConfig)
  const auth = input.sourceConfig.auth || { kind: 'google-oauth' as const }
  const descriptor = gcsReleaseSourceDescriptor({
    label: input.sourceConfig.label?.trim() || 'Private release feed',
    channel,
    authKind: auth.kind,
  })
  const manualReleaseUrl = manualReleaseUrlFor(input.config, null)
  const token = await resolveGoogleAccessToken({
    config: input.config,
    descriptor,
    manualReleaseUrl,
    options: input.options,
    requiredScopes: auth.requiredScopes,
  })

  if (auth.kind === 'signed-url-broker') {
    const brokerUrl = normalizeUpdateSourceUrl(auth.brokerUrl)
    if (!brokerUrl) {
      throw new UpdateReleaseSourceError(
        'source-misconfigured',
        'The signed update URL broker must use HTTPS.',
        { descriptor, manualReleaseUrl },
      )
    }
    const response = await fetchWithTimeout(input.options.fetchImpl || fetch, brokerUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        platform: 'darwin',
      }),
    })
    if (response.status === 401 || response.status === 403) {
      throw new UpdateReleaseSourceError(
        'auth-forbidden',
        'The update URL broker rejected the current credentials.',
        { descriptor, manualReleaseUrl },
      )
    }
    if (!response.ok) {
      throw new UpdateReleaseSourceError(
        'source-unreachable',
        `The update URL broker responded with ${response.status}.`,
        { descriptor, manualReleaseUrl },
      )
    }
    const brokerPayload = normalizeBrokerProviderPayload(await response.json())
    if (!brokerPayload) {
      throw new UpdateReleaseSourceError(
        'source-unreachable',
        'The update URL broker returned malformed release metadata.',
        { descriptor, manualReleaseUrl },
      )
    }
    const requestHeaders = brokerPayload.requestHeaders
    return {
      descriptor,
      manualReleaseUrl,
      installProvider: {
        provider: 'generic',
        url: brokerPayload.providerUrl,
        channel,
        ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
      },
      requestHeaders,
      discoverLatest: async () => {
        const yamlText = await fetchTextOrThrow({
          fetchImpl: input.options.fetchImpl || fetch,
          url: releaseFeedFileUrl(brokerPayload.providerUrl, channel),
          headers: requestHeaders,
          descriptor,
          manualReleaseUrl,
        })
        const latestVersion = parseUpdateInfoVersion(yamlText)
        if (!latestVersion) {
          throw new UpdateReleaseSourceError(
            'source-unreachable',
            'The brokered update feed metadata did not include a version.',
            { descriptor, manualReleaseUrl },
          )
        }
        return checkResultFromLatest({
          currentVersion: input.currentVersion,
          latestVersion,
          releaseUrl: manualReleaseUrl || '',
        })
      },
    } satisfies ResolvedUpdateReleaseSource
  }

  const baseUrl = gcsReleaseBaseUrl({
    bucket: input.sourceConfig.bucket,
    prefix: input.sourceConfig.prefix,
    channel,
  })
  if (!baseUrl) {
    throw new UpdateReleaseSourceError(
      'source-misconfigured',
      'The GCS update release source is missing a valid bucket or prefix.',
      { descriptor, manualReleaseUrl },
    )
  }
  const requestHeaders = { Authorization: `Bearer ${token}` }
  return {
    descriptor,
    manualReleaseUrl,
    installProvider: {
      provider: 'generic',
      url: baseUrl,
      channel,
      requestHeaders,
    },
    requestHeaders,
    discoverLatest: async () => {
      const yamlText = await fetchTextOrThrow({
        fetchImpl: input.options.fetchImpl || fetch,
        url: releaseFeedFileUrl(baseUrl, channel),
        headers: requestHeaders,
        descriptor,
        manualReleaseUrl,
      })
      const latestVersion = parseUpdateInfoVersion(yamlText)
      if (!latestVersion) {
        throw new UpdateReleaseSourceError(
          'source-unreachable',
          'The GCS update feed metadata did not include a version.',
          { descriptor, manualReleaseUrl },
        )
      }
      return checkResultFromLatest({
        currentVersion: input.currentVersion,
        latestVersion,
        releaseUrl: manualReleaseUrl || 'https://storage.cloud.google.com/',
      })
    },
  } satisfies ResolvedUpdateReleaseSource
}

export async function resolveUpdateReleaseSource(
  options: ResolveUpdateReleaseSourceOptions = {},
): Promise<ResolvedUpdateReleaseSource> {
  const config = options.config || getAppConfig()
  const currentVersion = await currentVersionFromOptions(options)
  const updates = updateConfig(config)
  if (updates.enabled === false) {
    throw new UpdateReleaseSourceError(
      'source-disabled',
      'Update checks are disabled for this build.',
      { manualReleaseUrl: manualReleaseUrlFor(config, config.branding.helpUrl) },
    )
  }

  const source = releaseSourceConfig(config)
  if (!source) {
    return resolveGithubSource({
      config,
      currentVersion,
      options,
    })
  }
  switch (source.kind) {
    case 'github-releases':
      return resolveGithubSource({ config, sourceConfig: source, currentVersion, options })
    case 'generic-http':
      return resolveGenericSource({ config, sourceConfig: source, currentVersion, options })
    case 'gcs':
      return resolveGcsSource({ config, sourceConfig: source, currentVersion, options })
    default:
      throw new UpdateReleaseSourceError(
        'source-misconfigured',
        'The update release source kind is not supported.',
        { manualReleaseUrl: manualReleaseUrlFor(config, getBranding().helpUrl) },
      )
  }
}
