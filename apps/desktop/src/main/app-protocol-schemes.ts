import electron from 'electron'
import type { CustomScheme } from 'electron'
import { BRANDING_ASSET_PROTOCOL } from './branding-assets.ts'
import { CHART_FRAME_ASSET_PROTOCOL } from '../lib/chart-frame-assets.ts'

const electronProtocol = (electron as { protocol?: typeof import('electron').protocol }).protocol

export const APP_PROTOCOL_SCHEMES: CustomScheme[] = [
  {
    scheme: BRANDING_ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
    },
  },
  {
    scheme: CHART_FRAME_ASSET_PROTOCOL,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]

export function registerAppProtocolSchemes() {
  if (!electronProtocol) return
  electronProtocol.registerSchemesAsPrivileged(APP_PROTOCOL_SCHEMES)
}
