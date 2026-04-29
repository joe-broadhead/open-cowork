import electron from 'electron'
import { existsSync } from 'fs'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'

export const BRANDING_ASSET_PROTOCOL = 'open-cowork-asset'
const BRANDING_ASSET_HOST = 'branding'
const SUPPORTED_BRANDING_ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'])
const electronApp = (electron as { app?: typeof import('electron').app }).app
const electronNet = (electron as { net?: typeof import('electron').net }).net
const electronProtocol = (electron as { protocol?: typeof import('electron').protocol }).protocol

export function getBrandingAssetRoot() {
  if (electronApp?.isPackaged) return join(process.resourcesPath, 'branding')
  if (electronApp?.getAppPath) return resolve(electronApp.getAppPath(), '..', '..', 'branding')
  return resolve(process.cwd(), 'branding')
}

function isPathInside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === '' || (rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function normalizeAssetPath(assetPath: string | undefined) {
  const trimmed = assetPath?.trim()
  if (!trimmed) return null
  if (trimmed.length > 512) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  if (isAbsolute(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) return null

  const normalized = normalize(trimmed).replace(/\\/g, '/')
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return null

  const relativeAssetPath = normalized.startsWith('branding/') ? normalized.slice('branding/'.length) : normalized
  if (!relativeAssetPath || relativeAssetPath === '.' || relativeAssetPath.startsWith('../') || relativeAssetPath.includes('/../')) return null

  const ext = extname(relativeAssetPath).toLowerCase()
  if (!SUPPORTED_BRANDING_ASSET_EXTENSIONS.has(ext)) return null
  return relativeAssetPath
}

export function resolveBrandingAssetFile(assetPath: string | undefined, root = getBrandingAssetRoot()) {
  const normalized = normalizeAssetPath(assetPath)
  if (!normalized) return null
  const rootPath = resolve(root)
  const resolved = resolve(rootPath, normalized)
  if (!isPathInside(rootPath, resolved)) return null
  if (!existsSync(resolved)) return null
  return resolved
}

export function brandingAssetUrl(assetPath: string | undefined, root = getBrandingAssetRoot()) {
  const file = resolveBrandingAssetFile(assetPath, root)
  if (!file) return undefined
  const relativePath = relative(resolve(root), file).split(sep).map(encodeURIComponent).join('/')
  return `${BRANDING_ASSET_PROTOCOL}://${BRANDING_ASSET_HOST}/${relativePath}`
}

export function registerBrandingAssetProtocol() {
  if (!electronProtocol || !electronNet) return
  electronProtocol.handle(BRANDING_ASSET_PROTOCOL, (request) => {
    const url = new URL(request.url)
    if (url.hostname !== BRANDING_ASSET_HOST) return new Response(null, { status: 404 })
    const assetPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    const file = resolveBrandingAssetFile(assetPath)
    if (!file) return new Response(null, { status: 404 })
    return electronNet.fetch(pathToFileURL(file).toString())
  })
}

export function registerBrandingAssetScheme() {
  if (!electronProtocol) return
  electronProtocol.registerSchemesAsPrivileged([
    {
      scheme: BRANDING_ASSET_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ])
}
