import type { ServerResponse } from 'node:http'

// Pure HTTP response writers for the cloud HTTP server, extracted from
// http-server.ts so the response-shaping concern (security/CORS headers, JSON /
// HTML / binary / error / redirect bodies) is separate from the route wiring.
// No side effects beyond the passed response; no server state.

export function writeSecurityHeaders(res: ServerResponse, options: { strictTransportSecurity?: boolean } = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  if (options.strictTransportSecurity) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

export function writeCorsHeaders(res: ServerResponse, origin: string | null | undefined) {
  if (!origin) return
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-CSRF-Token')
}

export function writeJson(res: ServerResponse, status: number, body: unknown, origin?: string | null) {
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function writeHtml(res: ServerResponse, status: number, body: string, origin?: string | null, nonce?: string | null) {
  const scriptSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'"
  const styleSrc = nonce ? `'self' 'nonce-${nonce}'` : "'self'"
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "img-src 'self' data: https:",
      `style-src ${styleSrc}`,
      `script-src ${scriptSrc}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(body)
}

export function writeBinary(res: ServerResponse, body: Buffer, contentType: string, cacheControl: string, origin?: string | null) {
  writeCorsHeaders(res, origin)
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': cacheControl,
    'content-length': String(body.byteLength),
  })
  res.end(body)
}

export function writeError(
  res: ServerResponse,
  status: number,
  message: string,
  origin?: string | null,
  details: { policyCode?: string | null, retryAfterMs?: number | null } = {},
) {
  if (details.retryAfterMs && details.retryAfterMs > 0) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(details.retryAfterMs / 1000))))
  }
  const body: Record<string, unknown> = { error: message }
  if (details.retryAfterMs && details.retryAfterMs > 0) body.retryAfterMs = details.retryAfterMs
  if (details.policyCode) {
    body.verdict = {
      allowed: false,
      reason: message,
      policyCode: details.policyCode,
    }
  }
  writeJson(res, status, body, origin)
}

export function writePolicyError(
  res: ServerResponse,
  status: number,
  message: string,
  policyCode: string,
  origin?: string | null,
) {
  writeJson(res, status, {
    error: message,
    verdict: {
      allowed: false,
      reason: message,
      policyCode,
    },
  }, origin)
}

export function writeRedirect(
  res: ServerResponse,
  location: string,
  setCookieHeaders: string[] | undefined,
  origin?: string | null,
) {
  writeCorsHeaders(res, origin)
  if (setCookieHeaders?.length) res.setHeader('Set-Cookie', setCookieHeaders)
  res.writeHead(302, {
    location,
    'cache-control': 'no-store',
  })
  res.end()
}

export function methodRequiresCsrf(method: string | undefined) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
}
