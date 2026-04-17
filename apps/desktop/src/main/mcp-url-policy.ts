// Policy gate for HTTP MCP URLs.
//
// Without this, a user can configure an HTTP MCP pointing at any URL
// the Electron runtime can reach from the host — including AWS IMDS
// (169.254.169.254), internal corporate APIs, and localhost services.
// That's a classic SSRF channel: a prompt-injected agent could tell
// an MCP to issue requests that exfiltrate cloud metadata tokens or
// read internal dashboards.
//
// Legitimate downstream installs do sometimes need internal-network
// MCPs (on-prem corp tools at 10.*, local dev servers on 127.*), so
// the policy is opt-in via `CustomMcpConfig.allowPrivateNetwork`. The
// default posture is "public internet only."

const LOOPBACK_HOSTS = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
])

function isLoopbackV4(host: string) {
  // 127.0.0.0/8
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

function isRfc1918(host: string) {
  // 10.0.0.0/8
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  // 172.16.0.0/12
  const match172 = /^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host)
  if (match172) {
    const second = Number(match172[1])
    if (second >= 16 && second <= 31) return true
  }
  // 192.168.0.0/16
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true
  return false
}

function isLinkLocalV4(host: string) {
  // 169.254.0.0/16 — includes cloud metadata services (AWS IMDS,
  // Azure IMDS at 169.254.169.254, GCP metadata). Prime SSRF target.
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)
}

function isUniqueLocalV6(host: string) {
  // fc00::/7
  return /^f[cd][0-9a-f]{2}:/i.test(host)
}

function isLinkLocalV6(host: string) {
  // fe80::/10
  return /^fe[89ab][0-9a-f]:/i.test(host)
}

function isLoopbackV6(host: string) {
  return host === '::1' || host === '0:0:0:0:0:0:0:1'
}

export type McpUrlPolicyResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string }

// Classify a URL and return either the parsed URL for the caller to
// use, or an explicit reason the URL was rejected. Callers decide
// whether to surface the reason to the user verbatim.
export function evaluateHttpMcpUrl(
  rawUrl: string,
  options?: { allowPrivateNetwork?: boolean },
): McpUrlPolicyResult {
  if (!rawUrl || !rawUrl.trim()) {
    return { ok: false, reason: 'URL is required.' }
  }

  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    return { ok: false, reason: 'URL is not valid.' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `Unsupported URL protocol "${url.protocol}". Only http and https are allowed.` }
  }

  // WHATWG URL preserves IPv6 brackets in hostname; strip them so the
  // pattern matchers below see the bare address.
  const rawHostname = url.hostname.toLowerCase()
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname

  if (options?.allowPrivateNetwork) {
    return { ok: true, url }
  }

  if (LOOPBACK_HOSTS.has(hostname) || isLoopbackV4(hostname) || isLoopbackV6(hostname)) {
    return { ok: false, reason: 'URL resolves to loopback. Enable "Allow private network" on the MCP if this is intentional.' }
  }

  if (isLinkLocalV4(hostname) || isLinkLocalV6(hostname)) {
    return { ok: false, reason: 'URL targets a link-local address (169.254.*). Cloud metadata endpoints are blocked by default — enable "Allow private network" if you genuinely need it.' }
  }

  if (isRfc1918(hostname) || isUniqueLocalV6(hostname)) {
    return { ok: false, reason: 'URL targets a private network (RFC1918). Enable "Allow private network" on the MCP to use corporate-internal endpoints.' }
  }

  return { ok: true, url }
}
