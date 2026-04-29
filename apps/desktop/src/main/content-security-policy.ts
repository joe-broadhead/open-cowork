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
    "img-src 'self' data: blob: open-cowork-asset:",
    `connect-src ${Array.from(connectSrc).join(' ')}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

export const PACKAGED_CONTENT_SECURITY_POLICY = buildContentSecurityPolicy()

// Chart frame CSP — rationale for `unsafe-eval`.
//
// Vega compiles user-supplied specs at runtime via `Function()` (the
// reactive dataflow runtime, expression interpreter, and signal
// bindings all go through `new Function(...)`), which CSP classifies
// as `unsafe-eval`. There is no ahead-of-time compile path we can use
// without reimplementing Vega. The directive is scoped to the chart
// iframe only (detected via `isChartFrameUrl`); the main renderer
// stays on strict `script-src 'self'`.
//
// Mitigations that bound the blast radius of `unsafe-eval` in this
// frame:
//   1. `default-src 'none'` + `connect-src 'none'` in packaged builds
//      — even if an attacker-controlled spec turns into arbitrary JS,
//      it cannot exfiltrate over the network.
//   2. `sandbox` attribute on the frame tag (allows scripts + same-origin
//      but blocks popups, forms, navigation, and top-level redirects).
//   3. `frame-ancestors 'self'` — only the host renderer can embed it,
//      blocking click-jacking from untrusted origins.
//   4. `validateInlineChartSpec` runs before static rendering and inside
//      the chart iframe before `vega-embed` receives the spec. It rejects
//      external resource keys (`url`, `href`, `src`), image marks,
//      oversized specs, excessive array items, and excessive object depth
//      so specs can only reference bounded inline values the caller
//      already had.
//   5. The chart-frame preload is a no-op — no `nodeIntegration`, no
//      `coworkApi`, so even arbitrary eval has no filesystem, IPC, or
//      Electron-specific escape hatches.
//   6. `postMessage` handlers in the parent check `event.origin` and
//      `event.source === iframe.contentWindow` before trusting the
//      payload (see `VegaChart.tsx`).
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
