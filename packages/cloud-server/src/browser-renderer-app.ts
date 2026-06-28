import { existsSync, readFileSync } from 'node:fs'

// Serves the UNIFIED RENDERER browser build (packages/app/dist-browser) at the
// cloud URL itself — the production-serving step of collapsing the desktop +
// cloud UIs into one codebase. The cloud serves this same renderer at GET / (and
// at /app); the bespoke website is gone.
//
// The renderer is a plain SPA. Its entry document (browser.html) loads hashed
// module scripts from /app/assets/*, installs a browser CoworkAPI shim, and talks
// to the same-origin cloud /api, /auth and /events (SSE) routes. The shim derives
// the endpoint base from window.location and reads the CSRF token from /auth/me at
// runtime, so the embedded bootstrap blob can be minimal.

// URL prefix the renderer's hashed assets are served from. The browser build is
// produced with vite `base: '/app/'`, so the built browser.html already
// references '/app/assets/<hash>.js' directly — no HTML rewrite is needed.
export const BROWSER_RENDERER_ASSET_PREFIX = '/app/assets/'

// Candidate locations for the dist-browser build.
//
// DEV RUNTIME: the cloud runs from source via scripts/open-cowork-cloud.ts, so
// import.meta.url is this file under packages/cloud-server/src/. The build lives at
// packages/app/dist-browser/ — three levels up (src -> cloud-server -> packages ->
// repo root), produced by `pnpm --filter @open-cowork/app build:browser`.
//
// PROD RUNTIME: scripts/build-cloud.mjs builds the browser renderer and copies it
// to ./browser-renderer/ next to the bundled cloud entry, so the first candidate
// below resolves in the production image (the cloud .mjs lives at
// apps/desktop/dist/cloud/, and browser-renderer/ is copied alongside it).
const BROWSER_RENDERER_DIRS = [
  new URL('./browser-renderer/', import.meta.url),
  new URL('../../../packages/app/dist-browser/', import.meta.url),
]

// The build emits hashed file names like `renderer-Dy7V1PNU.js` but also vendor
// chunks with dots in the name (`cytoscape.esm-hash.js`, `mermaid.core-hash.js`).
// Allow alphanumerics, dot, underscore and hyphen with a single final extension.
// The name must START with an alphanumeric (so a leading-dot `..js` is rejected)
// and contains no '/', so path traversal is not representable.
const BROWSER_RENDERER_ASSET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2)$/

const ASSET_CONTENT_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
}

// Immutable: every asset name carries a content hash, so a cached copy is valid
// forever; a new build emits a new name (the standard hashed-asset cache policy).
export const BROWSER_RENDERER_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable'

function resolveAssetExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf('.')
  return dot >= 0 ? fileName.slice(dot + 1) : null
}

function resolveInDir(relativePath: string): URL | null {
  for (const dir of BROWSER_RENDERER_DIRS) {
    const candidate = new URL(relativePath, dir)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** True when the dist-browser build is present (used to gate tests + the route). */
export function browserRendererBuildExists(): boolean {
  return resolveInDir('browser.html') !== null
}

const cachedAssetsByFileName = new Map<string, Buffer | null>()

function browserRendererAssetFileName(pathname: string): string | null {
  if (!pathname.startsWith(BROWSER_RENDERER_ASSET_PREFIX)) return null
  const fileName = pathname.slice(BROWSER_RENDERER_ASSET_PREFIX.length)
  return BROWSER_RENDERER_ASSET_PATTERN.test(fileName) ? fileName : null
}

export function isBrowserRendererAssetPath(pathname: string): boolean {
  return browserRendererAssetFileName(pathname) !== null
}

export type BrowserRendererAsset = { body: Buffer; contentType: string }

/** Resolve a hashed /app/assets/* file from the dist-browser build, or null. */
export function getBrowserRendererAsset(pathname: string): BrowserRendererAsset | null {
  const fileName = browserRendererAssetFileName(pathname)
  if (fileName === null) return null
  const extension = resolveAssetExtension(fileName)
  const contentType = extension ? ASSET_CONTENT_TYPES[extension] : undefined
  if (!contentType) return null

  let body = cachedAssetsByFileName.get(fileName)
  if (body === undefined) {
    const candidate = resolveInDir(`assets/${fileName}`)
    body = candidate ? readFileSync(candidate) : null
    cachedAssetsByFileName.set(fileName, body)
  }
  return body ? { body, contentType } : null
}

let cachedBrowserHtml: string | null | undefined

/**
 * The SPA document: the built browser.html (its hashed assets already reference
 * /app/assets via vite's `base: '/app/'`, so no path rewrite is needed) with the
 * bootstrap blob injected into <script id="cowork-bootstrap">. Returns null when
 * the dist-browser build is absent.
 */
export function browserRendererHtml(bootstrap: Record<string, unknown>): string | null {
  if (cachedBrowserHtml === undefined) {
    const candidate = resolveInDir('browser.html')
    cachedBrowserHtml = candidate ? readFileSync(candidate, 'utf8') : null
  }
  if (cachedBrowserHtml === null) return null
  // The shim reads JSON.parse(textContent) of this tag, so the payload must be
  // valid JSON and must not break out of the <script> element. JSON.stringify
  // cannot emit a literal '<', so a '</script>' sequence is not representable; the
  // '<' escape below is belt-and-suspenders for the same guarantee.
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c')
  return cachedBrowserHtml.replace(
    /(<script id="cowork-bootstrap" type="application\/json">)[\s\S]*?(<\/script>)/,
    `$1${json}$2`,
  )
}

// The unified renderer's interactive Vega charts render inside a sandboxed iframe
// whose document is chart-frame.html. The SPA embeds it via
//   new URL('./chart-frame.html', window.location.href)
// so it must be served at /chart-frame.html (SPA mounted at /) AND /app/chart-frame.html
// (SPA mounted at /app/). The frame's hashed module chunks (chartFrame-*.js,
// vendor-vega-*.js) already serve through the /app/assets/* route above — chart-frame.html
// references them at /app/assets via vite's `base: '/app/'`. Without this route the iframe
// 404s and interactive charts are dead in the cloud (BUNDLE-1 parity gap).
export function isBrowserRendererChartFramePath(pathname: string): boolean {
  return pathname === '/chart-frame.html' || pathname === '/app/chart-frame.html'
}

let cachedChartFrameHtml: string | null | undefined

/**
 * The built chart-frame.html (its script + modulepreloads already reference
 * /app/assets via vite's `base: '/app/'`, so no rewrite is needed). Returns null
 * when the dist-browser build is absent.
 */
export function browserRendererChartFrameHtml(): string | null {
  if (cachedChartFrameHtml === undefined) {
    const candidate = resolveInDir('chart-frame.html')
    cachedChartFrameHtml = candidate ? readFileSync(candidate, 'utf8') : null
  }
  return cachedChartFrameHtml
}
