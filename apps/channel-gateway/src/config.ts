import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isChannelProviderKind, normalizeChannelProviderIdentity, type ChannelProviderKind } from '@open-cowork/gateway-channel'
import {
  jsonConfigCandidates,
  parseJsoncText,
  redactSecretText as sharedRedactSecretText,
  resolveGatewayProductMode,
  splitTrustedProxyCidrs,
} from '@open-cowork/shared'
import type { GatewayDeploymentConfig, GatewayProductMode, PublicBrandingConfig } from '@open-cowork/shared'

import {
  assertGatewayConfigSafe,
  assertHttpsPublicUrl,
  isLoopbackHost,
  normalizeGatewayPublicBaseUrl,
  readGatewayInstanceId,
} from './config-safety.js'

export type { GatewayProductMode } from '@open-cowork/shared'

type GatewayMode = 'self-host' | 'managed'
type GatewayLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
export type GatewayProviderKind = ChannelProviderKind | 'fake'

export type GatewayConfig = {
  instanceId: string
  branding: PublicBrandingConfig
  productMode: GatewayProductMode
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
    allowLoopbackOperatorBypass: boolean
    maxRequestBodyBytes: number
    trustProxyHeaders: boolean
    trustedProxyCidrs: string[]
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
  timeouts: {
    cloudRequestMs: number
    webhookDeliveryMs: number
    smtpMs: number
    shutdownDrainMs: number
  }
  // Max cloud→channel deliveries the bounded dispatcher runs at once (audit P1-G2). Deliveries to
  // the same channel binding+target are serialized for ordering regardless; this caps the global
  // outbound fan-out so a backlog drain can't storm providers into 429s.
  maxDeliveryConcurrency: number
  // Hard cap on locally-queued deliveries (P1-C); beyond it, deliveries are shed (left unacked
  // for the cloud to re-serve) instead of growing the heap past their claim TTL.
  maxDeliveryQueueDepth: number
  providers: GatewayProviderConfig[]
}

export type GatewayCloudConnectionConfig = GatewayConfig['cloud'] & { requestTimeoutMs: number }

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
// Gateway listens on its own documented/EXPOSEd port (8790) by default, NOT the
// cloud control-plane port (8787) — a bare `gateway` run must not collide with a
// co-located cloud process. Operators override with OPEN_COWORK_GATEWAY_PORT.
const defaultPort = 8790
const defaultMaxRequestBodyBytes = 1024 * 1024
const maxAllowedRequestBodyBytes = 64 * 1024 * 1024
const defaultTimeouts = {
  cloudRequestMs: 30_000,
  webhookDeliveryMs: 15_000,
  smtpMs: 30_000,
  shutdownDrainMs: 10_000,
}
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
  'OPEN_COWORK_GATEWAY_DISCORD_SHARED_SECRET',
  'OPEN_COWORK_GATEWAY_WHATSAPP_SHARED_SECRET',
  'OPEN_COWORK_GATEWAY_SIGNAL_SHARED_SECRET',
  'OPEN_COWORK_GATEWAY_PROVIDERS',
]

export function loadGatewayConfig(env: GatewayEnv = process.env): GatewayConfig {
  const raw = readRawConfig(env)
  return resolveGatewayConfig(raw, env)
}

export function resolveGatewayConfig(raw: GatewayRawConfig = {}, env: GatewayEnv = {}): GatewayConfig {
  const productMode = resolveGatewayProductMode(env.OPEN_COWORK_GATEWAY_PRODUCT_MODE, raw.productMode)
  const cloud = resolveGatewayCloudConnection(env)
  const mode = readMode(env.OPEN_COWORK_GATEWAY_MODE) || raw.mode || 'self-host'
  const serverHost = readString(env.OPEN_COWORK_GATEWAY_HOST) || readString(raw.server?.host) || defaultHost
  const serverPublicBaseUrl = normalizeGatewayPublicBaseUrl(readNullableString(env.OPEN_COWORK_GATEWAY_PUBLIC_URL) ?? raw.server?.publicBaseUrl)
  const serverMaxRequestBodyBytes = readBoundedInteger(env.OPEN_COWORK_GATEWAY_MAX_REQUEST_BODY_BYTES ?? raw.server?.maxRequestBodyBytes, defaultMaxRequestBodyBytes, 1024, maxAllowedRequestBodyBytes)
  const timeouts = {
    cloudRequestMs: cloud.requestTimeoutMs,
    webhookDeliveryMs: readBoundedInteger(env.OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_TIMEOUT_MS ?? raw.timeouts?.webhookDeliveryMs, defaultTimeouts.webhookDeliveryMs, 100, 120_000),
    smtpMs: readBoundedInteger(env.OPEN_COWORK_GATEWAY_SMTP_TIMEOUT_MS ?? raw.timeouts?.smtpMs, defaultTimeouts.smtpMs, 100, 120_000),
    shutdownDrainMs: readBoundedInteger(env.OPEN_COWORK_GATEWAY_SHUTDOWN_DRAIN_TIMEOUT_MS ?? raw.timeouts?.shutdownDrainMs, defaultTimeouts.shutdownDrainMs, 100, 120_000),
  }
  const config: GatewayConfig = {
    instanceId: readGatewayInstanceId(env.OPEN_COWORK_GATEWAY_INSTANCE_ID ?? raw.instanceId ?? env.HOSTNAME),
    branding: resolveGatewayBranding(raw.branding, env),
    productMode,
    cloud: {
      baseUrl: cloud.baseUrl,
      serviceToken: cloud.serviceToken,
      allowInsecureHttp: cloud.allowInsecureHttp,
    },
    server: {
      host: serverHost,
      port: readPort(env.OPEN_COWORK_GATEWAY_PORT ?? raw.server?.port, defaultPort),
      publicBaseUrl: serverPublicBaseUrl,
      adminToken: readNullableString(env.OPEN_COWORK_GATEWAY_ADMIN_TOKEN) ?? readNullableString(raw.server?.adminToken),
      allowLoopbackOperatorBypass: readBoolean(env.OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS, raw.server?.allowLoopbackOperatorBypass ?? false),
      maxRequestBodyBytes: serverMaxRequestBodyBytes,
      trustProxyHeaders: readBoolean(env.OPEN_COWORK_GATEWAY_TRUST_PROXY_HEADERS, raw.server?.trustProxyHeaders ?? false),
      trustedProxyCidrs: splitTrustedProxyCidrs(env.OPEN_COWORK_GATEWAY_TRUSTED_PROXY_CIDRS ?? raw.server?.trustedProxyCidrs),
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
    timeouts,
    maxDeliveryConcurrency: readBoundedInteger(env.OPEN_COWORK_GATEWAY_MAX_DELIVERY_CONCURRENCY, 8, 1, 256),
    maxDeliveryQueueDepth: readBoundedInteger(env.OPEN_COWORK_GATEWAY_MAX_DELIVERY_QUEUE_DEPTH, 512, 16, 100_000),
    providers: normalizeProviders(raw.providers, env, serverPublicBaseUrl, serverMaxRequestBodyBytes),
  }
  assertGatewayConfigSafe(config, {
    allowPublicFakeProvider: readBoolean(env.OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER, false),
  })
  return config
}

export function resolveGatewayCloudConnection(env: GatewayEnv = process.env): GatewayCloudConnectionConfig {
  const cloudBaseUrl = readString(env.OPEN_COWORK_CLOUD_BASE_URL)
  const serviceToken = readString(env.OPEN_COWORK_GATEWAY_SERVICE_TOKEN)
  const allowInsecureHttp = readBoolean(env.OPEN_COWORK_GATEWAY_ALLOW_INSECURE_HTTP, false)
  if (!cloudBaseUrl) throw new Error('OPEN_COWORK_CLOUD_BASE_URL is required.')
  if (!serviceToken) throw new Error('OPEN_COWORK_GATEWAY_SERVICE_TOKEN is required.')
  return {
    baseUrl: normalizeBaseUrl(cloudBaseUrl, allowInsecureHttp),
    serviceToken,
    allowInsecureHttp,
    requestTimeoutMs: readBoundedInteger(env.OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS, defaultTimeouts.cloudRequestMs, 100, 120_000),
  }
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
    ? assertGatewayFileContract(parseGatewayConfigFile(readFileSync(configPath, 'utf8'), configPath), configPath)
    : {}
  const json = readString(env.OPEN_COWORK_GATEWAY_CONFIG_JSON)
  const fromJson = json
    ? assertGatewayFileContract(parseGatewayConfigJson(json, 'OPEN_COWORK_GATEWAY_CONFIG_JSON'), 'OPEN_COWORK_GATEWAY_CONFIG_JSON')
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
  const gateway = assertGatewayFileContract(parsed.gateway, source)
  return resolveGatewayEnvPlaceholders({
    gateway,
  }, allowed, env, source) as { gateway?: GatewayRawConfig }
}

function assertGatewayFileContract(value: unknown, source: string): GatewayRawConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const config = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(config, 'cloud')) {
    throw new Error(`Invalid gateway config JSON from ${source}: gateway cloud connection settings must use deployment environment variables.`)
  }
  if (config.timeouts && typeof config.timeouts === 'object' && !Array.isArray(config.timeouts)
    && Object.prototype.hasOwnProperty.call(config.timeouts, 'cloudRequestMs')) {
    throw new Error(`Invalid gateway config JSON from ${source}: cloudRequestMs must use OPEN_COWORK_GATEWAY_CLOUD_REQUEST_TIMEOUT_MS.`)
  }
  return config as GatewayRawConfig
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
    })
      // Prototype-pollution insurance (audit P3-6): never merge a key onto the prototype chain.
      .filter(([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
      .map(([key, value]) => [
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

function normalizeProviders(rawProviders: GatewayRawConfig['providers'], env: GatewayEnv, gatewayPublicBaseUrl: string | null | undefined, maxRequestBodyBytes: number): GatewayProviderConfig[] {
  const envProviders = readProvidersFromEnv(env, gatewayPublicBaseUrl)
  const providers = rawProviders?.length
    ? mergeProviderOverrides(rawProviders, envProviders)
    : envProviders
  const normalized = providers?.length
    ? providers.map((provider, index) => normalizeProvider(provider, index, gatewayPublicBaseUrl, maxRequestBodyBytes))
    : readBoolean(env.OPEN_COWORK_GATEWAY_ENABLE_FAKE_PROVIDER, false)
      ? [defaultFakeProvider(env)]
      : []
  assertUniqueProviderIds(normalized)
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

function readProvidersFromEnv(env: GatewayEnv, gatewayPublicBaseUrl?: string | null): GatewayRawConfig['providers'] {
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
        publicBaseUrl: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_PUBLIC_URL) || gatewayPublicBaseUrl || undefined,
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
        maxAttachmentBytes: readString(env.OPEN_COWORK_GATEWAY_EMAIL_MAX_ATTACHMENT_BYTES) || undefined,
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
      settings: cleanRecord({
        deliveryUrl: webhookDeliveryUrl,
        deliveryUrlAllowedHosts: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_ALLOWED_HOSTS) || undefined,
        allowPrivateDelivery: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_ALLOW_PRIVATE_DELIVERY) || undefined,
        maxAttachmentBytes: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_MAX_ATTACHMENT_BYTES) || undefined,
      }),
    })
  }

  for (const kind of ['discord', 'whatsapp', 'signal'] as const) {
    const prefix = `OPEN_COWORK_GATEWAY_${kind.toUpperCase()}`
    const deliveryUrl = readString(env[`${prefix}_DELIVERY_URL`])
    if (!deliveryUrl) continue
    providers.push({
      id: kind,
      kind,
      channelBindingId: readString(env[`${prefix}_CHANNEL_BINDING_ID`]) || kind,
      externalWorkspaceId: readNullableString(env[`${prefix}_WORKSPACE_ID`]),
      credentials: cleanStringRecord({
        sharedSecret: readString(env[`${prefix}_SHARED_SECRET`]) || undefined,
      }),
      settings: cleanRecord({
        deliveryUrl,
        deliveryUrlAllowedHosts: readString(env[`${prefix}_DELIVERY_ALLOWED_HOSTS`]) || undefined,
        allowPrivateDelivery: readString(env[`${prefix}_ALLOW_PRIVATE_DELIVERY`]) || undefined,
        maxAttachmentBytes: readString(env[`${prefix}_MAX_ATTACHMENT_BYTES`]) || undefined,
      }),
    })
  }

  if (readBoolean(env.OPEN_COWORK_GATEWAY_CLI_ENABLED, false)) {
    providers.push({
      id: 'cli',
      kind: 'cli',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_CLI_CHANNEL_BINDING_ID) || 'cli',
      externalWorkspaceId: readNullableString(env.OPEN_COWORK_GATEWAY_CLI_WORKSPACE_ID),
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

function normalizeProvider(raw: Partial<GatewayProviderConfig> & { kind: GatewayProviderKind }, index: number, gatewayPublicBaseUrl?: string | null, maxRequestBody = defaultMaxRequestBodyBytes): GatewayProviderConfig {
  const kind = readProviderKind(raw.kind)
  const requestedId = readString(raw.id) || `${kind}-${index + 1}`
  const id = kind === 'fake' ? requestedId : normalizeChannelProviderIdentity(kind, requestedId).providerId
  const channelBindingId = readString(raw.channelBindingId)
  if (!channelBindingId) throw new Error(`Gateway provider ${id} requires channelBindingId.`)
  const credentials = cleanStringRecord(raw.credentials)
  const settings = cleanRecord({
    ...(raw.settings || {}),
    ...(kind === 'telegram' && !readString(raw.settings?.publicBaseUrl) && gatewayPublicBaseUrl
      ? { publicBaseUrl: gatewayPublicBaseUrl }
      : {}),
  })
  if (kind === 'webhook' && !credentials.sharedSecret) {
    throw new Error(`Gateway provider ${id} requires credential sharedSecret for authenticated webhook ingress.`)
  }
  const hasMaxAttachmentBytes = settings.maxAttachmentBytes !== undefined
    && settings.maxAttachmentBytes !== null
    && settings.maxAttachmentBytes !== ''
  if (isRequestBodyBackedAttachmentProvider(kind)) {
    const attachmentLimit = readAttachmentLimit(settings.maxAttachmentBytes, id)
    if (attachmentLimit !== null && attachmentLimit > maxRequestBody) {
      throw new Error(`Gateway provider ${id} maxAttachmentBytes cannot exceed server.maxRequestBodyBytes (${maxRequestBody}).`)
    }
    if (!hasMaxAttachmentBytes || attachmentLimit === null) {
      settings.maxAttachmentBytes = maxRequestBody
    } else {
      settings.maxAttachmentBytes = attachmentLimit
    }
  }
  if (kind === 'discord' || kind === 'whatsapp' || kind === 'signal') {
    if (!credentials.sharedSecret) throw new Error(`Gateway provider ${id} requires credential sharedSecret for authenticated ${kind} bridge ingress.`)
    const deliveryUrl = readString(settings.deliveryUrl)
    if (!deliveryUrl) throw new Error(`Gateway provider ${id} requires setting deliveryUrl for ${kind} bridge delivery.`)
  }
  if (kind === 'telegram') {
    if (!credentials.botToken) throw new Error(`Gateway provider ${id} requires credential botToken.`)
    const telegramMode = readString(settings.mode) || 'polling'
    if (telegramMode !== 'polling' && telegramMode !== 'webhook') {
      throw new Error(`Gateway provider ${id} has unsupported Telegram mode ${telegramMode}. Use polling or webhook.`)
    }
    if (telegramMode === 'webhook') {
      if (!credentials.webhookSecret) throw new Error(`Gateway provider ${id} requires credential webhookSecret when Telegram webhook mode is enabled.`)
      const publicBaseUrl = readString(settings.publicBaseUrl)
      if (!publicBaseUrl) throw new Error(`Gateway provider ${id} requires setting publicBaseUrl or OPEN_COWORK_GATEWAY_PUBLIC_URL when Telegram webhook mode is enabled.`)
      assertHttpsPublicUrl(publicBaseUrl, `Gateway provider ${id} Telegram publicBaseUrl`)
    }
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
  if (kind === 'fake' || isChannelProviderKind(kind)) {
    return kind
  }
  throw new Error(`Unsupported gateway provider kind: ${kind || String(value)}`)
}

function isRequestBodyBackedAttachmentProvider(kind: GatewayProviderKind) {
  return kind === 'webhook'
    || kind === 'discord'
    || kind === 'whatsapp'
    || kind === 'signal'
    || kind === 'email'
}

function readAttachmentLimit(value: unknown, providerId: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(readString(value))
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxAllowedRequestBodyBytes) {
    throw new Error(`Gateway provider ${providerId} maxAttachmentBytes must be an integer between 1 and ${maxAllowedRequestBodyBytes}.`)
  }
  return parsed
}

function assertUniqueProviderIds(providers: GatewayProviderConfig[]) {
  const seen = new Set<string>()
  for (const provider of providers) {
    if (seen.has(provider.id)) throw new Error(`Duplicate gateway provider id ${provider.id}.`)
    seen.add(provider.id)
  }
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

function readBoundedInteger(value: unknown, fallback: number, min: number, max: number) {
  const text = readString(value)
  if (typeof value !== 'number' && !text) return fallback
  const parsed = typeof value === 'number' ? value : Number(text)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
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
  // Product-stable markers first (tests/contracts expect Bearer [redacted],
  // token=[redacted] query form, /Users/[redacted]). Shared token-family
  // scrubbing covers the long tail (ya29., AIza, JWT, ghp_, oc*, etc.).
  // URLs are placeholder-protected so shared's whole-query collapse cannot
  // rewrite `?token=[redacted]` into `?[REDACTED_QUERY]`.
  const bearerPlaceholder = '\uE000CGW_BEARER_REDACTED\uE001'
  const urlPlaceholders: string[] = []
  let text = String(value || '')
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => {
      const index = urlPlaceholders.length
      urlPlaceholders.push(redactUrlSecrets(url))
      return `\uE000CGW_URL_${index}\uE001`
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, bearerPlaceholder)
  text = text
    .replace(/\b([A-Za-z0-9_-]{0,64}(?:api[_-]?key|access[_-]?key|secret[_-]?access[_-]?key|token|secret|password|client[_-]?secret)[A-Za-z0-9_-]{0,64})\s*[:=]\s*(['"]?)[A-Za-z0-9+/=_-]{16,}\2/gi, (_match, key: string) => {
      return `${key}=[redacted]`
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
  text = sharedRedactSecretText(text, Number.MAX_SAFE_INTEGER)
  text = text.split(bearerPlaceholder).join('Bearer [redacted]')
  for (let index = 0; index < urlPlaceholders.length; index += 1) {
    text = text.split(`\uE000CGW_URL_${index}\uE001`).join(urlPlaceholders[index]!)
  }
  // Paths last so shared export sanitizer cannot rewrite product markers
  // (`/Users/[redacted]`) into `/Users/[REDACTED_HOME]`.
  return redactLocalPaths(text)
    .replace(/\/Users\/\[REDACTED_HOME\]/g, '/Users/[redacted]')
    .replace(/\/home\/\[REDACTED_HOME\]/g, '/home/[redacted]')
    .replace(/[A-Z]:\\Users\\\[REDACTED_HOME\]/gi, 'C:\\Users\\[redacted]')
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
  return url.toString().replace(/%5Bredacted%5D/gi, '[redacted]')
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
