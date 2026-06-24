// Desktop-only: registers the custom `open-cowork-asset://` protocol that serves
// branding files to the renderer via Electron `protocol` + `net`. Split out of
// branding-assets.ts (which stays Electron-free path-resolution shared with the
// cloud) so the cloud server never pulls Electron's protocol/net into its graph.
// Invoked once from the desktop entry after the app is ready.
import electron from 'electron'
import { pathToFileURL } from 'node:url'
import { BRANDING_ASSET_HOST, BRANDING_ASSET_PROTOCOL, resolveBrandingAssetFile } from './branding-assets.ts'

const electronNet = (electron as { net?: typeof import('electron').net }).net
const electronProtocol = (electron as { protocol?: typeof import('electron').protocol }).protocol

export function registerBrandingAssetProtocol() {
  if (!electronProtocol || !electronNet) return
  electronProtocol.handle(BRANDING_ASSET_PROTOCOL, (request) => {
    try {
      const url = new URL(request.url)
      if (url.hostname !== BRANDING_ASSET_HOST) return new Response(null, { status: 404 })
      const assetPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
      const file = resolveBrandingAssetFile(assetPath)
      if (!file) return new Response(null, { status: 404 })
      return electronNet.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
