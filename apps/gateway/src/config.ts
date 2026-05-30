import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { ChannelProviderId } from '@open-cowork/gateway-channel'
import { jsonConfigCandidates, parseJsoncText } from '@open-cowork/shared'
import type { GatewayDeploymentConfig, PublicBrandingConfig } from '@open-cowork/shared'

export type GatewayMode = 'self-host' | 'managed'
export type GatewayLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
export type GatewayProviderKind = ChannelProviderId | 'fake'

export type GatewayConfig = {
  branding: PublicBrandingConfig
  cloud: {
    baseUrl: string
    serviceToken: string
    allowInsecureHttp: boolean
  }
  server: {
    host: string
    port: number
    publicBaseUrl: string | null
    adminToken: string | null
  }
  mode: GatewayMode
  logging: {
    level: GatewayLogLevel
  }
  metrics: {
    enabled: boolean
  }
  diagnostics: {
    enabled: boolean
  }
  providers: GatewayProviderConfig[]
}

export type GatewayProviderConfig = {
  id: string
  kind: GatewayProviderKind
  enabled: boolean
  channelBindingId: string
  externalWorkspaceId: string | null
  defaultAgent: string | null
  credentials: Record<string, string>
  settings: Record<string, unknown>
}

export type GatewayRawConfig = GatewayDeploymentConfig
type GatewayRawProvider = NonNullable<GatewayRawConfig['providers']>[number]

export type GatewayEnv = Record<string, string | undefined>

const defaultHost = '127.0.0.1'
const defaultPort = 8787
const defaultGatewayBranding: PublicBrandingConfig = {
  productName: 'Open Cowork Cloud',
  shortName: 'OC',
  supportUrl: '',
  privacyUrl: '',
  securityUrl: '',
  legalUrl: '',
  managedOrgConnectionLabels: {
    desktopToken: 'Desktop token',
    gatewayToken: 'Gateway token',
    apiToken: 'API token',
    cloudUrl: 'Cloud URL',
  },
}
const secretEnvKeys = [
  'OPEN_COWORK_GATEWAY_SERVICE_TOKEN',
  'OPEN_COWORK_GATEWAY_ADMIN_TOKEN',
  'OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN',
  'OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET',
  'OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN',
  'OPEN_COWORK_GATEWAY_SLACK_SIGNING_SECRET',
  'OPEN_COWORK_GATEWAY_EMAIL_INBOUND_SECRET',
  'OPEN_COWORK_GATEWAY_EMAIL_SMTP_PASSWORD',
  'OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET',
  'OPEN_COWORK_GATEWAY_PROVIDERS',
]

export function loadGatewayConfig(env: GatewayEnv = process.env): GatewayConfig {
  const raw = readRawConfig(env)
  return resolveGatewayConfig(raw, env)
}

export function resolveGatewayConfig(raw: GatewayRawConfig = {}, env: GatewayEnv = {}): GatewayConfig {
  const cloudBaseUrl = readString(env.OPEN_COWORK_CLOUD_BASE_URL) || readString(raw.cloud?.baseUrl)
  const serviceToken = readString(env.OPEN_COWORK_GATEWAY_SERVICE_TOKEN) || readString(raw.cloud?.serviceToken)
  const allowInsecureHttp = readBoolean(env.OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP, raw.cloud?.allowInsecureHttp ?? false)
  const mode = readMode(env.OPEN_COWORK_GATEWAY_MODE) || raw.mode || 'self-host'
  const serverHost = readString(env.OPEN_COWORK_GATEWAY_HOST) || readString(raw.server?.host) || defaultHost
  if (!cloudBaseUrl) throw new Error('OPEN_COWORK_CLOUD_BASE_URL or cloud.baseUrl is required.')
  if (!serviceToken) throw new Error('OPEN_COWORK_GATEWAY_SERVICE_TOKEN or cloud.serviceToken is required.')
  const config: GatewayConfig = {
    branding: resolveGatewayBranding(raw.branding, env),
    cloud: {
      baseUrl: normalizeBaseUrl(cloudBaseUrl, allowInsecureHttp),
      serviceToken,
      allowInsecureHttp,
    },
    server: {
      host: serverHost,
      port: readPort(env.OPEN_COWORK_GATEWAY_PORT ?? raw.server?.port, defaultPort),
      publicBaseUrl: readNullableString(env.OPEN_COWORK_GATEWAY_PUBLIC_URL) ?? readNullableString(raw.server?.publicBaseUrl),
      adminToken: readNullableString(env.OPEN_COWORK_GATEWAY_ADMIN_TOKEN) ?? readNullableString(raw.server?.adminToken),
    },
    mode,
    logging: {
      level: readLogLevel(env.OPEN_COWORK_GATEWAY_LOG_LEVEL) || raw.logging?.level || 'info',
    },
    metrics: {
      enabled: readBoolean(env.OPEN_COWORK_GATEWAY_METRICS_ENABLED, raw.metrics?.enabled ?? true),
    },
    diagnostics: {
      enabled: readBoolean(env.OPEN_COWORK_GATEWAY_DIAGNOSTICS_ENABLED, raw.diagnostics?.enabled ?? mode === 'self-host'),
    },
    providers: normalizeProviders(raw.providers, env),
  }
  assertGatewayConfigSafe(config, {
    allowPublicFakeProvider: readBoolean(env.OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER, false),
  })
  return config
}

export function redactGatewayConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    ...config,
    cloud: {
      ...config.cloud,
      serviceToken: redactSecret(config.cloud.serviceToken),
    },
    server: {
      ...config.server,
      adminToken: redactSecret(config.server.adminToken),
    },
    providers: config.providers.map((provider) => ({
      ...provider,
      credentials: redactCredentialRecord(provider.credentials),
      settings: redactUnknown(provider.settings) as Record<string, unknown>,
    })),
  }
}

export function redactGatewayEnv(env: GatewayEnv): Record<string, string> {
  const redacted: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    redacted[key] = secretEnvKeys.includes(key) || /token|secret|password|credential/i.test(key)
      ? redactSecret(value) || '[redacted]'
      : value
  }
  return redacted
}

function readRawConfig(env: GatewayEnv): GatewayRawConfig {
  const central = readCentralGatewayConfig(env)
  const configPath = readString(env.OPEN_COWORK_GATEWAY_CONFIG)
  const fromGatewayFile = configPath
    ? parseGatewayConfigFile(readFileSync(configPath, 'utf8'), configPath)
    : {}
  const json = readString(env.OPEN_COWORK_GATEWAY_CONFIG_JSON)
  const fromJson = json
    ? parseGatewayConfigJson(json, 'OPEN_COWORK_GATEWAY_CONFIG_JSON')
    : {}

  return mergeGatewayRawConfigs(mergeGatewayRawConfigs(central, fromGatewayFile), fromJson)
}

function readCentralGatewayConfig(env: GatewayEnv): GatewayRawConfig {
  const candidates = centralConfigCandidates(env)
  let merged: GatewayRawConfig = {}
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const parsed = parseOpenCoworkConfig(readFileSync(candidate, 'utf8'), candidate, env)
    if (parsed.gateway) {
      merged = mergeGatewayRawConfigs(merged, parsed.gateway)
    }
  }
  return merged
}

function centralConfigCandidates(env: GatewayEnv) {
  const candidates: string[] = []
  candidates.push(...jsonConfigCandidates(resolve(process.cwd(), 'open-cowork.config.json')))
  for (const root of [
    readString(env.OPEN_COWORK_CONFIG_DIR),
    readString(env.OPEN_COWORK_DOWNSTREAM_ROOT),
  ]) {
    if (!root) continue
    candidates.push(...jsonConfigCandidates(resolve(root, 'config.json')))
    candidates.push(...jsonConfigCandidates(resolve(root, 'open-cowork.config.json')))
  }
  const explicitPath = readString(env.OPEN_COWORK_CONFIG_PATH)
  if (explicitPath) candidates.push(...jsonConfigCandidates(resolve(explicitPath)))
  return Array.from(new Set(candidates))
}

function parseOpenCoworkConfig(value: string, source: string, env: GatewayEnv): { gateway?: GatewayRawConfig } {
  const parsed = parseGatewayConfigFile(value, source) as Record<string, unknown>
  const allowed = new Set(Array.isArray(parsed.allowedEnvPlaceholders)
    ? parsed.allowedEnvPlaceholders.filter((entry): entry is string => typeof entry === 'string')
    : [])
  return resolveGatewayEnvPlaceholders({
    gateway: parsed.gateway,
  }, allowed, env, source) as { gateway?: GatewayRawConfig }
}

function parseGatewayConfigJson(value: string, source: string): GatewayRawConfig {
  return parseJson(value, source) as GatewayRawConfig
}

function parseGatewayConfigFile(value: string, source: string): GatewayRawConfig {
  try {
    return parseJsoncText(value) as GatewayRawConfig
  } catch (error) {
    throw new Error(`Invalid gateway config JSON from ${source}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function parseConfigJson(value: string, source: string): GatewayRawConfig {
  return parseGatewayConfigJson(value, source)
}

function parseJson(value: string, source: string): unknown {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`Invalid gateway config JSON from ${source}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function mergeGatewayRawConfigs(base: GatewayRawConfig, override: GatewayRawConfig): GatewayRawConfig {
  return deepMergeGateway(base, override) as GatewayRawConfig
}

function deepMergeGateway(base: unknown, override: unknown): unknown {
  if (Array.isArray(override)) return override
  if (override && typeof override === 'object') {
    const current = base && typeof base === 'object' && !Array.isArray(base)
      ? base as Record<string, unknown>
      : {}
    return Object.fromEntries(Object.entries({
      ...current,
      ...(override as Record<string, unknown>),
    }).map(([key, value]) => [
      key,
      Object.prototype.hasOwnProperty.call(override as Record<string, unknown>, key)
        ? deepMergeGateway(current[key], value)
        : value,
    ]))
  }
  return override === undefined ? base : override
}

function resolveGatewayEnvPlaceholders(value: unknown, allowed: ReadonlySet<string>, env: GatewayEnv, source: string): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{env:([A-Z0-9_]+)\}/g, (_match, envName) => {
      if (!allowed.has(envName)) {
        throw new Error(`Invalid gateway config JSON from ${source}: environment placeholder ${envName} is not allowlisted.`)
      }
      return env[envName] || ''
    })
  }
  if (Array.isArray(value)) return value.map((entry) => resolveGatewayEnvPlaceholders(entry, allowed, env, source))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      resolveGatewayEnvPlaceholders(entry, allowed, env, source),
    ]))
  }
  return value
}

function parseBrandingJson(env: GatewayEnv) {
  const json = readString(env.OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON)
  if (!json) return {}
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Partial<PublicBrandingConfig>
      : {}
  } catch (error) {
    throw new Error(`Invalid OPEN_COWORK_GATEWAY_PUBLIC_BRANDING_JSON: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function cleanBrandingObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => typeof entry === 'string' && entry.trim())
    .map(([key, entry]) => [key, String(entry).trim()]))
}

function safeBrandingUrl(value: unknown, allowMailto = false) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return undefined
  try {
    const url = new URL(text)
    if (url.protocol === 'https:') return url.toString()
    if (allowMailto && url.protocol === 'mailto:') return url.toString()
  } catch {
    return undefined
  }
  return undefined
}

function cleanBrandingEntry(entry: Partial<PublicBrandingConfig>) {
  const cleaned = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null && value !== '')) as Partial<PublicBrandingConfig> & Record<string, unknown>
  const urls: Array<[keyof PublicBrandingConfig, boolean]> = [
    ['logoUrl', false],
    ['supportUrl', true],
    ['privacyUrl', false],
    ['securityUrl', false],
    ['legalUrl', false],
  ]
  for (const [key, allowMailto] of urls) {
    if (!(key in cleaned)) continue
    const safeUrl = safeBrandingUrl(cleaned[key], allowMailto)
    if (safeUrl) cleaned[key] = safeUrl
    else delete cleaned[key]
  }
  return cleaned
}

function resolveGatewayBranding(raw: GatewayRawConfig['branding'], env: GatewayEnv): PublicBrandingConfig {
  const fromJson = parseBrandingJson(env)
  const fromEnv: Partial<PublicBrandingConfig> = {
    productName: readString(env.OPEN_COWORK_GATEWAY_BRAND_NAME) || undefined,
    shortName: readString(env.OPEN_COWORK_GATEWAY_BRAND_SHORT_NAME) || undefined,
    logoUrl: readString(env.OPEN_COWORK_GATEWAY_BRAND_LOGO_URL) || undefined,
    supportUrl: readString(env.OPEN_COWORK_GATEWAY_SUPPORT_URL) || undefined,
    privacyUrl: readString(env.OPEN_COWORK_GATEWAY_PRIVACY_URL) || undefined,
    securityUrl: readString(env.OPEN_COWORK_GATEWAY_SECURITY_URL) || undefined,
    legalUrl: readString(env.OPEN_COWORK_GATEWAY_LEGAL_URL) || undefined,
  }
  const merged = [defaultGatewayBranding, raw, fromJson, fromEnv].reduce<PublicBrandingConfig>((current, entry) => {
    if (!entry) return current
    const cleanEntry = cleanBrandingEntry(entry)
    return {
      ...current,
      ...cleanEntry,
      theme: {
        ...(current.theme || {}),
        ...cleanBrandingObject(cleanEntry.theme),
      },
      dashboard: {
        ...(current.dashboard || {}),
        ...cleanBrandingObject(cleanEntry.dashboard),
      },
      managedOrgConnectionLabels: {
        ...(current.managedOrgConnectionLabels || {}),
        ...cleanBrandingObject(cleanEntry.managedOrgConnectionLabels),
      },
    }
  }, { ...defaultGatewayBranding })
  return {
    ...merged,
    productName: merged.productName?.trim() || defaultGatewayBranding.productName,
    shortName: merged.shortName?.trim() || defaultGatewayBranding.shortName,
  }
}

function normalizeProviders(rawProviders: GatewayRawConfig['providers'], env: GatewayEnv): GatewayProviderConfig[] {
  const envProviders = readProvidersFromEnv(env)
  const providers = rawProviders?.length
    ? mergeProviderOverrides(rawProviders, envProviders)
    : envProviders
  const normalized = providers?.length
    ? providers.map((provider, index) => normalizeProvider(provider, index))
    : readBoolean(env.OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER, false)
      ? [defaultFakeProvider(env)]
      : []
  const enabled = normalized.filter((provider) => provider.enabled)
  if (enabled.length === 0) {
    throw new Error('At least one gateway provider must be enabled. Set OPEN_COWORK_GATEWAY_PROVIDERS, configure Telegram/webhook credentials, or explicitly enable the local fake provider with OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER=true.')
  }
  return normalized
}

function mergeProviderOverrides(
  rawProviders: NonNullable<GatewayRawConfig['providers']>,
  envProviders: GatewayRawConfig['providers'],
): NonNullable<GatewayRawConfig['providers']> {
  if (!envProviders?.length) return rawProviders
  const used = new Set<number>()
  const merged = rawProviders.map((provider) => {
    const overrideIndex = envProviders.findIndex((candidate, index) => !used.has(index) && providerOverrideMatches(provider, candidate))
    if (overrideIndex < 0) return provider
    used.add(overrideIndex)
    return mergeProviderConfig(provider, envProviders[overrideIndex]!)
  })
  for (const [index, provider] of envProviders.entries()) {
    if (!used.has(index)) merged.push(provider)
  }
  return merged
}

function providerOverrideMatches(base: GatewayRawProvider, override: GatewayRawProvider) {
  const baseId = readString(base.id)
  const overrideId = readString(override.id)
  if (baseId && overrideId && baseId === overrideId) return true
  const baseBinding = readString(base.channelBindingId)
  const overrideBinding = readString(override.channelBindingId)
  if (base.kind === override.kind && baseBinding && overrideBinding && baseBinding === overrideBinding) return true
  return base.kind === override.kind
}

function mergeProviderConfig(
  base: GatewayRawProvider,
  override: GatewayRawProvider,
): GatewayRawProvider {
  return {
    ...base,
    ...override,
    id: readString(base.id) || readString(override.id) || undefined,
    channelBindingId: readString(base.channelBindingId) || readString(override.channelBindingId),
    credentials: {
      ...(base.credentials || {}),
      ...(override.credentials || {}),
    },
    settings: {
      ...(base.settings || {}),
      ...(override.settings || {}),
    },
  }
}

function readProvidersFromEnv(env: GatewayEnv): GatewayRawConfig['providers'] {
  const providersJson = readString(env.OPEN_COWORK_GATEWAY_PROVIDERS)
  if (providersJson) {
    const parsed = parseConfigJson(`{"providers":${providersJson}}`, 'OPEN_COWORK_GATEWAY_PROVIDERS')
    return parsed.providers || []
  }

  const providers: GatewayRawConfig['providers'] = []
  const telegramToken = readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN)
  if (telegramToken) {
    providers.push({
      id: 'telegram',
      kind: 'telegram',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_CHANNEL_BINDING_ID) || 'telegram',
      credentials: cleanStringRecord({
        botToken: telegramToken,
        webhookSecret: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET) || undefined,
      }),
      settings: cleanRecord({
        mode: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_MODE) || undefined,
        respondInGroups: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_RESPOND_IN_GROUPS) || undefined,
      }),
    })
  }

  const slackToken = readString(env.OPEN_COWORK_GATEWAY_SLACK_BOT_TOKEN)
  if (slackToken) {
    providers.push({
      id: 'slack',
      kind: 'slack',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_SLACK_CHANNEL_BINDING_ID) || 'slack',
      externalWorkspaceId: readNullableString(env.OPEN_COWORK_GATEWAY_SLACK_TEAM_ID),
      credentials: cleanStringRecord({
        botToken: slackToken,
        signingSecret: readString(env.OPEN_COWORK_GATEWAY_SLACK_SIGNING_SECRET) || undefined,
      }),
      settings: cleanRecord({
        teamId: readString(env.OPEN_COWORK_GATEWAY_SLACK_TEAM_ID) || undefined,
        defaultChannelId: readString(env.OPEN_COWORK_GATEWAY_SLACK_DEFAULT_CHANNEL_ID) || undefined,
        apiBaseUrl: readString(env.OPEN_COWORK_GATEWAY_SLACK_API_BASE_URL) || undefined,
      }),
    })
  }

  const emailInboundSecret = readString(env.OPEN_COWORK_GATEWAY_EMAIL_INBOUND_SECRET)
  if (emailInboundSecret) {
    providers.push({
      id: 'email',
      kind: 'email',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_EMAIL_CHANNEL_BINDING_ID) || 'email',
      externalWorkspaceId: readNullableString(env.OPEN_COWORK_GATEWAY_EMAIL_DOMAIN),
      credentials: cleanStringRecord({
        inboundSecret: emailInboundSecret,
        smtpPassword: readString(env.OPEN_COWORK_GATEWAY_EMAIL_SMTP_PASSWORD) || undefined,
      }),
      settings: cleanRecord({
        from: readString(env.OPEN_COWORK_GATEWAY_EMAIL_FROM) || undefined,
        inboundAddress: readString(env.OPEN_COWORK_GATEWAY_EMAIL_ADDRESS) || undefined,
        smtpHost: readString(env.OPEN_COWORK_GATEWAY_EMAIL_SMTP_HOST) || undefined,
        smtpPort: readString(env.OPEN_COWORK_GATEWAY_EMAIL_SMTP_PORT) || undefined,
        smtpSecure: readString(env.OPEN_COWORK_GATEWAY_EMAIL_SMTP_SECURE) || undefined,
        smtpUsername: readString(env.OPEN_COWORK_GATEWAY_EMAIL_SMTP_USERNAME) || undefined,
      }),
    })
  }

  const webhookDeliveryUrl = readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_URL)
  if (webhookDeliveryUrl) {
    providers.push({
      id: 'webhook',
      kind: 'webhook',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_CHANNEL_BINDING_ID) || 'webhook',
      credentials: cleanStringRecord({
        sharedSecret: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET) || undefined,
      }),
      settings: {
        deliveryUrl: webhookDeliveryUrl,
      },
    })
  }

  return providers
}

function defaultFakeProvider(env: GatewayEnv): GatewayProviderConfig {
  return normalizeProvider({
    id: 'fake',
    kind: 'fake',
    enabled: true,
    channelBindingId: readString(env.OPEN_COWORK_GATEWAY_FAKE_CHANNEL_BINDING_ID) || 'fake-binding',
    externalWorkspaceId: readNullableString(env.OPEN_COWORK_GATEWAY_FAKE_WORKSPACE_ID),
  }, 0)
}

function normalizeProvider(raw: Partial<GatewayProviderConfig> & { kind: GatewayProviderKind }, index: number): GatewayProviderConfig {
  const kind = readProviderKind(raw.kind)
  const id = readString(raw.id) || `${kind}-${index + 1}`
  const channelBindingId = readString(raw.channelBindingId)
  if (!channelBindingId) throw new Error(`Gateway provider ${id} requires channelBindingId.`)
  const credentials = cleanStringRecord(raw.credentials)
  const settings = cleanRecord(raw.settings)
  if (kind === 'webhook' && !credentials.sharedSecret) {
    throw new Error(`Gateway provider ${id} requires credential sharedSecret for authenticated webhook ingress.`)
  }
  if (kind === 'slack') {
    if (!credentials.botToken) throw new Error(`Gateway provider ${id} requires credential botToken.`)
    if (!credentials.signingSecret) throw new Error(`Gateway provider ${id} requires credential signingSecret.`)
  }
  if (kind === 'email') {
    if (!credentials.inboundSecret) throw new Error(`Gateway provider ${id} requires credential inboundSecret.`)
    if (!readString(settings.from)) throw new Error(`Gateway provider ${id} requires setting from.`)
    if (!readString(settings.smtpHost)) throw new Error(`Gateway provider ${id} requires setting smtpHost.`)
  }
  return {
    id,
    kind,
    enabled: raw.enabled !== false,
    channelBindingId,
    externalWorkspaceId: readNullableString(raw.externalWorkspaceId),
    defaultAgent: readNullableString(raw.defaultAgent),
    credentials,
    settings,
  }
}

function readProviderKind(value: unknown): GatewayProviderKind {
  const kind = readString(value)
  if (kind === 'fake' || kind === 'telegram' || kind === 'slack' || kind === 'email' || kind === 'webhook') {
    return kind
  }
  if (kind === 'cli' || kind === 'discord' || kind === 'whatsapp' || kind === 'signal') {
    throw new Error(`Gateway provider kind ${kind} is reserved for the roadmap but is not implemented by this gateway build yet.`)
  }
  throw new Error(`Unsupported gateway provider kind: ${kind || String(value)}`)
}

function normalizeBaseUrl(value: string, allowInsecureHttp: boolean) {
  let normalized = value.trim()
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  const url = new URL(normalized)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('Cloud base URL must be HTTP or HTTPS.')
  if (url.protocol === 'http:' && !allowInsecureHttp && !isLoopbackHost(url.hostname)) {
    throw new Error('Cloud base URL must use HTTPS unless it is loopback or OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP is enabled.')
  }
  return normalized
}

function isLoopbackHost(hostname: string) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

function isPublicBindHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === '0.0.0.0' || host === '::' || host === '[::]' || !isLoopbackHost(host)
}

function isPublicBaseUrl(value: string | null) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

function assertGatewayConfigSafe(config: GatewayConfig, options: { allowPublicFakeProvider: boolean }) {
  const publicBind = isPublicBindHost(config.server.host)
  const publicExposure = publicBind || isPublicBaseUrl(config.server.publicBaseUrl)
  if (publicExposure && !config.server.adminToken) {
    throw new Error('Gateway public deployments require OPEN_COWORK_GATEWAY_ADMIN_TOKEN for metrics, diagnostics, and delivery operations.')
  }
  if (publicBind && (config.metrics.enabled || config.diagnostics.enabled) && !config.server.adminToken) {
    throw new Error('Gateway metrics or diagnostics on a public bind require OPEN_COWORK_GATEWAY_ADMIN_TOKEN.')
  }
  if (publicExposure && config.providers.some((provider) => provider.enabled && provider.kind === 'fake') && !(options.allowPublicFakeProvider && config.mode === 'self-host')) {
    throw new Error('Gateway fake provider cannot be exposed publicly unless OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER=true is set explicitly for a self-host demo.')
  }
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

function readNullableString(value: unknown) {
  const text = readString(value)
  return text || null
}

function readPort(value: unknown, fallback: number) {
  const parsed = typeof value === 'number' ? value : Number(readString(value))
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return fallback
  return parsed
}

function readMode(value: unknown): GatewayMode | null {
  const text = readString(value)
  return text === 'self-host' || text === 'managed' ? text : null
}

function readLogLevel(value: unknown): GatewayLogLevel | null {
  const text = readString(value)
  return text === 'debug' || text === 'info' || text === 'warn' || text === 'error' || text === 'silent' ? text : null
}

function readBoolean(value: unknown, fallback: boolean) {
  if (typeof value === 'boolean') return value
  const text = readString(value).toLowerCase()
  if (text === 'true' || text === '1' || text === 'yes') return true
  if (text === 'false' || text === '0' || text === 'no') return false
  return fallback
}

function cleanStringRecord(value: unknown) {
  const input = cleanRecord(value)
  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(input)) {
    if (typeof entry === 'string') output[key] = entry
  }
  return output
}

function cleanRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined && entry !== null && entry !== ''))
}

function redactCredentialRecord(value: Record<string, string>) {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    redactSecret(entry),
  ]))
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    key,
    redactValue(key, entry),
  ]))
}

function redactValue(key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    if (/token|secret|password|credential|authorization|api[_-]?key|private[_-]?key|access[_-]?key/i.test(key)) return redactSecret(value)
    return redactGatewayDiagnosticText(value)
  }
  return redactUnknown(value)
}

export function redactGatewayDiagnosticText(value: string) {
  return redactLocalPaths(redactUrlSecretsInText(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|secret|password|credential|api[_-]?key)=([^\s"'&]+)/gi, (match) => {
      const [key] = match.split('=')
      return `${key}=[redacted]`
    })
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]'))
}

function redactUrlSecretsInText(value: string) {
  return value.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => redactUrlSecrets(url))
}

function redactUrlSecrets(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return value
  }
  if (url.username) url.username = '[redacted]'
  if (url.password) url.password = '[redacted]'
  for (const key of [...url.searchParams.keys()]) {
    if (/token|secret|password|credential|authorization|api[_-]?key/i.test(key)) {
      url.searchParams.set(key, '[redacted]')
    }
  }
  return url.toString()
}

function redactLocalPaths(value: string) {
  return value
    .replace(/\/Users\/[^\s"'`:]+/g, '/Users/[redacted]')
    .replace(/\/home\/[^\s"'`:]+/g, '/home/[redacted]')
    .replace(/[A-Z]:\\Users\\[^\s"'`:]+/gi, 'C:\\Users\\[redacted]')
}

function redactSecret(value: string | null | undefined) {
  if (!value) return null
  return value.length <= 8 ? '[redacted]' : `${value.slice(0, 4)}...[redacted]...${value.slice(-4)}`
}
