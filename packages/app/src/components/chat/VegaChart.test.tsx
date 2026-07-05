import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { VegaChart } from './VegaChart'

describe('VegaChart', () => {
  it('loads charts in a sandboxed frame and surfaces frame startup failures', () => {
    vi.useFakeTimers()
    render(<VegaChart spec={{ mark: 'bar', data: { values: [{ x: 'A', y: 1 }] } }} />)

    const iframe = screen.getByTitle('Generated chart')
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts')
    expect(iframe.getAttribute('src')).toContain('chart-frame.html')

    fireEvent.load(iframe)
    act(() => {
      vi.advanceTimersByTime(3_000)
    })

    expect(screen.getByText('Chart error: Chart frame did not initialize')).toBeTruthy()
  })

  it('pings the chart frame after load so a missed one-shot ready message can recover', () => {
    vi.useFakeTimers()
    render(<VegaChart spec={{ mark: 'bar', data: { values: [{ x: 'A', y: 1 }] } }} />)

    const iframe = screen.getByTitle('Generated chart') as HTMLIFrameElement
    const frameWindow = iframe.contentWindow
    expect(frameWindow).toBeTruthy()
    const postMessage = vi.spyOn(frameWindow!, 'postMessage')

    fireEvent.load(iframe)
    expect(postMessage).toHaveBeenCalledWith({ type: 'chart-frame-ping' }, '*')

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'chart-frame-ready' },
        origin: 'null',
        source: frameWindow,
      }))
      vi.advanceTimersByTime(3_000)
    })

    expect(screen.queryByText('Chart error: Chart frame did not initialize')).toBeNull()
  })
})
