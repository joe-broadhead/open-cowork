import { existsSync, readFileSync } from 'node:fs'

// Serves the UNIFIED RENDERER browser build (apps/desktop/dist-browser) so the
// cloud URL itself runs the desktop renderer — the production-serving step of
// collapsing the website + desktop UIs into one codebase. This is additive: the
// website served at GET / is untouched; the renderer is mounted under /app.
//
// The renderer is a plain SPA. Its entry document (browser.html) loads hashed
// module scripts from /assets/*, installs a browser CoworkAPI shim, and talks to
// the same-origin cloud /api, /auth and /events (SSE) routes. The shim derives the
// endpoint base from window.location and reads the CSRF token from /auth/me at
// runtime, so the embedded bootstrap blob can be minimal.

// URL prefix the /app document loads hashed assets from. The built browser.html
// references '/assets/<hash>.js'; we rewrite those to '/app/assets/...' (see
// rewriteBrowserHtmlAssetPaths) and serve them from this prefix.
export const BROWSER_RENDERER_ASSET_PREFIX = '/app/assets/'

// Candidate locations for the dist-browser build.
//
// DEV RUNTIME: the cloud runs from source via scripts/open-cowork-cloud.ts, so
// import.meta.url is this file under packages/cloud-server/src/. The build lives at
// apps/desktop/dist-browser/ — three levels up (src -> cloud-server -> packages ->
// repo root). Mirrors how web-client-assets.ts resolves the website dev build.
//
// TODO(prod-packaging): production bundles the cloud server (build-cloud) without
// the repo tree, so the relative path above won't resolve. Packaging must copy
// apps/desktop/dist-browser/ next to the cloud entry (e.g. ./browser-renderer/),
// and the first candidate below should point there. Tracked as a follow-up to the
// website deletion / cutover step — do not block the additive /app route on it.
const BROWSER_RENDERER_DIRS = [
  new URL('./browser-renderer/', import.meta.url),
  new URL('../../../apps/desktop/dist-browser/', import.meta.url),
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
// forever; a new build emits a new name. Matches the website font cache policy.
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

// The built browser.html points at '/assets/...'; under /app we serve assets from
// '/app/assets/...'. Rewrite the asset references (and inject the bootstrap blob)
// so the document loads correctly when mounted under /app. The rewrite targets
// src="/assets/ and href="/assets/ only — same-origin absolute asset paths.
function rewriteBrowserHtmlAssetPaths(html: string): string {
  return html
    .replace(/src="\/assets\//g, `src="${BROWSER_RENDERER_ASSET_PREFIX}`)
    .replace(/href="\/assets\//g, `href="${BROWSER_RENDERER_ASSET_PREFIX}`)
}

let cachedBrowserHtml: string | null | undefined

/**
 * The /app SPA document: the built browser.html with asset paths rewritten under
 * /app/assets and the bootstrap blob injected into <script id="cowork-bootstrap">.
 * Returns null when the dist-browser build is absent.
 */
export function browserRendererHtml(bootstrap: Record<string, unknown>): string | null {
  if (cachedBrowserHtml === undefined) {
    const candidate = resolveInDir('browser.html')
    cachedBrowserHtml = candidate ? readFileSync(candidate, 'utf8') : null
  }
  if (cachedBrowserHtml === null) return null
  const rewritten = rewriteBrowserHtmlAssetPaths(cachedBrowserHtml)
  // The shim reads JSON.parse(textContent) of this tag, so the payload must be
  // valid JSON and must not break out of the <script> element. JSON.stringify
  // cannot emit a literal '<', so a '</script>' sequence is not representable; the
  // '<' escape below is belt-and-suspenders for the same guarantee.
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c')
  return rewritten.replace(
    /(<script id="cowork-bootstrap" type="application\/json">)[\s\S]*?(<\/script>)/,
    `$1${json}$2`,
  )
}
