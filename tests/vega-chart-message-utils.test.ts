import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldHandleChartFrameMessage } from '../apps/desktop/src/renderer/components/chat/vega-chart-message-utils.ts'

test('shouldHandleChartFrameMessage only accepts messages from the matching iframe window', () => {
  const owningFrame = {} as Window
  const otherFrame = {} as Window

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: owningFrame,
    eventOrigin: 'https://app.example',
    expectedOrigin: 'https://app.example',
  }), true)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: otherFrame,
    eventOrigin: 'https://app.example',
    expectedOrigin: 'https://app.example',
  }), false)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: null,
    eventSource: owningFrame,
    eventOrigin: 'https://app.example',
    expectedOrigin: 'https://app.example',
  }), false)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: owningFrame,
    eventOrigin: 'https://evil.example',
    expectedOrigin: 'https://app.example',
  }), false)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: owningFrame,
    eventOrigin: 'file://',
    expectedOrigin: 'null',
  }), true)

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: owningFrame,
    eventOrigin: 'null',
    expectedOrigin: 'null',
  }), true)
})

test('shouldHandleChartFrameMessage rejects opaque origins for non-file frames', () => {
  const owningFrame = {} as Window

  assert.equal(shouldHandleChartFrameMessage({
    frameWindow: owningFrame,
    eventSource: owningFrame,
    eventOrigin: 'null',
    expectedOrigin: 'https://app.example',
  }), false)
})
