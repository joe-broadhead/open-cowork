import { extractHostname, isLocalHostname, redactSensitiveText } from './security.js'
import { isTrustedOpenCodePeerHost } from './opencode-peer-hosts.js'

export { setTrustedOpenCodePeerHosts } from './opencode-peer-hosts.js'

const OPEN_CODE_LOCAL_HOST_ALIASES = new Set(['0.0.0.0', 'host.docker.internal'])

export function openCodeEndpointUrl(opencodeUrl: string, path: string): URL {
  const base = safeOpenCodeBaseUrl(opencodeUrl)
  const relative = String(path || '').replace(/^\/+/, '')
  return new URL(relative, base)
}

export function safeOpenCodeBaseUrl(opencodeUrl: string): URL {
  let url: URL
  try {
    url = new URL(String(opencodeUrl || '').trim())
  } catch {
    throw new Error('OpenCode URL is invalid; expected a local http(s) URL or trusted peer URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('OpenCode URL must use http or https for daemon-side fetches')
  }
  if (url.username || url.password) {
    throw new Error('OpenCode URL must not embed credentials')
  }
  if (!isAllowedOpenCodeFetchHost(url.hostname)) {
    throw new Error(`OpenCode URL host is not allowed for daemon-side fetches: ${redactSensitiveText(url.hostname)}`)
  }
  url.hash = ''
  url.search = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url
}

export function safeOpenCodeBaseUrlString(opencodeUrl: string): string {
  return safeOpenCodeBaseUrl(opencodeUrl).toString().replace(/\/$/, '')
}

export function isAllowedOpenCodeFetchHost(hostname: string): boolean {
  const host = normalizeOpenCodeHostname(hostname)
  if (isLocalHostname(host) || host.endsWith('.localhost') || OPEN_CODE_LOCAL_HOST_ALIASES.has(host)) return true
  return isTrustedOpenCodePeerHost(host)
}

function normalizeOpenCodeHostname(hostname: string): string {
  const value = String(hostname || '').trim().toLowerCase()
  return extractHostname(value.replace(/^\[(.*)\]$/, '$1'))
}
