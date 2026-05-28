import { readFileSync } from 'node:fs'

import type { ChannelProviderId } from '@open-cowork/gateway-channel'

export type GatewayMode = 'self-host' | 'managed'
export type GatewayLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'
export type GatewayProviderKind = ChannelProviderId | 'fake'

export type GatewayConfig = {
  cloud: {
    baseUrl: string
    serviceToken: string
    allowInsecureHttp: boolean
  }
  server: {
    host: string
    port: number
    publicBaseUrl: string | null
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

export type GatewayRawConfig = Partial<{
  cloud: Partial<GatewayConfig['cloud']>
  server: Partial<GatewayConfig['server']>
  mode: GatewayMode
  logging: Partial<GatewayConfig['logging']>
  metrics: Partial<GatewayConfig['metrics']>
  diagnostics: Partial<GatewayConfig['diagnostics']>
  providers: Array<Partial<GatewayProviderConfig> & {
    kind: GatewayProviderKind
  }>
}>

export type GatewayEnv = Record<string, string | undefined>

const defaultHost = '127.0.0.1'
const defaultPort = 8787
const secretEnvKeys = [
  'OPEN_COWORK_GATEWAY_SERVICE_TOKEN',
  'OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN',
  'OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET',
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
  if (!cloudBaseUrl) throw new Error('OPEN_COWORK_CLOUD_BASE_URL or cloud.baseUrl is required.')
  if (!serviceToken) throw new Error('OPEN_COWORK_GATEWAY_SERVICE_TOKEN or cloud.serviceToken is required.')

  return {
    cloud: {
      baseUrl: normalizeBaseUrl(cloudBaseUrl, allowInsecureHttp),
      serviceToken,
      allowInsecureHttp,
    },
    server: {
      host: readString(env.OPEN_COWORK_GATEWAY_HOST) || readString(raw.server?.host) || defaultHost,
      port: readPort(env.OPEN_COWORK_GATEWAY_PORT ?? raw.server?.port, defaultPort),
      publicBaseUrl: readNullableString(env.OPEN_COWORK_GATEWAY_PUBLIC_URL) ?? readNullableString(raw.server?.publicBaseUrl),
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
}

export function redactGatewayConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    ...config,
    cloud: {
      ...config.cloud,
      serviceToken: redactSecret(config.cloud.serviceToken),
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
  const json = readString(env.OPEN_COWORK_GATEWAY_CONFIG_JSON)
  if (json) return parseConfigJson(json, 'OPEN_COWORK_GATEWAY_CONFIG_JSON')

  const path = readString(env.OPEN_COWORK_GATEWAY_CONFIG)
  if (!path) return {}
  return parseConfigJson(readFileSync(path, 'utf8'), path)
}

function parseConfigJson(value: string, source: string): GatewayRawConfig {
  try {
    return JSON.parse(value) as GatewayRawConfig
  } catch (error) {
    throw new Error(`Invalid gateway config JSON from ${source}: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    })
  }
}

function normalizeProviders(rawProviders: GatewayRawConfig['providers'], env: GatewayEnv): GatewayProviderConfig[] {
  const envProviders = readProvidersFromEnv(env)
  const providers = rawProviders?.length ? rawProviders : envProviders
  const normalized = providers?.length ? providers.map((provider, index) => normalizeProvider(provider, index)) : [defaultFakeProvider(env)]
  const enabled = normalized.filter((provider) => provider.enabled)
  if (enabled.length === 0) throw new Error('At least one gateway provider must be enabled.')
  return normalized
}

function readProvidersFromEnv(env: GatewayEnv): GatewayRawConfig['providers'] {
  const providersJson = readString(env.OPEN_COWORK_GATEWAY_PROVIDERS)
  if (providersJson) {
    const parsed = parseConfigJson(`{"providers":${providersJson}}`, 'OPEN_COWORK_GATEWAY_PROVIDERS')
    return parsed.providers || []
  }

  const telegramToken = readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_BOT_TOKEN)
  if (telegramToken) {
    return [{
      id: 'telegram',
      kind: 'telegram',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_CHANNEL_BINDING_ID) || 'telegram',
      credentials: {
        botToken: telegramToken,
        webhookSecret: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_WEBHOOK_SECRET),
      },
      settings: {
        mode: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_MODE) || 'polling',
        respondInGroups: readString(env.OPEN_COWORK_GATEWAY_TELEGRAM_RESPOND_IN_GROUPS) || 'commands_only',
      },
    }]
  }

  const webhookDeliveryUrl = readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_DELIVERY_URL)
  if (webhookDeliveryUrl) {
    return [{
      id: 'webhook',
      kind: 'webhook',
      channelBindingId: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_CHANNEL_BINDING_ID) || 'webhook',
      credentials: {
        sharedSecret: readString(env.OPEN_COWORK_GATEWAY_WEBHOOK_SHARED_SECRET),
      },
      settings: {
        deliveryUrl: webhookDeliveryUrl,
      },
    }]
  }

  return []
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
  return {
    id,
    kind,
    enabled: raw.enabled !== false,
    channelBindingId,
    externalWorkspaceId: readNullableString(raw.externalWorkspaceId),
    defaultAgent: readNullableString(raw.defaultAgent),
    credentials: cleanStringRecord(raw.credentials),
    settings: cleanRecord(raw.settings),
  }
}

function readProviderKind(value: unknown): GatewayProviderKind {
  const kind = readString(value)
  if (kind === 'fake' || kind === 'telegram' || kind === 'webhook' || kind === 'cli' || kind === 'slack' || kind === 'discord' || kind === 'whatsapp' || kind === 'signal') {
    return kind
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
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
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
  return { ...(value as Record<string, unknown>) }
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
    return redactLocalPaths(redactUrlSecrets(value))
  }
  return redactUnknown(value)
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
