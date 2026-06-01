import {
  evaluateHttpMcpUrl,
  evaluateHttpMcpUrlResolved,
  type McpDnsResolver,
  type McpUrlPolicyResult,
} from '../mcp-url-policy.ts'

export type DesktopPairingBrokerUrlResolutionOptions = {
  resolveHostname?: McpDnsResolver
}

function normalizeBrokerHostname(hostname: string) {
  const lower = hostname.toLowerCase()
  const withoutBrackets = lower.startsWith('[') && lower.endsWith(']')
    ? lower.slice(1, -1)
    : lower
  const zoneIndex = withoutBrackets.indexOf('%')
  const withoutZone = zoneIndex >= 0 ? withoutBrackets.slice(0, zoneIndex) : withoutBrackets
  return withoutZone.endsWith('.') ? withoutZone.slice(0, -1) : withoutZone
}

function brokerReason(reason: string) {
  return reason.replace(/\bMCPs\b/g, 'desktop pairing brokers').replace(/\bMCP\b/g, 'desktop pairing broker')
}

export function isLocalDevelopmentBrokerUrl(rawUrl: string | URL) {
  const parsed = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl
  const host = normalizeBrokerHostname(parsed.hostname)
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
}

export function evaluateDesktopPairingBrokerUrl(rawUrl: string): McpUrlPolicyResult {
  if (!rawUrl || !rawUrl.trim()) {
    return { ok: false, reason: 'Desktop pairing broker URL is required.' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { ok: false, reason: 'Desktop pairing broker URL is not valid.' }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Desktop pairing broker URL must not include embedded credentials.' }
  }

  if (isLocalDevelopmentBrokerUrl(parsed)) {
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { ok: true, url: parsed }
    return { ok: false, reason: 'Desktop pairing broker URL must use http or https for localhost development.' }
  }

  const verdict = evaluateHttpMcpUrl(parsed.toString(), { allowPrivateNetwork: false })
  if (!verdict.ok) return { ok: false, reason: brokerReason(verdict.reason) }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Desktop pairing broker URL must use https, except for localhost development.' }
  }

  return verdict
}

export async function resolveDesktopPairingBrokerUrl(
  rawUrl: string,
  options: DesktopPairingBrokerUrlResolutionOptions = {},
) {
  const staticVerdict = evaluateDesktopPairingBrokerUrl(rawUrl)
  if (!staticVerdict.ok) {
    throw new Error(`Desktop pairing broker URL is not allowed. ${staticVerdict.reason}`)
  }
  if (isLocalDevelopmentBrokerUrl(staticVerdict.url)) {
    return staticVerdict.url.toString()
  }

  const verdict = await evaluateHttpMcpUrlResolved(staticVerdict.url.toString(), {
    allowPrivateNetwork: false,
    resolveHostname: options.resolveHostname,
  })
  if (verdict.ok) return verdict.url.toString()
  throw new Error(`Desktop pairing broker URL is not allowed. ${brokerReason(verdict.reason)}`)
}
