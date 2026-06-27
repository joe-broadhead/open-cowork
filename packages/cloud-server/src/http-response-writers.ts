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
      // The design system themes per-entity surfaces with dynamic inline custom
      // properties (--entity-chroma / --studio-tone / --spine on identity tiles,
      // card spines, status dots). Inline style ATTRIBUTES can't carry a nonce,
      // so without this they're blocked and every tinted tile renders flat grey.
      // style-src-attr governs only attributes (not <style> elements, which stay
      // nonce-locked above); 'unsafe-inline' here cannot execute script.
      "style-src-attr 'unsafe-inline'",
      `script-src ${scriptSrc}`,
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  })
  res.end(body)
}

// CSP for the UNIFIED RENDERER SPA served at /app. It differs from the website's
// nonce CSP (writeHtml) in exactly ONE axis: style-src allows 'unsafe-inline'.
//
// WHY style-src is relaxed: the renderer injects its shared surface stylesheet at
// RUNTIME via a script-created <style> element (apps/desktop/src/renderer/index.tsx
// injectStudioSurfaceStyles) rather than a server-rendered <style nonce>. A
// runtime-created <style> carries no nonce, so a nonce-only style-src would block
// it and the whole app would render unstyled. Hashing the stylesheet is not viable
// (it is assembled from the design-system token modules at runtime). So style-src
// gets 'unsafe-inline'. style-src-attr 'unsafe-inline' additionally allows the
// per-entity inline `style` attributes the design system uses for theming
// (--entity-chroma); an inline style attribute cannot carry a nonce or hash.
//
// WHY script-src stays STRICT: the document loads only external hashed module
// scripts (no inline script, no eval), so script-src stays 'self' with NO
// 'unsafe-inline'. Relaxing style does not weaken script execution — 'unsafe-inline'
// in style-src cannot run JavaScript.
export function writeBrowserRendererHtml(res: ServerResponse, status: number, body: string, origin?: string | null) {
  writeCorsHeaders(res, origin)
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': [
      "default-src 'self'",
      // External hashed module scripts only — no inline script. Stays strict.
      "script-src 'self'",
      // Runtime-injected <style> element (see block comment above).
      "style-src 'self' 'unsafe-inline'",
      // Per-entity inline style attributes (entity-chroma theming).
      "style-src-attr 'unsafe-inline'",
      // Same-origin HTTP (/api, /auth) + SSE (/events).
      "connect-src 'self'",
      "font-src 'self'",
      "img-src 'self' data: https:",
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
