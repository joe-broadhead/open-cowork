import { existsSync, readFileSync } from 'node:fs'
import { CLOUD_WEB_REACT_CLIENT_ASSET_PATH } from './browser-app.ts'

// URL-path directory the SSR shell + entry chunk import client chunks from.
// Derived from the entry path so the two never drift (e.g. '/assets/').
const CLOUD_WEB_REACT_CLIENT_ASSET_DIR = CLOUD_WEB_REACT_CLIENT_ASSET_PATH.slice(
  0,
  CLOUD_WEB_REACT_CLIENT_ASSET_PATH.lastIndexOf('/') + 1,
)

// The vite client build (apps/website/vite.config.ts) emits a fixed-name entry
// (open-cowork-cloud-react.js) PLUS sibling chunks (open-cowork-cloud-react-vendor.js,
// …) that the entry imports by name. build-cloud ships every chunk, so the cloud
// server must serve the whole family — serving only the entry 404s the vendor chunk
// and white-screens the app. The variable part is strictly `[A-Za-z0-9]` segments
// joined by single hyphens: no '.', no '/', so no path traversal is representable.
const CLOUD_WEB_REACT_CLIENT_FILE_PATTERN = /^open-cowork-cloud-react(?:-[A-Za-z0-9]+)*\.js$/

// Candidate directories holding the built client (mirrors the original single-file
// lookup): the bundled/Docker assets dir next to the cloud entry, and the dev/source
// vite build relative to this package source. Trailing slash is required so a
// validated file name resolves *into* the directory.
const CLOUD_WEB_REACT_CLIENT_DIRS = [
  new URL('./assets/', import.meta.url),
  new URL('../../../apps/website/dist/client/', import.meta.url),
]

const cachedAssetsByFileName = new Map<string, Buffer | null>()

function reactClientFileName(pathname: string): string | null {
  if (!pathname.startsWith(CLOUD_WEB_REACT_CLIENT_ASSET_DIR)) return null
  const fileName = pathname.slice(CLOUD_WEB_REACT_CLIENT_ASSET_DIR.length)
  return CLOUD_WEB_REACT_CLIENT_FILE_PATTERN.test(fileName) ? fileName : null
}

// True for the entry chunk and every allowlisted sibling (vendor/runtime) chunk.
export function isCloudWebReactClientAssetPath(pathname: string): boolean {
  return reactClientFileName(pathname) !== null
}

export function getCloudWebReactClientAsset(pathname: string) {
  const fileName = reactClientFileName(pathname)
  if (fileName === null) return null

  const cached = cachedAssetsByFileName.get(fileName)
  if (cached !== undefined) return cached

  for (const dir of CLOUD_WEB_REACT_CLIENT_DIRS) {
    const candidate = new URL(fileName, dir)
    if (!existsSync(candidate)) continue
    const body = readFileSync(candidate)
    cachedAssetsByFileName.set(fileName, body)
    return body
  }

  cachedAssetsByFileName.set(fileName, null)
  return null
}
