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
  const connectSrc = new Set([
    "'self'",
    'https:',
    'http://127.0.0.1:*',
    'http://localhost:*',
    'ws://127.0.0.1:*',
    'ws://localhost:*',
  ])
  const devServerOrigin = normalizeDevServerOrigin(options.devServerUrl)
  if (devServerOrigin) {
    connectSrc.add(devServerOrigin)
    connectSrc.add(devServerOrigin.replace(/^http:/, 'ws:'))
    connectSrc.add(devServerOrigin.replace(/^https:/, 'wss:'))
  }

  // Vega's expression runtime still relies on Function/eval under the hood,
  // so packaged chart rendering breaks unless the renderer CSP allows it.
  const scriptSrc = ["'self'", "'unsafe-eval'"]

  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
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

export function attachContentSecurityPolicy(
  session: Session,
  options: ContentSecurityPolicyOptions = {},
) {
  const policy = buildContentSecurityPolicy(options)

  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders: Record<string, string[]> = {}

    for (const [key, value] of Object.entries(details.responseHeaders || {})) {
      if (!value) continue
      responseHeaders[key] = Array.isArray(value) ? value : [String(value)]
    }

    responseHeaders['Content-Security-Policy'] = [policy]
    callback({ responseHeaders })
  })

  return policy
}
