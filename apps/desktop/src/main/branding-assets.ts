import { getAppPathHost } from '@open-cowork/shared/node'
import { existsSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, join, normalize, relative, resolve, sep } from 'path'

export const BRANDING_ASSET_PROTOCOL = 'open-cowork-asset'
export const BRANDING_ASSET_HOST = 'branding'
const SUPPORTED_BRANDING_ASSET_EXTENSIONS = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif'])

export function getBrandingAssetRoot() {
  const appPaths = getAppPathHost()
  if (appPaths?.isPackaged) return join(process.resourcesPath, 'branding')
  if (appPaths?.getAppPath) return resolve(appPaths.getAppPath(), '..', '..', 'branding')
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
  try {
    const realRoot = realpathSync.native(rootPath)
    const realFile = realpathSync.native(resolved)
    if (!isPathInside(realRoot, realFile)) return null
    if (!statSync(realFile).isFile()) return null
    return realFile
  } catch {
    return null
  }
}

// Resolves the configured OS window/dock icon (`branding.appIcon`, a branding-relative
// path) to a real file path usable by `BrowserWindow({ icon })` / `nativeImage`. Returns
// null when unset or invalid (path traversal, unsupported type, missing file) so callers
// fall back to the bundled default icon.
export function resolveAppIconFile(appIcon: string | null | undefined, root = getBrandingAssetRoot()) {
  if (!appIcon) return null
  return resolveBrandingAssetFile(appIcon, root)
}

export function brandingAssetUrl(assetPath: string | undefined, root = getBrandingAssetRoot()) {
  const file = resolveBrandingAssetFile(assetPath, root)
  if (!file) return undefined
  try {
    const realRoot = realpathSync.native(resolve(root))
    if (!isPathInside(realRoot, file)) return undefined
    const relativePath = relative(realRoot, file).split(sep).map(encodeURIComponent).join('/')
    if (!relativePath) return undefined
    return `${BRANDING_ASSET_PROTOCOL}://${BRANDING_ASSET_HOST}/${relativePath}`
  } catch {
    return undefined
  }
}
