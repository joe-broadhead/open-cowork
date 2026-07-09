import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampWindowZoomFactor,
  nextWindowZoomFactor,
  windowZoomDirectionForInput,
} from '../apps/desktop/src/main/window-zoom.ts'

test('window zoom helper clamps factors to the supported accessibility range', () => {
  assert.equal(clampWindowZoomFactor(0.4), 0.8)
  assert.equal(clampWindowZoomFactor(1), 1)
  assert.equal(clampWindowZoomFactor(1.234), 1.23)
  assert.equal(clampWindowZoomFactor(9), 1.5)
  assert.equal(clampWindowZoomFactor(Number.NaN), 1)
})

test('window zoom helper steps and resets from the current factor', () => {
  assert.equal(nextWindowZoomFactor(1, 'in'), 1.1)
  assert.equal(nextWindowZoomFactor(1, 'out'), 0.9)
  assert.equal(nextWindowZoomFactor(0.81, 'out'), 0.8)
  assert.equal(nextWindowZoomFactor(1.49, 'in'), 1.5)
  assert.equal(nextWindowZoomFactor(1.25, 'reset'), 1)
})

test('window zoom keyboard mapping preserves platform zoom shortcuts', () => {
  assert.equal(windowZoomDirectionForInput({ type: 'keyDown', control: true, meta: false, key: '=', code: 'Equal' }), 'in')
  assert.equal(windowZoomDirectionForInput({ type: 'keyDown', control: false, meta: true, key: '+', code: 'Equal' }), 'in')
  assert.equal(windowZoomDirectionForInput({ type: 'keyDown', control: true, meta: false, key: '-', code: 'Minus' }), 'out')
  assert.equal(windowZoomDirectionForInput({ type: 'keyDown', control: false, meta: true, key: '0', code: 'Digit0' }), 'reset')
  assert.equal(windowZoomDirectionForInput({ type: 'keyUp', control: true, meta: false, key: '=', code: 'Equal' }), null)
  assert.equal(windowZoomDirectionForInput({ type: 'keyDown', control: false, meta: false, key: '=', code: 'Equal' }), null)
})
