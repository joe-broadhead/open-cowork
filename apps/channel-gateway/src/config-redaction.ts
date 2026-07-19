/**
 * Channel Gateway config/diagnostic redaction.
 *
 * Product-stable markers (Bearer [redacted], token= query form, local paths)
 * stay here; token families layer through `@open-cowork/shared` so coverage
 * cannot drift from Desktop/Cloud/standalone (audit 2026-07-18).
 */
import { redactSecretText as sharedRedactSecretText } from '@open-cowork/shared'

import type { GatewayConfig, GatewayEnv } from './config.js'

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

export function redactGatewayDiagnosticText(value: string) {
  // Product-stable markers first. URLs are placeholder-protected so shared's
  // whole-query collapse cannot rewrite `?token=[redacted]` into `?[REDACTED_QUERY]`.
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
