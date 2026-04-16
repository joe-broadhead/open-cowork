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
  const devServerOrigin = normalizeDevServerOrigin(options.devServerUrl)
  if (devServerOrigin) {
    connectSrc.add(devServerOrigin)
    connectSrc.add(devServerOrigin.replace(/^http:/, 'ws:'))
    connectSrc.add(devServerOrigin.replace(/^https:/, 'wss:'))
  }

  return [
    "default-src 'self'",
    "script-src 'self'",
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

  if (devServerOrigin) {
    scriptSrc.add(devServerOrigin)
    styleSrc.add(devServerOrigin)
  }

  return [
    "default-src 'none'",
    `script-src ${Array.from(scriptSrc).join(' ')}`,
    `style-src ${Array.from(styleSrc).join(' ')}`,
    "img-src 'self' data: blob:",
    "connect-src 'none'",
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
