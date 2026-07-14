import { describe, expect, it } from 'vitest'
import { normalizeChartFrameMessage, shouldHandleChartFrameMessage } from './vega-chart-message-utils'

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

describe('normalizeChartFrameMessage', () => {
  it('clamps finite chart heights and validates request ids', () => {
    expect(normalizeChartFrameMessage({ type: 'chart-ready', requestId: 1, height: 50_000 })).toEqual({
      type: 'chart-ready',
      requestId: 1,
      height: 2_000,
    })
    expect(normalizeChartFrameMessage({ type: 'chart-ready', requestId: 1, height: Number.NaN })).toBeNull()
    expect(normalizeChartFrameMessage({ type: 'chart-ready', requestId: '1', height: 300 })).toBeNull()
  })

  it('accepts only bounded PNG captures and string error messages', () => {
    expect(normalizeChartFrameMessage({
      type: 'chart-capture',
      requestId: 2,
      dataUrl: 'data:image/png;base64,AAAA',
    })).toEqual({
      type: 'chart-capture',
      requestId: 2,
      dataUrl: 'data:image/png;base64,AAAA',
    })
    expect(normalizeChartFrameMessage({ type: 'chart-capture', requestId: 2, dataUrl: 'https://example.test/chart.png' })).toBeNull()
    expect(normalizeChartFrameMessage({ type: 'chart-error', requestId: 2, message: { unsafe: true } })).toBeNull()
  })
})
