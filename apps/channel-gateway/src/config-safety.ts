import type { GatewayConfig } from './config.js'

const defaultInstanceId = 'local'

export function isLoopbackHost(hostname: string) {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
}

export function normalizeGatewayPublicBaseUrl(value: unknown) {
  const text = readNullableString(value)
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('OPEN_COWORK_GATEWAY_PUBLIC_URL must be a valid HTTPS URL.')
  }
  if (url.protocol !== 'https:') throw new Error('OPEN_COWORK_GATEWAY_PUBLIC_URL must use HTTPS.')
  if (isLoopbackHost(url.hostname)) throw new Error('OPEN_COWORK_GATEWAY_PUBLIC_URL must be publicly reachable, not loopback.')
  let normalized = url.toString()
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

export function assertHttpsPublicUrl(value: string, label: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`)
  }
  if (url.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`)
  if (isLoopbackHost(url.hostname)) throw new Error(`${label} must be publicly reachable, not loopback.`)
}

export function assertGatewayConfigSafe(config: GatewayConfig, options: { allowPublicFakeProvider: boolean }) {
  const publicBind = isPublicBindHost(config.server.host)
  const publicExposure = publicBind || Boolean(config.server.publicBaseUrl)
  const loopbackOperatorBypass = config.server.allowLoopbackOperatorBypass
    && isLoopbackHost(config.server.host)
    && config.mode === 'self-host'
    && !config.server.publicBaseUrl
  if (config.server.allowLoopbackOperatorBypass && !loopbackOperatorBypass) {
    throw new Error('OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS is only allowed for self-host gateways bound to loopback without a public Gateway URL.')
  }
  if (isPlaceholderSecret(config.cloud.serviceToken)) {
    throw new Error('Gateway cloud service token is still a placeholder. Set OPEN_COWORK_GATEWAY_SERVICE_TOKEN to a generated gateway-scoped token before startup.')
  }
  if (!config.server.adminToken && !loopbackOperatorBypass) {
    throw new Error('Gateway operator endpoints require OPEN_COWORK_GATEWAY_ADMIN_TOKEN. For local loopback development only, set OPEN_COWORK_GATEWAY_ALLOW_LOOPBACK_OPERATOR_BYPASS=true explicitly.')
  }
  if (config.server.adminToken && isPlaceholderSecret(config.server.adminToken)) {
    throw new Error('Gateway operator admin token is still a placeholder. Set OPEN_COWORK_GATEWAY_ADMIN_TOKEN to a generated secret before startup.')
  }
  if (publicExposure && !config.server.adminToken) {
    throw new Error('Gateway public deployments require OPEN_COWORK_GATEWAY_ADMIN_TOKEN for metrics, diagnostics, and delivery operations.')
  }
  if (publicBind && (config.metrics.enabled || config.diagnostics.enabled) && !config.server.adminToken) {
    throw new Error('Gateway metrics or diagnostics on a public bind require OPEN_COWORK_GATEWAY_ADMIN_TOKEN.')
  }
  if (publicExposure && config.providers.some((provider) => provider.enabled && provider.kind === 'fake') && !(options.allowPublicFakeProvider && config.mode === 'self-host')) {
    throw new Error('Gateway fake provider cannot be exposed publicly unless OPEN_COWORK_GATEWAY_ALLOW_PUBLIC_FAKE_PROVIDER=true is set explicitly for a self-host demo.')
  }
  if (publicExposure && config.providers.some((provider) => provider.enabled && provider.kind === 'cli')) {
    throw new Error('Gateway CLI provider is local-only and cannot be exposed publicly.')
  }
  for (const provider of config.providers) {
    for (const [key, value] of Object.entries(provider.credentials)) {
      if (/token|secret|password|credential|api[_-]?key|private[_-]?key|access[_-]?key/i.test(key) && isPlaceholderSecret(value)) {
        throw new Error(`Gateway provider ${provider.id} credential ${key} is still a placeholder.`)
      }
    }
  }
}

export function readGatewayInstanceId(value: unknown) {
  const text = readString(value) || defaultInstanceId
  const parts: string[] = []
  let previousWasDash = false
  for (const char of text.toLowerCase()) {
    if (parts.length >= 96) break
    if (isInstanceIdChar(char)) {
      parts.push(char)
      previousWasDash = false
      continue
    }
    if (!previousWasDash && parts.length > 0) {
      parts.push('-')
      previousWasDash = true
    }
  }
  while (parts[parts.length - 1] === '-') parts.pop()
  return parts.join('') || defaultInstanceId
}

function isInstanceIdChar(char: string) {
  return (char >= 'a' && char <= 'z')
    || (char >= '0' && char <= '9')
    || char === '_'
    || char === '.'
    || char === ':'
    || char === '-'
}

function isPublicBindHost(hostname: string) {
  const host = hostname.trim().toLowerCase()
  return host === '0.0.0.0' || host === '::' || host === '[::]' || !isLoopbackHost(host)
}

function isPlaceholderSecret(value: string) {
  return /^(change-me|replace-with|example-|demo-)/i.test(value.trim())
}

function readNullableString(value: unknown) {
  const text = readString(value)
  return text || null
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}
