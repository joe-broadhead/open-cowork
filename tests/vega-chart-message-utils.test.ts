import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldHandleChartFrameMessage } from '../apps/desktop/src/renderer/components/chat/vega-chart-message-utils.ts'

test('shouldHandleChartFrameMessage only accepts messages from the matching iframe window', () => {
  const owningFrame = {} as Window
  const otherFrame = {} as Window

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: owningFrame,
  }), true)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: otherFrame,
  }), false)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: null,
    eventSource: owningFrame,
  }), false)
})
