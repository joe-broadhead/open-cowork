import electron from 'electron'
import { existsSync, realpathSync, statSync } from 'fs'
import { extname, isAbsolute, normalize, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import {
  CHART_FRAME_ASSET_HOST,
  CHART_FRAME_ASSET_PROTOCOL,
} from '../lib/chart-frame-assets.ts'

const electronNet = (electron as { net?: typeof import('electron').net }).net
const electronProtocol = (electron as { protocol?: typeof import('electron').protocol }).protocol
const SUPPORTED_CHART_FRAME_ASSET_EXTENSIONS = new Set(['.js', '.css', '.map'])

function getRendererDistRoot() {
  return resolve(__dirname, '..')
}

function isPathInside(parent: string, child: string) {
  const rel = relative(parent, child)
  return rel === '' || (rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function normalizeChartFrameAssetPath(assetPath: string | undefined) {
  const trimmed = assetPath?.trim()
  if (!trimmed) return null
  if (trimmed.length > 512) return null
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null
  if (isAbsolute(trimmed) || trimmed.startsWith('/') || trimmed.startsWith('\\')) return null

  const normalized = normalize(trimmed).replace(/\\/g, '/')
  if (!normalized.startsWith('assets/')) return null
  if (normalized === 'assets' || normalized.startsWith('../') || normalized.includes('/../')) return null

  const ext = extname(normalized).toLowerCase()
  if (!SUPPORTED_CHART_FRAME_ASSET_EXTENSIONS.has(ext)) return null
  return normalized
}

export function resolveChartFrameAssetFile(assetPath: string | undefined, root = getRendererDistRoot()) {
  const normalized = normalizeChartFrameAssetPath(assetPath)
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

function contentTypeForPath(filePath: string) {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.js') return 'text/javascript; charset=utf-8'
  if (ext === '.css') return 'text/css; charset=utf-8'
  if (ext === '.map') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

export function registerChartFrameAssetProtocol() {
  if (!electronProtocol || !electronNet) return
  electronProtocol.handle(CHART_FRAME_ASSET_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== CHART_FRAME_ASSET_HOST) return new Response(null, { status: 404 })
      const assetPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const file = resolveChartFrameAssetFile(assetPath)
      if (!file) return new Response(null, { status: 404 })
      const response = await electronNet.fetch(pathToFileURL(file).toString())
      const headers = new Headers(response.headers)
      headers.set('Content-Type', contentTypeForPath(file))
      // Chart-frame module scripts are loaded from an opaque sandboxed file
      // frame. CORS must allow the opaque `null` origin, but the protocol only
      // serves immutable bundled chart chunks from the renderer dist.
      headers.set('Access-Control-Allow-Origin', '*')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
