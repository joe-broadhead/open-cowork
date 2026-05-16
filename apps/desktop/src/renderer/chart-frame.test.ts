import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { embedMock } = vi.hoisted(() => ({
  embedMock: vi.fn(),
}))

vi.mock('vega-embed', () => ({
  default: embedMock,
}))

type MockView = {
  finalize: ReturnType<typeof vi.fn>
  height: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  runAsync: ReturnType<typeof vi.fn>
  toImageURL: ReturnType<typeof vi.fn>
}

type ResizeObserverRecord = {
  disconnect: ReturnType<typeof vi.fn>
  observe: ReturnType<typeof vi.fn>
}

function createView(height = 240): MockView {
  return {
    finalize: vi.fn(),
    height: vi.fn(() => height),
    resize: vi.fn(),
    runAsync: vi.fn(async () => undefined),
    toImageURL: vi.fn(async () => 'data:image/png;base64,chart'),
  }
}

function dispatchParentMessage(data: unknown, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    origin,
    source: window,
  }))
}

describe('chart-frame', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
    embedMock.mockReset()
    document.body.innerHTML = '<div id="chart-root"></div>'
  })

  it('isolates parent messages, cancels stale renders, blocks external loaders, captures active charts, and tears down observers', async () => {
    const resizeObservers: ResizeObserverRecord[] = []
    class TestResizeObserver implements ResizeObserver {
      readonly disconnect = vi.fn()
      readonly observe = vi.fn()
      readonly unobserve = vi.fn()

      constructor() {
        resizeObservers.push(this)
      }
    }

    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: TestResizeObserver,
    })
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    const postMessageSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => undefined)

    let resolveFirstRender!: (result: { view: MockView }) => void
    const staleView = createView(120)
    const activeView = createView(260)
    embedMock
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveFirstRender = resolve
      }))
      .mockImplementationOnce(async () => ({ view: activeView }))

    await import('./chart-frame')

    expect(postMessageSpy).toHaveBeenCalledWith({ type: 'chart-frame-ready' }, '*')

    dispatchParentMessage({
      type: 'render-chart',
      requestId: 1,
      spec: { data: { values: [{ label: 'A', value: 1 }] }, mark: 'bar' },
    }, 'https://attacker.example')
    expect(embedMock).not.toHaveBeenCalled()

    dispatchParentMessage({
      type: 'render-chart',
      requestId: 1,
      spec: { data: { values: [{ label: 'A', value: 1 }] }, mark: 'bar' },
    })
    await waitFor(() => expect(embedMock).toHaveBeenCalledTimes(1))

    dispatchParentMessage({
      type: 'render-chart',
      requestId: 2,
      spec: { data: { values: [{ label: 'B', value: 2 }] }, mark: 'bar' },
    })
    await waitFor(() => expect(embedMock).toHaveBeenCalledTimes(2))

    const loader = embedMock.mock.calls[1]?.[2]?.loader as { load: (uri: string) => Promise<unknown> }
    await expect(loader.load('https://example.test/data.json')).rejects.toThrow('external resource')

    await waitFor(() => {
      expect(postMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'chart-ready', requestId: 2 }),
        '*',
      )
    })

    expect(
      postMessageSpy.mock.calls.some(([message]) =>
        typeof message === 'object'
        && message !== null
        && (message as { type?: string; requestId?: number }).type === 'chart-ready'
        && (message as { requestId?: number }).requestId === 1
      ),
    ).toBe(false)

    resolveFirstRender({ view: staleView })
    await waitFor(() => expect(staleView.finalize).toHaveBeenCalledTimes(1))

    dispatchParentMessage({ type: 'capture-chart', requestId: 7, scale: 3 })
    await waitFor(() => expect(activeView.toImageURL).toHaveBeenCalledWith('png', 3))
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: 'chart-capture',
      requestId: 7,
      dataUrl: 'data:image/png;base64,chart',
    }, '*')

    window.dispatchEvent(new Event('beforeunload'))
    expect(activeView.finalize).toHaveBeenCalledTimes(1)
    expect(resizeObservers.at(-1)?.disconnect).toHaveBeenCalledTimes(1)
  })
})
