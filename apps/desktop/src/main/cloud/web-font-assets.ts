import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export const CLOUD_WEB_FONT_ASSET_PREFIX = '/assets/fonts/'
export const CLOUD_WEB_FONT_CACHE_CONTROL = 'public, max-age=86400'

const CLOUD_WEB_FONT_ASSETS = new Map<string, Buffer>([
  [
    'mona-sans-latin-wght-normal.woff2',
    readFileSync(require.resolve('@fontsource-variable/mona-sans/files/mona-sans-latin-wght-normal.woff2')),
  ],
  [
    'mona-sans-latin-wght-italic.woff2',
    readFileSync(require.resolve('@fontsource-variable/mona-sans/files/mona-sans-latin-wght-italic.woff2')),
  ],
  [
    'hubot-sans-latin-wght-normal.woff2',
    readFileSync(require.resolve('@fontsource-variable/hubot-sans/files/hubot-sans-latin-wght-normal.woff2')),
  ],
  [
    'hubot-sans-latin-wght-italic.woff2',
    readFileSync(require.resolve('@fontsource-variable/hubot-sans/files/hubot-sans-latin-wght-italic.woff2')),
  ],
])

export function getCloudWebFontAsset(pathname: string) {
  if (!pathname.startsWith(CLOUD_WEB_FONT_ASSET_PREFIX)) return null
  const fontName = pathname.slice(CLOUD_WEB_FONT_ASSET_PREFIX.length)
  return fontName && !fontName.includes('/') ? CLOUD_WEB_FONT_ASSETS.get(fontName) || null : null
}
