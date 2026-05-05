export const CHART_FRAME_ASSET_PROTOCOL = 'open-cowork-chart'
export const CHART_FRAME_ASSET_HOST = 'frame'

export function chartFrameAssetUrl(assetPath: string) {
  const normalized = assetPath.replace(/^\.?\//, '').replace(/\\/g, '/')
  return `${CHART_FRAME_ASSET_PROTOCOL}://${CHART_FRAME_ASSET_HOST}/${normalized}`
}
