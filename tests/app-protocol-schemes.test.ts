import assert from 'node:assert/strict'
import test from 'node:test'
import { BRANDING_ASSET_PROTOCOL } from '../apps/desktop/src/main/branding-assets.ts'
import { CHART_FRAME_ASSET_PROTOCOL } from '../apps/desktop/src/lib/chart-frame-assets.ts'
import { APP_PROTOCOL_SCHEMES } from '../apps/desktop/src/main/app-protocol-schemes.ts'

test('app protocol schemes are registered as one privileged scheme list', () => {
  const schemes = new Map(APP_PROTOCOL_SCHEMES.map((entry) => [entry.scheme, entry.privileges]))

  assert.deepEqual(Array.from(schemes.keys()).sort(), [
    BRANDING_ASSET_PROTOCOL,
    CHART_FRAME_ASSET_PROTOCOL,
  ].sort())

  assert.equal(schemes.get(BRANDING_ASSET_PROTOCOL)?.standard, true)
  assert.equal(schemes.get(BRANDING_ASSET_PROTOCOL)?.secure, true)
  assert.equal(schemes.get(BRANDING_ASSET_PROTOCOL)?.supportFetchAPI, true)
  assert.equal(schemes.get(BRANDING_ASSET_PROTOCOL)?.corsEnabled, false)

  assert.equal(schemes.get(CHART_FRAME_ASSET_PROTOCOL)?.standard, true)
  assert.equal(schemes.get(CHART_FRAME_ASSET_PROTOCOL)?.secure, true)
  assert.equal(schemes.get(CHART_FRAME_ASSET_PROTOCOL)?.supportFetchAPI, true)
  assert.equal(schemes.get(CHART_FRAME_ASSET_PROTOCOL)?.corsEnabled, true)
})
