import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installRendererTestCoworkApi } from '../../test/setup'
import { ViewErrorBoundary } from './ViewErrorBoundary'

function BrokenView(): never {
  throw new Error('render exploded')
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ViewErrorBoundary', () => {
  it('renders a recovery panel, reports diagnostics, and lets the user go home', () => {
    const reportRendererError = vi.fn()
    installRendererTestCoworkApi({
      diagnostics: { reportRendererError },
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onBackHome = vi.fn()

    render(
      <ViewErrorBoundary resetKey="capabilities" onBackHome={onBackHome}>
        <BrokenView />
      </ViewErrorBoundary>,
    )

    expect(screen.getByText('This page failed to render.')).toBeInTheDocument()
    expect(reportRendererError).toHaveBeenCalledWith(expect.objectContaining({
      message: 'render exploded',
      view: 'capabilities',
    }))
    expect(consoleError).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Back to home' }))
    expect(onBackHome).toHaveBeenCalledTimes(1)
  })

  it('resets after navigation changes the reset key', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { rerender } = render(
      <ViewErrorBoundary resetKey="agents" onBackHome={() => undefined}>
        <BrokenView />
      </ViewErrorBoundary>,
    )
    expect(screen.getByText('This page failed to render.')).toBeInTheDocument()

    rerender(
      <ViewErrorBoundary resetKey="home" onBackHome={() => undefined}>
        <div>Recovered page</div>
      </ViewErrorBoundary>,
    )

    expect(screen.getByText('Recovered page')).toBeInTheDocument()
  })
})
