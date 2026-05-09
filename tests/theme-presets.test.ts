import test from 'node:test'
import assert from 'node:assert/strict'
import { UI_THEME_PRESETS } from '../apps/desktop/src/renderer/helpers/theme-preset-data.ts'

test('built-in Matrix theme uses the OpenCode Matrix palette', () => {
  const matrix = UI_THEME_PRESETS.matrix

  assert.equal(matrix.label, 'Matrix')
  assert.deepEqual(matrix.swatches, ['#0a0e0a', '#2eff6a', '#62ff94', '#c770ff'])
  assert.equal(matrix.dark.base, '#0a0e0a')
  assert.equal(matrix.dark.text, '#62ff94')
  assert.equal(matrix.dark.accent, '#2eff6a')
  assert.equal(matrix.dark.info, '#30b3ff')
  assert.equal(matrix.light.base, '#eef3ea')
  assert.equal(matrix.light.text, '#203022')
  assert.equal(matrix.light.accent, '#1cc24b')
})

test('built-in Matrix theme is included in the preset seed order', () => {
  const themeIds = Object.keys(UI_THEME_PRESETS)

  assert.ok(themeIds.includes('matrix'))
  assert.ok(themeIds.indexOf('matrix') > themeIds.indexOf('cyberdream'))
  assert.ok(themeIds.indexOf('matrix') < themeIds.indexOf('moonfly'))
})
