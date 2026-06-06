import type { Buffer } from 'node:buffer'
import { CLOUD_WEB_REACT_CLIENT_ASSET_PATH } from './browser-app.ts'
import { CLOUD_WEB_FONT_ASSET_PREFIX, CLOUD_WEB_FONT_CACHE_CONTROL, getCloudWebFontAsset } from './web-font-assets.ts'
import { getCloudWebReactClientAsset } from './web-client-assets.ts'

export type CloudWebStaticAssetResponse =
  | { status: 'ok'; body: Buffer; contentType: string; cacheControl: string }
  | { status: 'not-found'; message: string }

export function resolveCloudWebStaticAsset(pathname: string): CloudWebStaticAssetResponse | null {
  if (pathname === CLOUD_WEB_REACT_CLIENT_ASSET_PATH) {
    const body = getCloudWebReactClientAsset(pathname)
    return body
      ? { status: 'ok', body, contentType: 'application/javascript; charset=utf-8', cacheControl: 'no-store' }
      : { status: 'not-found', message: 'Cloud Web React client asset was not found.' }
  }

  if (pathname.startsWith(CLOUD_WEB_FONT_ASSET_PREFIX)) {
    const body = getCloudWebFontAsset(pathname)
    return body
      ? { status: 'ok', body, contentType: 'font/woff2', cacheControl: CLOUD_WEB_FONT_CACHE_CONTROL }
      : { status: 'not-found', message: 'Cloud Web font asset was not found.' }
  }

  return null
}
