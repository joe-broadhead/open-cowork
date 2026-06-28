import { describe, expect, it } from 'vitest'
import { shouldHandleChartFrameMessage } from './vega-chart-message-utils'

describe('shouldHandleChartFrameMessage', () => {
  it('accepts messages from the chart frame when both origins are opaque variants', () => {
    expect(shouldHandleChartFrameMessage({
      frameWindow: window,
      eventSource: window,
      eventOrigin: 'null',
      expectedOrigin: 'file://',
    })).toBe(true)

    expect(shouldHandleChartFrameMessage({
      frameWindow: window,
      eventSource: window,
      eventOrigin: 'file://',
      expectedOrigin: 'null',
    })).toBe(true)
  })

  it('rejects messages from other sources or concrete origins', () => {
    expect(shouldHandleChartFrameMessage({
      frameWindow: window,
      eventSource: null,
      eventOrigin: 'null',
      expectedOrigin: 'null',
    })).toBe(false)

    expect(shouldHandleChartFrameMessage({
      frameWindow: window,
      eventSource: window,
      eventOrigin: 'https://example.test',
      expectedOrigin: 'null',
    })).toBe(false)
  })
})
