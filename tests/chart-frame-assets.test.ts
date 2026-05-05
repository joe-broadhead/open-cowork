import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { chartFrameAssetUrl } from '../apps/desktop/src/lib/chart-frame-assets.ts'
import { resolveChartFrameAssetFile } from '../apps/desktop/src/main/chart-frame-assets.ts'

test('chartFrameAssetUrl points bundled chart chunks at the app-owned protocol', () => {
  assert.equal(
    chartFrameAssetUrl('./assets/chartFrame-abc123.js'),
    'open-cowork-chart://frame/assets/chartFrame-abc123.js',
  )
})

test('resolveChartFrameAssetFile only serves contained renderer asset files', () => {
  const root = mkdtempSync(join(tmpdir(), 'open-cowork-chart-assets-'))
  const outside = mkdtempSync(join(tmpdir(), 'open-cowork-chart-outside-'))
  try {
    mkdirSync(join(root, 'assets'), { recursive: true })
    const chunk = join(root, 'assets', 'chartFrame-test.js')
    writeFileSync(chunk, 'export {}')
    const secret = join(outside, 'secret.js')
    writeFileSync(secret, 'export const secret = true')
    symlinkSync(secret, join(root, 'assets', 'linked.js'))

    assert.equal(resolveChartFrameAssetFile('assets/chartFrame-test.js', root), realpathSync.native(chunk))
    assert.equal(resolveChartFrameAssetFile('../assets/chartFrame-test.js', root), null)
    assert.equal(resolveChartFrameAssetFile('chart-frame.html', root), null)
    assert.equal(resolveChartFrameAssetFile('assets/chartFrame-test.html', root), null)
    assert.equal(resolveChartFrameAssetFile('assets/linked.js', root), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
