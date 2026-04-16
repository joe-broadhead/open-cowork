import type { Session } from 'electron'

type ContentSecurityPolicyOptions = {
  devServerUrl?: string | null
}

function normalizeDevServerOrigin(devServerUrl?: string | null) {
  if (!devServerUrl) return null
  try {
    return new URL(devServerUrl).origin
  } catch {
    return null
  }
}

export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}) {
  const connectSrc = new Set(["'self'"])
  const scriptSrc = new Set(["'self'"])
  const devServerOrigin = normalizeDevServerOrigin(options.devServerUrl)
  if (devServerOrigin) {
    connectSrc.add(devServerOrigin)
    connectSrc.add(devServerOrigin.replace(/^http:/, 'ws:'))
    connectSrc.add(devServerOrigin.replace(/^https:/, 'wss:'))
    // Vite's React Fast Refresh injects an inline preamble into index.html
    // that must run before any module imports. There is no way to nonce or
    // hash it ahead of time, so dev mode allows inline scripts. Packaged
    // builds do not set devServerUrl and stay on strict `'self'`.
    scriptSrc.add("'unsafe-inline'")
  }

  return [
    "default-src 'self'",
    `script-src ${Array.from(scriptSrc).join(' ')}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    `connect-src ${Array.from(connectSrc).join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export const PACKAGED_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy()

export function buildChartFrameContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}) {
  const devServerOrigin = normalizeDevServerOrigin(options.devServerUrl)
  const scriptSrc = new Set(["'self'", "'unsafe-eval'"])
  const styleSrc = new Set(["'self'", "'unsafe-inline'"])
  const connectSrc = new Set<string>()

  if (devServerOrigin) {
    scriptSrc.add(devServerOrigin)
    styleSrc.add(devServerOrigin)
    // Vite's HMR injects an inline preamble and opens a WebSocket back to the
    // dev server. The chart frame still denies all egress in packaged builds
    // (connectSrc stays 'none'); dev mode opens just the local HMR channel.
    scriptSrc.add("'unsafe-inline'")
    connectSrc.add(devServerOrigin)
    connectSrc.add(devServerOrigin.replace(/^http:/, 'ws:'))
    connectSrc.add(devServerOrigin.replace(/^https:/, 'wss:'))
  }

  return [
    "default-src 'none'",
    `script-src ${Array.from(scriptSrc).join(' ')}`,
    `style-src ${Array.from(styleSrc).join(' ')}`,
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc.size > 0 ? Array.from(connectSrc).join(' ') : "'none'"}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

function isChartFrameUrl(url: string) {
  return /\/chart-frame\.html(?:[?#].*)?$/.test(url)
}

export function attachContentSecurityPolicy(
  session: Session,
  options: ContentSecurityPolicyOptions = {},
) {
  const policy = buildContentSecurityPolicy(options)
  const chartFramePolicy = buildChartFrameContentSecurityPolicy(options)

  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {}

    for (const [key, value] of Object.entries(details.responseHeaders || {})) {
      if (!value) continue
      responseHeaders[key] = Array.isArray(value) ? value : [String(value)]
    }

    responseHeaders['Content-Security-Policy'] = [isChartFrameUrl(details.url) ? chartFramePolicy : policy]
    callback({ responseHeaders })
  })

  return policy
}
