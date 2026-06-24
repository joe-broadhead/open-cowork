import { existsSync, readFileSync } from 'node:fs'
import { CLOUD_WEB_REACT_CLIENT_ASSET_PATH } from './browser-app.ts'

const CLOUD_WEB_REACT_CLIENT_FILE_NAME = 'open-cowork-cloud-react.js'
const CLOUD_WEB_REACT_CLIENT_CANDIDATES = [
  // Bundled/Docker runtime: build-cloud copies the client next to the cloud entry.
  new URL(`./assets/${CLOUD_WEB_REACT_CLIENT_FILE_NAME}`, import.meta.url),
  // Dev/source run: the website's vite client build, relative to this package source.
  new URL(`../../../apps/website/dist/client/${CLOUD_WEB_REACT_CLIENT_FILE_NAME}`, import.meta.url),
]

let cachedReactClientAsset: Buffer | null | undefined

export function getCloudWebReactClientAsset(pathname: string) {
  if (pathname !== CLOUD_WEB_REACT_CLIENT_ASSET_PATH) return null
  if (cachedReactClientAsset !== undefined) return cachedReactClientAsset

  for (const candidate of CLOUD_WEB_REACT_CLIENT_CANDIDATES) {
    if (!existsSync(candidate)) continue
    cachedReactClientAsset = readFileSync(candidate)
    return cachedReactClientAsset
  }

  cachedReactClientAsset = null
  return cachedReactClientAsset
}
